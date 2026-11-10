import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/db.js';
import {
  AgreementStatusSchema,
  DealStageSchema,
  FeeBasisSchema,
  PARTNERSHIP_TERMS,
  type AgreementStatus,
  type DealStage,
  type FeeBasis,
} from '../../lib/constants.js';
import { normalizeHandle } from '../../lib/paths.js';
import { creatorNiche } from '../../lib/creatorNiche.js';
import { addMonths, appendHistory, computeSplit, FLAG_UNSIGNED_BUILD, HAND_HANDLED_TAG, type HistoryEntry } from './sync.js';

export { syncDeals, computeSplit, HAND_HANDLED_TAG } from './sync.js';

// --- parsing helpers (CLI input → typed values) ------------------------------------------------

/** "49.00" / "49" / "$3.10" → 4900 / 4900 / 310. Exact — no float rounding. */
export function dollarsToCents(raw: string): number {
  const m = raw.trim().replace(/^\$/, '').match(/^(-)?(\d+)(?:\.(\d{1,2}))?$/);
  if (!m) throw new Error(`"${raw}" is not a dollar amount (e.g. 49.00).`);
  const cents = Number(m[2]) * 100 + Number((m[3] ?? '0').padEnd(2, '0'));
  return m[1] ? -cents : cents;
}

/** YYYY-MM-DD → local midnight. */
export function parseDay(raw: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw new Error(`"${raw}" is not a date (YYYY-MM-DD).`);
  const d = new Date(`${raw}T00:00:00`);
  if (Number.isNaN(+d)) throw new Error(`"${raw}" is not a real date.`);
  return d;
}

export function parsePeriod(raw: string): string {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(raw)) throw new Error(`"${raw}" is not a period (YYYY-MM).`);
  return raw;
}

export const day = (d: Date | null | undefined): string =>
  d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : '—';

export function usd(cents: number): string {
  const s = (Math.abs(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${cents < 0 ? '-' : ''}$${s}`;
}

// --- lookups -----------------------------------------------------------------------------------

const dealInclude = {
  creator: true,
  product: true,
  launch: true,
  ledger: { orderBy: [{ period: 'asc' }, { source: 'asc' }] },
} satisfies Prisma.DealInclude;

export type DealFull = Prisma.DealGetPayload<{ include: typeof dealInclude }>;

export async function getDeal(handle: string): Promise<DealFull> {
  const h = normalizeHandle(handle);
  const deal = await prisma.deal.findFirst({ where: { creator: { handle: h } }, include: dealInclude });
  if (!deal) {
    const exists = await prisma.creator.findUnique({ where: { handle: h }, select: { id: true } });
    throw new Error(exists ? `@${h} has no deal yet — run \`npm run deals -- --sync\`.` : `No creator @${h}.`);
  }
  return deal;
}

export async function listDeals(stage?: DealStage): Promise<DealFull[]> {
  return prisma.deal.findMany({
    where: stage ? { stage } : {},
    include: dealInclude,
    orderBy: [{ nextActionDue: { sort: 'asc', nulls: 'last' } }, { updatedAt: 'desc' }],
  });
}

export function profileLink(c: { platform: string; handle: string; profileUrl: string | null }): string {
  return c.platform === 'INSTAGRAM'
    ? `instagram.com/${c.handle}`
    : (c.profileUrl ?? `youtube.com/@${c.handle}`).replace(/^https?:\/\/(www\.)?/, '');
}

export const nicheOf = (c: DealFull['creator']): string => creatorNiche(c);

// --- manual changes ----------------------------------------------------------------------------

export async function setStage(handle: string, raw: string, opts: { note?: string; auto?: boolean } = {}): Promise<DealFull> {
  const deal = await getDeal(handle);
  if (opts.auto) {
    await prisma.deal.update({
      where: { id: deal.id },
      data: {
        stageSource: 'AUTO',
        stageHistory: appendHistory(deal.stageHistory, { stage: deal.stage as DealStage, at: new Date().toISOString(), by: 'manual', note: opts.note ?? 'stage handed back to auto-sync' }),
      },
    });
    return getDeal(handle);
  }
  const stage = DealStageSchema.parse(raw.trim().toUpperCase());
  if (stage === 'BUILDING' && deal.agreementStatus !== 'SIGNED') {
    throw new Error(`refused: @${deal.creator.handle} has no signed agreement (agreement ${deal.agreementStatus}). Nothing is built until both sides sign — record it with --agreement @${deal.creator.handle} signed first.`);
  }
  await prisma.deal.update({
    where: { id: deal.id },
    data: {
      stage,
      stageSource: 'MANUAL',
      lostReason: stage === 'LOST' ? (opts.note ?? deal.lostReason) : null,
      // a closed or properly signed deal has nothing left for the terms guard to flag
      termsFlag: stage === 'BUILDING' || stage === 'LOST' ? null : deal.termsFlag,
      stageHistory: appendHistory(deal.stageHistory, { stage, at: new Date().toISOString(), by: 'manual', note: opts.note }),
    },
  });
  return getDeal(handle);
}

export async function setAgreement(handle: string, raw: string, opts: { url?: string; date?: string } = {}): Promise<DealFull> {
  const deal = await getDeal(handle);
  const status = AgreementStatusSchema.parse(raw.trim().toUpperCase()) as AgreementStatus;
  if (status === 'NONE') throw new Error('use sent | signed | ended.');
  const at = opts.date ? parseDay(opts.date) : new Date();
  const data: Prisma.DealUpdateInput = { agreementStatus: status };
  if (opts.url) {
    if (!/^https?:\/\//i.test(opts.url)) throw new Error(`--url must be a link, got "${opts.url}".`);
    data.agreementUrl = opts.url;
  }
  if (status === 'SENT') data.agreementSentAt = at;
  if (status === 'SIGNED') {
    data.signedAt = at;
    if (!deal.agreementSentAt) data.agreementSentAt = at;
    // 12 months from launch; counted from signing until there is one (sync moves it to the launch date).
    const from = deal.launch?.launchedAt ?? at;
    data.endsAt = addMonths(from, PARTNERSHIP_TERMS.termMonths);
    if (deal.termsFlag === FLAG_UNSIGNED_BUILD) data.termsFlag = null;
  }
  if (status === 'ENDED') data.endsAt = at;
  await prisma.deal.update({ where: { id: deal.id }, data });
  return getDeal(handle);
}

export async function setTerms(
  handle: string,
  opts: { share?: string; basis?: string; window?: string; posts?: string },
): Promise<DealFull> {
  const deal = await getDeal(handle);
  const data: Prisma.DealUpdateInput = {};
  if (opts.share !== undefined) {
    const n = Number(opts.share);
    if (!Number.isInteger(n) || n < 0 || n > 100) throw new Error(`--share must be a whole number 0-100, got "${opts.share}".`);
    data.creatorSharePct = n;
  }
  if (opts.basis !== undefined) data.feeBasis = FeeBasisSchema.parse(opts.basis.trim().toUpperCase()) as FeeBasis;
  if (opts.window !== undefined) {
    const [a, b] = opts.window.split(':');
    if (!a || !b) throw new Error('--window must be YYYY-MM-DD:YYYY-MM-DD.');
    const start = parseDay(a);
    const end = parseDay(b);
    if (end < start) throw new Error('--window ends before it starts.');
    data.launchWindowStart = start;
    data.launchWindowEnd = end;
  }
  if (opts.posts !== undefined) {
    const n = Number(opts.posts);
    if (!Number.isInteger(n) || n < 0) throw new Error(`--posts must be a whole number, got "${opts.posts}".`);
    data.promoPostsAgreed = n;
  }
  if (!Object.keys(data).length) throw new Error('pass at least one of --share, --basis, --window, --posts.');
  await prisma.deal.update({ where: { id: deal.id }, data });
  return getDeal(handle);
}

/** Deal notes: --notes @handle "text" adds a dated line; --replace overwrites. */
export async function addNote(handle: string, text: string, opts: { replace?: boolean } = {}): Promise<DealFull> {
  const deal = await getDeal(handle);
  if (!text.trim()) throw new Error('note text is empty.');
  const line = `${day(new Date())}: ${text.trim()}`;
  const notes = opts.replace || !deal.notes ? line : `${deal.notes}\n${line}`;
  await prisma.deal.update({ where: { id: deal.id }, data: { notes } });
  return getDeal(handle);
}

export async function addPromo(handle: string, raw: string): Promise<DealFull> {
  const deal = await getDeal(handle);
  const m = raw.trim().match(/^([+-])?(\d+)$/);
  if (!m) throw new Error(`--done must be +N, -N or N, got "${raw}".`);
  const n = Number(m[2]);
  const done = m[1] === '+' ? deal.promoPostsDone + n : m[1] === '-' ? deal.promoPostsDone - n : n;
  if (done < 0) throw new Error('promo posts done cannot go below 0.');
  await prisma.deal.update({ where: { id: deal.id }, data: { promoPostsDone: done } });
  return getDeal(handle);
}

export async function setNext(handle: string, text: string, due?: string): Promise<DealFull> {
  const deal = await getDeal(handle);
  if (!text.trim()) throw new Error('next action text is empty.');
  await prisma.deal.update({ where: { id: deal.id }, data: { nextAction: text.trim(), nextActionDue: due ? parseDay(due) : null } });
  return getDeal(handle);
}

export async function addLedgerEntry(
  handle: string,
  opts: { period: string; gross: string; fees: string; refunds: string; sales: string; note?: string },
): Promise<DealFull> {
  const deal = await getDeal(handle);
  const period = parsePeriod(opts.period);
  const grossCents = dollarsToCents(opts.gross);
  const whopFeeCents = dollarsToCents(opts.fees);
  const refundCents = dollarsToCents(opts.refunds);
  const sales = Number(opts.sales);
  if (!Number.isInteger(sales) || sales < 0) throw new Error(`--sales must be a whole number, got "${opts.sales}".`);
  if (grossCents < 0 || whopFeeCents < 0 || refundCents < 0) throw new Error('amounts must not be negative.');
  const split = computeSplit({
    grossCents,
    whopFeeCents,
    refundCents,
    sharePct: deal.creatorSharePct,
    basis: FeeBasisSchema.parse(deal.feeBasis),
  });
  const row = { grossCents, whopFeeCents, refundCents, sales, notes: opts.note ?? null, ...split };
  await prisma.splitEntry.upsert({
    where: { dealId_period_source: { dealId: deal.id, period, source: 'MANUAL' } },
    create: { dealId: deal.id, period, source: 'MANUAL', ...row },
    update: row,
  });
  return getDeal(handle);
}

// --- rendering ---------------------------------------------------------------------------------

export function agreementLabel(d: Pick<DealFull, 'agreementStatus' | 'signedAt' | 'agreementSentAt'>): string {
  if (d.agreementStatus === 'SIGNED') return `signed ${day(d.signedAt)}`;
  if (d.agreementStatus === 'SENT') return `sent ${day(d.agreementSentAt)}`;
  return d.agreementStatus.toLowerCase();
}

export function renderList(deals: DealFull[]): string[] {
  if (!deals.length) return ['No deals. Run `npm run deals -- --sync`.'];
  const out = [
    '| @handle | Platform | Niche | Score | Stage | Agreement | Next action (due) | Last ledger |',
    '|---|---|---|---|---|---|---|---|',
  ];
  for (const d of deals) {
    const c = d.creator;
    const last = d.ledger.at(-1)?.period ?? '—';
    const stage = `${d.stage}${d.stageSource === 'MANUAL' ? ' (manual)' : ''}${d.termsFlag ? ' ⚠' : ''}`;
    const next = d.nextAction ? `${d.nextAction} (${day(d.nextActionDue)})` : c.doNotContact ? HAND_HANDLED_TAG : '—';
    out.push(`| @${c.handle} | ${c.platform === 'INSTAGRAM' ? 'Instagram' : 'YouTube'} | ${nicheOf(c)} | ${c.score ?? '—'} | ${stage} | ${agreementLabel(d)} | ${next} | ${last} |`);
  }
  return out;
}

export function renderShow(d: DealFull): string[] {
  const c = d.creator;
  const email = c.businessEmail ?? c.contactEmail;
  const out = [
    `# Deal: @${c.handle}`,
    '',
    `- Creator: ${c.displayName ?? '—'} · ${profileLink(c)} · ${nicheOf(c)} · score ${c.score ?? '—'} · creator status ${c.status}`,
    `- Contact: ${email ?? 'no email'}${c.doNotContact ? ` · **${HAND_HANDLED_TAG}**` : ''}`,
    `- Stage: **${d.stage}** (${d.stageSource.toLowerCase()})${d.lostReason ? ` · lost: ${d.lostReason}` : ''}`,
    d.termsFlag ? `- ⚠ Terms: ${d.termsFlag}` : '',
    `- Next action: ${d.nextAction ?? '—'}${d.nextActionDue ? ` (due ${day(d.nextActionDue)})` : ''}`,
    `- Agreement: ${agreementLabel(d)}${d.agreementUrl ? ` · ${d.agreementUrl}` : ''} · ends ${day(d.endsAt)}`,
    `- Terms: creator ${d.creatorSharePct}% · fee basis ${d.feeBasis}${d.feeBasis === PARTNERSHIP_TERMS.feeBasis && !PARTNERSHIP_TERMS.feeBasisConfirmed ? ' (default, not yet confirmed in Whop)' : ''}`,
    `- Launch window: ${d.launchWindowStart ? `${day(d.launchWindowStart)} → ${day(d.launchWindowEnd)}` : '—'} · promo posts ${d.promoPostsDone}/${d.promoPostsAgreed ?? '—'}`,
    `- Product: ${d.product ? `${d.product.title} (${d.product.status})` : '—'} · Launch: ${d.launch ? `${d.launch.status}${d.launch.url ? ` ${d.launch.url}` : ''}` : '—'}`,
    d.notes ? `- Notes:\n${d.notes.split('\n').map((l) => `  - ${l}`).join('\n')}` : '',
    '',
    '## Stage history',
  ].filter((l, i, a) => l !== '' || a[i - 1] !== '');
  const history = (Array.isArray(d.stageHistory) ? d.stageHistory : []) as unknown as HistoryEntry[];
  if (!history.length) out.push('—');
  for (const h of history) out.push(`- ${h.at.slice(0, 10)} · ${h.stage} · ${h.by}${h.note ? ` — ${h.note}` : ''}`);
  out.push('', '## Ledger');
  if (!d.ledger.length) out.push('No entries.');
  else {
    out.push('| Period | Source | Sales | Gross | Fees | Refunds | Net | Creator | iClipmedia | Notes |', '|---|---|---|---|---|---|---|---|---|---|');
    for (const e of d.ledger) {
      out.push(`| ${e.period} | ${e.source} | ${e.sales} | ${usd(e.grossCents)} | ${usd(e.whopFeeCents)} | ${usd(e.refundCents)} | ${usd(e.netCents)} | ${usd(e.creatorCents)} | ${usd(e.iclipCents)} | ${e.notes ?? ''} |`);
    }
  }
  return out;
}
