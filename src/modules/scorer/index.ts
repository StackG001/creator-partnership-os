import { z } from 'zod';
import type { Creator } from '@prisma/client';
import { prisma } from '../../lib/db.js';
import { completeJSON } from '../../lib/llm.js';
import { QUALIFICATION } from '../../lib/constants.js';
import { normalizeHandle } from '../../lib/paths.js';
import { createLogger } from '../../lib/logger.js';

const log = createLogger('scorer');

export interface ScoreBreakdown {
  reach: number;
  engagement: number;
  nicheClarity: number;
  productGap: number;
  monetisability: number;
  reachability: number;
}

export interface ScoreResult {
  handle: string;
  score: number;
  breakdown: ScoreBreakdown;
  rationale: string;
  disqualifiedFor?: string;
}

// --- deterministic half -------------------------------------------------------

function clamp(n: number, lo = 0, hi = 100): number {
  return Math.min(hi, Math.max(lo, n));
}

function scoreReach(followers: number | null): number {
  if (!followers || followers <= 0) return 0;
  const { minFollowers, maxFollowers } = QUALIFICATION;
  const ratio =
    (Math.log10(followers) - Math.log10(minFollowers)) /
    (Math.log10(maxFollowers) - Math.log10(minFollowers));
  return Math.round(clamp(ratio * 100));
}

/** Posting less than ~2x/week tapers the engagement score — a hot rate on a dormant account is a weaker signal. */
function cadenceFactor(postsPerWeek: number | null): number {
  if (postsPerWeek === null || postsPerWeek === undefined) return 1;
  if (postsPerWeek >= 2) return 1;
  if (postsPerWeek <= 0) return 0.85;
  return 0.85 + (postsPerWeek / 2) * 0.15;
}

function scoreEngagement(engagementRate: number | null, postsPerWeek: number | null): number {
  if (!engagementRate || engagementRate <= 0) return 0;
  const target = QUALIFICATION.minEngagementRate * 3; // 3x the qualification floor maps to 100
  const base = (engagementRate / target) * 100;
  return Math.round(clamp(base * cadenceFactor(postsPerWeek)));
}

// --- LLM half ------------------------------------------------------------------

const ScoreLlmSchema = z.object({
  nicheClarity: z.number().min(0).max(100).describe('How specific and buyable the niche/audience is — "lifestyle" scores low, a tight niche scores high.'),
  productGap: z.number().min(0).max(100).describe('How clearly this audience lacks a digital product and would want one.'),
  monetisability: z.number().min(0).max(100).describe('How much this specific audience would plausibly pay for a done-for-you product.'),
  reachability: z.number().min(0).max(100).describe('How likely a cold outreach is to get a reply — contactability, apparent openness to partnerships, not already flooded with sponsors.'),
  rationale: z.string().describe('2-4 sentences on the overall verdict.'),
  disqualifiedFor: z
    .string()
    .nullable()
    .describe('Null unless something clearly disqualifies this creator — e.g. a brand/agency account, not an individual creator, or an audience that looks inorganic.'),
});
type ScoreLlm = z.infer<typeof ScoreLlmSchema>;

async function scoreWithLlm(creator: Creator): Promise<ScoreLlm> {
  const system = [
    'You score micro-creator prospects for Creator Partnership OS — an internal tool that finds creators with engaged niche audiences and no digital product, and offers to build them one.',
    'Score each dimension 0-100 independently; do not anchor them to each other.',
    'Be skeptical: a vague bio, a generic "lifestyle" niche, or thin evidence should score low rather than being given the benefit of the doubt.',
  ].join('\n');

  const monetization = (creator.monetization as Record<string, boolean> | null) ?? {};
  const productEvidence = (creator.productEvidence as string[] | null) ?? [];

  const prompt = [
    `Platform: ${creator.platform}`,
    `Handle: @${creator.handle}`,
    `Display name: ${creator.displayName ?? '(unknown)'}`,
    `Niche: ${creator.niche ?? '(unknown)'} ${creator.subNiche ? `/ ${creator.subNiche}` : ''}`,
    `Bio: ${creator.bio ?? '(empty)'}`,
    `Language/country: ${creator.language ?? '?'} / ${creator.country ?? '?'}`,
    '',
    `Followers: ${creator.followers ?? 0}`,
    `Engagement rate: ${creator.engagementRate ? `${(creator.engagementRate * 100).toFixed(2)}%` : 'unknown'}`,
    `Posting cadence: ${creator.postsPerWeek ?? 'unknown'} posts/week`,
    '',
    `Already sells a digital product (heuristic): ${creator.hasDigitalProduct ? 'yes' : 'no'}`,
    `Product/monetization evidence found: ${productEvidence.join('; ') || '(none)'}`,
    `Monetization signals: ${Object.entries(monetization).filter(([, v]) => v).map(([k]) => k).join(', ') || '(none detected)'}`,
    '',
    `Business email on file: ${creator.businessEmail ?? creator.contactEmail ?? '(none)'}`,
    `Website / link-in-bio: ${creator.websiteUrl ?? '(none)'}`,
  ].join('\n');

  const { data } = await completeJSON({
    system,
    prompt,
    schema: ScoreLlmSchema,
    schemaName: 'creator_score',
    tier: 'default',
    label: 'scorer:llm',
    maxTokens: 1024,
  });
  return data;
}

// --- orchestration ---------------------------------------------------------------

async function scoreOne(creator: Creator): Promise<ScoreResult> {
  const reach = scoreReach(creator.followers);
  const engagement = scoreEngagement(creator.engagementRate, creator.postsPerWeek);
  const llm = await scoreWithLlm(creator);

  const breakdown: ScoreBreakdown = {
    reach,
    engagement,
    nicheClarity: Math.round(clamp(llm.nicheClarity)),
    productGap: Math.round(clamp(llm.productGap)),
    monetisability: Math.round(clamp(llm.monetisability)),
    reachability: Math.round(clamp(llm.reachability)),
  };

  const arithmeticAvg = (breakdown.reach + breakdown.engagement) / 2;
  const llmAvg =
    (breakdown.nicheClarity + breakdown.productGap + breakdown.monetisability + breakdown.reachability) / 4;
  const score = Math.round(clamp(arithmeticAvg * 0.5 + llmAvg * 0.5));

  const disqualifiedFor = creator.hasDigitalProduct
    ? 'Already sells a digital product (flagged during discovery).'
    : (llm.disqualifiedFor ?? undefined);

  const nextStatus = disqualifiedFor
    ? 'DISQUALIFIED'
    : creator.status === 'DISCOVERED'
      ? 'SCORED'
      : creator.status;

  await prisma.creator.update({
    where: { id: creator.id },
    data: {
      score,
      scoreBreakdown: JSON.parse(JSON.stringify(breakdown)),
      scoredAt: new Date(),
      scoreModel: 'arithmetic (reach/engagement) + default tier LLM (see llm trace)',
      status: nextStatus,
      ...(disqualifiedFor ? { disqualifiedFor } : {}),
    },
  });

  return {
    handle: creator.handle,
    score,
    breakdown,
    rationale: llm.rationale,
    ...(disqualifiedFor ? { disqualifiedFor } : {}),
  };
}

/**
 * Deterministic metric scoring blended with an LLM read of niche clarity and
 * product gap. Writes score, scoreBreakdown and status SCORED.
 */
export async function scoreCreator(handle: string): Promise<ScoreResult> {
  const normalized = normalizeHandle(handle);
  const creator = await prisma.creator.findUnique({ where: { handle: normalized } });
  if (!creator) {
    throw new Error(`No creator found for handle "${normalized}" — run the finder first.`);
  }
  return scoreOne(creator);
}

export interface ScoreAllOptions {
  limit: number;
  rescore?: boolean;
}

export interface ScoreAllResult {
  scored: ScoreResult[];
  skipped: number;
}

export async function scoreAllCreators(options: ScoreAllOptions): Promise<ScoreAllResult> {
  const creators = await prisma.creator.findMany({
    where: options.rescore ? { status: { in: ['DISCOVERED', 'SCORED'] } } : { status: 'DISCOVERED' },
    orderBy: { createdAt: 'asc' },
    take: options.limit,
  });

  const scored: ScoreResult[] = [];
  for (const creator of creators) {
    try {
      scored.push(await scoreOne(creator));
    } catch (error) {
      log.warn(`could not score @${creator.handle}: ${(error as Error).message}`);
    }
  }

  return { scored, skipped: creators.length - scored.length };
}
