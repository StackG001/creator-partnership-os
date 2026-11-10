import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/db.js';
import {
  AgreementStatusSchema,
  DealStageSchema,
  FeeBasisSchema,
  PARTNERSHIP_TERMS,
  PRODUCT_STATUSES,
  type DealStage,
  type FeeBasis,
} from '../../lib/constants.js';
import { qualifiedLeadWhere } from '../pipeline/index.js';

/**
 * Auto-sync: every qualified creator, and everyone we've written to, gets a
 * Deal whose stage follows the data already in the database. Reads only the
 * local database — never Whop, Apify or an LLM.
 */

/** Forward order. LOST is off the line: auto-sync can reach it but never leaves it. */
export const STAGE_ORDER: readonly DealStage[] = ['FOUND', 'PITCHED', 'REPLIED', 'AGREED', 'BUILDING', 'LAUNCHED'];
export const stageRank = (s: string): number => STAGE_ORDER.indexOf(s as DealStage);

/** A message that actually reached the creator (a CANCELLED/SUPERSEDED/DRAFT one never did). */
const DELIVERED = ['SENT', 'REPLIED', 'BOUNCED', 'IGNORED', 'DECLINED'];
/** Product statuses that mean the build has started (RESEARCHING..APPROVED). */
const BUILD_STATUSES = PRODUCT_STATUSES.slice(PRODUCT_STATUSES.indexOf('RESEARCHING'), PRODUCT_STATUSES.indexOf('APPROVED') + 1) as readonly string[];

export const HAND_HANDLED_TAG = 'handled by hand — no automated outreach';
export const FLAG_UNSIGNED_BUILD = 'build started without a signed agreement';
export const FLAG_UNSIGNED_LAUNCH = 'launched without a signed agreement';
export const FEES_UNKNOWN = 'fees not yet known';

export interface HistoryEntry {
  stage: DealStage;
  at: string;
  by: 'auto' | 'manual';
  note?: string;
}

export function appendHistory(current: Prisma.JsonValue | null, entry: HistoryEntry): Prisma.InputJsonValue {
  const list = Array.isArray(current) ? (current as unknown as HistoryEntry[]) : [];
  return [...list, entry] as unknown as Prisma.InputJsonValue;
}

export function addMonths(d: Date, months: number): Date {
  const out = new Date(d);
  out.setMonth(out.getMonth() + months);
  return out;
}

export function periodOf(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// --- the money split (all integer cents) -------------------------------------------------------

export interface Split {
  netCents: number;
  creatorCents: number;
  iclipCents: number;
}

/**
 * net = gross − fees − refunds; the creator gets round(base × pct / 100) where base
 * is net (AFTER_FEES) or gross − refunds (GROSS); iClipmedia keeps net − creator.
 */
export function computeSplit(args: { grossCents: number; whopFeeCents: number; refundCents: number; sharePct: number; basis: FeeBasis }): Split {
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === 'number' && !Number.isInteger(v)) throw new Error(`${k} must be an integer (cents), got ${v}`);
  }
  if (args.sharePct < 0 || args.sharePct > 100) throw new Error(`creator share must be 0-100, got ${args.sharePct}`);
  FeeBasisSchema.parse(args.basis);
  const netCents = args.grossCents - args.whopFeeCents - args.refundCents;
  const base = args.basis === 'GROSS' ? args.grossCents - args.refundCents : netCents;
  const creatorCents = Math.round((base * args.sharePct) / 100);
  return { netCents, creatorCents, iclipCents: netCents - creatorCents };
}

// --- stage derivation --------------------------------------------------------------------------

type SyncCreator = Prisma.CreatorGetPayload<{
  include: { messages: true; products: true; launches: true; deal: true };
}>;

interface Derived {
  /** What the data says, before the terms guard. */
  stage: DealStage;
  /** What the data says ignoring products and launches — where the guard holds a deal. */
  beforeBuild: DealStage;
  lostReason: string | null;
  productId: string | null;
  launchId: string | null;
  launchedAt: Date | null;
}

export function deriveStage(c: SyncCreator): Derived {
  const delivered = c.messages.some((m) => DELIVERED.includes(m.status) || m.sentAt);
  const replied = c.messages.some((m) => m.status === 'REPLIED' || m.repliedAt);

  let beforeBuild: DealStage = 'FOUND';
  if (delivered || c.status === 'CONTACTED') beforeBuild = 'PITCHED';
  if (replied || c.status === 'REPLIED') beforeBuild = 'REPLIED';
  if (c.status === 'AGREED') beforeBuild = 'AGREED';

  const products = [...c.products].filter((p) => p.status !== 'ARCHIVED').sort((a, b) => +b.updatedAt - +a.updatedAt);
  const building = products.find((p) => BUILD_STATUSES.includes(p.status));
  const launches = [...c.launches].sort((a, b) => +b.updatedAt - +a.updatedAt);
  const live = launches.find((l) => l.status === 'LIVE');

  let stage: DealStage = beforeBuild;
  if (building) stage = 'BUILDING';
  if (live || c.status === 'LAUNCHED') stage = 'LAUNCHED';

  let lostReason: string | null = null;
  if ((c.status === 'DECLINED' || c.status === 'DISQUALIFIED') && stageRank(stage) < stageRank('BUILDING')) {
    stage = 'LOST';
    lostReason = c.disqualifiedFor ?? (c.status === 'DECLINED' ? 'declined' : 'disqualified');
  }

  const launch = live ?? launches[0] ?? null;
  return {
    stage,
    beforeBuild,
    lostReason,
    productId: launch?.productId ?? building?.id ?? products[0]?.id ?? null,
    launchId: launch?.id ?? null,
    launchedAt: live?.launchedAt ?? null,
  };
}

// --- sync --------------------------------------------------------------------------------------

export interface SyncReport {
  created: string[];
  moved: Array<{ handle: string; from: string; to: string }>;
  manualKept: Array<{ handle: string; stage: string; dataSays: string }>;
  flagged: Array<{ handle: string; flag: string }>;
  handHandled: string[];
  ledger: Array<{ handle: string; period: string; grossCents: number; creatorCents: number; note: string | null }>;
  total: number;
}

export async function syncDeals(opts: { dryRun?: boolean } = {}): Promise<SyncReport> {
  const report: SyncReport = { created: [], moved: [], manualKept: [], flagged: [], handHandled: [], ledger: [], total: 0 };
  const now = new Date();

  const creators = await prisma.creator.findMany({
    where: {
      OR: [
        qualifiedLeadWhere,
        { messages: { some: {} }, status: { not: 'RETIRED' } },
        // retired creators only if something actually reached them
        { status: 'RETIRED', messages: { some: { OR: [{ status: { in: DELIVERED } }, { sentAt: { not: null } }] } } },
        { deal: { isNot: null } },
      ],
    },
    include: { messages: true, products: true, launches: true, deal: true },
    orderBy: { handle: 'asc' },
  });

  for (const c of creators) {
    report.total++;
    const d = deriveStage(c);
    if (c.doNotContact) report.handHandled.push(c.handle);

    let deal = c.deal;
    if (!deal) {
      report.created.push(c.handle);
      if (opts.dryRun) continue;
      deal = await prisma.deal.create({
        data: {
          creatorId: c.id,
          stage: 'FOUND',
          creatorSharePct: PARTNERSHIP_TERMS.creatorSharePct,
          feeBasis: PARTNERSHIP_TERMS.feeBasis,
          stageHistory: appendHistory(null, { stage: 'FOUND', at: now.toISOString(), by: 'auto', note: 'deal created by sync' }),
        },
      });
    }
    DealStageSchema.parse(deal.stage);
    AgreementStatusSchema.parse(deal.agreementStatus);

    const signed = deal.agreementStatus === 'SIGNED';
    let target = d.stage;
    let flag: string | null = null;
    // Terms guard: nothing is built until both sides sign.
    // A LOST deal is closed — nothing left to flag.
    if (deal.stage === 'LOST') {
      // no flag
    } else if (target === 'BUILDING' && !signed && PARTNERSHIP_TERMS.buildNeedsSignature) {
      flag = FLAG_UNSIGNED_BUILD;
      target = stageRank(d.beforeBuild) < stageRank('AGREED') ? d.beforeBuild : 'AGREED';
    } else if (target === 'LAUNCHED' && !signed) {
      flag = FLAG_UNSIGNED_LAUNCH;
    }
    if (flag) report.flagged.push({ handle: c.handle, flag });

    const data: Prisma.DealUpdateInput = {};
    if (flag !== deal.termsFlag) data.termsFlag = flag;
    if (d.productId && d.productId !== deal.productId) data.product = { connect: { id: d.productId } };
    if (d.launchId && d.launchId !== deal.launchId) data.launch = { connect: { id: d.launchId } };

    // 12 months from launch; from signing until there is a launch.
    const fromSigning = deal.signedAt ? addMonths(deal.signedAt, PARTNERSHIP_TERMS.termMonths) : null;
    const autoEnds = !deal.endsAt || (fromSigning && +deal.endsAt === +fromSigning);
    if (autoEnds) {
      const ends = d.launchedAt ? addMonths(d.launchedAt, PARTNERSHIP_TERMS.termMonths) : fromSigning;
      if (ends && (!deal.endsAt || +ends !== +deal.endsAt)) data.endsAt = ends;
    }

    if (deal.stageSource === 'MANUAL') {
      if (target !== deal.stage) report.manualKept.push({ handle: c.handle, stage: deal.stage, dataSays: target });
    } else {
      const forward =
        deal.stage !== 'LOST' &&
        (target === 'LOST' ? stageRank(deal.stage) < stageRank('BUILDING') : stageRank(target) > stageRank(deal.stage));
      if (forward) {
        report.moved.push({ handle: c.handle, from: deal.stage, to: target });
        data.stage = target;
        let history = deal.stageHistory as Prisma.JsonValue;
        if (target === 'LOST') {
          data.lostReason = d.lostReason;
          // Record how far they got first, so the funnel still counts them as pitched/replied.
          if (stageRank(d.beforeBuild) > stageRank(deal.stage)) {
            history = appendHistory(history, { stage: d.beforeBuild, at: now.toISOString(), by: 'auto' }) as Prisma.JsonValue;
          }
        }
        data.stageHistory = appendHistory(history, {
          stage: target,
          at: now.toISOString(),
          by: 'auto',
          note: flag ? `held below BUILDING: ${flag}` : undefined,
        });
      }
    }

    if (!opts.dryRun && Object.keys(data).length) deal = await prisma.deal.update({ where: { id: deal.id }, data });
  }

  if (!opts.dryRun) report.ledger = await syncLedger(now);
  return report;
}

/**
 * This month's WHOP_SYNC row for every deal with a launch, from the numbers the
 * publisher module already refreshed. Launch totals are cumulative, so this
 * month = launch totals − every earlier month's WHOP_SYNC row.
 */
async function syncLedger(now: Date): Promise<SyncReport['ledger']> {
  const period = periodOf(now);
  const deals = await prisma.deal.findMany({
    where: { launchId: { not: null } },
    include: { launch: true, creator: { select: { handle: true } }, ledger: { where: { source: 'WHOP_SYNC' } } },
  });
  const out: SyncReport['ledger'] = [];
  for (const deal of deals) {
    const launch = deal.launch;
    if (!launch) continue;
    const earlier = deal.ledger.filter((e) => e.period < period);
    const grossCents = launch.revenueCents - earlier.reduce((n, e) => n + e.grossCents, 0);
    const refundCents = launch.refundCents - earlier.reduce((n, e) => n + e.refundCents, 0);
    const sales = launch.sales - earlier.reduce((n, e) => n + e.sales, 0);
    if (!grossCents && !refundCents && !sales && !deal.ledger.some((e) => e.period === period)) continue;
    // Launch rows carry no Whop fee data yet.
    const whopFeeCents = 0;
    const notes = FEES_UNKNOWN;
    const sharePct = deal.creatorSharePct ?? launch.revShareCreatorPct ?? PARTNERSHIP_TERMS.creatorSharePct;
    const split = computeSplit({ grossCents, whopFeeCents, refundCents, sharePct, basis: FeeBasisSchema.parse(deal.feeBasis) });
    const row = { grossCents, whopFeeCents, refundCents, sales, notes, ...split };
    await prisma.splitEntry.upsert({
      where: { dealId_period_source: { dealId: deal.id, period, source: 'WHOP_SYNC' } },
      create: { dealId: deal.id, period, source: 'WHOP_SYNC', ...row },
      update: row,
    });
    out.push({ handle: deal.creator.handle, period, grossCents, creatorCents: split.creatorCents, note: notes });
  }
  return out;
}
