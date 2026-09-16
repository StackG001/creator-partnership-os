import { z } from 'zod';
import {
  JUDGED_DIMENSIONS,
  QUALIFICATION,
  SCORE_WEIGHTS,
  type ScoreDimension,
} from '../../lib/constants.js';
import { prisma } from '../../lib/db.js';
import { completeJSON } from '../../lib/llm.js';
import { createLogger } from '../../lib/logger.js';

/**
 * Turns a discovered creator into one 0-100 number plus the reasoning behind it.
 *
 * Reach and engagement are arithmetic on the metrics the finder already
 * collected — a model asked to "score reach out of 100" would just be guessing
 * at something we can compute exactly. The other four dimensions are genuine
 * judgement calls on the evidence, so those go to the model, which must return
 * a reason for each. The weights live in constants.ts.
 */

const log = createLogger('scorer');

const judged = z.object({
  score: z.number().min(0).max(100).describe('0-100, where 100 is the strongest possible case.'),
  reason: z.string().min(1).describe('One sentence citing specific evidence from the input.'),
});

const judgementSchema = z.object({
  nicheClarity: judged.describe('How sharply defined and coherent the channel topic is.'),
  productGap: judged.describe(
    'How clearly the audience wants something the creator does not yet sell. High means an obvious gap.',
  ),
  monetisability: judged.describe(
    'Willingness and ability of this audience to pay for a digital product.',
  ),
  reachability: judged.describe(
    'How easy it looks to reach this creator directly (business email, contact links, active presence).',
  ),
  summary: z.string().min(1).describe('Two sentences on whether this is a good partner and why.'),
  suggestedNiche: z.string().optional().describe('A tighter niche label, if the stated one is vague.'),
});

export type Judgement = z.infer<typeof judgementSchema>;

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
  reasons: Record<string, string>;
  summary: string;
  model: string;
}

/**
 * Reach peaks in the middle of the qualification window rather than at the top
 * of it: a 45k-subscriber channel is a better partner than a 199k one, which is
 * closer to having an agent, a media deal and no need for us. Log-scaled,
 * because the difference between 10k and 20k is not the difference between
 * 190k and 200k. Edges of the window floor at 40, not 0 — they still qualify.
 */
export function scoreReach(followers: number | null | undefined): number {
  if (!followers) return 0;
  const { minFollowers, maxFollowers } = QUALIFICATION;
  if (followers < minFollowers || followers > maxFollowers) return 0;

  const sweet = Math.sqrt(minFollowers * maxFollowers); // geometric midpoint
  const halfSpan = Math.log(maxFollowers) - Math.log(sweet);
  const distance = Math.abs(Math.log(followers) - Math.log(sweet)) / halfSpan;
  return Math.round(100 - 60 * Math.min(distance, 1));
}

/**
 * Engagement relative to the floor: at the 2% minimum this scores 50, at twice
 * the floor it maxes out. On YouTube a sustained 4% like-and-comment rate is a
 * genuinely engaged audience, which is the whole thesis.
 */
export function scoreEngagement(rate: number | null | undefined): number {
  if (!rate || rate <= 0) return 0;
  return Math.round(Math.max(0, Math.min(100, 50 * (rate / QUALIFICATION.minEngagementRate))));
}

/** Weighted total. Weights are percentages that sum to 100. */
export function combine(breakdown: ScoreBreakdown): number {
  const total = (Object.keys(SCORE_WEIGHTS) as ScoreDimension[]).reduce(
    (sum, key) => sum + breakdown[key] * SCORE_WEIGHTS[key],
    0,
  );
  return Math.round(total / 100);
}

const SYSTEM = `You assess whether a micro-creator is a good partner for a done-for-you digital product deal.

The offer: we research, write, design and publish a premium PDF product in the creator's voice, build its sales funnel, and split the revenue. The creator does nothing but approve and promote it.

The best partner has a sharply defined audience that trusts them, visible unmet demand for a paid resource, and nothing of their own to sell yet. Judge the evidence you are given. Do not invent facts about the creator, and do not reward vague positivity — a reason that cites nothing specific is a bad reason. Scores near 50 are the honest answer when the evidence is thin.`;

export async function scoreCreator(handle: string, options: { dryRun?: boolean } = {}): Promise<ScoreResult> {
  const creator = await prisma.creator.findUnique({ where: { handle } });
  if (!creator) throw new Error(`No creator "${handle}". Run the finder first.`);

  const raw = (creator.raw ?? {}) as { videos?: Array<{ title: string; views: number; publishedAt: string }> };
  const videos = raw.videos ?? [];
  const evidence = (creator.productEvidence ?? {}) as { hasDigitalProduct?: boolean; matches?: Array<{ domain: string; url: string }> };

  const breakdown: ScoreBreakdown = {
    reach: scoreReach(creator.followers),
    engagement: scoreEngagement(creator.engagementRate),
    nicheClarity: 50,
    productGap: 50,
    monetisability: 50,
    reachability: 50,
  };

  if (options.dryRun) {
    log.info(`${handle}: computed reach=${breakdown.reach} engagement=${breakdown.engagement}; model skipped`);
    return {
      handle,
      score: combine(breakdown),
      breakdown,
      reasons: Object.fromEntries(JUDGED_DIMENSIONS.map((d) => [d, 'not judged (dry run)'])),
      summary: 'Dry run — the model was not called, so the judged dimensions are placeholders.',
      model: '(dry-run)',
    };
  }

  const prompt = [
    `Channel: ${creator.displayName ?? handle} (@${handle})`,
    creator.profileUrl ? `URL: ${creator.profileUrl}` : '',
    creator.niche ? `Stated niche: ${creator.niche}` : '',
    creator.country ? `Country: ${creator.country}` : '',
    '',
    'Metrics (from their last uploads):',
    `  subscribers: ${creator.followers?.toLocaleString() ?? 'hidden'}`,
    `  average views: ${creator.avgViews?.toLocaleString() ?? '?'}`,
    `  average likes: ${creator.avgLikes?.toLocaleString() ?? '?'}`,
    `  average comments: ${creator.avgComments?.toLocaleString() ?? '?'}`,
    `  engagement rate: ${((creator.engagementRate ?? 0) * 100).toFixed(2)}%`,
    `  uploads per week: ${creator.postsPerWeek ?? '?'}`,
    '',
    'Existing digital product:',
    evidence.hasDigitalProduct
      ? `  YES — links found to ${evidence.matches?.map((m) => m.domain).join(', ')}`
      : '  none found in the channel or video descriptions',
    '',
    `Channel description:\n${(creator.bio ?? '(empty)').slice(0, 1500)}`,
    '',
    videos.length
      ? `Recent uploads (newest first):\n${videos
          .map((v) => `  - ${v.title} (${v.views.toLocaleString()} views)`)
          .join('\n')}`
      : 'No upload sample was recorded.',
  ]
    .filter(Boolean)
    .join('\n');

  const result = await completeJSON({
    schema: judgementSchema,
    schemaName: 'score_creator',
    schemaDescription: 'Judge the four qualitative dimensions of this creator as a product partner.',
    system: SYSTEM,
    prompt,
    tier: 'default',
    label: 'scorer:judge',
  });

  for (const dimension of JUDGED_DIMENSIONS) {
    breakdown[dimension] = Math.round(result.data[dimension].score);
  }

  const score = combine(breakdown);
  const reasons = Object.fromEntries(JUDGED_DIMENSIONS.map((d) => [d, result.data[d].reason]));

  await prisma.creator.update({
    where: { handle },
    data: {
      score,
      scoreBreakdown: { ...breakdown, reasons, summary: result.data.summary } as object,
      scoredAt: new Date(),
      scoreModel: result.model,
      ...(result.data.suggestedNiche && !creator.niche ? { niche: result.data.suggestedNiche } : {}),
      // A disqualified creator keeps that status: a score does not requalify
      // someone the finder already ruled out.
      ...(creator.status === 'DISCOVERED' ? { status: 'SCORED' } : {}),
    },
  });

  log.info(`${handle}: ${score}/100`);
  return { handle, score, breakdown, reasons, summary: result.data.summary, model: result.model };
}

/** Score every creator still waiting for one, highest-reach first. */
export async function scorePending(limit: number, options: { dryRun?: boolean } = {}): Promise<ScoreResult[]> {
  const pending = await prisma.creator.findMany({
    where: { status: 'DISCOVERED' },
    orderBy: { followers: 'desc' },
    take: limit,
  });

  const out: ScoreResult[] = [];
  for (const creator of pending) {
    out.push(await scoreCreator(creator.handle, options));
  }
  return out;
}
