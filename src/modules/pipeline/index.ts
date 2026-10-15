import fs from 'node:fs/promises';
import path from 'node:path';
import type { Creator } from '@prisma/client';
import { prisma } from '../../lib/db.js';
import { createLogger } from '../../lib/logger.js';
import { outputsRoot, toRelative } from '../../lib/paths.js';
import {
  APIFY,
  AUTO_SEND,
  INSTAGRAM_AUDIT,
  PIPELINE,
  QUALIFICATION,
  type OutreachChannel,
} from '../../lib/constants.js';
import {
  ApifyBudgetError,
  apifyHeadroom,
  apifySpentThisProcess,
  getApifyUsage,
  pricePerResultUsd,
  setApifySpendCeiling,
  type ApifyUsage,
} from '../../lib/sources/apify.js';
import { INSTAGRAM_ACTOR } from '../../lib/sources/instagram.js';
import { findBusinessEmail } from '../../lib/sources/emailFinder.js';
import { analyzeMonetization } from '../../lib/sources/productSignals.js';
import { fetchPage } from '../../lib/sources/linkInBio.js';
import { instagramDmHandle } from '../../lib/sources/instagramGoogle.js';
import { QuoteSourceError } from '../../lib/quotes.js';
import { findCreators } from '../finder/index.js';
import { scoreCreator } from '../scorer/index.js';
import { auditCreator } from '../audit/index.js';
import {
  autoSendEmails,
  draftOutreach,
  MANUAL_HOLD,
  listFollowUpsDue,
  SEQUENCE_DESIGN_SINCE,
} from '../outreach/index.js';
import {
  addSimilarAccountSearches,
  chargeAudit,
  ensureGoogleSources,
  ensureLegacyNiches,
  generateNiches,
  generationDue,
  libraryReport,
  pickSearches,
  recordNicheRun,
  recordSearchOutcome,
  usd,
  type NicheEvents,
  type SourceWithNiche,
} from '../niches/index.js';
import { dmQueueUrl } from '../dmqueue/index.js';

const log = createLogger('pipeline');

// The automated loop, in two daily parts (cron, see README):
//
//   09:00 --part youtube   — weekly niche generation when due, then YouTube
//                            (free API): find → score → find email → audit →
//                            draft seq 1. Then follow-ups, sends, summary.
//   10:00 --part instagram — Instagram through Apify: search terms from the
//                            niche library (~70% producers / ~30% exploring),
//                            a cheap profile-only stage 1 (finder), paid
//                            audits only for creators who pass. The run's hard
//                            ceiling is what's left of 80% of the plan ÷ the
//                            run days left; its size (audits) is that ceiling
//                            ÷ the cost of one qualified creator — the
//                            estimate until 3 runs are measured, then the
//                            measured average. Unused budget rolls into the
//                            next run's ceiling, so runs grow, not multiply.
//                            Then follow-ups, sends, summary.
//
// Each part runs once a day; a second call the same day exits (--force
// overrides). Each stage picks up whatever is waiting at it, so a run that
// died halfway is finished off by the next one.

export type PipelinePlatform = 'YOUTUBE' | 'INSTAGRAM';
export type DailyPart = 'youtube' | 'instagram';

const MICRO = 1e6;

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function cycleLabel(u: ApifyUsage): string {
  return `${u.cycleStart.toISOString().slice(0, 10)} → ${u.cycleEnd.toISOString().slice(0, 10)}`;
}

/** Instagram run days left in this Apify cycle, today included. */
export function instagramRunsLeft(cycleEnd: Date, from = new Date()): number {
  const days = PIPELINE.instagram.runDays as readonly number[];
  const d = new Date(from);
  d.setHours(12, 0, 0, 0);
  let n = 0;
  for (; d <= cycleEnd; d.setDate(d.getDate() + 1)) if (days.includes(d.getDay())) n++;
  return Math.max(1, n);
}

/** Apify results one Instagram audit pulls: profile + posts + comments on the most-commented posts. */
export const INSTAGRAM_AUDIT_RESULTS =
  1 + INSTAGRAM_AUDIT.posts + INSTAGRAM_AUDIT.commentPosts * INSTAGRAM_AUDIT.commentsPerPost;

// --- sizing ------------------------------------------------------------------------

export interface InstagramSizing {
  plan: string;
  cycle: string;
  usedUsd: number;
  stopAtUsd: number;
  leftUsd: number;
  runsLeft: number;
  runBudgetUsd: number;
  pricePerResultUsd: number;
  auditUsd: number;
  auditFormulaUsd: number;
  profilesPerQualified: number;
  costPerQualifiedUsd: number;
  audits: number;
  discoveryBudgetUsd: number;
  basis: string;
  measuredRuns: number;
}

/** How big today's Instagram run is, from live Apify numbers and (after 3 runs) measured costs. */
export async function sizeInstagramRun(): Promise<InstagramSizing> {
  const [usage, price] = await Promise.all([getApifyUsage(), pricePerResultUsd(INSTAGRAM_ACTOR)]);
  const runsLeft = instagramRunsLeft(usage.cycleEnd);
  const leftUsd = Math.max(0, usage.stopAtUsd - usage.usedUsd);
  const runBudgetUsd = leftUsd / runsLeft;

  const measured = await prisma.pipelineRun.findMany({
    where: { platform: 'INSTAGRAM', finishedAt: { not: null } },
    orderBy: { startedAt: 'desc' },
    take: 10,
  });
  const auditFormulaUsd = INSTAGRAM_AUDIT_RESULTS * price;
  // Until runs are measured, an audit costs what INSTAGRAM_AUDIT's result count says.
  let auditUsd: number = auditFormulaUsd;
  let profilesPerQualified: number = PIPELINE.instagram.estimate.profilesPerQualified;
  let basis = `INSTAGRAM_AUDIT formula ($${auditUsd.toFixed(3)} per audit = ${INSTAGRAM_AUDIT_RESULTS} results) and ${profilesPerQualified} profiles checked per qualified creator (estimate)`;
  if (measured.length >= PIPELINE.instagram.measuredRunsBeforeResize) {
    const d = (r: (typeof measured)[number]) => (r.details ?? {}) as { auditSpentMicros?: number };
    const audits = measured.reduce((n, r) => n + r.audits, 0);
    const auditSpent = measured.reduce((n, r) => n + (d(r).auditSpentMicros ?? 0), 0);
    const profiles = measured.reduce((n, r) => n + r.profilesChecked, 0);
    const added = measured.reduce((n, r) => n + r.added, 0);
    if (audits) auditUsd = auditSpent / audits / MICRO;
    if (added) profilesPerQualified = profiles / added;
    basis = `measured over the last ${measured.length} runs ($${auditUsd.toFixed(3)} per audit, ${profilesPerQualified.toFixed(1)} profiles per qualified creator)`;
  }
  const costPerQualifiedUsd = auditUsd + profilesPerQualified * price;
  const audits = Math.max(0, Math.min(PIPELINE.instagram.maxAuditsPerRun, Math.floor(runBudgetUsd / costPerQualifiedUsd)));
  return {
    plan: `$${usage.maxMonthlyUsd}/month`,
    cycle: cycleLabel(usage),
    usedUsd: usage.usedUsd,
    stopAtUsd: usage.stopAtUsd,
    leftUsd,
    runsLeft,
    runBudgetUsd,
    pricePerResultUsd: price,
    auditUsd,
    auditFormulaUsd,
    profilesPerQualified,
    costPerQualifiedUsd,
    audits,
    discoveryBudgetUsd: Math.max(0, runBudgetUsd - audits * auditUsd),
    basis,
    measuredRuns: measured.length,
  };
}

// --- one platform run ----------------------------------------------------------------------

interface SearchRun {
  prefilter?: import('../finder/index.js').PrefilterStats;
  /** Apify-confirmed profiles inside 10k–200k. */
  inRange?: number;
  niche: string;
  query: string;
  kind: string;
  explore: boolean;
  found: number;
  added: number;
  spentMicros: number;
  pausedNow?: boolean;
  error?: string;
}

interface CreatorLine {
  handle: string;
  niche: string | null;
  profileUrl: string | null;
  followers: number | null;
  score?: number;
  disqualifiedFor?: string;
  email?: string;
  audited?: boolean;
  drafts?: Array<{ id: string; channel: OutreachChannel; variant: string }>;
  heldBack?: string;
  error?: string;
}

export interface RunDetails {
  searches: SearchRun[];
  creators: CreatorLine[];
  nicheEvents: NicheEvents;
  sizing?: InstagramSizing;
  auditSpentMicros: number;
  discoverySpentMicros: number;
  stoppedFor?: string;
}

/** Free fetch of the creator's own website: evidence that it already sells a course/program/product, else null. */
export async function websiteSellsProduct(url: string | null): Promise<string | null> {
  if (!url || !/^https?:/i.test(url)) return null;
  const host = new URL(url).hostname;
  const byHost = analyzeMonetization('', [url]);
  if (byHost.hasDigitalProduct) return `website ${host} is a course/storefront platform`;
  const page = await fetchPage(url, 15_000);
  const signals = analyzeMonetization(page.text ?? '', page.links);
  return signals.hasDigitalProduct ? `website ${host}: ${signals.evidence[0] ?? 'product found'}` : null;
}

async function tryFindEmail(creator: Creator): Promise<string | null> {
  if (creator.businessEmail || creator.contactEmail) return null;
  const raw = (creator.raw ?? {}) as {
    profile?: { externalUrls?: string[] };
    channel?: { description?: string };
    videos?: Array<{ description?: string }>;
  };
  const found = await findBusinessEmail({
    bio: creator.bio,
    externalUrls: [...(raw.profile?.externalUrls ?? []), ...(creator.websiteUrl ? [creator.websiteUrl] : [])],
    youtubeTexts: [raw.channel?.description ?? '', ...(raw.videos ?? []).map((v) => v.description ?? '')],
  });
  if (!found) return null;
  await prisma.creator.update({ where: { id: creator.id }, data: { businessEmail: found.email, emailSource: found.source } });
  log.info(`@${creator.handle}: business email found in ${found.source}`);
  return found.email;
}

async function runPlatform(platform: PipelinePlatform): Promise<RunDetails & { added: number; profilesChecked: number; spentMicros: number; budgetMicros: number }> {
  const isIg = platform === 'INSTAGRAM';
  await ensureLegacyNiches();
  if (isIg) await ensureGoogleSources();
  const details: RunDetails = {
    searches: [],
    creators: [],
    nicheEvents: { promoted: [], retired: [], pausedTerms: [], explored: [] },
    auditSpentMicros: 0,
    discoverySpentMicros: 0,
  };
  const lines = new Map<string, CreatorLine>();
  const line = (c: Pick<Creator, 'handle' | 'niche' | 'profileUrl' | 'followers'>) => {
    if (!lines.has(c.handle)) lines.set(c.handle, { handle: c.handle, niche: c.niche, profileUrl: c.profileUrl, followers: c.followers });
    return lines.get(c.handle)!;
  };
  const spentStart = apifySpentThisProcess();

  // --- sizing -------------------------------------------------------------------------
  let newCap: number;
  let auditsAllowed = Infinity;
  if (isIg) {
    const sizing = await sizeInstagramRun();
    details.sizing = sizing;
    auditsAllowed = sizing.audits;
    // Discover enough to fill the audits, plus slack for creators who then miss the score bar.
    newCap = sizing.audits ? sizing.audits * 2 : 0;
    if (sizing.leftUsd <= 0) details.stoppedFor = `cycle usage has reached the $${sizing.stopAtUsd} Instagram stop`;
    else if (!sizing.audits) details.stoppedFor = `today's $${sizing.runBudgetUsd.toFixed(2)} share is less than one qualified creator (~$${sizing.costPerQualifiedUsd.toFixed(2)}) — it rolls into tomorrow`;
    // Discovery may only spend what the audits don't need.
    setApifySpendCeiling(spentStart + sizing.discoveryBudgetUsd);
    log.info(
      `Instagram run: ceiling $${sizing.runBudgetUsd.toFixed(2)} (${sizing.runsLeft} run day(s) left, $${sizing.leftUsd.toFixed(2)} left of the $${sizing.stopAtUsd} stop) → ${sizing.audits} audit(s), discovery up to $${sizing.discoveryBudgetUsd.toFixed(2)} · ${sizing.basis}`,
    );
  } else {
    const addedToday = await prisma.creator.count({
      where: { platform: 'YOUTUBE', createdAt: { gte: startOfToday() }, source: { notes: 'pipeline' } },
    });
    newCap = Math.max(0, PIPELINE.dailyNewCreatorCap - addedToday);
  }

  // --- 1. discover ----------------------------------------------------------------------
  let remaining = details.stoppedFor ? 0 : newCap;
  let profilesChecked = 0;
  if (remaining > 0) {
    const n = isIg ? 12 : PIPELINE.youtubeSearchesPerDay;
    const { exploit, explore } = await pickSearches(platform, n);
    const plan: Array<{ s: SourceWithNiche; explore: boolean }> = [];
    // Interleave so the 70/30 split holds even when the cap fills early.
    const ex = [...exploit];
    const xp = [...explore];
    while (ex.length || xp.length) {
      for (let i = 0; i < 2 && ex.length; i++) plan.push({ s: ex.shift()!, explore: false });
      if (xp.length) plan.push({ s: xp.shift()!, explore: true });
    }
    const outcomes: Array<{ nicheId: string | null; added: number; spentMicros: number; wasExplore: boolean }> = [];
    for (const { s, explore: isExplore } of plan) {
      if (remaining <= 0) break;
      const before = apifySpentThisProcess();
      const run: SearchRun = { niche: s.nicheRef?.name ?? s.niche ?? '', query: s.query, kind: s.kind, explore: isExplore, found: 0, added: 0, spentMicros: 0 };
      log.info(`${isExplore ? 'exploring' : 'searching'} ${platform.toLowerCase()} ${s.kind} "${s.query}" (${run.niche}) — ${remaining} slot(s) left`);
      try {
        const result = await findCreators({
          platform,
          sourceId: s.id,
          limit: remaining,
          newOnly: true,
          minFollowers: QUALIFICATION.minFollowers,
          maxFollowers: QUALIFICATION.maxFollowers,
          minEngagement: QUALIFICATION.minEngagementRate,
        });
        for (const c of result.created) line(c);
        remaining -= result.created.length;
        profilesChecked += result.found;
        run.found = result.found;
        run.added = result.created.length;
        if (result.prefilter) run.prefilter = result.prefilter;
        run.inRange = result.found - result.skipped.filter((x) => /^followers \d+ (below|above)/.test(x.reason)).length;
      } catch (error) {
        run.error = (error as Error).message;
        log.warn(`search "${s.query}" failed: ${run.error}`);
        if (error instanceof ApifyBudgetError) {
          details.stoppedFor = `discovery budget used: ${run.error}`;
        }
      }
      run.spentMicros = Math.round((apifySpentThisProcess() - before) * MICRO);
      details.discoverySpentMicros += run.spentMicros;
      if (!run.error || run.found) run.pausedNow = await recordSearchOutcome(s, run.added, run.spentMicros, run.found);
      if (run.pausedNow) details.nicheEvents.pausedTerms.push(`${s.kind === 'HASHTAG' ? '#' : ''}${s.query} (${platform === 'INSTAGRAM' ? 'IG' : 'YT'})`);
      outcomes.push({ nicheId: s.nicheId, added: run.added, spentMicros: run.spentMicros, wasExplore: isExplore });
      details.searches.push(run);
      if (details.stoppedFor) break;
    }
    const ev = await recordNicheRun(outcomes);
    details.nicheEvents.promoted.push(...ev.promoted);
    details.nicheEvents.retired.push(...ev.retired);
    details.nicheEvents.explored.push(...ev.explored);
  }

  // Audits may now use the whole run ceiling.
  if (isIg && details.sizing) setApifySpendCeiling(spentStart + details.sizing.runBudgetUsd);

  // --- 2. score everything of ours still waiting at DISCOVERED ---------------
  const ours = { platform, source: { notes: 'pipeline' } };
  for (const creator of await prisma.creator.findMany({ where: { ...ours, status: 'DISCOVERED' } })) {
    const l = line(creator);
    try {
      log.info(`scoring @${creator.handle}`);
      const scored = await scoreCreator(creator.handle);
      l.score = scored.score;
      if (scored.disqualifiedFor) l.disqualifiedFor = scored.disqualifiedFor;
    } catch (error) {
      l.error = `scoring failed: ${(error as Error).message}`;
    }
  }

  // --- 3. passed scoring: find a business email (free), then audit ------------
  const scored = await prisma.creator.findMany({ where: { ...ours, status: 'SCORED' }, orderBy: { score: 'desc' } });
  let auditsDone = 0;
  for (const creator of scored) {
    if ((creator.score ?? 0) < QUALIFICATION.minScore) {
      const l = lines.get(creator.handle);
      if (l) l.heldBack = `score ${creator.score ?? '—'} below the ${QUALIFICATION.minScore} bar — not audited`;
      continue;
    }
    const l = line(creator);
    l.score ??= creator.score ?? undefined;
    const email = await tryFindEmail(creator).catch(() => null);
    if (email) l.email = email;
    if (isIg) {
      const { headroomUsd } = await apifyHeadroom(); // real usage, re-checked before every paid call
      const auditUsd = details.sizing!.auditUsd;
      const why =
        auditsDone >= auditsAllowed
          ? `today's ${auditsAllowed} audit(s) done`
          : headroomUsd < auditUsd
            ? `audit needs ~$${auditUsd.toFixed(2)}, $${Math.max(0, headroomUsd).toFixed(2)} left in today's ceiling`
            : null;
      if (why) {
        l.heldBack = `audit waits for the next Instagram run — ${why}`;
        continue;
      }
    }
    const before = apifySpentThisProcess();
    try {
      log.info(`auditing @${creator.handle} (score ${creator.score})`);
      await auditCreator(creator.handle);
      l.audited = true;
      auditsDone++;
    } catch (error) {
      l.error = `audit failed: ${(error as Error).message}`;
      if (error instanceof ApifyBudgetError) details.stoppedFor = (error as Error).message;
    }
    const cost = Math.round((apifySpentThisProcess() - before) * MICRO);
    details.auditSpentMicros += cost;
    await chargeAudit(creator.sourceId, cost);
  }

  // --- 4. draft seq 1 for audited creators with no live messages yet — email when we have one ---
  // (Cancelled/superseded messages never went out — a rediscovered creator still gets a first touch.)
  const live = { status: { notIn: ['CANCELLED', 'SUPERSEDED'] } };
  for (const creator of await prisma.creator.findMany({ where: { ...ours, status: 'AUDITED', messages: { none: live } } })) {
    const l = line(creator);
    l.audited = true;
    // The audit may have found their own website — if it already sells something, they're out.
    const sells = await websiteSellsProduct(creator.websiteUrl).catch(() => null);
    if (sells) {
      await prisma.creator.update({
        where: { id: creator.id },
        data: { status: 'DISQUALIFIED', disqualifiedFor: 'already sells a course/program (website)', hasDigitalProduct: true, productEvidence: [sells] },
      });
      l.disqualifiedFor = `already sells a course/program — ${sells}`;
      continue;
    }
    if (!creator.businessEmail && !creator.contactEmail) await tryFindEmail(creator).catch(() => null);
    const fresh = (await prisma.creator.findUnique({ where: { id: creator.id } }))!;
    // Email first; otherwise an Instagram DM (a YouTube creator's linked Instagram).
    // YouTube has no channel messaging any more, so YT_ABOUT is never drafted.
    const channel: OutreachChannel | null =
      fresh.businessEmail || fresh.contactEmail ? 'EMAIL' : instagramDmHandle(fresh) ? 'IG_DM' : null;
    if (!channel) {
      l.heldBack = 'no email and no Instagram found — no way to contact, not drafted';
      continue;
    }
    try {
      await draftOutreach(creator.handle, channel, 1, PIPELINE.outreachVariants);
      const saved = await prisma.outreachMessage.findMany({ where: { creatorId: creator.id, sequence: 1, status: 'DRAFT' }, orderBy: { variant: 'asc' } });
      l.drafts = saved.map((m) => ({ id: m.id, channel: m.channel as OutreachChannel, variant: m.variant ?? '' }));
    } catch (error) {
      l.error = `drafting failed: ${(error as Error).message}`;
    }
  }

  setApifySpendCeiling(null);
  details.creators = [...lines.values()];
  const added = details.searches.reduce((n, s) => n + s.added, 0);
  return {
    ...details,
    added,
    profilesChecked,
    spentMicros: Math.round((apifySpentThisProcess() - spentStart) * MICRO),
    budgetMicros: Math.round((details.sizing?.runBudgetUsd ?? 0) * MICRO),
  };
}

// --- follow-ups, DMs, stale drafts ---------------------------------------------------------

/** Pending drafts for a sequence number that has already been sent can never go out — SUPERSEDED. */
async function retireStaleDrafts(dryRun: boolean): Promise<string[]> {
  const pending = await prisma.outreachMessage.findMany({ where: { status: { in: ['DRAFT', 'APPROVED'] } }, include: { creator: { select: { handle: true } } } });
  const sent = new Set(
    (await prisma.outreachMessage.findMany({ where: { sentAt: { not: null } }, select: { creatorId: true, sequence: true } })).map((m) => `${m.creatorId}:${m.sequence}`),
  );
  const stale = pending.filter((m) => sent.has(`${m.creatorId}:${m.sequence}`));
  if (!dryRun && stale.length) {
    await prisma.outreachMessage.updateMany({ where: { id: { in: stale.map((m) => m.id) } }, data: { status: 'SUPERSEDED' } });
  }
  return [...new Set(stale.map((m) => `@${m.creator.handle} seq ${m.sequence}`))];
}

interface FollowUpDrafted {
  handle: string;
  sequence: number;
  channel: OutreachChannel;
  switchedToEmail?: boolean;
  ids?: string[];
  replacedOld?: number;
  held?: string;
}

/** Draft seq 2/3 for everyone due — by email whenever we have one — replacing old-design drafts. */
async function draftDueFollowUps(dryRun: boolean): Promise<FollowUpDrafted[]> {
  const out: FollowUpDrafted[] = [];
  for (const f of (await listFollowUpsDue()).filter((x) => x.dueNow)) {
    const creator = await prisma.creator.findUnique({ where: { handle: f.handle } });
    if (!creator) continue;
    const pending = await prisma.outreachMessage.findMany({
      where: { creatorId: creator.id, sequence: f.nextSequence, status: { in: ['DRAFT', 'APPROVED'] } },
    });
    if (pending.some((m) => m.createdAt >= SEQUENCE_DESIGN_SINCE)) continue;
    const old = pending.filter((m) => m.createdAt < SEQUENCE_DESIGN_SINCE);
    let email = creator.businessEmail ?? creator.contactEmail;
    if (!email && f.channel !== 'EMAIL' && !dryRun) email = await tryFindEmail(creator).catch(() => null);
    const channel: OutreachChannel = email ? 'EMAIL' : f.channel === 'YT_ABOUT' && instagramDmHandle(creator) ? 'IG_DM' : f.channel;
    const entry: FollowUpDrafted = { handle: f.handle, sequence: f.nextSequence, channel, replacedOld: old.length, switchedToEmail: channel !== f.channel };
    if (dryRun) {
      out.push(entry);
      continue;
    }
    try {
      if (old.length) await prisma.outreachMessage.updateMany({ where: { id: { in: old.map((m) => m.id) } }, data: { status: 'SUPERSEDED' } });
      await draftOutreach(f.handle, channel, f.nextSequence, PIPELINE.outreachVariants);
      const saved = await prisma.outreachMessage.findMany({
        where: { creatorId: creator.id, sequence: f.nextSequence, status: 'DRAFT', createdAt: { gte: SEQUENCE_DESIGN_SINCE } },
      });
      entry.ids = saved.map((m) => m.id);
    } catch (error) {
      entry.held = error instanceof QuoteSourceError ? `quote problem — ${(error as Error).message}` : `drafting failed: ${(error as Error).message}`;
    }
    out.push(entry);
  }
  return out;
}

// --- the daily parts ------------------------------------------------------------------------

interface PipelineState {
  [key: string]: string | undefined;
}

function statePath(): string {
  return path.join(outputsRoot(), '_pipeline', 'state.json');
}

async function readState(): Promise<PipelineState> {
  try {
    return JSON.parse(await fs.readFile(statePath(), 'utf8')) as PipelineState;
  } catch {
    return {};
  }
}

async function writeState(state: PipelineState): Promise<void> {
  await fs.mkdir(path.dirname(statePath()), { recursive: true });
  await fs.writeFile(statePath(), JSON.stringify(state, null, 2), 'utf8');
}

export interface DailyPartResult {
  part: DailyPart;
  runId: string;
  summaryPath: string;
}

export async function runDailyPart(
  part: DailyPart,
  options: { force?: boolean; noSend?: boolean } = {},
): Promise<DailyPartResult | { skipped: string }> {
  const state = await readState();
  const day = today();
  const key = `last_${part}`;
  if (state[key] === day && !options.force) return { skipped: `${part} already ran today (${day}) — pass --force to run again` };
  if (part === 'instagram' && !(PIPELINE.instagram.runDays as readonly number[]).includes(new Date().getDay())) {
    return { skipped: 'today is not an Instagram run day' };
  }

  // Weekly: grow the niche library (the 09:00 part does it, so Instagram at 10:00 gets the new terms too).
  let generated: string[] = [];
  if (part === 'youtube' && (await generationDue())) {
    try {
      const g = await generateNiches();
      generated = g.created.map((n) => n.name);
    } catch (error) {
      log.warn(`niche generation failed: ${(error as Error).message}`);
    }
  } else if (part === 'instagram') {
    await addSimilarAccountSearches();
  }

  const platform: PipelinePlatform = part === 'youtube' ? 'YOUTUBE' : 'INSTAGRAM';
  const run = await prisma.pipelineRun.create({ data: { platform, day } });
  const r = await runPlatform(platform);

  const retired = await retireStaleDrafts(false);
  const followUps = await draftDueFollowUps(false);
  const dir = path.join(outputsRoot(), '_pipeline');
  await fs.mkdir(dir, { recursive: true });
  // --no-send: nothing goes out, and every pending draft gets a MANUAL HOLD that only approval lifts.
  if (options.noSend) {
    await prisma.outreachMessage.updateMany({
      where: { status: 'DRAFT', OR: [{ heldFor: null }, { NOT: { heldFor: { startsWith: MANUAL_HOLD } } }] },
      data: { heldFor: `${MANUAL_HOLD}: first live run (${day}) — waiting for Gerald to approve (npm run outreach -- --approve <id>)` },
    });
  }
  const send =
    AUTO_SEND.enabled && !options.noSend
      ? await autoSendEmails({ max: AUTO_SEND.maxEmailsPerDay, logPath: path.join(dir, 'sends.jsonl') })
      : null;

  await prisma.pipelineRun.update({
    where: { id: run.id },
    data: {
      finishedAt: new Date(),
      budgetMicros: r.budgetMicros,
      spentMicros: r.spentMicros,
      profilesChecked: r.profilesChecked,
      added: r.added,
      audits: r.creators.filter((c) => c.audited).length,
      details: JSON.parse(
        JSON.stringify({
          searches: r.searches,
          creators: r.creators,
          nicheEvents: { ...r.nicheEvents, generated },
          sizing: r.sizing,
          auditSpentMicros: r.auditSpentMicros,
          discoverySpentMicros: r.discoverySpentMicros,
          stoppedFor: r.stoppedFor,
          retiredDrafts: retired,
          followUps,
          send,
        }),
      ),
    },
  });

  state[key] = day;
  await writeState(state);
  const summary = await renderDailySummary(day);
  const summaryPath = path.join(dir, `${day}-daily.md`);
  await fs.writeFile(summaryPath, summary, 'utf8');
  await fs.writeFile(path.join(dir, 'latest.md'), summary, 'utf8');
  return { part, runId: run.id, summaryPath: toRelative(summaryPath) };
}

// --- the daily summary (built from the database, so both parts show) ---------------------------

interface StoredDetails extends RunDetails {
  nicheEvents: NicheEvents & { generated?: string[] };
  retiredDrafts?: string[];
  followUps?: FollowUpDrafted[];
  send?: { sent: Array<{ handle: string; sequence: number; to: string; resendId: string }>; held: Array<{ handle: string; id: string; sequence: number; reasons: string[] }> } | null;
}

export async function renderDailySummary(day: string): Promise<string> {
  const runs = await prisma.pipelineRun.findMany({ where: { day }, orderBy: { startedAt: 'asc' } });
  const d = (r: (typeof runs)[number]) => (r.details ?? {}) as unknown as StoredDetails;
  const out: string[] = [`# Daily pipeline — ${day}`, ''];

  // New creators by niche
  const start = new Date(`${day}T00:00:00`);
  const newCreators = await prisma.creator.findMany({
    where: { createdAt: { gte: start }, source: { notes: 'pipeline' } },
    include: { source: { include: { nicheRef: true } } },
  });
  const byNiche = new Map<string, string[]>();
  for (const c of newCreators) {
    const k = c.source?.nicheRef?.name ?? c.niche ?? '—';
    byNiche.set(k, [...(byNiche.get(k) ?? []), `@${c.handle} (${c.platform === 'INSTAGRAM' ? 'IG' : 'YT'}, ${c.followers?.toLocaleString('en-US') ?? '—'})`]);
  }

  // Apify
  const usage = await getApifyUsage().catch(() => null);
  const spentToday = runs.reduce((n, r) => n + r.spentMicros, 0);
  const addedToday = runs.filter((r) => r.platform === 'INSTAGRAM').reduce((n, r) => n + r.added, 0);
  const cycleRuns = usage
    ? await prisma.pipelineRun.findMany({ where: { platform: 'INSTAGRAM', startedAt: { gte: usage.cycleStart }, finishedAt: { not: null } } })
    : [];
  const cycleSpent = cycleRuns.reduce((n, r) => n + r.spentMicros, 0);
  const cycleAdded = cycleRuns.reduce((n, r) => n + r.added, 0);

  const sentToday = await prisma.outreachMessage.findMany({
    where: { channel: 'EMAIL', sentAt: { gte: start } },
    include: { creator: { select: { handle: true } } },
  });
  const held = await prisma.outreachMessage.findMany({
    where: { status: 'DRAFT', heldFor: { not: null } },
    include: { creator: { select: { handle: true } } },
    orderBy: { createdAt: 'asc' },
  });
  const dms = await prisma.outreachMessage.findMany({
    where: { channel: { not: 'EMAIL' }, status: { in: ['DRAFT', 'APPROVED'] } },
    include: { creator: { select: { handle: true } } },
  });
  const dmCreators = new Set(dms.map((m) => `${m.creatorId}:${m.sequence}`));
  const approvedDms = new Set(dms.filter((m) => m.status === 'APPROVED').map((m) => `${m.creatorId}:${m.sequence}`));
  const replies = await prisma.outreachMessage.findMany({
    where: { repliedAt: { gte: new Date(start.getTime() - 86_400_000) } },
    include: { creator: { select: { handle: true, displayName: true, status: true } } },
  });
  const events = runs.reduce(
    (acc, r) => {
      const e = d(r).nicheEvents ?? {};
      for (const k of ['promoted', 'retired', 'pausedTerms', 'explored', 'generated'] as const) acc[k].push(...((e as unknown as Record<string, string[]>)[k] ?? []));
      return acc;
    },
    { promoted: [] as string[], retired: [] as string[], pausedTerms: [] as string[], explored: [] as string[], generated: [] as string[] },
  );

  out.push(`- **New creators found:** ${newCreators.length}${byNiche.size ? ` across ${byNiche.size} niche(s)` : ''}`);
  if (usage) {
    out.push(
      `- **Apify:** ${usd(spentToday)} today · $${usage.usedUsd.toFixed(2)} this cycle (${cycleLabel(usage)}; stop at $${usage.stopAtUsd} = 80% of the $${usage.maxMonthlyUsd} plan)`,
    );
  }
  out.push(
    `- **Cost per qualified creator:** today ${addedToday ? usd(Math.round(spentToday / addedToday)) : '—'} · this cycle ${cycleAdded ? usd(Math.round(cycleSpent / cycleAdded)) : '—'} (${cycleAdded} qualified on Instagram)`,
  );
  out.push(`- **Emails sent:** ${sentToday.length}/${AUTO_SEND.maxEmailsPerDay}${AUTO_SEND.enabled ? '' : ' — auto-send is OFF'}`);
  out.push(`- **Held for you:** ${held.length} · **DMs waiting:** ${dmCreators.size} (${approvedDms.size} approved) — [DM queue](${await dmQueueUrl()}) · **Replies:** ${replies.length}`);
  out.push('');

  out.push('## New creators by niche');
  if (!byNiche.size) out.push('- none today');
  for (const [n, list] of byNiche) out.push(`- **${n}:** ${list.join(', ')}`);
  out.push('');

  out.push('## Niches');
  out.push(`- **Promoted:** ${events.promoted.join(', ') || 'none'}`);
  out.push(`- **Paused terms:** ${events.pausedTerms.join(', ') || 'none'}`);
  out.push(`- **Retired:** ${events.retired.join(', ') || 'none'}`);
  out.push(`- **New niches tried today:** ${events.explored.join(', ') || 'none'}`);
  if (events.generated.length) out.push(`- **Added to the library this week:** ${events.generated.join(', ')}`);
  out.push('');

  for (const r of runs) {
    const det = d(r);
    out.push(`## ${r.platform === 'INSTAGRAM' ? 'Instagram (10:00)' : 'YouTube (09:00)'} run`);
    if (det.sizing) {
      const s = det.sizing;
      out.push(
        `Ceiling $${s.runBudgetUsd.toFixed(2)} → ${s.audits} audit(s) · spent ${usd(r.spentMicros)} (discovery ${usd(det.discoverySpentMicros)}, audits ${usd(det.auditSpentMicros)}) · sized on ${s.basis}`,
      );
    }
    if (det.stoppedFor) out.push(`**Stopped:** ${det.stoppedFor}`);
    for (const s of det.searches ?? []) {
      const pf = s.prefilter
        ? ` · Google: ${s.prefilter.serperSearches} search(es), ${s.prefilter.profilesFound} profiles, ${s.prefilter.snippetKept} kept by snippet (${s.prefilter.droppedOutOfRange} out of range, ${s.prefilter.droppedNoCount} no count, ${s.prefilter.alreadyKnown} already seen) → ${s.prefilter.sentToApify} to Apify, ${s.inRange ?? 0} confirmed 10k–200k`
        : '';
      out.push(
        `- ${s.explore ? '🧭 explore' : '⛏ exploit'} · ${s.niche} · ${s.kind} "${s.query}" — ${s.error ? `FAILED: ${s.error}` : `${s.found} checked, ${s.added} kept`}${pf} · ${usd(s.spentMicros)}${s.pausedNow ? ' · **PAUSED**' : ''}`,
      );
    }
    for (const c of det.creators ?? []) {
      const bits = [
        c.score !== undefined ? `score ${c.score}` : null,
        c.disqualifiedFor ? `disqualified: ${c.disqualifiedFor}` : null,
        c.heldBack ?? null,
        c.email ? `email found: ${c.email}` : null,
        c.audited ? 'audited' : null,
        c.drafts?.length ? `drafted ${c.drafts[0]!.channel} seq 1` : null,
        c.error ? `ERROR ${c.error}` : null,
      ].filter(Boolean);
      out.push(`  - @${c.handle} — ${bits.join(' · ')}`);
    }
    out.push('');
  }

  out.push('## Emails sent');
  if (!sentToday.length) out.push('- none');
  for (const m of sentToday) out.push(`- @${m.creator.handle} · seq ${m.sequence} → ${m.to} · Resend \`${m.externalId}\``);
  out.push('');
  out.push('## Held for you (not sent)');
  if (!held.length) out.push('- none');
  for (const m of held) out.push(`- @${m.creator.handle} · seq ${m.sequence} \`${m.id}\` — ${m.heldFor}`);
  out.push('');
  out.push(`## DMs waiting — send from the [DM queue](${await dmQueueUrl()})`);
  if (!dms.length) out.push('- none');
  const seen = new Set<string>();
  for (const m of dms) {
    const k = `${m.creatorId}:${m.sequence}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(`- @${m.creator.handle} · ${m.channel} seq ${m.sequence} · ${approvedDms.has(k) ? 'approved, ready to send' : 'draft — approve a variant in the queue'}`);
  }
  out.push('');
  out.push('## Replies received');
  if (!replies.length) out.push('- none logged (`npm run outreach -- --replied <handle> --status …`)');
  for (const m of replies) out.push(`- @${m.creator.handle} (${m.creator.displayName ?? ''}) · seq ${m.sequence} · ${m.creator.status}`);
  out.push('');

  const follow = runs.flatMap((r) => d(r).followUps ?? []);
  if (follow.length) {
    out.push('## Follow-ups drafted');
    for (const f of follow) out.push(`- @${f.handle} · seq ${f.sequence} ${f.channel}${f.switchedToEmail ? ' (switched to email)' : ''} — ${f.held ? `HELD: ${f.held}` : 'drafted'}`);
    out.push('');
  }

  out.push(...(await measuredVsEstimate()));
  out.push('');
  out.push(...renderLeadsTable(await qualifiedLeads()));
  return out.join('\n');
}

// --- qualified leads (permanent: ends every run report) ------------------------------------

export interface QualifiedLead {
  handle: string;
  platform: string;
  link: string;
  niche: string;
  score: number | null;
  contact: string;
  status: string;
}

/**
 * Every qualified creator still in play: cleared the score bar, audited or further,
 * not retired / do-not-contact. Status from their newest live message.
 */
export async function qualifiedLeads(): Promise<QualifiedLead[]> {
  const creators = await prisma.creator.findMany({
    where: {
      score: { gte: QUALIFICATION.minScore },
      status: { in: ['AUDITED', 'CONTACTED', 'REPLIED', 'AGREED', 'LAUNCHED'] },
      doNotContact: false,
    },
    include: {
      source: { include: { nicheRef: true } },
      messages: { where: { status: { notIn: ['CANCELLED', 'SUPERSEDED'] } }, orderBy: [{ sequence: 'desc' }, { createdAt: 'desc' }] },
    },
    orderBy: { updatedAt: 'desc' },
  });
  return creators.map((c) => {
    const email = c.businessEmail ?? c.contactEmail;
    const top = c.messages[0];
    let status = 'audited — not drafted yet';
    if (top) {
      const n = `msg ${top.sequence}`;
      if (top.status === 'REPLIED' || top.repliedAt) status = `replied (${n}) — waiting for me`;
      else if (top.status === 'SENT') status = `sent (${n}, ${top.sentAt?.toISOString().slice(0, 10)})`;
      else if (top.status === 'APPROVED') status = top.channel === 'EMAIL' ? `approved (${n}) — sends next run` : `waiting for me — ${n} DM ready in the queue`;
      else if (top.heldFor?.startsWith(MANUAL_HOLD)) status = `waiting for me — pick/approve ${n}`;
      else if (top.heldFor) status = `held (${n}): ${top.heldFor.slice(0, 80)}`;
      else status = `drafted (${n}) — auto-send checks next run`;
    }
    const link =
      c.platform === 'INSTAGRAM'
        ? `instagram.com/${c.handle}`
        : (c.profileUrl ?? `youtube.com/@${c.handle}`).replace(/^https?:\/\/(www\.)?/, '');
    return {
      handle: c.handle,
      platform: c.platform === 'INSTAGRAM' ? 'Instagram' : 'YouTube',
      link,
      niche: c.source?.nicheRef?.name ?? c.niche?.slice(0, 60) ?? '—',
      score: c.score,
      contact: email
        ? `email (${email})`
        : instagramDmHandle(c)
          ? `DM (Instagram @${instagramDmHandle(c)})`
          : 'none found — no email or Instagram',
      status,
    };
  });
}

export function renderLeadsTable(leads: QualifiedLead[]): string[] {
  const out = ['## Qualified leads'];
  if (!leads.length) return [...out, 'No qualified leads this run.'];
  out.push('| @handle | Platform | Profile | Niche | Score | Contact | Status |', '|---|---|---|---|---|---|---|');
  for (const l of leads) {
    out.push(`| @${l.handle} | ${l.platform} | ${l.link} | ${l.niche} | ${l.score ?? '—'} | ${l.contact} | ${l.status} |`);
  }
  return out;
}

/** After 3 live Instagram runs: real cost per run vs the estimate, and per qualified creator. */
async function measuredVsEstimate(): Promise<string[]> {
  const runs = await prisma.pipelineRun.findMany({ where: { platform: 'INSTAGRAM', finishedAt: { not: null } }, orderBy: { startedAt: 'asc' } });
  if (runs.length < PIPELINE.instagram.measuredRunsBeforeResize) {
    return [`_Instagram cost check: ${runs.length}/${PIPELINE.instagram.measuredRunsBeforeResize} live runs so far — the measured-vs-estimate report appears after the third._`];
  }
  const first = runs.slice(0, 3);
  const det = (r: (typeof runs)[number]) => (r.details ?? {}) as { auditSpentMicros?: number };
  const audits = first.reduce((n, r) => n + r.audits, 0);
  const auditSpent = first.reduce((n, r) => n + (det(r).auditSpentMicros ?? 0), 0);
  const spent = first.reduce((n, r) => n + r.spentMicros, 0);
  const added = first.reduce((n, r) => n + r.added, 0);
  const est = PIPELINE.instagram.estimate.auditUsd;
  const real = audits ? auditSpent / audits / MICRO : 0;
  const off = audits ? Math.abs(real - est) / est : 0;
  return [
    '## Instagram cost: first 3 live runs vs estimate',
    ...first.map((r, i) => `- Run ${i + 1} (${r.day}): ${usd(r.spentMicros)} · ${r.audits} audit(s) · ${r.added} qualified`),
    `- Per audit: **$${real.toFixed(3)} real** vs $${est} estimate (${audits ? `${off > 0.2 ? '**off by' : 'within'} ${(off * 100).toFixed(0)}%${off > 0.2 ? '**' : ''}` : 'no audits yet'})`,
    `- Per run: ${usd(Math.round(spent / 3))} average · per qualified creator: ${added ? usd(Math.round(spent / added)) : '—'}`,
    `- Run size now uses these measured numbers (see each run's "sized on" line).`,
  ];
}

// --- dry run ---------------------------------------------------------------------------------

/** Everything the schedule would do, with no Apify actor, no LLM call and no send. */
export async function dryRunDaily(): Promise<string> {
  await ensureLegacyNiches();
  const s = await sizeInstagramRun();
  const out: string[] = [`# Daily pipeline — DRY RUN ${today()} (nothing scraped, drafted or sent)`, ''];

  out.push('## Apify plan (read live from /v2/users/me/limits)');
  out.push(`- Plan **${s.plan}** · cycle **${s.cycle}** · used **$${s.usedUsd.toFixed(4)}** · Instagram stops at **$${s.stopAtUsd}** (80%) · $${s.leftUsd.toFixed(2)} left`);
  out.push(`- $${s.pricePerResultUsd}/result · ${s.runsLeft} Instagram run days left (daily at 10:00) · per-run hard ceiling **$${s.runBudgetUsd.toFixed(2)}**`);
  out.push('');
  out.push('## Run size and projected spend');
  out.push(`- One qualified creator ≈ $${s.costPerQualifiedUsd.toFixed(2)}: audit $${s.auditUsd.toFixed(2)} (${s.basis}; the INSTAGRAM_AUDIT formula says $${s.auditFormulaUsd.toFixed(2)}) + ${s.profilesPerQualified} stage-1 profiles × $${s.pricePerResultUsd}`);
  out.push(`- **Per run: ${s.audits} paid audit(s)** (discovery up to $${s.discoveryBudgetUsd.toFixed(2)}, up to ${s.audits * 2} new creators) ≈ **$${(s.audits * s.costPerQualifiedUsd).toFixed(2)}**`);
  const perRun = s.audits * s.costPerQualifiedUsd;
  out.push(`- **Projected this cycle:** ≈ $${Math.min(s.leftUsd, perRun * s.runsLeft).toFixed(2)} over ${s.runsLeft} runs (≈ ${s.audits * s.runsLeft} audited creators), never past $${s.stopAtUsd}. Unspent share rolls into the next day's ceiling, so a quiet day makes the next run bigger.`);
  out.push(`- YouTube: free API, up to ${PIPELINE.dailyNewCreatorCap} new creators/day from up to ${PIPELINE.youtubeSearchesPerDay} searches.`);
  out.push('');

  // First week's plan: simulate rotation day by day.
  out.push('## First week — searches the schedule would run');
  for (const platform of ['YOUTUBE', 'INSTAGRAM'] as const) {
    const used = new Set<string>();
    out.push(`### ${platform === 'YOUTUBE' ? 'YouTube 09:00' : 'Instagram 10:00'}`);
    for (let i = 0; i < 7; i++) {
      const asOf = new Date(Date.now() + i * 86_400_000);
      const n = platform === 'YOUTUBE' ? PIPELINE.youtubeSearchesPerDay : Math.max(3, s.audits * 2);
      const { exploit, explore } = await pickSearches(platform, n, { asOf, exclude: used });
      for (const x of [...exploit, ...explore]) used.add(x.id);
      const fmt = (x: SourceWithNiche) => `${x.kind === 'HASHTAG' ? '#' : x.kind === 'SIMILAR_TO' ? 'like @' : ''}${x.query} [${x.nicheRef?.name ?? x.niche}]`;
      out.push(`- ${asOf.toDateString().slice(0, 10)} — ⛏ ${exploit.map(fmt).join(', ') || '—'} · 🧭 ${explore.map(fmt).join(', ') || '—'}`);
    }
  }
  out.push('_(Searches stop early each day once the day\'s creator cap fills, so later terms in a day may roll forward.)_');
  out.push('');

  out.push('## Outreach today');
  const retired = await retireStaleDrafts(true);
  if (retired.length) out.push(`- Would retire stale drafts (already sent): ${retired.join(', ')}`);
  const fu = await draftDueFollowUps(true);
  out.push(`- Follow-ups due: ${fu.length}`);
  for (const f of fu) out.push(`  - @${f.handle} · seq ${f.sequence} ${f.channel}${f.replacedOld ? ` (replaces ${f.replacedOld} old-design draft(s))` : ''}`);
  const send = await autoSendEmails({ max: AUTO_SEND.maxEmailsPerDay, dryRun: true });
  out.push(`- Auto-send ${AUTO_SEND.enabled ? 'ON' : 'OFF'}: against today's existing drafts it would send ${send.sent.length}, hold ${send.held.length} (old-design and stale drafts are always held)`);
  out.push('');

  // More email, fewer DMs: what the free email finder turns up for creators we'd otherwise DM.
  out.push('## Email finder (free page fetches, nothing saved in the dry run)');
  const dmOnly = await prisma.creator.findMany({
    where: { businessEmail: null, contactEmail: null, score: { gte: QUALIFICATION.minScore }, status: { in: ['SCORED', 'AUDITED', 'CONTACTED'] } },
    take: 25,
  });
  let found = 0;
  for (const c of dmOnly) {
    const raw = (c.raw ?? {}) as { profile?: { externalUrls?: string[] }; channel?: { description?: string }; videos?: Array<{ description?: string }> };
    const f = await findBusinessEmail({
      bio: c.bio,
      externalUrls: [...(raw.profile?.externalUrls ?? []), ...(c.websiteUrl ? [c.websiteUrl] : [])],
      youtubeTexts: [raw.channel?.description ?? '', ...(raw.videos ?? []).map((v) => v.description ?? '')],
    }).catch(() => null);
    if (f) {
      found++;
      out.push(`- @${c.handle}: **${f.email}** (found in ${f.source})`);
    }
  }
  out.push(`- ${found} of ${dmOnly.length} scored creators without an email would get one${found ? ' — the live run saves it and switches their next message to email' : ''}.`);
  out.push('');
  out.push(`DM queue: ${await dmQueueUrl()}`);
  out.push('');
  out.push(...(await libraryReport()));
  out.push('');
  out.push(...renderLeadsTable(await qualifiedLeads()));
  return out.join('\n');
}

export function renderPlanShort(s: InstagramSizing): string {
  return `ceiling $${s.runBudgetUsd.toFixed(2)} · ${s.audits} audit(s) · ~$${s.costPerQualifiedUsd.toFixed(2)}/qualified · ${s.basis}`;
}

export { APIFY };
