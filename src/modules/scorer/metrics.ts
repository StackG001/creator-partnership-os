import {
  ENGAGEMENT_FLOORS,
  ENGAGEMENT_PER_VIEW_FLOOR,
  SCORE_WEIGHTS,
  VERDICT_THRESHOLDS,
  type ScoreVerdict,
} from '../../lib/constants.js';

/**
 * The deterministic half of the score. Everything here is a pure function of
 * stored metrics, so the same creator always scores the same and the maths can
 * be tested without a model.
 *
 * Each component returns 0-1. index.ts multiplies by the weight.
 */

// Fail fast if the weights stop summing to 100 — a score that silently tops
// out at 95 would quietly corrupt every shortlist.
const WEIGHT_TOTAL = Object.values(SCORE_WEIGHTS).reduce((sum, w) => sum + w, 0);
if (WEIGHT_TOTAL !== 100) {
  throw new Error(`SCORE_WEIGHTS must sum to 100, got ${WEIGHT_TOTAL}`);
}

export interface ScorableCreator {
  platform: string;
  bio?: string | null;
  followers?: number | null;
  engagementRate?: number | null;
  engagementPerView?: number | null;
  postsPerWeek?: number | null;
  hasDigitalProduct?: boolean | null;
  contactEmail?: string | null;
  /** Recent captions — used for sponsor-load detection. */
  captions?: string[];
  /** Sampled comment text — used for buying-intent detection. */
  comments?: string[];
  /** Whether the creator is seen replying to their own comments. */
  repliesToComments?: boolean | null;
}

/** Linear ramp from `floor` (0) to `target` (1). */
export function ramp(value: number | null | undefined, floor: number, target: number): number {
  if (value === undefined || value === null || !Number.isFinite(value)) return 0;
  if (target <= floor) return value >= target ? 1 : 0;
  return Number(Math.min(1, Math.max(0, (value - floor) / (target - floor))).toFixed(4));
}

/**
 * Engagement, on the denominator that fits the platform: per view on YouTube,
 * per follower on Instagram (see ENGAGEMENT_FLOORS).
 */
export function engagementScore(creator: ScorableCreator): number {
  const onYouTube = creator.platform === 'YOUTUBE';
  const rate = onYouTube ? creator.engagementPerView : creator.engagementRate;
  const floor = onYouTube ? ENGAGEMENT_PER_VIEW_FLOOR / 2 : ENGAGEMENT_FLOORS.INSTAGRAM / 2;
  // Twice the floor is a genuinely strong account on either platform.
  const target = onYouTube ? ENGAGEMENT_PER_VIEW_FLOOR * 2.5 : ENGAGEMENT_FLOORS.INSTAGRAM * 2.5;
  return ramp(rate, floor, target);
}

/**
 * Buying intent in the comments. Someone asking "how do I fix my utilisation"
 * is telling you they would pay for the answer; "🔥🔥" is not.
 */
const INTENT_PATTERNS: RegExp[] = [
  /\bhow (?:do|would|can|did) (?:i|you|we)\b/i,
  /\bwhat (?:if|about|should|do) i\b/i,
  /\bcan (?:i|you) (?:still|also)?\s*\w+/i,
  /\bwhere do i\b/i,
  /\bis (?:it|this) possible\b/i,
  /\bany (?:advice|tips|help)\b/i,
  /\bhelp me\b/i,
  /\bdo you (?:have|offer|sell)\b/i,
  /\bi (?:need|want|struggle|can't|cannot)\b/i,
  /\?\s*$/,
];

export function commentIntentScore(comments: string[] = []): number | undefined {
  if (!comments.length) return undefined;
  const hits = comments.filter((comment) =>
    INTENT_PATTERNS.some((pattern) => pattern.test(comment)),
  ).length;
  // A third of comments carrying a question is an unusually engaged audience.
  return ramp(hits / comments.length, 0, 0.33);
}

/** Sponsored-post markers — a heavy sponsor load means less room for us. */
const SPONSOR_PATTERNS = [/#ad\b/i, /\bsponsored\b/i, /\bpaid partnership\b/i, /#spon\b/i, /\bpartnered with\b/i, /\buse code\b/i, /\bpromo code\b/i];

export function sponsorLoad(captions: string[] = []): number {
  if (!captions.length) return 0;
  const sponsored = captions.filter((caption) =>
    SPONSOR_PATTERNS.some((pattern) => pattern.test(caption)),
  ).length;
  return Number((sponsored / captions.length).toFixed(3));
}

/**
 * The monetisation gap: do they have room for a product of ours?
 * An existing product is close to disqualifying; a heavy sponsor load means
 * the audience is already being sold to and the creator has income elsewhere.
 */
export function monetisationGapScore(creator: ScorableCreator): number {
  if (creator.hasDigitalProduct) return 0.1;
  const load = sponsorLoad(creator.captions);
  // No sponsorships at all = 1; half the feed sponsored = 0.
  return Number(Math.max(0, 1 - load * 2).toFixed(3));
}

/** Cadence: roughly two posts a week is the sweet spot for a live audience. */
export function consistencyScore(creator: ScorableCreator): number {
  const rate = creator.postsPerWeek;
  if (rate === undefined || rate === null) return 0;
  if (rate >= 2 && rate <= 14) return 1;
  if (rate < 2) return ramp(rate, 0.25, 2);
  // Above ~14/week is usually a repost farm, not a creator with an audience.
  return Number(Math.max(0.3, 1 - (rate - 14) / 20).toFixed(3));
}

/** Can we actually reach them, and do they talk back? */
export function reachabilityScore(creator: ScorableCreator): number {
  let score = 0;
  if (creator.contactEmail) score += 0.7;
  if (creator.repliesToComments) score += 0.3;
  // No email but an active presence still leaves a DM route.
  if (!creator.contactEmail && !creator.repliesToComments) score = 0.15;
  return Number(Math.min(1, score).toFixed(3));
}

export function verdictFromScore(score: number): ScoreVerdict {
  if (score >= VERDICT_THRESHOLDS.go) return 'GO';
  if (score >= VERDICT_THRESHOLDS.maybe) return 'MAYBE';
  return 'NO';
}

export interface ComponentInput {
  /** 0-1 from the model: is the niche specific and the content educational? */
  nicheSpecificity: number;
  /** 0-1 from the model, anchored by CPC data when we have it. */
  spendingPower: number;
}

export interface ScoredComponents {
  nicheSpecificity: number;
  engagement: number;
  monetisationGap: number;
  spendingPower: number;
  consistency: number;
  reachability: number;
}

export interface ComputedScore {
  score: number;
  /** 0-1 ratings per component, before weighting. */
  components: ScoredComponents;
  /** Weighted points per component — these sum to `score`. */
  points: ScoredComponents;
  weights: typeof SCORE_WEIGHTS;
}

/**
 * Blend the model's qualitative ratings with the deterministic metrics into the
 * final 0-100.
 *
 * Engagement is 70% rate and 30% comment intent when comments were sampled; on
 * the rate alone when they were not, rather than penalising a creator for data
 * we failed to collect.
 */
export function computeScore(creator: ScorableCreator, qualitative: ComponentInput): ComputedScore {
  const intent = commentIntentScore(creator.comments);
  const rate = engagementScore(creator);
  const engagement = intent === undefined ? rate : Number((rate * 0.7 + intent * 0.3).toFixed(4));

  const components: ScoredComponents = {
    nicheSpecificity: clamp01(qualitative.nicheSpecificity),
    engagement,
    monetisationGap: monetisationGapScore(creator),
    spendingPower: clamp01(qualitative.spendingPower),
    consistency: consistencyScore(creator),
    reachability: reachabilityScore(creator),
  };

  const weigh = (key: keyof ScoredComponents) =>
    Number((components[key] * SCORE_WEIGHTS[key]).toFixed(2));

  const points: ScoredComponents = {
    nicheSpecificity: weigh('nicheSpecificity'),
    engagement: weigh('engagement'),
    monetisationGap: weigh('monetisationGap'),
    spendingPower: weigh('spendingPower'),
    consistency: weigh('consistency'),
    reachability: weigh('reachability'),
  };

  const score = Math.round(Object.values(points).reduce((sum, p) => sum + p, 0));

  return { score, components, points, weights: SCORE_WEIGHTS };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Number(Math.min(1, Math.max(0, value)).toFixed(4));
}
