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
 * The request body for Whop's POST /api/v1/checkout_configurations (mode:
 * "payment", inline plan + product) — one call creates the product, its plan
 * and a live checkout link. Whop prices are DOLLARS (decimal), not cents.
 */
interface CheckoutConfigPayload {
  mode: 'payment';
  plan: {
    company_id: string;
    currency: 'usd';
    title: string;
    description: string;
    plan_type: 'one_time';
    initial_price: number;
    renewal_price: number;
    visibility: 'visible';
    product: {
      external_identifier: string;
      title: string;
      description: string;
      headline: string;
      visibility: 'visible';
    };
  };
  metadata: { creatorHandle: string; revShareCreatorPct: number; source: 'creator-partnership-os' };
}

/**
 * Creators are paid through Whop REVENUE SHARE: 50% of every sale of their
 * product, set per product, calculated after all Whop fees
 * (docs/partnership-terms.md). Not an affiliate link.
 *
 * TODO(rev-share): set it through the API once the REST shape is confirmed.
 * Whop documents it only as SDK calls (https://docs.whop.com/developer/guides/affiliates.md):
 *   const affiliate = await client.affiliates.create({ company_id, user_identifier });
 *   await client.affiliates.overrides.create(affiliate.id, { override_type: 'rev_share', product_id, commission_value: 50 });
 * The raw HTTP path isn't documented, and neither is `revenue_basis` (the dashboard
 * docs say the split is always after Whop's fees: https://docs.whop.com/affiliates/setup-rev-share).
 * Until then a live publish does NOT set the share: it records REV_SHARE_NOT_SET on the
 * Launch, prints the dashboard steps, and the deals report flags it until it is done.
 */
export const REV_SHARE_NOT_SET = 'REV SHARE NOT SET IN WHOP';

export interface RevSharePlan {
  status: 'planned — not sent (API shape unconfirmed, see TODO in publisher/index.ts)';
  docs: string[];
  affiliate: { company_id: string; user_identifier: string };
  override: { override_type: 'rev_share'; product_id: string; commission_value: number };
  revenueBasis: 'post_fees (Whop always splits after fees)';
  dashboardSteps: string[];
}

export function revSharePlan(companyId: string, creatorHandle: string, sharePct: number, productTitle: string, productId?: string): RevSharePlan {
  return {
    status: 'planned — not sent (API shape unconfirmed, see TODO in publisher/index.ts)',
    docs: ['https://docs.whop.com/developer/guides/affiliates.md', 'https://docs.whop.com/affiliates/setup-rev-share'],
    affiliate: { company_id: companyId, user_identifier: `<@${creatorHandle}'s Whop username or email>` },
    override: { override_type: 'rev_share', product_id: productId ?? '<prod_… from the create response>', commission_value: sharePct },
    revenueBasis: 'post_fees (Whop always splits after fees)',
    dashboardSteps: [
      'Whop Dashboard → Marketing → Affiliates → "Share your revenue"',
      `User: @${creatorHandle}'s Whop account · Share %: ${sharePct}`,
      `Products: override for "${productTitle}" only`,
    ],
  };
}

function centsToDollars(cents: number): number {
  return Math.round(cents) / 100;
}

async function loadPublishInputs(handleOrUrl: string, productId?: string) {
  const handle = normalizeHandle(handleOrUrl);
  const creator = await prisma.creator.findUnique({ where: { handle } });
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

function buildPayload(
  companyId: string,
  creatorHandle: string,
  revShareCreatorPct: number,
  product: { id: string; title: string; promise: string | null; priceCents: number | null },
  funnel: { salesPage?: { headline?: string; subhead?: string } } | null,
): CheckoutConfigPayload {
  return {
    mode: 'payment',
    plan: {
      company_id: companyId,
      currency: 'usd',
      title: product.title,
      description: product.promise ?? '',
      plan_type: 'one_time',
      initial_price: centsToDollars(product.priceCents ?? 0),
      renewal_price: 0,
      visibility: 'visible',
      product: {
        external_identifier: `cpos-${product.id}`,
        title: product.title,
        description: product.promise ?? '',
        headline: funnel?.salesPage?.headline ?? product.title,
        visibility: 'visible',
      },
    },
    metadata: {
      creatorHandle,
      revShareCreatorPct,
      source: 'creator-partnership-os',
    },
  };
}

/**
 * Creates the Whop product, plan and checkout link, then records a Launch row.
 * dryRun builds and logs the exact payload without calling Whop or writing to
 * the database — nothing external ever happens implicitly.
 */
export async function publishLaunch(
  handleOrUrl: string,
  revShareCreatorPct: number,
  options: { dryRun?: boolean; productId?: string } = {},
): Promise<PublishResult> {
  const env = getEnv();
  if (!env.WHOP_API_KEY || !env.WHOP_COMPANY_ID) {
    throw new Error('WHOP_API_KEY and WHOP_COMPANY_ID must be set to publish.');
  }

  const { creator, product, funnel } = await loadPublishInputs(handleOrUrl, options.productId);
  // Safety-advice products: the creator must approve every procedure first (src/lib/productLine.ts).
  const deal = await prisma.deal.findUnique({ where: { creatorId: creator.id }, select: { notes: true } });
  const safety = safetyNicheReason({ niche: creator.niche, subNiche: creator.subNiche, dealNotes: deal?.notes });
  if (safety && product.status !== 'APPROVED') {
    throw new Error(
      `refused: @${creator.handle} is a safety-advice product (${safety}) and "${product.title}" is ${product.status}, not APPROVED. ` +
        `The creator must approve every procedure in outputs/${creator.handle}/product/safety-review.md, then run ` +
        `\`npm run product -- --handle ${creator.handle} --approve --approved-by "…"\`.`,
    );
  }
  const payload = buildPayload(env.WHOP_COMPANY_ID, creator.handle, revShareCreatorPct, product, funnel);

  if (options.dryRun) {
    log.info('DRY RUN — no Whop API call made, no database write. Payload that would be sent:');
    console.log(JSON.stringify(payload, null, 2));
    log.info("Creator's revenue share (planned; not sent by the live run yet either — see TODO):");
    console.log(JSON.stringify(revSharePlan(env.WHOP_COMPANY_ID, creator.handle, revShareCreatorPct, product.title), null, 2));
    return {
      launchId: '(dry-run — nothing created)',
      url: '',
      checkoutUrl: '',
      externalProductId: '',
      revShareCreatorPct,
      dryRun: true,
    };
  }

  log.info(`publishing "${product.title}" to Whop (company ${env.WHOP_COMPANY_ID})`);
  const res = await fetch('https://api.whop.com/api/v1/checkout_configurations', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.WHOP_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Whop checkout_configurations create failed: HTTP ${res.status} ${body.slice(0, 500)}`);
  }

  const data = (await res.json()) as {
    id: string;
    purchase_url: string;
    plan: { id: string };
  };

  const checkoutUrl = `https://whop.com${data.purchase_url}`;

  const launch = await prisma.launch.create({
    data: {
      creatorId: creator.id,
      productId: product.id,
      platform: 'WHOP',
      externalProductId: data.plan.id,
      externalPlanId: data.plan.id,
      url: checkoutUrl,
      checkoutUrl,
      priceCents: product.priceCents,
      bumpPriceCents: product.bumpPriceCents,
      upsellPriceCents: product.upsellPriceCents,
      revShareCreatorPct,
      status: 'LIVE',
      launchedAt: new Date(),
      // TODO(rev-share): cleared once the share is set (by API or by hand in the dashboard)
      notes: `${REV_SHARE_NOT_SET}: set @${creator.handle}'s ${revShareCreatorPct}% revenue share for this product in Whop (Dashboard → Affiliates → Revenue share)`,
      raw: JSON.parse(JSON.stringify(data)),
    },
  });

  await prisma.product.update({ where: { id: product.id }, data: { status: 'PUBLISHED' } });

  log.info(`live: ${checkoutUrl}`);
  log.warn(`${REV_SHARE_NOT_SET} — do this now so @${creator.handle} is paid:`);
  for (const step of revSharePlan(env.WHOP_COMPANY_ID, creator.handle, revShareCreatorPct, product.title, data.plan.id).dashboardSteps) log.warn(`  ${step}`);

  return {
    launchId: launch.id,
    url: checkoutUrl,
    checkoutUrl,
    externalProductId: data.plan.id,
    revShareCreatorPct,
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
