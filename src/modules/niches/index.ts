import { z } from 'zod';
import type { Niche, Source } from '@prisma/client';
import { prisma } from '../../lib/db.js';
import { completeJSON } from '../../lib/llm.js';
import { createLogger } from '../../lib/logger.js';
import { isSensitiveNiche } from '../../lib/productLine.js';
import { LEGACY_NICHES, NICHE_LIBRARY, PIPELINE, type NicheOrigin } from '../../lib/constants.js';

const log = createLogger('niches');

// The niche library: no niche is off limits. Every week the generator adds
// niches and sub-niches (problem hashtags, "how do I…" phrases, conditions,
// life situations, hobbies), each with its own search terms, plus a
// similar-accounts search for every Instagram creator who qualified. The
// pipeline picks terms from here — ~70% from niches that produce, ~30%
// exploring new ones — and reports back so producers get promoted, dead terms
// paused and dead niches retired.

export type SearchPlatform = 'YOUTUBE' | 'INSTAGRAM';

const DAY = 86_400_000;

// --- migration -----------------------------------------------------------------------

/** One-off: the pre-library niches and their Sources become LEGACY niches. Safe to call every run. */
export async function ensureLegacyNiches(): Promise<void> {
  for (const l of LEGACY_NICHES) {
    const niche = await prisma.niche.upsert({
      where: { name: l.niche },
      create: { name: l.niche, category: l.category, origin: 'LEGACY', sensitive: false },
      update: {},
    });
    await prisma.source.updateMany({ where: { niche: l.niche, nicheId: null }, data: { nicheId: niche.id } });
    for (const query of l.queries) {
      for (const [platform, kind] of [['YOUTUBE', 'YT_SEARCH'], ['INSTAGRAM', 'IG_SEARCH']] as const) {
        await prisma.source.upsert({
          where: { platform_kind_query: { platform, kind, query } },
          create: { platform, kind, query, niche: l.niche, nicheId: niche.id, notes: 'pipeline' },
          update: { nicheId: niche.id },
        });
      }
    }
    // Credit the niche with what its Sources already found.
    const agg = await prisma.source.aggregate({ where: { nicheId: niche.id }, _sum: { qualifiedCount: true }, _max: { runCount: true } });
    const qualified = agg._sum.qualifiedCount ?? 0;
    if (qualified && niche.qualified === 0) {
      await prisma.niche.update({
        where: { id: niche.id },
        data: { qualified, runs: agg._max.runCount ?? 0, status: 'PRODUCING', promotedAt: niche.promotedAt ?? new Date() },
      });
    }
  }
}

/**
 * Every niche gets Google-pre-filtered Instagram terms (IG_GOOGLE): its keyword
 * phrase (the YouTube keyword, not the "how do I…" one) and its #hashtag. Safe to call every run.
 */
export async function ensureGoogleSources(): Promise<number> {
  const niches = await prisma.niche.findMany({ where: { status: { not: 'RETIRED' } }, include: { sources: true } });
  let added = 0;
  for (const n of niches) {
    const terms = [
      ...n.sources.filter((s) => s.kind === 'YT_SEARCH' && !/^how\b/i.test(s.query)).map((s) => s.query),
      ...n.sources.filter((s) => s.kind === 'HASHTAG').map((s) => `#${s.query}`),
    ];
    for (const query of [...new Set(terms)]) {
      const exists = await prisma.source.findUnique({ where: { platform_kind_query: { platform: 'INSTAGRAM', kind: 'IG_GOOGLE', query } } });
      if (exists) continue;
      await prisma.source.create({ data: { platform: 'INSTAGRAM', kind: 'IG_GOOGLE', query, niche: n.name, nicheId: n.id, notes: 'pipeline' } });
      added++;
    }
  }
  return added;
}

// --- weekly generation -------------------------------------------------------------------

const GeneratedSchema = z.object({
  niches: z.array(
    z.object({
      name: z.string().min(3).describe('Specific niche or sub-niche, e.g. "Sourdough for busy parents", "Living with Graves\' disease", "Budgeting on one income".'),
      category: z.string().describe('Broad area, ideally one of the given categories.'),
      parent: z.string().nullable().describe('Name of an existing niche this is a sub-niche of, or null.'),
      origin: z.enum(['GENERATED', 'PROVEN']).describe('PROVEN when it comes straight from a niche that already produced qualified creators; otherwise GENERATED.'),
      sensitive: z.boolean().describe('True for health, medical conditions, mental health, or money/finance.'),
      why: z.string().describe('One line: what the audience in this niche keeps asking or struggling with.'),
      keyword: z.string().describe('2-4 word YouTube search for channels in this niche (no "how", no #).'),
      igKeyword: z.string().describe('1-2 word Instagram account search for this niche (Instagram only matches short words in names/handles), e.g. "vanlife", "sourdough", "crochet".'),
      howDoI: z.string().describe('A real "how do I…" / "how to…" phrase this audience types into YouTube.'),
      hashtag: z.string().describe('One Instagram problem hashtag people in this niche use, without the #, lowercase, no spaces.'),
    }),
  ),
});

export interface GenerateResult {
  created: Array<Pick<Niche, 'name' | 'category' | 'origin' | 'sensitive'> & { why: string; terms: string[] }>;
  similar: string[];
}

function ageDays(d: Date | null | undefined): number {
  return d ? (Date.now() - d.getTime()) / DAY : Infinity;
}

/** Whether the weekly generator is due. */
export async function generationDue(): Promise<boolean> {
  const last = await prisma.niche.findFirst({ where: { origin: { in: ['GENERATED', 'PROVEN'] } }, orderBy: { createdAt: 'desc' } });
  return ageDays(last?.createdAt) >= NICHE_LIBRARY.generateEveryDays;
}

/**
 * Add NICHE_LIBRARY.newNichesPerWeek new niches (with YouTube + Instagram
 * search terms and a hashtag), plus a similar-accounts search for every
 * Instagram creator who qualified and doesn't have one yet.
 */
export async function generateNiches(count: number = NICHE_LIBRARY.newNichesPerWeek): Promise<GenerateResult> {
  await ensureLegacyNiches();
  const existing = await prisma.niche.findMany({ select: { name: true, status: true, qualified: true } });
  const producing = existing.filter((n) => n.status === 'PRODUCING').map((n) => `${n.name} (${n.qualified} qualified)`);
  const retired = existing.filter((n) => n.status === 'RETIRED').map((n) => n.name);
  // Every creator who ever cleared the bar is proof a niche works, wherever they came from.
  const proven = await prisma.creator.findMany({
    where: { status: { in: ['AUDITED', 'CONTACTED', 'REPLIED', 'AGREED', 'LAUNCHED'] }, niche: { not: null } },
    select: { niche: true },
    take: 60,
    orderBy: { updatedAt: 'desc' },
  });

  const { data } = await completeJSON({
    system: [
      'You build the niche library for Creator Partnership OS, which finds micro-creators (10k-200k followers) whose audience keeps asking them questions, then builds the creator a digital product for a revenue share.',
      'No niche is off limits: anywhere creators teach, show or struggle with something and their audience asks questions — every hobby, life situation, condition, skill, job, place and identity.',
      'Go specific: sub-niches beat broad niches ("sourdough for people with celiac", "budgeting as a single dad", "crochet for left-handers", "vanlife with dogs"). Spread across many different categories; do not cluster.',
      `About a third should be PROVEN: sub-niches and neighbours of the niches that already produced qualified creators (given below). The rest GENERATED: new territory.`,
      'Health, medical, mental-health and finance niches are welcome (mark sensitive: true) — their products will only ever be lifestyle/experience guides from the creator\'s own routines.',
      'Never repeat an existing or retired niche, even reworded.',
      'Search terms find CREATORS who teach/show/live it — never use "coach", "consultant", "agency", "shop" or "services" in a keyword (those find service sellers, who are excluded).',
      `Return exactly ${count} niches.`,
    ].join('\n'),
    prompt: [
      `Categories to cover (and go beyond): ${NICHE_LIBRARY.categories.join(', ')}`,
      '',
      `Niches that produced qualified creators: ${producing.join('; ') || 'none yet'}`,
      `Areas where creators already qualified (from audits): ${[...new Set(proven.map((p) => p.niche!.slice(0, 120)))].join(' | ') || 'none'}`,
      `Existing niches (do not repeat): ${existing.map((n) => n.name).join('; ') || 'none'}`,
      `Retired niches (dead — avoid): ${retired.join('; ') || 'none'}`,
    ].join('\n'),
    schema: GeneratedSchema.refine((v) => v.niches.length === count, { message: `exactly ${count} niches` }),
    schemaName: 'niche_library',
    tier: 'default',
    label: 'niches:generate',
    maxTokens: 8000,
  });

  const created: GenerateResult['created'] = [];
  const known = new Set(existing.map((n) => n.name.toLowerCase()));
  for (const g of data.niches) {
    if (known.has(g.name.toLowerCase())) continue;
    known.add(g.name.toLowerCase());
    const parent = g.parent ? await prisma.niche.findUnique({ where: { name: g.parent } }) : null;
    const sensitive = g.sensitive || isSensitiveNiche(`${g.name} ${g.category}`);
    const niche = await prisma.niche.create({
      data: { name: g.name, category: g.category, parentId: parent?.id ?? null, origin: g.origin, sensitive, notes: g.why },
    });
    const hashtag = g.hashtag.replace(/^#/, '').replace(/\s+/g, '').toLowerCase();
    const terms: Array<{ platform: SearchPlatform; kind: string; query: string }> = [
      { platform: 'YOUTUBE', kind: 'YT_SEARCH', query: g.keyword },
      { platform: 'YOUTUBE', kind: 'YT_SEARCH', query: g.howDoI },
      { platform: 'INSTAGRAM', kind: 'IG_SEARCH', query: g.igKeyword.trim().split(/\s+/).slice(0, 2).join(' ') },
      { platform: 'INSTAGRAM', kind: 'HASHTAG', query: hashtag },
      { platform: 'INSTAGRAM', kind: 'IG_GOOGLE', query: g.keyword },
      { platform: 'INSTAGRAM', kind: 'IG_GOOGLE', query: `#${hashtag}` },
    ];
    for (const t of terms) {
      await prisma.source.upsert({
        where: { platform_kind_query: { platform: t.platform, kind: t.kind, query: t.query } },
        create: { ...t, niche: g.name, nicheId: niche.id, notes: 'pipeline' },
        update: {},
      });
    }
    created.push({ name: g.name, category: g.category, origin: g.origin, sensitive, why: g.why, terms: terms.map((t) => `${t.kind === 'HASHTAG' ? '#' : ''}${t.query} (${t.kind})`) });
  }

  await ensureGoogleSources();
  const similar = await addSimilarAccountSearches();
  log.info(`added ${created.length} niche(s) and ${similar.length} similar-accounts search(es)`);
  return { created, similar };
}

/** A SIMILAR_TO search for every qualified Instagram creator that doesn't have one yet. */
export async function addSimilarAccountSearches(): Promise<string[]> {
  const creators = await prisma.creator.findMany({
    where: { platform: 'INSTAGRAM', status: { in: ['AUDITED', 'CONTACTED', 'REPLIED', 'AGREED', 'LAUNCHED'] } },
    include: { source: { include: { nicheRef: true } } },
  });
  const added: string[] = [];
  for (const c of creators) {
    const exists = await prisma.source.findUnique({
      where: { platform_kind_query: { platform: 'INSTAGRAM', kind: 'SIMILAR_TO', query: c.handle } },
    });
    if (exists) continue;
    const name = `Accounts like @${c.handle}`;
    const niche =
      c.source?.nicheRef ??
      (await prisma.niche.upsert({
        where: { name },
        create: {
          name,
          category: (c.niche ?? 'similar accounts').slice(0, 80),
          origin: 'SIMILAR_ACCOUNTS',
          sensitive: isSensitiveNiche(c.niche),
          notes: c.niche,
        },
        update: {},
      }));
    await prisma.source.create({
      data: { platform: 'INSTAGRAM', kind: 'SIMILAR_TO', query: c.handle, niche: niche.name, nicheId: niche.id, notes: 'pipeline' },
    });
    added.push(`@${c.handle}`);
  }
  return added;
}

// --- picking what to search -----------------------------------------------------------------

export type SourceWithNiche = Source & { nicheRef: Niche | null };

const KINDS: Record<SearchPlatform, readonly string[]> = {
  YOUTUBE: ['YT_SEARCH'],
  INSTAGRAM: PIPELINE.instagram.discoveryKinds,
};

const EXPLOIT_ORIGINS: NicheOrigin[] = ['PROVEN', 'SIMILAR_ACCOUNTS'];

/** Instagram keyword searches are 1–2 words; anything longer returns no accounts. */
export function isShortIgKeyword(query: string): boolean {
  return query.trim().split(/\s+/).length <= 2;
}

/** Instagram: hashtags and similar-accounts first, short keywords last. */
const IG_KIND_ORDER: Record<string, number> = { IG_GOOGLE: 0, SIMILAR_TO: 1, HASHTAG: 2, IG_SEARCH: 3 };

function isExploit(s: SourceWithNiche): boolean {
  const n = s.nicheRef;
  return s.qualifiedCount > 0 || n?.status === 'PRODUCING' || (n ? EXPLOIT_ORIGINS.includes(n.origin as NicheOrigin) : false);
}

/**
 * Up to `count` search terms for this platform: ~70% from niches that
 * produce (best qualified-per-run first), ~30% exploring niches that haven't
 * yet (never-run niches first, one term per niche). Paused terms, retired
 * niches and terms run in the last NICHE_LIBRARY.rotationDays are skipped.
 * `asOf` lets the dry run plan future days.
 */
export async function pickSearches(
  platform: SearchPlatform,
  count: number,
  options: { asOf?: Date; exclude?: Set<string> } = {},
): Promise<{ exploit: SourceWithNiche[]; explore: SourceWithNiche[] }> {
  const asOf = options.asOf ?? new Date();
  const cutoff = new Date(asOf.getTime() - NICHE_LIBRARY.rotationDays * DAY);
  const all = (await prisma.source.findMany({
    where: {
      platform,
      kind: { in: [...KINDS[platform]] },
      notes: 'pipeline',
      pausedAt: null,
      active: true,
      OR: [{ lastRunAt: null }, { lastRunAt: { lt: cutoff } }],
    },
    include: { nicheRef: true },
  })) as SourceWithNiche[];
  const eligible = all.filter(
    (s) =>
      s.nicheRef?.status !== 'RETIRED' &&
      !options.exclude?.has(s.id) &&
      // Instagram account search only matches short words — longer keyword searches return nothing.
      !(s.kind === 'IG_SEARCH' && !isShortIgKeyword(s.query)),
  );

  const rate = (s: SourceWithNiche) => (s.qualifiedCount + (s.nicheRef?.qualified ?? 0)) / Math.max(1, s.runCount);
  const kindRank = (s: SourceWithNiche) => (platform === 'INSTAGRAM' ? (IG_KIND_ORDER[s.kind] ?? 3) : 0);
  const exploitPool = eligible.filter(isExploit).sort((a, b) => kindRank(a) - kindRank(b) || rate(b) - rate(a));
  const explorePool = eligible
    .filter((s) => !isExploit(s))
    .sort(
      (a, b) =>
        kindRank(a) - kindRank(b) ||
        (a.nicheRef?.runs ?? 0) - (b.nicheRef?.runs ?? 0) ||
        a.createdAt.getTime() - b.createdAt.getTime(),
    );

  // At most one term per niche per run, in BOTH pools, so a run spreads across the
  // whole library instead of piling onto whichever niche produced first.
  const seenNiche = new Set<string>();
  const onePerNiche = (s: SourceWithNiche) => {
    const k = s.nicheId ?? s.id;
    if (seenNiche.has(k)) return false;
    seenNiche.add(k);
    return true;
  };
  // Exploit: least-recently-run niche first among producers, so producers take turns.
  const byNicheAge = (a: SourceWithNiche, b: SourceWithNiche) =>
    (a.nicheRef?.lastRunAt?.getTime() ?? 0) - (b.nicheRef?.lastRunAt?.getTime() ?? 0) || kindRank(a) - kindRank(b) || rate(b) - rate(a);
  const exploitSpread = [...exploitPool].sort(byNicheAge).filter(onePerNiche);
  const exploreSpread = explorePool.filter(onePerNiche);

  const nExplore = count <= 1 ? (exploitPool.length ? 0 : 1) : Math.max(1, Math.round(count * NICHE_LIBRARY.exploreShare));
  const exploitShare = exploitSpread.length ? count - Math.min(nExplore, exploreSpread.length) : 0;
  const exploit = exploitSpread.slice(0, exploitShare);
  const explore = exploreSpread.slice(0, count - exploit.length);
  // Top up only with terms from niches not used this run.
  const short = count - explore.length - exploit.length;
  if (short > 0) {
    const used = new Set([...explore, ...exploit].map((s) => s.id));
    const rest = [...exploreSpread, ...exploitSpread].filter((s) => !used.has(s.id));
    for (const s of rest) {
      if (explore.length + exploit.length >= count) break;
      if (used.has(s.id)) continue;
      used.add(s.id);
      (isExploit(s) ? exploit : explore).push(s);
    }
  }
  return { exploit, explore };
}

// --- learning from each run -------------------------------------------------------------------

export interface NicheEvents {
  promoted: string[];
  retired: string[];
  pausedTerms: string[];
  explored: string[];
}

/**
 * After a run: per niche touched, count the run, add what it found and cost,
 * promote it on its first qualified creator, retire it after
 * NICHE_LIBRARY.retireAfterEmptyRuns empty runs in a row (pausing its terms).
 */
export async function recordNicheRun(
  outcomes: Array<{ nicheId: string | null; added: number; spentMicros: number; wasExplore: boolean }>,
): Promise<NicheEvents> {
  const events: NicheEvents = { promoted: [], retired: [], pausedTerms: [], explored: [] };
  const byNiche = new Map<string, { added: number; spent: number; explore: boolean }>();
  for (const o of outcomes) {
    if (!o.nicheId) continue;
    const e = byNiche.get(o.nicheId) ?? { added: 0, spent: 0, explore: false };
    e.added += o.added;
    e.spent += o.spentMicros;
    e.explore ||= o.wasExplore;
    byNiche.set(o.nicheId, e);
  }
  for (const [id, o] of byNiche) {
    const n = await prisma.niche.findUnique({ where: { id } });
    if (!n) continue;
    if (o.explore && n.runs === 0) events.explored.push(n.name);
    const emptyRuns = o.added > 0 ? 0 : n.emptyRuns + 1;
    const promote = o.added > 0 && n.status !== 'PRODUCING';
    const retire = o.added === 0 && emptyRuns >= NICHE_LIBRARY.retireAfterEmptyRuns && n.status !== 'RETIRED';
    await prisma.niche.update({
      where: { id },
      data: {
        runs: { increment: 1 },
        qualified: { increment: o.added },
        spentMicros: { increment: o.spent },
        emptyRuns,
        lastRunAt: new Date(),
        ...(promote ? { status: 'PRODUCING', promotedAt: new Date() } : {}),
        ...(retire ? { status: 'RETIRED', retiredAt: new Date() } : {}),
      },
    });
    if (promote) events.promoted.push(n.name);
    if (retire) {
      events.retired.push(n.name);
      await prisma.source.updateMany({
        where: { nicheId: id, pausedAt: null },
        data: { pausedAt: new Date(), pausedReason: `niche retired after ${emptyRuns} empty runs` },
      });
    }
  }
  return events;
}

/** Search-term outcome: reset the empty streak, or count it and pause the term at PIPELINE.pauseAfterEmptyRuns. */
export async function recordSearchOutcome(source: Source, added: number, spentMicros: number, found = 1): Promise<boolean> {
  const streak = added > 0 ? 0 : source.consecutiveEmptyRuns + 1;
  // An Instagram keyword search that returns no accounts at all is dropped at once.
  const noAccounts = source.kind === 'IG_SEARCH' && found === 0;
  const pause = noAccounts || streak >= PIPELINE.pauseAfterEmptyRuns;
  await prisma.source.update({
    where: { id: source.id },
    data: {
      consecutiveEmptyRuns: streak,
      spentMicros: { increment: spentMicros },
      ...(pause
        ? { pausedAt: new Date(), pausedReason: noAccounts ? 'Instagram keyword search returned no accounts' : `no new qualified creators ${streak} runs in a row` }
        : {}),
    },
  });
  if (pause) log.warn(`paused search term "${source.query}" (${source.platform}) — nothing new ${streak} runs in a row`);
  return pause;
}

/** Charge a paid audit to the term and niche that found the creator. */
export async function chargeAudit(sourceId: string | null, spentMicros: number): Promise<void> {
  if (!sourceId || !spentMicros) return;
  const s = await prisma.source.update({ where: { id: sourceId }, data: { spentMicros: { increment: spentMicros } } });
  if (s.nicheId) await prisma.niche.update({ where: { id: s.nicheId }, data: { spentMicros: { increment: spentMicros } } });
}

// --- reporting -------------------------------------------------------------------------------

export function usd(micros: number): string {
  return `$${(micros / 1e6).toFixed(micros && micros < 10_000 ? 4 : 2)}`;
}

export async function libraryReport(): Promise<string[]> {
  const niches = await prisma.niche.findMany({
    include: { sources: true },
    orderBy: [{ status: 'asc' }, { qualified: 'desc' }, { name: 'asc' }],
  });
  const out: string[] = [];
  const by = (st: string) => niches.filter((n) => n.status === st);
  out.push(`Library: ${niches.length} niches — ${by('PRODUCING').length} producing, ${by('EXPLORING').length} exploring, ${by('RETIRED').length} retired · ${niches.reduce((n, x) => n + x.sources.length, 0)} search terms`);
  for (const n of niches) {
    const cpq = n.qualified ? usd(Math.round(n.spentMicros / n.qualified)) : '—';
    out.push(
      `- [${n.status}] **${n.name}** (${n.category}${n.sensitive ? ', sensitive' : ''}, ${n.origin}) — ${n.qualified} qualified over ${n.runs} run(s) · spent ${usd(n.spentMicros)} · per qualified ${cpq}`,
    );
  }
  return out;
}
