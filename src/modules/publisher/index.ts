import { WhopClient } from '@whop/sdk';
import { prisma } from '../../lib/db.js';
import { getEnv } from '../../lib/env.js';
import { createLogger } from '../../lib/logger.js';
import { normalizeHandle } from '../../lib/paths.js';
import { safetyNicheReason } from '../../lib/productLine.js';

const log = createLogger('publisher');

export interface PublishResult {
  launchId: string;
  url: string;
  checkoutUrl: string;
  externalProductId: string;
  revShareCreatorPct: number;
  revShare: string;
  dryRun: boolean;
}

export interface LaunchStats {
  launchId: string;
  visits: number;
  checkouts: number;
  sales: number;
  revenueCents: number;
}

/**
 * Creators are paid through Whop REVENUE SHARE: their share of every sale of
 * their product, set on that product only, calculated after all Whop fees
 * (docs/partnership-terms.md). Not an affiliate link. Set with the official SDK
 * (@whop/sdk, https://docs.whop.com/developer/guides/affiliates.md):
 *   affiliates.create → affiliates.overrides.create({ override_type: 'rev_share', product_id, revenue_basis: 'post_fees' })
 * Order matters: the share is set on the product BEFORE its checkout exists, so
 * nothing goes on sale without the creator's cut in place.
 */
export const REV_SHARE_NOT_SET = 'REV SHARE NOT SET IN WHOP';

/** Every Whop write the live run makes, in order — printed as-is by --dry-run. */
export interface PublishPlan {
  affiliate: { account_id: string; user_identifier: string } | null;
  product: { account_id: string; title: string; description: string; headline: string; visibility: 'visible'; metadata: Record<string, string> };
  revShareOverride: { override_type: 'rev_share'; commission_value: number; product_id: string; revenue_basis: 'post_fees' } | null;
  checkout: {
    account_id: string;
    mode: 'payment';
    currency: 'usd';
    metadata: Record<string, string | number>;
    variant: { product_id: string; title: string; description: string; billing_type: 'one_time'; initial_price: number; renewal_price: number; currency: 'usd'; visibility: 'visible' };
  };
}

function centsToDollars(cents: number): number {
  return Math.round(cents) / 100;
}

async function loadPublishInputs(handleOrUrl: string, productId?: string) {
  const handle = normalizeHandle(handleOrUrl);
  const creator = await prisma.creator.findUnique({ where: { handle }, include: { deal: true } });
  if (!creator) throw new Error(`No creator found for handle "${handle}" — run the audit first.`);

  const product = productId
    ? await prisma.product.findUnique({ where: { id: productId } })
    : await prisma.product.findFirst({
        where: { creatorId: creator.id, status: { in: ['RENDERED', 'APPROVED'] } },
        orderBy: { createdAt: 'desc' },
      });

  if (!product) {
    throw new Error(
      `No RENDERED product found for @${handle} — run \`npm run product\` first (or pass --product).`,
    );
  }
  if (!product.priceCents) {
    throw new Error(`Product "${product.title}" has no price set — run \`npm run funnel\` first.`);
  }

  const funnel = product.funnel as unknown as {
    salesPage?: { headline?: string; subhead?: string };
  } | null;

  return { creator, product, funnel };
}

const PRODUCT_ID = '<prod_… from step 2>';

export function buildPlan(
  accountId: string,
  creatorHandle: string,
  revShareCreatorPct: number,
  whopUser: string | null,
  product: { id: string; title: string; promise: string | null; priceCents: number | null },
  funnel: { salesPage?: { headline?: string; subhead?: string } } | null,
): PublishPlan {
  const description = product.promise ?? '';
  return {
    affiliate: whopUser ? { account_id: accountId, user_identifier: whopUser } : null,
    product: {
      account_id: accountId,
      title: product.title,
      description,
      headline: funnel?.salesPage?.headline ?? product.title,
      visibility: 'visible',
      metadata: { external_identifier: `cpos-${product.id}`, creatorHandle },
    },
    revShareOverride: whopUser
      ? { override_type: 'rev_share', commission_value: revShareCreatorPct, product_id: PRODUCT_ID, revenue_basis: 'post_fees' }
      : null,
    checkout: {
      account_id: accountId,
      mode: 'payment',
      currency: 'usd',
      metadata: { creatorHandle, revShareCreatorPct, source: 'creator-partnership-os' },
      variant: {
        product_id: PRODUCT_ID,
        title: product.title,
        description,
        billing_type: 'one_time',
        initial_price: centsToDollars(product.priceCents ?? 0),
        renewal_price: 0,
        currency: 'usd',
        visibility: 'visible',
      },
    },
  };
}

/** The creator's affiliate record on our Whop account: created, or found if they already have one. */
async function findOrCreateAffiliate(client: WhopClient, accountId: string, whopUser: string): Promise<{ id: string; username: string | null }> {
  try {
    const a = await client.affiliates.create({ account_id: accountId, user_identifier: whopUser });
    return { id: a.id, username: a.user?.username ?? null };
  } catch (error) {
    // Already an affiliate (or the create was refused): look them up before giving up.
    const wanted = whopUser.replace(/^@/, '').toLowerCase();
    for await (const a of await client.affiliates.list({ account_id: accountId, query: wanted })) {
      if (a.user?.username?.toLowerCase() === wanted || a.user?.id === whopUser) return { id: a.id, username: a.user.username };
    }
    throw new Error(`could not create or find a Whop affiliate for "${whopUser}": ${(error as Error).message}`);
  }
}

/**
 * Publishes on Whop, in this order:
 *   1. the creator's affiliate record (create or find)
 *   2. the product
 *   3. the creator's rev-share override on that product (post_fees)
 *   4. the checkout (one-time price) — only after 3 succeeded
 * then records a Launch row. A failure before 4 leaves nothing on sale.
 * --dry-run prints the plan without calling Whop or writing to the database.
 * --skip-rev-share publishes without the share (recorded as REV_SHARE_NOT_SET and flagged by deals --report).
 */
export async function publishLaunch(
  handleOrUrl: string,
  revShareCreatorPct: number,
  options: { dryRun?: boolean; productId?: string; whopUser?: string; skipRevShare?: boolean } = {},
): Promise<PublishResult> {
  const env = getEnv();
  if (!env.WHOP_API_KEY || !env.WHOP_COMPANY_ID) {
    throw new Error('WHOP_API_KEY and WHOP_COMPANY_ID must be set to publish.');
  }
  if (!Number.isInteger(revShareCreatorPct) || revShareCreatorPct < 1 || revShareCreatorPct > 100) {
    throw new Error(`--rev-share must be a whole number 1-100 (Whop's limit), got ${revShareCreatorPct}.`);
  }

  const { creator, product, funnel } = await loadPublishInputs(handleOrUrl, options.productId);
  // Safety-advice products: the creator must approve every procedure first (src/lib/productLine.ts).
  const safety = safetyNicheReason({ niche: creator.niche, subNiche: creator.subNiche, dealNotes: creator.deal?.notes });
  if (safety && product.status !== 'APPROVED') {
    throw new Error(
      `refused: @${creator.handle} is a safety-advice product (${safety}) and "${product.title}" is ${product.status}, not APPROVED. ` +
        `The creator must approve every procedure in outputs/${creator.handle}/product/safety-review.md, then run ` +
        `\`npm run product -- --handle ${creator.handle} --approve --approved-by "…"\`.`,
    );
  }

  const whopUser = options.skipRevShare ? null : (options.whopUser ?? creator.deal?.whopUser ?? null);
  if (!whopUser && !options.skipRevShare) {
    throw new Error(
      `refused: no Whop account for @${creator.handle}, so their ${revShareCreatorPct}% revenue share can't be set. ` +
        `Pass --whop-user <their Whop username or email> (saved on the deal), or --skip-rev-share to set it by hand in the dashboard.`,
    );
  }
  const plan = buildPlan(env.WHOP_COMPANY_ID, creator.handle, revShareCreatorPct, whopUser, product, funnel);

  if (options.dryRun) {
    log.info('DRY RUN — no Whop API call made, no database write. The live run would make these calls, in order:');
    console.log(JSON.stringify({
      '1 affiliates.create (or find existing)': plan.affiliate ?? 'skipped (--skip-rev-share)',
      '2 products.create': plan.product,
      '3 affiliates.overrides.create': plan.revShareOverride ?? 'skipped (--skip-rev-share) — set it by hand: Dashboard → Affiliates → Revenue share',
      '4 checkoutConfigurations.create': plan.checkout,
    }, null, 2));
    return { launchId: '(dry-run — nothing created)', url: '', checkoutUrl: '', externalProductId: '', revShareCreatorPct, revShare: plan.revShareOverride ? 'planned' : 'skipped', dryRun: true };
  }

  const client = new WhopClient({ token: env.WHOP_API_KEY });
  if (whopUser && options.whopUser && creator.deal && creator.deal.whopUser !== whopUser) {
    await prisma.deal.update({ where: { id: creator.deal.id }, data: { whopUser } });
  }

  log.info(`publishing "${product.title}" to Whop (account ${env.WHOP_COMPANY_ID})`);
  const affiliate = whopUser ? await findOrCreateAffiliate(client, env.WHOP_COMPANY_ID, whopUser) : null;

  const created = await client.products.create(plan.product);
  log.info(`product ${created.id} created`);

  let revShare: string;
  if (affiliate && plan.revShareOverride) {
    try {
      const override = await client.affiliates.overrides.create({
        id: affiliate.id,
        body: { ...plan.revShareOverride, id: affiliate.id, product_id: created.id },
      });
      revShare = `rev share set: ${revShareCreatorPct}% post_fees for ${affiliate.username ? `@${affiliate.username}` : whopUser} (affiliate ${affiliate.id}, override ${override.id}) on ${created.id}`;
      log.info(revShare);
    } catch (error) {
      throw new Error(
        `revenue-share override failed, so NO checkout was created (product ${created.id} exists but is not on sale): ${(error as Error).message}. ` +
          `Fix it in Whop (Dashboard → Affiliates → Revenue share) or re-run.`,
      );
    }
  } else {
    revShare = `${REV_SHARE_NOT_SET}: set @${creator.handle}'s ${revShareCreatorPct}% revenue share for product ${created.id} in Whop (Dashboard → Affiliates → Revenue share)`;
    log.warn(revShare);
  }

  const checkout = await client.checkoutConfigurations.create({
    ...plan.checkout,
    variant: { ...plan.checkout.variant, product_id: created.id },
  });
  if (!checkout.purchase_url) throw new Error(`Whop returned no purchase_url for checkout ${checkout.id} (product ${created.id}).`);
  const checkoutUrl = /^https?:\/\//.test(checkout.purchase_url) ? checkout.purchase_url : `https://whop.com${checkout.purchase_url}`;

  const launch = await prisma.launch.create({
    data: {
      creatorId: creator.id,
      productId: product.id,
      platform: 'WHOP',
      externalProductId: created.id,
      externalPlanId: checkout.variant?.id ?? null,
      url: checkoutUrl,
      checkoutUrl,
      priceCents: product.priceCents,
      bumpPriceCents: product.bumpPriceCents,
      upsellPriceCents: product.upsellPriceCents,
      revShareCreatorPct,
      status: 'LIVE',
      launchedAt: new Date(),
      notes: revShare,
      raw: JSON.parse(JSON.stringify({ product: created, checkout, affiliate })),
    },
  });

  await prisma.product.update({ where: { id: product.id }, data: { status: 'PUBLISHED' } });

  log.info(`live: ${checkoutUrl}`);

  return {
    launchId: launch.id,
    url: checkoutUrl,
    checkoutUrl,
    externalProductId: created.id,
    revShareCreatorPct,
    revShare,
    dryRun: false,
  };
}

/** Pulls current numbers for every LIVE launch back into the database. */
export async function syncLaunchStats(): Promise<LaunchStats[]> {
  const env = getEnv();
  if (!env.WHOP_API_KEY) throw new Error('WHOP_API_KEY must be set to sync stats.');

  const launches = await prisma.launch.findMany({ where: { status: 'LIVE', platform: 'WHOP' } });
  const results: LaunchStats[] = [];

  for (const launch of launches) {
    if (!launch.externalPlanId) continue;
    try {
      const res = await fetch(
        `https://api.whop.com/api/v1/memberships?plan_id=${launch.externalPlanId}`,
        { headers: { Authorization: `Bearer ${env.WHOP_API_KEY}` } },
      );
      if (!res.ok) {
        log.warn(`stats fetch failed for launch ${launch.id}: HTTP ${res.status}`);
        continue;
      }
      const data = (await res.json()) as { data?: unknown[]; pagination?: { total_count?: number } };
      const sales = data.pagination?.total_count ?? data.data?.length ?? 0;
      const revenueCents = sales * (launch.priceCents ?? 0);

      await prisma.launch.update({
        where: { id: launch.id },
        data: { sales, revenueCents, statsAt: new Date() },
      });

      results.push({ launchId: launch.id, visits: launch.visits, checkouts: launch.checkouts, sales, revenueCents });
    } catch (error) {
      log.warn(`stats sync failed for launch ${launch.id}`, String(error));
    }
  }

  return results;
}
