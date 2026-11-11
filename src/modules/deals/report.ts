import { prisma } from '../../lib/db.js';
import { DEAL_STAGES, PARTNERSHIP_TERMS } from '../../lib/constants.js';
import { qualifiedLeads, renderLeadsTable } from '../pipeline/index.js';
import { day, usd } from './index.js';
import { periodOf, stageRank } from './sync.js';
import { REV_SHARE_NOT_SET } from '../publisher/index.js';

const DAY_MS = 86_400_000;

type LedgerRow = { dealId: string; period: string; source: string; grossCents: number; refundCents: number; creatorCents: number; iclipCents: number; whopFeeCents: number };

/**
 * One row per deal per month: a MANUAL entry overrides the WHOP_SYNC one for
 * the same month, so a hand-corrected month is never counted twice.
 */
export function effectiveLedger<T extends LedgerRow>(rows: T[]): T[] {
  const byKey = new Map<string, T>();
  for (const r of rows) {
    const k = `${r.dealId}|${r.period}`;
    const prev = byKey.get(k);
    if (!prev || r.source === 'MANUAL') byKey.set(k, r);
  }
  return [...byKey.values()];
}

/** Weekly deals report. Ends with the Qualified leads table unless leadsTable is false. */
export async function renderDealsReport(opts: { leadsTable?: boolean; now?: Date } = {}): Promise<string> {
  const now = opts.now ?? new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const deals = await prisma.deal.findMany({
    include: { creator: { select: { handle: true, doNotContact: true } }, ledger: true, launch: { select: { notes: true } } },
    orderBy: { updatedAt: 'desc' },
  });
  const out: string[] = [`# Deals — week of ${day(today)}`, ''];

  // Funnel
  const count = (s: string) => deals.filter((d) => d.stage === s).length;
  out.push('## Pipeline funnel', '| Stage | Deals |', '|---|---|');
  for (const s of DEAL_STAGES) out.push(`| ${s} | ${count(s)} |`);
  // Conversion counts everyone who reached a stage, not just who sits there now.
  const reached = (s: string) => deals.filter((d) => d.stage !== 'LOST' ? stageAtLeast(d.stage, s) : historyReached(d.stageHistory, s)).length;
  const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '—');
  const p = reached('PITCHED');
  const r = reached('REPLIED');
  const a = reached('AGREED');
  out.push('', `Conversion: PITCHED ${p} → REPLIED ${r} (${pct(r, p)}) → AGREED ${a} (${pct(a, r)}).`, '');

  // Needing action
  const action: string[] = [];
  for (const d of deals) {
    const h = `@${d.creator.handle}`;
    if (d.nextActionDue && d.nextActionDue < today) action.push(`- ${h}: overdue since ${day(d.nextActionDue)} — ${d.nextAction ?? 'next action'}`);
    if (d.stage === 'AGREED' && d.agreementStatus !== 'SIGNED') action.push(`- ${h}: AGREED but agreement is ${d.agreementStatus} — send/sign it before anything is built`);
    if (d.agreementStatus === 'SENT' && d.agreementSentAt && +today - +d.agreementSentAt > PARTNERSHIP_TERMS.chaseUnsignedAfterDays * DAY_MS) {
      action.push(`- ${h}: agreement sent ${day(d.agreementSentAt)}, not signed after ${PARTNERSHIP_TERMS.chaseUnsignedAfterDays}+ days`);
    }
    if (d.launchWindowEnd && d.promoPostsAgreed != null && d.promoPostsDone < d.promoPostsAgreed) {
      const left = (+d.launchWindowEnd - +today) / DAY_MS;
      if (left >= 0 && left <= PARTNERSHIP_TERMS.launchWindowWarnDays) {
        action.push(`- ${h}: launch window ends ${day(d.launchWindowEnd)} with ${d.promoPostsDone}/${d.promoPostsAgreed} promo posts done`);
      }
    }
    if (d.endsAt && d.agreementStatus === 'SIGNED') {
      const left = (+d.endsAt - +today) / DAY_MS;
      if (left >= 0 && left <= PARTNERSHIP_TERMS.endingWarnDays) action.push(`- ${h}: agreement ends ${day(d.endsAt)} (renews yearly; ${PARTNERSHIP_TERMS.noticeDays} days' notice to end)`);
    }
    if (d.launch?.notes?.includes(REV_SHARE_NOT_SET)) action.push(`- ${h}: ⚠ live on Whop but the creator's ${d.creatorSharePct}% revenue share is not set in Whop yet — Dashboard → Affiliates → Revenue share`);
    if (d.termsFlag && d.stage !== 'LOST') action.push(`- ${h}: ⚠ terms guard — ${d.termsFlag}`);
  }
  out.push('## Deals needing action', ...(action.length ? action : ['Nothing needs action.']), '');

  // Money
  const period = periodOf(now);
  const rows = effectiveLedger(deals.flatMap((d) => d.ledger));
  const handle = new Map(deals.map((d) => [d.id, d.creator.handle]));
  const sum = (rs: LedgerRow[]) => ({
    gross: rs.reduce((n, e) => n + e.grossCents, 0),
    fees: rs.reduce((n, e) => n + e.whopFeeCents, 0),
    refunds: rs.reduce((n, e) => n + e.refundCents, 0),
    creator: rs.reduce((n, e) => n + e.creatorCents, 0),
    iclip: rs.reduce((n, e) => n + e.iclipCents, 0),
  });
  out.push(`## Money (USD) — ${period} and all time`);
  if (!rows.length) out.push('No sales recorded yet.');
  else {
    out.push('| Deal | Month gross | Month refunds | Month creator | Month iClipmedia | All-time gross | All-time refunds | All-time creator | All-time iClipmedia |', '|---|---|---|---|---|---|---|---|---|');
    const ids = [...new Set(rows.map((e) => e.dealId))];
    for (const id of [...ids, 'TOTAL']) {
      const mine = id === 'TOTAL' ? rows : rows.filter((e) => e.dealId === id);
      const m = sum(mine.filter((e) => e.period === period));
      const t = sum(mine);
      const label = id === 'TOTAL' ? '**Total**' : `@${handle.get(id)}`;
      out.push(`| ${label} | ${usd(m.gross)} | ${usd(m.refunds)} | ${usd(m.creator)} | ${usd(m.iclip)} | ${usd(t.gross)} | ${usd(t.refunds)} | ${usd(t.creator)} | ${usd(t.iclip)} |`);
    }
  }
  const bases = [...new Set(deals.map((d) => d.feeBasis))];
  const oneOff = deals.filter((d) => d.feeBasis !== PARTNERSHIP_TERMS.feeBasis).map((d) => `@${d.creator.handle} (${d.feeBasis})`);
  out.push(
    '',
    `Fee basis: ${PARTNERSHIP_TERMS.feeBasis} (Whop revenue share is calculated after all Whop fees; confirmed ${PARTNERSHIP_TERMS.feeBasisConfirmedOn}).${oneOff.length ? ` One-off deals on another basis: ${oneOff.join(', ')}.` : ''}`,
  );
  if (rows.some((e) => e.source === 'WHOP_SYNC' && e.whopFeeCents === 0 && e.grossCents > 0)) out.push('Whop fees are not yet known for synced months (recorded as $0).');

  const hand = deals.filter((d) => d.creator.doNotContact).map((d) => `@${d.creator.handle}`);
  if (hand.length) out.push('', `Handled by hand — no automated outreach: ${hand.join(', ')}.`);

  if (opts.leadsTable !== false) out.push('', ...renderLeadsTable(await qualifiedLeads()));
  return out.join('\n');
}

const stageAtLeast = (stage: string, target: string) => stageRank(stage) >= stageRank(target);
function historyReached(history: unknown, target: string): boolean {
  const list = Array.isArray(history) ? (history as Array<{ stage: string }>) : [];
  return list.some((h) => stageAtLeast(h.stage, target));
}
