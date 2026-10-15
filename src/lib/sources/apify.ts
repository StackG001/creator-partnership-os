import { getEnv } from '../env.js';
import { createLogger } from '../logger.js';
import { APIFY } from '../constants.js';

/**
 * Every Apify actor run goes through runActorGuarded, which enforces the
 * spending limits in APIFY (src/lib/constants.ts):
 *
 *  1. Before every run, the account's real usage and plan limit this cycle are
 *     read from GET /v2/users/me/limits. At or over the stop line
 *     (APIFY.instagramShareOfPlan × the plan's monthly limit), the run is
 *     refused with ApifyBudgetError.
 *  2. Each run is capped at min(APIFY.maxRunUsd, what's left before the stop
 *     line, any per-process ceiling the caller set). The cap goes to Apify as
 *     maxTotalChargeUsd + maxItems, and the run is also watched while it runs
 *     and aborted if its cost reaches the cap.
 *
 * Runs are serialised so two concurrent calls can't both spend the same headroom.
 */

const log = createLogger('sources:apify');
const API = 'https://api.apify.com/v2';

export class ApifyBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApifyBudgetError';
  }
}

export interface ApifyUsage {
  usedUsd: number;
  cycleStart: Date;
  cycleEnd: Date;
  maxMonthlyUsd: number;
  /** Where Instagram runs stop: APIFY.instagramShareOfPlan of the plan's monthly limit. */
  stopAtUsd: number;
}

function token(): string {
  const env = getEnv();
  if (!env.APIFY_TOKEN) throw new Error('APIFY_TOKEN is not set — required to call Apify.');
  return env.APIFY_TOKEN;
}

async function api<T>(pathAndQuery: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API}${pathAndQuery}`, {
    ...init,
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json', ...init.headers },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Apify ${init.method ?? 'GET'} ${pathAndQuery.split('?')[0]} failed: HTTP ${res.status} ${body.slice(0, 500)}`);
  }
  return (await res.json()) as T;
}

/** Actual usage this billing cycle, straight from Apify's limits endpoint. */
export async function getApifyUsage(): Promise<ApifyUsage> {
  const { data } = await api<{
    data: {
      monthlyUsageCycle: { startAt: string; endAt: string };
      limits: { maxMonthlyUsageUsd: number };
      current: { monthlyUsageUsd: number };
    };
  }>('/users/me/limits');
  return {
    usedUsd: data.current.monthlyUsageUsd,
    cycleStart: new Date(data.monthlyUsageCycle.startAt),
    cycleEnd: new Date(data.monthlyUsageCycle.endAt),
    maxMonthlyUsd: data.limits.maxMonthlyUsageUsd,
    stopAtUsd: Number((data.limits.maxMonthlyUsageUsd * APIFY.instagramShareOfPlan).toFixed(2)),
  };
}

interface PricingInfo {
  pricingModel: string;
  startedAt?: string;
  pricePerUnitUsd?: number;
  tieredPricing?: Record<string, { tieredPricePerUnitUsd: number }>;
  pricingPerEvent?: {
    actorChargeEvents: Record<
      string,
      { isPrimaryEvent?: boolean; eventPriceUsd?: number; eventTieredPricingUsd?: Record<string, { tieredEventPriceUsd: number }> }
    >;
  };
}

const priceCache = new Map<string, number>();

/** What one dataset result costs on this account's plan tier, from the actor's current pricing. */
export async function pricePerResultUsd(actor: string): Promise<number> {
  const cached = priceCache.get(actor);
  if (cached !== undefined) return cached;

  const [{ data: me }, { data: act }] = await Promise.all([
    api<{ data: { plan?: { tier?: string } } }>('/users/me'),
    api<{ data: { pricingInfos?: PricingInfo[] } }>(`/acts/${actor}`),
  ]);
  const tier = me.plan?.tier ?? 'FREE';
  const now = Date.now();
  const current = (act.pricingInfos ?? [])
    .filter((p) => !p.startedAt || new Date(p.startedAt).getTime() <= now)
    .at(-1);

  let price: number | undefined;
  if (current?.pricingModel === 'PAY_PER_EVENT') {
    const events = Object.values(current.pricingPerEvent?.actorChargeEvents ?? {});
    const primary = events.find((e) => e.isPrimaryEvent) ?? events[0];
    price = primary?.eventTieredPricingUsd?.[tier]?.tieredEventPriceUsd ?? primary?.eventPriceUsd;
  } else if (current?.pricingModel === 'PRICE_PER_DATASET_ITEM') {
    price = current.tieredPricing?.[tier]?.tieredPricePerUnitUsd ?? current.pricePerUnitUsd;
  }
  if (!price || price <= 0) {
    throw new Error(
      `Could not work out a per-result price for ${actor} (pricing model ${current?.pricingModel ?? 'unknown'}) — refusing to run it without a cost cap.`,
    );
  }
  priceCache.set(actor, price);
  return price;
}

// --- per-process bookkeeping ------------------------------------------------------

let baselineUsd: number | null = null;
let spentUsd = 0;
let ceilingUsd: number | null = null;
let queue: Promise<unknown> = Promise.resolve();

/** What this process has spent on Apify so far. */
export function apifySpentThisProcess(): number {
  return spentUsd;
}

/** Optional extra cap on this process's total Apify spend (the Instagram pipeline sets one per run). */
export function setApifySpendCeiling(usd: number | null): void {
  ceilingUsd = usd;
}

/** Room left under every limit for the next run, before any per-run cap. */
export async function apifyHeadroom(): Promise<{ usage: ApifyUsage; usedUsd: number; headroomUsd: number }> {
  const usage = await getApifyUsage();
  baselineUsd ??= usage.usedUsd;
  // The limits endpoint can lag a run or two behind; never trust it below what
  // this process has provably spent since it started.
  const usedUsd = Math.max(usage.usedUsd, baselineUsd + spentUsd);
  let headroomUsd = usage.stopAtUsd - usedUsd;
  if (ceilingUsd !== null) headroomUsd = Math.min(headroomUsd, ceilingUsd - spentUsd);
  return { usage, usedUsd, headroomUsd };
}

interface ActorRun {
  id: string;
  status: string;
  defaultDatasetId: string;
  usageTotalUsd?: number;
}

const RUNNING = new Set(['READY', 'RUNNING']);

export async function runActorGuarded<T>(actor: string, input: Record<string, unknown>, label: string): Promise<T[]> {
  const next = queue.then(() => runOne<T>(actor, input, label));
  queue = next.catch(() => undefined);
  return next;
}

async function runOne<T>(actor: string, input: Record<string, unknown>, label: string): Promise<T[]> {
  const { usage, usedUsd, headroomUsd } = await apifyHeadroom();
  const cycle = `${usage.cycleStart.toISOString().slice(0, 10)} → ${usage.cycleEnd.toISOString().slice(0, 10)}`;
  if (usedUsd >= usage.stopAtUsd) {
    throw new ApifyBudgetError(
      `Apify usage this cycle (${cycle}) is $${usedUsd.toFixed(2)} — Instagram runs stop at $${usage.stopAtUsd} (${APIFY.instagramShareOfPlan * 100}% of the $${usage.maxMonthlyUsd} plan). Nothing was run.`,
    );
  }

  const price = await pricePerResultUsd(actor);
  const capUsd = Math.min(APIFY.maxRunUsd, headroomUsd);
  const maxItems = Math.floor(capUsd / price);
  if (maxItems < 1) {
    throw new ApifyBudgetError(
      `Only $${Math.max(0, headroomUsd).toFixed(4)} of Apify budget left for this run (usage $${usedUsd.toFixed(2)} of the $${usage.stopAtUsd} stop, cycle ${cycle}) — not enough for one result. Nothing was run.`,
    );
  }
  const cap = Number(capUsd.toFixed(4));
  log.info(
    `${label}: cycle usage $${usedUsd.toFixed(2)} / $${usage.stopAtUsd} stop — this run capped at $${cap} (≤ ${maxItems} results at $${price}/result)`,
  );

  const query = new URLSearchParams({ maxTotalChargeUsd: String(cap), maxItems: String(maxItems), waitForFinish: '60' });
  let { data: run } = await api<{ data: ActorRun }>(`/acts/${actor}/runs?${query}`, {
    method: 'POST',
    body: JSON.stringify(input),
  });

  let abortedByUs = false;
  while (RUNNING.has(run.status)) {
    if ((run.usageTotalUsd ?? 0) >= cap) {
      log.warn(`${label}: run ${run.id} reached its $${cap} cap — aborting it`);
      await api(`/actor-runs/${run.id}/abort`, { method: 'POST' });
      abortedByUs = true;
    }
    ({ data: run } = await api<{ data: ActorRun }>(`/actor-runs/${run.id}?waitForFinish=60`));
  }

  if (run.status !== 'SUCCEEDED' && !abortedByUs) {
    spentUsd += run.usageTotalUsd ?? 0;
    throw new Error(`Apify ${actor} run ${run.id} ended ${run.status} (${label}).`);
  }

  // The results are paid for the moment the run finishes — retry the download so
  // a network blip never throws a paid run away.
  let items: T[] = [];
  for (let attempt = 1; ; attempt++) {
    try {
      items = await api<T[]>(`/datasets/${run.defaultDatasetId}/items?clean=true&format=json&limit=${maxItems}`);
      break;
    } catch (error) {
      if (attempt >= 4) {
        spentUsd += Math.max(run.usageTotalUsd ?? 0, price);
        throw error;
      }
      log.warn(`${label}: downloading results failed (${(error as Error).message}) — retry ${attempt}/3`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }

  // usageTotalUsd lags the real charge when the run has just finished; this actor
  // charges per result (an empty search still returns — and bills — one item), so
  // never count less than results × price.
  const cost = Math.max(run.usageTotalUsd ?? 0, Math.max(1, items.length) * price);
  spentUsd += cost;
  log.info(`${label}: run ${run.id} ${run.status} · ${items.length} result(s) · cost $${cost.toFixed(4)}`);
  return items;
}
