import { z } from 'zod';

/**
 * The audit contract. Both model passes are validated against these, so
 * anything that reaches audit.json / audit.md has the shape the brief asks for.
 *
 * Evidence is mandatory throughout: every pain carries the quote it came from
 * and the post it was said on. A pain without a source is a guess, and a guess
 * in an outreach message is how you lose a creator in one message.
 */

export const PRICE_BANDS = ['$9-19', '$19-39', '$39-79', '$79-149', '$149+'] as const;

/** Where a quote came from, so any claim can be checked against the source. */
export const evidenceRefSchema = z.object({
  type: z.enum(['comment', 'caption', 'bio', 'link_page']),
  /** Post/video URL, or the page URL for link_page. Empty for bio. */
  reference: z.string(),
  /** Post title or shortcode — human-readable in the report. */
  label: z.string().optional(),
});

// --- pass 1: extraction (runs per chunk, cheap model) ------------------------

export const extractionSchema = z.object({
  painSignals: z
    .array(
      z.object({
        quote: z.string().min(4).describe('Verbatim text from a comment or caption. Never paraphrase.'),
        source: evidenceRefSchema,
        theme: z.string().min(3).describe('Short label for what this is about, e.g. "collections fallout".'),
        isQuestion: z.boolean().describe('True when the audience is asking how to do something.'),
      }),
    )
    .describe('Struggles, frustrations and questions visible in this chunk. Empty if none.'),
  voiceSignals: z.object({
    openings: z.array(z.string()).describe('How posts in this chunk begin, verbatim.'),
    closings: z.array(z.string()).describe('How they end, verbatim — CTAs, sign-offs.'),
    signaturePhrases: z.array(z.string()).describe('Phrases this creator repeats.'),
    emojis: z.array(z.string()).describe('Emoji actually used.'),
    toneAdjectives: z.array(z.string()),
  }),
  topics: z.array(z.object({ topic: z.string(), evidence: z.string() })),
  audienceSignals: z
    .array(z.object({ observation: z.string(), quote: z.string(), source: evidenceRefSchema }))
    .describe('What the audience reveals about their situation — what they have already tried.'),
});

export type Extraction = z.infer<typeof extractionSchema>;

// --- pass 2: synthesis (one call, strongest model) --------------------------

export const painSchema = z.object({
  pain: z.string().min(10).describe('The struggle, in plain words.'),
  quote: z.string().min(4).describe('Verbatim supporting quote from a real comment or caption.'),
  source: evidenceRefSchema,
  severity: z.enum(['high', 'medium', 'low']),
  /** Roughly how often this showed up across the sample. */
  frequency: z.enum(['pervasive', 'common', 'occasional']),
});

export const productOpportunitySchema = z.object({
  title: z.string().min(4),
  promise: z.string().min(10).describe('The point-A-to-point-B transformation, concrete.'),
  whoItsFor: z.string().min(10).describe('The specific person, not a demographic.'),
  whyItFits: z.string().min(20).describe('Why THIS audience, citing evidence from the audit.'),
  score: z.number().min(0).max(10),
  priceBand: z.enum(PRICE_BANDS),
  recommended: z.boolean(),
  /**
   * The blueprint's profitable-pocket test. Both must be answerable or the
   * opportunity is a category, not a pocket.
   */
  pocket: z.object({
    specificPerson: z.string().min(10),
    problemTheyAreAlreadyFixing: z.string().min(10),
  }),
});

export const auditSchema = z
  .object({
    niche: z.string().min(20).describe('One sentence. What this creator is about, specifically.'),
    audiencePersona: z.object({
      who: z.string().min(20),
      situation: z.string().min(20),
      whatTheyveTried: z.array(z.string().min(5)).min(2),
    }),
    top10Pains: z.array(painSchema).length(10),
    voiceGuide: z.object({
      toneAdjectives: z.array(z.string()).min(3).max(8),
      sentenceLength: z.string().describe('e.g. "short, 8-14 words, often fragments".'),
      signaturePhrases: z.array(z.string()).min(1),
      neverUses: z.array(z.string()).describe('Words and registers absent from their writing.'),
      emojiUsage: z.string(),
      howTheyOpen: z.string().min(10),
      howTheyClose: z.string().min(10),
    }),
    visualStyle: z.object({
      /**
       * Filled from real image extraction, not the model — the model describes
       * the palette it is given rather than inventing hex values.
       */
      dominantColors: z.array(z.object({ hex: z.string(), share: z.number(), role: z.string() })),
      fontFeel: z.string().min(5),
      layoutHabits: z.string().min(10),
    }),
    productOpportunities: z.array(productOpportunitySchema).length(5),
    hookLines: z.array(z.string().min(10)).length(10).describe("Written in the creator's voice."),
    partnershipPitchAngle: z.string().min(40).describe('The one insight to lead outreach with.'),
  })
  .refine(
    (audit) => audit.productOpportunities.filter((o) => o.recommended).length === 1,
    { message: 'Exactly one product opportunity must be marked recommended.', path: ['productOpportunities'] },
  );

export type Audit = z.infer<typeof auditSchema>;

/** What the collector gathered, stored alongside the audit for traceability. */
export interface AuditSourceSummary {
  handle: string;
  platform: string;
  postsAnalysed: number;
  commentsAnalysed: number;
  pinnedPosts: number;
  imagesSampled: number;
  linkPagesRead: number;
  /** Anything that could not be collected, and why. */
  gaps: string[];
  collectedAt: string;
}
