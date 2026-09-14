import { z } from 'zod';
import { completeJSON } from '../../lib/llm.js';
import type { CpcMatch } from './cpc.js';
import type { ScorableCreator } from './metrics.js';

/**
 * The qualitative half of the score.
 *
 * The model judges only what metrics cannot: how specific the niche is, how
 * educational the content is, and how willing this audience is to pay. It also
 * returns the human-facing read — reasons, red flags, product type, price band
 * and verdict. Weighted arithmetic stays in metrics.ts, where it is testable.
 */

export const PRICE_BANDS = ['$9-19', '$19-39', '$39-79', '$79-149', '$149+'] as const;

/**
 * The brief's schema, plus the two 0-1 ratings the weighted score needs as
 * inputs — without them the 25-point niche and 15-point spending-power
 * components would have nothing to multiply.
 */
export const scorerSchema = z.object({
  nicheSpecificity: z
    .number()
    .min(0)
    .max(1)
    .describe(
      'How specific and educational this creator is. 1 = a narrow, teachable problem with step-by-step content. 0 = general lifestyle content with no teachable throughline.',
    ),
  spendingPower: z
    .number()
    .min(0)
    .max(1)
    .describe(
      'How willing this audience is to pay for a digital product that solves their problem. 1 = urgent, expensive, money-adjacent problem. 0 = casual hobby interest.',
    ),
  score: z
    .number()
    .int()
    .min(0)
    .max(100)
    .describe('Your own holistic 0-100 read, independent of the weighted score.'),
  reasons: z
    .array(z.string().min(10))
    .length(3)
    .describe('Exactly three concrete reasons, each citing something specific from the profile.'),
  redFlags: z
    .array(z.string().min(5))
    .describe('Anything that would make this partnership fail. Empty array if genuinely none.'),
  recommendedProductType: z
    .string()
    .min(3)
    .describe('The digital product to build for this audience, e.g. "60-day credit dispute playbook".'),
  priceBand: z.enum(PRICE_BANDS),
  verdict: z.enum(['GO', 'MAYBE', 'NO']),
});

export type ScorerLlmOutput = z.infer<typeof scorerSchema>;

const SYSTEM = `You evaluate micro-creators as partners for a done-for-you digital product business.

The thesis: find creators with an engaged, niche audience who have NOT yet built a
digital product, then build and sell one in their voice for a revenue share.

Judge only what you can support from the profile you are given. Be sceptical —
a high follower count with vague content is worse than a small, sharply focused
audience. Cite specifics in every reason; never write generic praise.

A creator who already sells a product is a NO: the gap we exist to fill is closed.`;

export interface ScorerLlmInput {
  creator: ScorableCreator & { handle: string; displayName?: string | null; niche?: string | null };
  cpc?: CpcMatch | undefined;
}

/** Only what the model should see — no ids, no internal scoring state. */
function buildPrompt({ creator, cpc }: ScorerLlmInput): string {
  const captions = (creator.captions ?? []).slice(0, 12);
  const comments = (creator.comments ?? []).slice(0, 30);

  return [
    `Creator: @${creator.handle}${creator.displayName ? ` (${creator.displayName})` : ''}`,
    `Platform: ${creator.platform}`,
    creator.niche ? `Niche label: ${creator.niche}` : undefined,
    `Followers: ${creator.followers?.toLocaleString() ?? 'unknown'}`,
    creator.engagementRate !== undefined && creator.engagementRate !== null
      ? `Engagement per follower: ${(creator.engagementRate * 100).toFixed(2)}%`
      : undefined,
    creator.engagementPerView !== undefined && creator.engagementPerView !== null
      ? `Engagement per view: ${(creator.engagementPerView * 100).toFixed(2)}%`
      : undefined,
    creator.postsPerWeek ? `Posts per week: ${creator.postsPerWeek}` : undefined,
    `Already sells a digital product: ${creator.hasDigitalProduct ? 'YES' : 'no evidence found'}`,
    `Public email in bio: ${creator.contactEmail ? 'yes' : 'no'}`,
    '',
    'Bio / channel description:',
    creator.bio ? creator.bio.slice(0, 1500) : '(empty)',
    '',
    captions.length ? `Recent post titles/captions:\n${captions.map((c) => `- ${c.slice(0, 200)}`).join('\n')}` : '(no captions available)',
    '',
    comments.length
      ? `Sampled audience comments:\n${comments.map((c) => `- ${c.slice(0, 200)}`).join('\n')}`
      : '(no comments sampled — do not treat this as low engagement)',
    '',
    cpc
      ? `Paid-search signal: keywords in "${cpc.niche}" average $${cpc.cpcUsd.toFixed(2)} per click${cpc.notes ? ` — ${cpc.notes}` : ''}. Use this to anchor spendingPower; high CPC means advertisers value this audience.`
      : 'No CPC data for this niche — estimate spendingPower from the content alone.',
  ]
    .filter((line) => line !== undefined)
    .join('\n');
}

export async function scoreQualitatively(
  input: ScorerLlmInput,
): Promise<{ data: ScorerLlmOutput; model: string }> {
  const { data, model } = await completeJSON({
    system: SYSTEM,
    prompt: buildPrompt(input),
    schema: scorerSchema,
    schemaName: 'score_creator',
    schemaDescription: 'Your evaluation of this creator as a product partner.',
    tier: 'default',
    label: `scorer:${input.creator.handle}`,
    temperature: 0.3,
  });
  return { data, model };
}
