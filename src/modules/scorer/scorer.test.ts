import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SCORE_WEIGHTS } from '../../lib/constants.js';
import { matchCpc, normaliseCpc } from './cpc.js';
import { scorerSchema } from './llm.js';
import {
  commentIntentScore,
  computeScore,
  consistencyScore,
  engagementScore,
  monetisationGapScore,
  ramp,
  reachabilityScore,
  sponsorLoad,
  verdictFromScore,
  type ScorableCreator,
} from './metrics.js';

function creator(overrides: Partial<ScorableCreator> = {}): ScorableCreator {
  return {
    platform: 'INSTAGRAM',
    followers: 50_000,
    engagementRate: 0.04,
    postsPerWeek: 3,
    hasDigitalProduct: false,
    contactEmail: 'a@b.com',
    captions: [],
    comments: [],
    ...overrides,
  };
}

describe('score weights', () => {
  it('sum to exactly 100', () => {
    const total = Object.values(SCORE_WEIGHTS).reduce((sum, w) => sum + w, 0);
    assert.equal(total, 100);
  });

  it('match the weights in the brief', () => {
    assert.deepEqual(SCORE_WEIGHTS, {
      nicheSpecificity: 25,
      engagement: 20,
      monetisationGap: 20,
      spendingPower: 15,
      consistency: 10,
      reachability: 10,
    });
  });
});

describe('ramp', () => {
  it('clamps below the floor and above the target', () => {
    assert.equal(ramp(0, 1, 5), 0);
    assert.equal(ramp(9, 1, 5), 1);
  });

  it('interpolates in between', () => {
    assert.equal(ramp(3, 1, 5), 0.5);
  });

  it('returns 0 for missing values rather than throwing', () => {
    assert.equal(ramp(undefined, 0, 1), 0);
    assert.equal(ramp(null, 0, 1), 0);
  });
});

describe('engagement', () => {
  it('uses per-follower engagement on Instagram', () => {
    const low = engagementScore(creator({ engagementRate: 0.005 }));
    const high = engagementScore(creator({ engagementRate: 0.06 }));
    assert.ok(high > low);
    assert.equal(high, 1);
  });

  it('uses per-view engagement on YouTube', () => {
    // A per-follower rate this low would score 0 on Instagram's scale, but is
    // healthy on YouTube once measured against views.
    const score = engagementScore({
      platform: 'YOUTUBE',
      engagementRate: 0.0001,
      engagementPerView: 0.045,
    });
    assert.ok(score > 0.8, `expected a strong YouTube score, got ${score}`);
  });

  it('does not punish a YouTube channel for a low per-follower rate', () => {
    const youtube = engagementScore({ platform: 'YOUTUBE', engagementRate: 0.0002, engagementPerView: 0.03 });
    const instagram = engagementScore({ platform: 'INSTAGRAM', engagementRate: 0.0002 });
    assert.ok(youtube > instagram);
  });
});

describe('comment intent', () => {
  it('is undefined when no comments were sampled', () => {
    assert.equal(commentIntentScore([]), undefined);
    assert.equal(commentIntentScore(undefined), undefined);
  });

  it('scores questions and asks above reaction noise', () => {
    const asking = commentIntentScore([
      'how do I dispute a charge-off?',
      'what should i do if my utilisation is high',
      'I need help with this',
    ]);
    const noise = commentIntentScore(['🔥🔥🔥', 'love this', 'yes queen']);
    assert.ok((asking ?? 0) > (noise ?? 1));
    assert.equal(noise, 0);
  });

  it('counts a trailing question mark as intent', () => {
    assert.ok((commentIntentScore(['does this work for medical debt?']) ?? 0) > 0);
  });
});

describe('monetisation gap', () => {
  it('collapses when a product already exists', () => {
    assert.equal(monetisationGapScore(creator({ hasDigitalProduct: true })), 0.1);
  });

  it('is full when nothing is being sold', () => {
    assert.equal(monetisationGapScore(creator({ captions: ['a tip', 'another tip'] })), 1);
  });

  it('falls as sponsor load rises', () => {
    const light = monetisationGapScore(creator({ captions: ['tip', 'tip', 'tip', '#ad brand'] }));
    const heavy = monetisationGapScore(creator({ captions: ['#ad one', 'sponsored two'] }));
    assert.ok(light > heavy);
    assert.equal(heavy, 0);
  });

  it('detects the usual sponsorship markers', () => {
    assert.equal(sponsorLoad(['paid partnership with X', 'normal post']), 0.5);
    assert.equal(sponsorLoad(['use code SAVE20']), 1);
  });
});

describe('consistency', () => {
  it('rewards a steady cadence', () => {
    assert.equal(consistencyScore(creator({ postsPerWeek: 3 })), 1);
  });

  it('penalises near-dormant accounts', () => {
    assert.ok(consistencyScore(creator({ postsPerWeek: 0.3 })) < 0.2);
  });

  it('penalises firehose accounts, but not to zero', () => {
    const score = consistencyScore(creator({ postsPerWeek: 30 }));
    assert.ok(score >= 0.3 && score < 1);
  });

  it('scores 0 when cadence is unknown', () => {
    assert.equal(consistencyScore(creator({ postsPerWeek: null })), 0);
  });
});

describe('reachability', () => {
  it('rewards a public email', () => {
    assert.equal(reachabilityScore(creator({ contactEmail: 'a@b.com', repliesToComments: false })), 0.7);
  });

  it('adds credit for replying to comments', () => {
    assert.equal(reachabilityScore(creator({ contactEmail: 'a@b.com', repliesToComments: true })), 1);
  });

  it('leaves a floor for a DM-only route', () => {
    assert.equal(reachabilityScore(creator({ contactEmail: null, repliesToComments: false })), 0.15);
  });
});

describe('computeScore', () => {
  it('weights each component and sums to the score', () => {
    const result = computeScore(creator(), { nicheSpecificity: 1, spendingPower: 1 });
    const summed = Object.values(result.points).reduce((sum, p) => sum + p, 0);
    assert.equal(result.score, Math.round(summed));
    assert.equal(result.points.nicheSpecificity, 25);
    assert.equal(result.points.spendingPower, 15);
  });

  it('tops out at 100 for a perfect creator', () => {
    const result = computeScore(
      creator({
        engagementRate: 0.1,
        postsPerWeek: 4,
        contactEmail: 'a@b.com',
        repliesToComments: true,
        comments: ['how do I start?', 'what should i do next?', 'I need help'],
        captions: ['tip', 'tip'],
      }),
      { nicheSpecificity: 1, spendingPower: 1 },
    );
    assert.equal(result.score, 100);
  });

  it('never exceeds 100 even with out-of-range model ratings', () => {
    const result = computeScore(creator(), { nicheSpecificity: 9, spendingPower: -4 });
    assert.ok(result.score <= 100);
    assert.equal(result.components.nicheSpecificity, 1, 'clamped to 1');
    assert.equal(result.components.spendingPower, 0, 'clamped to 0');
  });

  it('drops hard when a product already exists', () => {
    const withProduct = computeScore(creator({ hasDigitalProduct: true }), { nicheSpecificity: 0.9, spendingPower: 0.9 });
    const without = computeScore(creator({ hasDigitalProduct: false }), { nicheSpecificity: 0.9, spendingPower: 0.9 });
    assert.ok(without.score - withProduct.score >= 15, 'the monetisation gap is worth 20 points');
  });

  it('uses engagement rate alone when no comments were sampled', () => {
    const noComments = computeScore(creator({ comments: [] }), { nicheSpecificity: 0.5, spendingPower: 0.5 });
    const rateOnly = engagementScore(creator({ comments: [] }));
    assert.equal(noComments.components.engagement, rateOnly, 'missing data must not be scored as a zero');
  });
});

describe('verdicts', () => {
  it('maps scores to GO / MAYBE / NO', () => {
    assert.equal(verdictFromScore(85), 'GO');
    assert.equal(verdictFromScore(70), 'GO');
    assert.equal(verdictFromScore(69), 'MAYBE');
    assert.equal(verdictFromScore(50), 'MAYBE');
    assert.equal(verdictFromScore(49), 'NO');
  });
});

describe('cpc hints', () => {
  const table = {
    credit: { cpcUsd: 5 },
    'credit repair': { cpcUsd: 12.5 },
    insurance: { cpcUsd: 21.5 },
  };

  it('normalises against a $20 ceiling', () => {
    assert.equal(normaliseCpc(10), 0.5);
    assert.equal(normaliseCpc(40), 1, 'clamped');
    assert.equal(normaliseCpc(0), 0);
  });

  it('prefers the most specific matching niche', () => {
    const match = matchCpc(table, ['credit repair coach']);
    assert.equal(match?.niche, 'credit repair');
    assert.equal(match?.cpcUsd, 12.5);
  });

  it('matches case-insensitively across several fields', () => {
    const match = matchCpc(table, [null, 'I sell INSURANCE advice', undefined]);
    assert.equal(match?.niche, 'insurance');
  });

  it('returns undefined when nothing matches', () => {
    assert.equal(matchCpc(table, ['home barista content']), undefined);
  });
});

describe('llm response schema', () => {
  const valid = {
    nicheSpecificity: 0.8,
    spendingPower: 0.7,
    score: 76,
    reasons: ['Teaches one narrow skill', 'Audience asks buying questions', 'No product in bio'],
    redFlags: [],
    recommendedProductType: '60-day credit dispute playbook',
    priceBand: '$39-79',
    verdict: 'GO',
  };

  it('accepts a well-formed response', () => {
    assert.equal(scorerSchema.safeParse(valid).success, true);
  });

  it('rejects the wrong number of reasons', () => {
    assert.equal(scorerSchema.safeParse({ ...valid, reasons: ['only one'] }).success, false);
  });

  it('rejects an unknown price band', () => {
    assert.equal(scorerSchema.safeParse({ ...valid, priceBand: '$500+' }).success, false);
  });

  it('rejects an unknown verdict', () => {
    assert.equal(scorerSchema.safeParse({ ...valid, verdict: 'PROBABLY' }).success, false);
  });

  it('rejects ratings outside 0-1', () => {
    assert.equal(scorerSchema.safeParse({ ...valid, nicheSpecificity: 1.4 }).success, false);
  });

  it('allows an empty redFlags array', () => {
    assert.equal(scorerSchema.safeParse({ ...valid, redFlags: [] }).success, true);
  });
});

// --- the model path, with the model stubbed out -----------------------------

import type { Creator } from '@prisma/client';
import { createLogger } from '../../lib/logger.js';
import { scoreOne } from './index.js';
import type { ScorerLlmOutput } from './llm.js';

function dbCreator(overrides: Partial<Creator> = {}): Creator {
  return {
    handle: 'creditcoach',
    platform: 'INSTAGRAM',
    displayName: 'Credit Coach',
    niche: 'credit repair',
    bio: 'I teach credit repair. hello@coach.com',
    followers: 48_000,
    engagementRate: 0.05,
    engagementPerView: null,
    postsPerWeek: 3,
    hasDigitalProduct: false,
    contactEmail: 'hello@coach.com',
    score: null,
    raw: {
      posts: [
        { caption: 'How to dispute an error', comments: [{ text: 'how do I start?' }] },
        { caption: 'Utilisation explained', comments: [{ text: 'what should i do first?' }] },
      ],
    },
    ...overrides,
  } as unknown as Creator;
}

function stubModel(output: Partial<ScorerLlmOutput> = {}) {
  const calls: unknown[] = [];
  const fn = async (input: unknown) => {
    calls.push(input);
    return {
      data: {
        nicheSpecificity: 0.9,
        spendingPower: 0.8,
        score: 82,
        reasons: ['Narrow, teachable niche', 'Audience asks how-to questions', 'No product yet'],
        redFlags: [],
        recommendedProductType: '60-day credit dispute playbook',
        priceBand: '$39-79' as const,
        verdict: 'GO' as const,
        ...output,
      },
      model: 'stub-model',
    };
  };
  return { fn: fn as never, calls };
}

describe('scoreOne with a stubbed model', () => {
  const log = createLogger('test');
  const options = { limit: 1, log };

  it('feeds the model ratings into the weighted score', async () => {
    const { fn } = stubModel();
    const record = await scoreOne(dbCreator(), {}, { ...options, scoreFn: fn }, log);

    assert.equal(record.llm, true);
    assert.equal(record.model, 'stub-model');
    assert.equal(record.computed.components.nicheSpecificity, 0.9);
    assert.equal(record.computed.points.nicheSpecificity, 22.5, '0.9 x 25');
    assert.equal(record.computed.points.spendingPower, 12, '0.8 x 15');
    assert.equal(record.verdict, 'GO');
    assert.equal(record.recommendedProductType, '60-day credit dispute playbook');
    assert.equal(record.reasons.length, 3);
  });

  it('keeps the model score separately from the weighted score', async () => {
    const { fn } = stubModel({ score: 82 });
    const record = await scoreOne(dbCreator(), {}, { ...options, scoreFn: fn }, log);
    assert.equal(record.llmScore, 82);
    assert.notEqual(record.score, undefined);
    assert.ok(record.score >= 0 && record.score <= 100);
  });

  it('will not let the model promote a creator the maths rejects', async () => {
    // A weak creator the model enthusiastically calls GO.
    const weak = dbCreator({
      engagementRate: 0.0001,
      postsPerWeek: 0.1,
      contactEmail: null,
      hasDigitalProduct: true,
      raw: {},
    });
    const { fn } = stubModel({ verdict: 'GO', nicheSpecificity: 0.2, spendingPower: 0.1 });
    const record = await scoreOne(weak, {}, { ...options, scoreFn: fn }, log);

    assert.ok(record.score < 50, `expected a low score, got ${record.score}`);
    assert.equal(record.verdict, 'NO', 'the weighted score overrides an over-eager GO');
  });

  it('passes sampled comments and captions to the model', async () => {
    const { fn, calls } = stubModel();
    await scoreOne(dbCreator(), {}, { ...options, scoreFn: fn }, log);
    const input = calls[0] as { creator: { comments: string[]; captions: string[] } };
    assert.deepEqual(input.creator.comments, ['how do I start?', 'what should i do first?']);
    assert.equal(input.creator.captions.length, 2);
  });

  it('anchors spending power with a CPC hint when one matches', async () => {
    const { fn, calls } = stubModel();
    await scoreOne(dbCreator(), { 'credit repair': { cpcUsd: 12.5 } }, { ...options, scoreFn: fn }, log);
    const input = calls[0] as { cpc?: { niche: string; normalised: number } };
    assert.equal(input.cpc?.niche, 'credit repair');
    assert.equal(input.cpc?.normalised, 0.625);
  });

  it('falls back to deterministic ratings offline, and says so', async () => {
    const record = await scoreOne(dbCreator(), { 'credit repair': { cpcUsd: 12.5 } }, { ...options, offline: true }, log);

    assert.equal(record.llm, false);
    assert.equal(record.llmScore, undefined);
    assert.equal(record.computed.components.spendingPower, 0.625, 'CPC still anchors it offline');
    assert.match(record.reasons[0] ?? '', /offline/);
  });

  it('offline scoring never invents a product recommendation', async () => {
    const record = await scoreOne(dbCreator(), {}, { ...options, offline: true }, log);
    assert.match(record.recommendedProductType, /offline/);
  });
});
