import type { Creator } from '@prisma/client';
import { prisma } from '../../lib/db.js';
import { createLogger, type Logger } from '../../lib/logger.js';
import { SCORE_WEIGHTS, type ScoreVerdict } from '../../lib/constants.js';
import { loadCpcTable, matchCpc, type CpcMatch, type NicheCpc } from './cpc.js';
import { scoreQualitatively, type ScorerLlmOutput } from './llm.js';
import {
  computeScore,
  verdictFromScore,
  type ComputedScore,
  type ScorableCreator,
} from './metrics.js';

/**
 * Scoring orchestration: read FOUND creators, pull the qualitative read from
 * the model, blend it with the deterministic metrics, and write score,
 * scoreJson and status SCORED.
 *
 * `--offline` runs the deterministic half only. It exists so the CLI stays
 * usable and testable without an API key — the score it produces is real but
 * weaker, and scoreJson records `llm: false` so nobody mistakes one for the other.
 */

export interface ScorerOptions {
  handle?: string;
  all?: boolean;
  rescore?: boolean;
  limit: number;
  /** Skip the model; derive qualitative ratings from deterministic proxies. */
  offline?: boolean;
  cpcPath?: string;
  dryRun?: boolean;
  log?: Logger;
  /** Test seam — replaces the model call. */
  scoreFn?: typeof scoreQualitatively;
}

export interface ScoreRecord {
  handle: string;
  score: number;
  verdict: ScoreVerdict;
  reasons: string[];
  redFlags: string[];
  recommendedProductType: string;
  priceBand: string;
  /** Whether a model produced the qualitative half. */
  llm: boolean;
  llmScore?: number;
  model?: string;
  cpc?: CpcMatch;
  computed: ComputedScore;
}

export interface ScorerResult {
  scored: ScoreRecord[];
  skipped: Array<{ handle: string; reason: string }>;
  failed: Array<{ handle: string; error: string }>;
}

/** Post captions and sampled comments live in Creator.raw, shaped per platform. */
export function extractText(creator: Creator): { captions: string[]; comments: string[] } {
  const raw = creator.raw as Record<string, unknown> | null;
  const captions: string[] = [];
  const comments: string[] = [];

  const posts = (raw?.latestPosts ?? raw?.posts) as Array<Record<string, unknown>> | undefined;
  for (const post of posts ?? []) {
    const caption = post?.caption ?? post?.title;
    if (typeof caption === 'string' && caption.trim()) captions.push(caption.trim());

    const postComments = (post?.latestComments ?? post?.comments) as
      | Array<Record<string, unknown> | string>
      | undefined;
    if (!Array.isArray(postComments)) continue;
    for (const comment of postComments) {
      const text = typeof comment === 'string' ? comment : comment?.text;
      if (typeof text === 'string' && text.trim()) comments.push(text.trim());
    }
  }

  return { captions, comments };
}

function toScorable(creator: Creator): ScorableCreator & { handle: string } {
  const { captions, comments } = extractText(creator);
  return {
    handle: creator.handle,
    platform: creator.platform,
    bio: creator.bio,
    followers: creator.followers,
    engagementRate: creator.engagementRate,
    engagementPerView: creator.engagementPerView,
    postsPerWeek: creator.postsPerWeek,
    hasDigitalProduct: creator.hasDigitalProduct,
    contactEmail: creator.contactEmail,
    captions,
    comments,
    // Set by the audit, which is the only pass that reads comments. Null until
    // then — absence of the signal is not evidence the creator ignores people.
    repliesToComments:
      (creator.monetization as { repliesToComments?: boolean } | null)?.repliesToComments ?? null,
  };
}

/**
 * Offline stand-ins for the two ratings the model would supply. Deliberately
 * conservative: a specific niche label and a CPC hint raise them, nothing else
 * does, so an offline score never flatters a creator.
 */
function offlineQualitative(
  creator: Creator,
  cpc: CpcMatch | undefined,
): { nicheSpecificity: number; spendingPower: number } {
  const bio = (creator.bio ?? '').trim();
  // A bio that names a problem is weak evidence of a specific niche.
  const specificity = Math.min(1, (creator.niche ? 0.35 : 0) + (bio.length > 80 ? 0.3 : 0.1));
  return {
    nicheSpecificity: Number(specificity.toFixed(3)),
    spendingPower: cpc ? cpc.normalised : 0.4,
  };
}

export async function scoreOne(
  creator: Creator,
  cpcTable: Record<string, NicheCpc>,
  options: ScorerOptions,
  log: Logger,
): Promise<ScoreRecord> {
  const scorable = toScorable(creator);
  const cpc = matchCpc(cpcTable, [creator.niche, creator.bio, creator.displayName]);

  let llmOutput: ScorerLlmOutput | undefined;
  let model: string | undefined;

  if (!options.offline) {
    const run = options.scoreFn ?? scoreQualitatively;
    const result = await run({ creator: { ...scorable, niche: creator.niche, displayName: creator.displayName }, cpc });
    llmOutput = result.data;
    model = result.model;
  }

  const qualitative = llmOutput
    ? { nicheSpecificity: llmOutput.nicheSpecificity, spendingPower: llmOutput.spendingPower }
    : offlineQualitative(creator, cpc);

  const computed = computeScore(scorable, qualitative);

  // The weighted score is authoritative and is what the shortlist sorts on.
  // The model's own verdict is kept, but cannot promote a creator the weighted
  // maths puts in NO territory.
  const thresholdVerdict = verdictFromScore(computed.score);
  const verdict: ScoreVerdict =
    llmOutput && !(llmOutput.verdict === 'GO' && thresholdVerdict === 'NO')
      ? llmOutput.verdict
      : thresholdVerdict;

  if (llmOutput && verdict !== llmOutput.verdict) {
    log.debug(`${creator.handle}: model said ${llmOutput.verdict}, weighted score ${computed.score} overrode to ${verdict}`);
  }

  return {
    handle: creator.handle,
    score: computed.score,
    verdict,
    reasons: llmOutput?.reasons ?? [
      `Weighted score ${computed.score}/100 from metrics only (offline run — no model).`,
      `${creator.followers?.toLocaleString() ?? 'unknown'} followers, engagement component ${computed.points.engagement}/${SCORE_WEIGHTS.engagement}.`,
      creator.hasDigitalProduct
        ? 'Already sells a digital product — the monetisation gap is closed.'
        : 'No existing digital product found in bio or links.',
    ],
    redFlags: llmOutput?.redFlags ?? (creator.hasDigitalProduct ? ['Already sells a digital product.'] : []),
    recommendedProductType: llmOutput?.recommendedProductType ?? 'unknown (offline run)',
    priceBand: llmOutput?.priceBand ?? 'unknown (offline run)',
    llm: Boolean(llmOutput),
    ...(llmOutput ? { llmScore: llmOutput.score } : {}),
    ...(model ? { model } : {}),
    ...(cpc ? { cpc } : {}),
    computed,
  };
}

export async function scoreCreators(options: ScorerOptions): Promise<ScorerResult> {
  const log = options.log ?? createLogger('scorer');
  const cpcTable = await loadCpcTable(options.cpcPath);
  log.debug(`cpc table: ${Object.keys(cpcTable).length} niche(s)`);

  const creators = options.handle
    ? await prisma.creator.findMany({ where: { handle: options.handle } })
    : await prisma.creator.findMany({
        where: {
          // --rescore has to reach creators that are already SCORED, or it can
          // only ever re-score the ones it has not scored yet.
          status: options.rescore ? { in: ['FOUND', 'SCORED'] } : 'FOUND',
          ...(options.rescore ? {} : { score: null }),
        },
        orderBy: { followers: 'desc' },
        take: options.limit,
      });

  if (options.handle && !creators.length) {
    throw new Error(`No creator with handle "${options.handle}". Run the finder first.`);
  }

  const scored: ScoreRecord[] = [];
  const skipped: ScorerResult['skipped'] = [];
  const failed: ScorerResult['failed'] = [];

  for (const creator of creators) {
    if (creator.score !== null && !options.rescore && options.handle) {
      skipped.push({ handle: creator.handle, reason: `already scored ${creator.score} — use --rescore` });
      continue;
    }

    try {
      const record = await scoreOne(creator, cpcTable, options, log);
      scored.push(record);

      if (!options.dryRun) {
        await prisma.creator.update({
          where: { id: creator.id },
          data: {
            score: record.score,
            scoreBreakdown: {
              components: record.computed.components,
              points: record.computed.points,
              weights: record.computed.weights,
            } as object,
            scoreJson: {
              score: record.score,
              reasons: record.reasons,
              redFlags: record.redFlags,
              recommendedProductType: record.recommendedProductType,
              priceBand: record.priceBand,
              verdict: record.verdict,
              llm: record.llm,
              ...(record.llmScore !== undefined ? { llmScore: record.llmScore } : {}),
              ...(record.cpc ? { cpc: record.cpc } : {}),
            } as object,
            scoreVerdict: record.verdict,
            scoredAt: new Date(),
            scoreModel: record.model ?? (record.llm ? 'unknown' : 'offline'),
            status: 'SCORED',
          },
        });
      }

      log.info(`${creator.handle}: ${record.score}/100 ${record.verdict}`);
    } catch (error) {
      failed.push({ handle: creator.handle, error: (error as Error).message });
      log.warn(`${creator.handle}: ${(error as Error).message}`);
    }
  }

  return { scored, skipped, failed };
}
