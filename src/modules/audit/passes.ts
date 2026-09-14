import { completeJSON } from '../../lib/llm.js';
import type { Logger } from '../../lib/logger.js';
import type { CollectedAudit } from './collect.js';
import { auditSchema, extractionSchema, type Audit, type Extraction } from './schema.js';

/**
 * Two passes, because they are different jobs.
 *
 * Pass 1 (extraction) reads raw posts and comments in chunks on the default
 * tier. It only pulls out verbatim quotes and signals — no judgement — which
 * keeps each call small enough to attend to every comment rather than skimming
 * a 100-post dump.
 *
 * Pass 2 (synthesis) sees only the extracted signals and makes the calls that
 * need the strongest model: the pains that matter, the voice, the products.
 */

export interface PassOptions {
  log: Logger;
  /** Posts per extraction chunk. */
  chunkSize?: number;
  /** Test seam: replaces both model calls. */
  completeJsonFn?: typeof completeJSON;
}

export interface ExtractionResult {
  chunks: Extraction[];
  model: string;
  /** Chunks the model failed on — recorded, not fatal. */
  failures: string[];
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const EXTRACTION_SYSTEM = `You extract raw signal from a creator's posts and their audience's comments.

You do NOT judge, summarise or advise at this stage. You pull out what is
literally there:
- quotes showing a struggle, frustration, confusion or question
- how the creator writes: openings, closings, repeated phrases, emoji
- what the audience reveals about their situation and what they've already tried

Comments prefixed [CREATOR] were written by the creator themselves, usually a
pinned promo or a reply. They are evidence of VOICE and of the creator engaging
with their audience. They are NEVER an audience pain — do not put a [CREATOR]
comment in painSignals, however much it sounds like a problem statement.

Every quote must be VERBATIM. Never clean up grammar, never paraphrase, never
merge two comments into one quote. If a chunk contains nothing for a field,
return an empty array — an invented example is worse than a gap.`;

/** Render one chunk of posts with their comments as the model's input. */
function renderChunk(
  posts: CollectedAudit['posts'],
  comments: CollectedAudit['comments'],
): string {
  const byPost = new Map<string, CollectedAudit['comments']>();
  for (const comment of comments) {
    const key = comment.postUrl ?? '';
    byPost.set(key, [...(byPost.get(key) ?? []), comment]);
  }

  return posts
    .map((post) => {
      const postComments = byPost.get(post.url ?? '') ?? [];
      return [
        `--- POST ${post.url ?? post.id}`,
        post.publishedAt ? `published: ${post.publishedAt}` : undefined,
        `stats: ${post.views ?? '?'} views, ${post.likes ?? '?'} likes, ${post.comments ?? '?'} comments`,
        post.pinned ? 'PINNED' : undefined,
        '',
        'CAPTION:',
        post.caption?.slice(0, 2000) ?? '(none)',
        '',
        postComments.length
          ? `COMMENTS (${postComments.length}):\n${postComments
              .map((c) => `- ${c.byCreator ? '[CREATOR] ' : ''}${c.text.slice(0, 400)}`)
              .join('\n')}`
          : 'COMMENTS: (none available)',
      ]
        .filter((line) => line !== undefined)
        .join('\n');
    })
    .join('\n\n');
}

export async function runExtraction(
  collected: CollectedAudit,
  options: PassOptions,
): Promise<ExtractionResult> {
  const complete = options.completeJsonFn ?? completeJSON;
  const size = options.chunkSize ?? 10;
  const batches = chunk(collected.posts, size);
  const chunks: Extraction[] = [];
  const failures: string[] = [];
  let model = '';

  options.log.info(`extraction: ${batches.length} chunk(s) of up to ${size} posts`);

  for (const [index, batch] of batches.entries()) {
    const urls = new Set(batch.map((post) => post.url ?? ''));
    const batchComments = collected.comments.filter((comment) => urls.has(comment.postUrl ?? ''));

    try {
      const { data, model: used } = await complete({
        system: EXTRACTION_SYSTEM,
        prompt: [
          `Creator: @${collected.profile.handle} on ${collected.profile.platform}`,
          `Chunk ${index + 1} of ${batches.length}.`,
          '',
          renderChunk(batch, batchComments),
        ].join('\n'),
        schema: extractionSchema,
        schemaName: 'extract_signals',
        schemaDescription: 'Verbatim signals from this chunk of posts and comments.',
        tier: 'default',
        label: `audit:extract:${collected.profile.handle}:${index + 1}`,
        temperature: 0,
      });
      chunks.push(data);
      model = used;
      options.log.debug(`chunk ${index + 1}: ${data.painSignals.length} pain signal(s)`);
    } catch (error) {
      // One bad chunk must not cost the whole audit.
      failures.push(`chunk ${index + 1}: ${(error as Error).message}`);
      options.log.warn(`extraction chunk ${index + 1} failed: ${(error as Error).message}`);
    }
  }

  if (!chunks.length) {
    throw new Error(`Extraction produced nothing across ${batches.length} chunk(s). First error: ${failures[0] ?? 'unknown'}`);
  }

  return { chunks, model, failures };
}

const SYNTHESIS_SYSTEM = `You turn extracted signals about one creator into a partnership audit.

Rules:
- Every pain must carry a VERBATIM quote and the post it came from. No quote, no pain.
- Write hook lines and the pitch angle in THIS creator's voice, using the voice
  guide you produce. They should be indistinguishable from their own writing.
- Product opportunities must pass the profitable-pocket test: a SPECIFIC person
  with a SPECIFIC problem they are ALREADY trying to fix. "People who want better
  credit" is a category and fails. "Someone 60 days from a mortgage application
  with two collections they have already disputed once" is a pocket.
- Mark exactly one opportunity as recommended: the one with the tightest pocket,
  not the largest audience.
- The dominant colours are given to you, measured from real images. Describe
  their roles; do not invent hex values or contradict them.
- Where the evidence is thin, say so plainly rather than writing something
  confident. An audit that overclaims gets the outreach ignored.`;

export async function runSynthesis(
  collected: CollectedAudit,
  extraction: ExtractionResult,
  options: PassOptions,
): Promise<{ audit: Audit; model: string }> {
  const complete = options.completeJsonFn ?? completeJSON;

  // Merge the chunks: dedupe repeated voice signals, keep every pain quote.
  const merged = {
    painSignals: extraction.chunks.flatMap((c) => c.painSignals),
    audienceSignals: extraction.chunks.flatMap((c) => c.audienceSignals),
    topics: extraction.chunks.flatMap((c) => c.topics),
    voice: {
      openings: unique(extraction.chunks.flatMap((c) => c.voiceSignals.openings)),
      closings: unique(extraction.chunks.flatMap((c) => c.voiceSignals.closings)),
      signaturePhrases: unique(extraction.chunks.flatMap((c) => c.voiceSignals.signaturePhrases)),
      emojis: unique(extraction.chunks.flatMap((c) => c.voiceSignals.emojis)),
      toneAdjectives: unique(extraction.chunks.flatMap((c) => c.voiceSignals.toneAdjectives)),
    },
  };

  options.log.info(
    `synthesis: ${merged.painSignals.length} pain signal(s), ${merged.audienceSignals.length} audience signal(s)`,
  );

  const { profile, palette, linkPages, summary } = collected;

  const { data, model } = await complete({
    system: SYNTHESIS_SYSTEM,
    prompt: [
      `CREATOR: @${profile.handle}${profile.displayName ? ` (${profile.displayName})` : ''} on ${profile.platform}`,
      `Followers: ${profile.followers?.toLocaleString() ?? 'unknown'}`,
      '',
      'BIO:',
      profile.bio?.slice(0, 2000) ?? '(empty)',
      '',
      collected.pinnedPosts.length
        ? `PINNED POSTS:\n${collected.pinnedPosts.map((p) => `- ${p.caption?.slice(0, 300)} (${p.url})`).join('\n')}`
        : 'PINNED POSTS: none identified',
      '',
      linkPages.filter((page) => page.ok).length
        ? `LINK-IN-BIO PAGES:\n${linkPages
            .filter((page) => page.ok)
            .map((page) => `# ${page.url}\n${page.text.slice(0, 3000)}`)
            .join('\n\n')}`
        : 'LINK-IN-BIO: not readable',
      '',
      palette.length
        ? `MEASURED PALETTE (from ${summary.imagesSampled} real post images — use these exact hex values):\n${palette
            .map((c) => `- ${c.hex} (${(c.share * 100).toFixed(1)}% of sampled pixels)`)
            .join('\n')}`
        : 'MEASURED PALETTE: no images could be sampled — return an empty dominantColors array.',
      '',
      `EXTRACTED SIGNALS (from ${summary.postsAnalysed} posts and ${summary.commentsAnalysed} comments):`,
      JSON.stringify(merged, null, 2).slice(0, 60_000),
      '',
      summary.gaps.length ? `KNOWN GAPS IN THE DATA:\n${summary.gaps.map((g) => `- ${g}`).join('\n')}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
    schema: auditSchema,
    schemaName: 'creator_audit',
    schemaDescription: 'The full partnership audit for this creator.',
    tier: 'heavy',
    label: `audit:synthesis:${profile.handle}`,
    temperature: 0.4,
    maxTokens: 16_000,
  });

  return { audit: data, model };
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))];
}
