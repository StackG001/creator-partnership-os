import { z } from 'zod';
import { prisma } from '../../lib/db.js';
import { completeJSON } from '../../lib/llm.js';
import { fetchImages } from '../../lib/media.js';
import {
  creatorDir,
  ensureCreatorDir,
  normalizeHandle,
  toRelative,
  writeArtifact,
  writeJsonArtifact,
} from '../../lib/paths.js';
import { extractUrls, fetchPage, pickLinkInBioUrl } from '../../lib/sources/linkInBio.js';
import { resolveSocialLinks, type SocialLinks } from '../../lib/sources/socialLinks.js';
import { isSensitiveNiche, productLineFlags, SENSITIVE_PRODUCT_RULE } from '../../lib/productLine.js';
import {
  fetchInstagramComments,
  fetchInstagramPosts,
  fetchInstagramProfile,
  type InstagramComment,
} from '../../lib/sources/instagram.js';
import {
  fetchYoutubeChannel,
  fetchYoutubeComments,
  fetchYoutubeVideos,
  parseYoutubeInput,
  type YoutubeComment,
} from '../../lib/sources/youtube.js';
import { createLogger } from '../../lib/logger.js';
import { INSTAGRAM_AUDIT } from '../../lib/constants.js';
import { isCreatorName, isVerbatimIn, originForPlatform, refreshReviewFlag, resolveAuditQuotes, saveQuote } from '../../lib/quotes.js';
import fs from 'node:fs/promises';
import path from 'node:path';

const log = createLogger('audit');

// --- shapes shared across the pipeline --------------------------------------

/** One post/video, normalised across platforms. `ref` is stable across the whole run. */
interface UnifiedPost {
  ref: string;
  url: string;
  caption: string;
  timestamp: string;
  likeCount: number;
  commentCount: number;
  isPinned: boolean;
  imageUrl: string | null;
}

interface UnifiedComment {
  postRef: string;
  text: string;
  author: string;
  likeCount: number;
}

interface ProfileInfo {
  handle: string;
  displayName: string;
  bio: string;
  followers: number;
  postCount: number;
  externalUrls: string[];
  profilePicUrl: string;
}

export interface AuditResult {
  handle: string;
  auditId: string;
  opportunityScore: number;
  goldmineSignals: number;
  lowProductFit: boolean;
  productAngles: Array<{ title: string; promise: string; confidence: number }>;
  artifactPath: string;
  socialLinks: SocialLinks;
}

// --- zod schemas: extraction (pass 1, per chunk) ----------------------------

// The Goldmine filter: only comments revealing a hidden problem worth a digital
// product are extracted — never generic complaints or one-off frustrations.
export const GOLDMINE_SIGNAL_TYPES = [
  'RECURRING_UNANSWERED_QUESTION',
  'TRIED_EVERYTHING',
  'TRANSFORMATION_REQUEST',
  'SHAME_OR_EMBARRASSMENT',
  'WISH_SOMEONE_TOLD_ME',
] as const;

/** Fewer goldmine signals than this → low product-fit, no outreach. */
export const GOLDMINE_MIN = 3;
export const GOLDMINE_MAX = 8;

const PRODUCT_FORMATS = ['guide', 'planner', 'checklist', 'system', 'course module'] as const;

const GOLDMINE_FILTER = [
  'WHAT TO EXTRACT — THE GOLDMINE FILTER:',
  'Do NOT extract generic complaints, questions about products, or one-off frustrations. Only extract comments that pass the Goldmine Test — a hidden problem worth a digital product.',
  'Look specifically for these 5 signal types:',
  '1. RECURRING_UNANSWERED_QUESTION — a question that appears across multiple posts/videos that the creator\'s content never fully resolves. The creator keeps teaching but the same confusion keeps coming back. Note the question AND every post it repeats on. Example signal: "I\'ve watched all your videos and I still don\'t understand why my [X] isn\'t working".',
  '   Count this signal if 3 or more different commenters describe the same struggle or ask the same question — even if the exact words differ. A cluster of "confused / gave up / threw it out" comments about the same step counts as one strong recurring signal with multiple askers. Do NOT require the exact same wording — look for the same underlying problem. Record how many different commenters it covers in askerCount.',
  '2. TRIED_EVERYTHING — someone who has already spent time, money or effort trying to solve this and failed. A proven buyer who will pay again for something that actually works. Key phrases: "I\'ve tried everything", "nothing works for me", "I followed all the steps and still", "I bought [product] and it didn\'t help".',
  '3. TRANSFORMATION_REQUEST — someone begging for a packaged version of what the creator gives away in fragments: a plan, schedule, system, routine, checklist or step-by-step guide. Key phrases: "Can you make a full routine for", "I wish you had a plan for", "someone needs to make a guide for", "do you have a programme for".',
  '4. SHAME_OR_EMBARRASSMENT — comments revealing a problem people are embarrassed about, things they wouldn\'t say on most channels but trust this creator enough to admit. High emotional charge = high willingness to pay. Examples: hair loss, debt, relationship failure, health struggles, parenting shame, body image.',
  '   Also count self-blame phrasing regardless of topic — the person blames themself for being stuck: "I feel stupid", "sorry if this is obvious", "am I the only one who", "what am I doing wrong", "I must be doing something wrong", "is this a dumb question", "don\'t judge me but", "embarrassed to ask".',
  '5. WISH_SOMEONE_TOLD_ME — regret-based pain. They already paid the price of not knowing and will pay to shortcut it or finally fix it. Key phrases: "I wish I knew this earlier", "nobody tells you that", "I learned this the hard way", "if only I\'d found this sooner".',
  '',
  'CREATOR-VALIDATED ANGLE: If a goldmine signal directly matches the topic or title of one of the creator\'s top-performing videos (by likes or views), treat this as confirmed product demand. Boost that signal\'s priority score and flag it as creator_validated: true in the output. This is the strongest signal — the creator already proved the audience wants this content, the gap is a packaged product. Set validatedBy to the [Pn] of that top-performing post (it must be one listed under "Top-performing posts"); otherwise creator_validated: false and validatedBy: null.',
  'Only ONE signal per audit may be creator_validated: true — the strongest match. Every other signal gets creator_validated: false and validatedBy: null, even if it also matches a top post.',
  '',
  'QUOTE SOURCE: every goldmine quote must be a FOLLOWER\'s comment, copied verbatim. Never quote the creator\'s own caption, post text or their own replies in the comments (marked "creator\'s own reply") — the creator asking a question or describing a problem is not evidence that the audience has it. A signal can still stand if followers express the same pain: quote one of those follower comments. If no follower comment shows it, drop the signal.',
  '',
  'THE PRODUCT OPPORTUNITY TEST — score every signal against all three; include it ONLY if it passes all three:',
  '✓ The audience has already paid money trying to solve it, or would obviously pay to solve it.',
  '✓ The creator\'s free content does NOT fully solve it — there is a gap.',
  '✓ It can be packaged into a system, guide, plan or framework — not just more information.',
].join('\n');

const GoldmineFields = {
  signalType: z.enum(GOLDMINE_SIGNAL_TYPES),
  pain: z.string().describe('one-line paraphrase of the hidden problem'),
  quote: z.string().describe("exact follower comment, copied verbatim — never the creator's caption or own reply"),
  source: z.literal('comment').describe("always 'comment' — a follower's comment, never the creator's caption or reply"),
  postRef: z.string().describe('video/post reference: the [Pn] the quote came from'),
  repeatPostRefs: z
    .array(z.string())
    .describe('every [Pn] where the same problem shows up, including postRef'),
  whyItPasses: z
    .string()
    .describe('why it passes all three product-opportunity tests: paid/would pay, gap in free content, packageable'),
  productFormat: z.enum(PRODUCT_FORMATS),
  askerCount: z
    .number()
    .int()
    .min(1)
    .describe('how many different commenters describe this same underlying problem'),
  creator_validated: z
    .boolean()
    .describe("true when the signal matches the topic/title of one of the creator's top-performing posts"),
  validatedBy: z
    .string()
    .nullable()
    .describe('the [Pn] of the matching top-performing post, or null'),
};

const ExtractionSchema = z.object({
  goldmineSignals: z.array(z.object(GoldmineFields)).max(GOLDMINE_MAX),
  themes: z.array(z.string()).max(10),
  voiceSignals: z.object({
    toneAdjectives: z.array(z.string()).max(8),
    openers: z.array(z.string()).max(5),
    closers: z.array(z.string()).max(5),
    signaturePhrases: z.array(z.string()).max(8),
    neverUsesWords: z.array(z.string()).max(8),
    emojiUsage: z.string(),
    sentenceLengthNote: z.string(),
  }),
});
type Extraction = z.infer<typeof ExtractionSchema>;

// --- zod schemas: vision pass ------------------------------------------------

const VisualStyleSchema = z.object({
  dominantColors: z
    .array(z.object({ hex: z.string().regex(/^#[0-9a-fA-F]{6}$/), name: z.string() }))
    .min(3)
    .max(6),
  fontFeel: z.string(),
  layoutHabits: z.string(),
});
type VisualStyle = z.infer<typeof VisualStyleSchema>;

// --- zod schemas: synthesis (pass 2) ----------------------------------------

const ProductOpportunitySchema = z.object({
  title: z.string(),
  promise: z.string(),
  whoItsFor: z.string(),
  whyItFits: z.string(),
  solvesSignals: z
    .array(z.number().int().min(0))
    .describe('indexes into goldmineSignals this product solves'),
  score: z.number().min(0).max(10),
  priceBand: z.string(),
  recommended: z.boolean(),
});

/**
 * Score ceiling for a product, from how widely its goldmine signals repeat:
 * a problem seen once is interesting, a problem seen across 5+ posts (or
 * raised by 5+ different commenters) is a product. A creator-validated signal
 * lifts the ceiling to 10 — the creator's own best content already proved it.
 */
export function repeatScoreCap(posts: number): number {
  if (posts >= 5) return 10;
  if (posts >= 3) return 8;
  if (posts === 2) return 6.5;
  if (posts === 1) return 5;
  return 3;
}

function signalReach(signal: { postRef: string; repeatPostRefs: string[]; askerCount: number }): number {
  return Math.max(new Set([signal.postRef, ...signal.repeatPostRefs]).size, signal.askerCount);
}

type ValidatedSignal = { postRef: string; repeatPostRefs: string[]; askerCount: number; creator_validated: boolean };

/**
 * Only one signal per audit keeps creator_validated: the flagged one with the
 * widest reach (posts or commenters); ties go to the earlier, i.e. stronger-ranked, one.
 */
export function keptValidatedIndex(signals: ValidatedSignal[]): number {
  let best = -1;
  signals.forEach((g, i) => {
    if (g.creator_validated && (best < 0 || signalReach(g) > signalReach(signals[best]!))) best = i;
  });
  return best;
}

/** The creator's best posts by likes + 3×comments (the same weighting as bestPosts) — proof of what the audience wants. */
function topPerformingPosts(posts: UnifiedPost[], n = 8): UnifiedPost[] {
  return [...posts]
    .sort((a, b) => b.likeCount + b.commentCount * 3 - (a.likeCount + a.commentCount * 3))
    .slice(0, n);
}

function formatTopPosts(top: UnifiedPost[]): string {
  return top
    .map((p) => `[${p.ref}] ${p.likeCount} likes · ${p.commentCount} comments · ${p.caption.trim().split('\n')[0]!.slice(0, 140) || '(no caption)'}`)
    .join('\n');
}

/** Source texts the synthesis quotes are checked against: follower comments vs the creator's own captions and replies. */
interface QuoteProvenance {
  followerTexts: string[];
  creatorTexts: string[];
}

const synthesisSchema = (topRefs: Set<string>, provenance: QuoteProvenance) => z
  .object({
    niche: z.string().describe('one sentence'),
    audiencePersona: z.object({
      who: z.string(),
      situation: z.string(),
      triedAlready: z.string(),
    }),
    goldmineSignals: z
      .array(
        z.object({
          ...GoldmineFields,
          quote: z.string().describe('verbatim, taken from the goldmine evidence provided'),
        }),
      )
      .max(GOLDMINE_MAX),
    voiceGuide: z.object({
      toneAdjectives: z.array(z.string()).min(3).max(8),
      sentenceLength: z.string(),
      signaturePhrases: z.array(z.string()),
      neverUsesWords: z.array(z.string()),
      emojiUsage: z.string(),
      opensWith: z.string(),
      closesWith: z.string(),
    }),
    productOpportunities: z.array(ProductOpportunitySchema).length(5),
    hookLines: z.array(z.string()).length(10),
    partnershipPitchAngle: z.string(),
  })
  .refine((v) => v.productOpportunities.filter((p) => p.recommended).length === 1, {
    message: 'Exactly one productOpportunities entry must have recommended: true',
    path: ['productOpportunities'],
  })
  .superRefine((v, ctx) => {
    const kept = keptValidatedIndex(v.goldmineSignals);
    v.productOpportunities.forEach((p, i) => {
      const bad = p.solvesSignals.filter((n) => n >= v.goldmineSignals.length);
      if (bad.length) {
        ctx.addIssue({ code: 'custom', path: ['productOpportunities', i, 'solvesSignals'], message: `no goldmineSignals at index ${bad.join(', ')}` });
        return;
      }
      const solved = p.solvesSignals.map((n) => v.goldmineSignals[n]!);
      const reach = Math.max(0, ...solved.map(signalReach));
      const cap = p.solvesSignals.includes(kept) ? 10 : repeatScoreCap(reach);
      if (p.score > cap) {
        ctx.addIssue({
          code: 'custom',
          path: ['productOpportunities', i, 'score'],
          message: `"${p.title}" scores ${p.score} but its best signal repeats on ${reach} post(s)/commenter(s) and it doesn't solve the one creator-validated signal (index ${kept < 0 ? 'none' : kept}) — max ${cap}`,
        });
      }
    });
    v.goldmineSignals.forEach((g, i) => {
      if (g.creator_validated && (!g.validatedBy || !topRefs.has(g.validatedBy.replace(/[[\]]/g, '')))) {
        ctx.addIssue({
          code: 'custom',
          path: ['goldmineSignals', i, 'validatedBy'],
          message: `creator_validated needs validatedBy to be one of the top-performing posts (${[...topRefs].join(', ')})`,
        });
      }
      const fromFollower = provenance.followerTexts.some((t) => isVerbatimIn(g.quote, t));
      if (!fromFollower && provenance.creatorTexts.some((t) => isVerbatimIn(g.quote, t))) {
        ctx.addIssue({
          code: 'custom',
          path: ['goldmineSignals', i, 'quote'],
          message: "this quote is the creator's own caption or reply, not a follower comment — quote a follower comment showing the same pain, or drop the signal",
        });
      }
    });
  });
type Synthesis = z.infer<ReturnType<typeof synthesisSchema>>;

export interface AuditReport extends Synthesis {
  /** The goldmine quotes, in the shape outreach/product/funnel/quotes read. */
  top10Pains: Array<{ pain: string; quote: string; source: 'comment' | 'caption'; postRef: string }>;
  /** Fewer than GOLDMINE_MIN goldmine signals — outreach not recommended. */
  lowProductFit: boolean;
  visualStyle: VisualStyle;
}

// --- fetching ----------------------------------------------------------------

async function fetchInstagramSource(username: string, postCount: number) {
  const [profileRaw, posts] = await Promise.all([
    fetchInstagramProfile(username),
    fetchInstagramPosts(username, postCount),
  ]);

  const unified: UnifiedPost[] = posts.map((p, i) => ({
    ref: `P${i + 1}`,
    url: p.url,
    caption: p.caption,
    timestamp: p.timestamp,
    likeCount: p.likesCount,
    commentCount: p.commentsCount,
    isPinned: p.isPinned,
    imageUrl: p.images[0] ?? p.displayUrl ?? null,
  }));

  const profile: ProfileInfo = {
    handle: profileRaw.username,
    displayName: profileRaw.fullName,
    bio: profileRaw.biography,
    followers: profileRaw.followersCount,
    postCount: profileRaw.postsCount,
    externalUrls: profileRaw.externalUrls,
    profilePicUrl: profileRaw.profilePicUrl,
  };

  const fetchComments = async (_top: UnifiedPost[]): Promise<UnifiedComment[]> => {
    // Comments are the expensive part of an Instagram audit — sized by
    // INSTAGRAM_AUDIT, and only on the posts with the most comments: that's
    // where the audience asks for things.
    const byComments = [...unified].sort((a, b) => b.commentCount - a.commentCount).filter((p) => p.commentCount > 0);
    const raw: InstagramComment[] = await fetchInstagramComments(
      byComments.slice(0, INSTAGRAM_AUDIT.commentPosts).map((p) => p.url),
      INSTAGRAM_AUDIT.commentsPerPost,
    );
    const refByUrl = new Map(unified.map((p) => [p.url, p.ref]));
    return raw.map((c) => ({
      postRef: refByUrl.get(c.postUrl) ?? '?',
      text: c.text,
      author: c.ownerUsername,
      likeCount: c.likesCount,
    }));
  };

  return { profile, posts: unified, fetchComments };
}

async function fetchYoutubeSource(input: string, postCount: number) {
  const channel = await fetchYoutubeChannel(parseYoutubeInput(input));
  const videos = await fetchYoutubeVideos(channel.uploadsPlaylistId, postCount);

  const unified: UnifiedPost[] = videos.map((v, i) => ({
    ref: `P${i + 1}`,
    url: v.url,
    caption: `${v.title}\n\n${v.description}`,
    timestamp: v.publishedAt,
    likeCount: v.likeCount,
    commentCount: v.commentCount,
    isPinned: false,
    imageUrl: v.thumbnailUrl || null,
  }));

  const profile: ProfileInfo = {
    handle: channel.customUrl || channel.channelId,
    displayName: channel.title,
    bio: channel.description,
    followers: channel.subscriberCount,
    postCount: channel.videoCount,
    externalUrls: extractUrls(channel.description),
    profilePicUrl: channel.thumbnailUrl,
  };

  const fetchComments = async (top: UnifiedPost[]): Promise<UnifiedComment[]> => {
    const idByRef = new Map(top.map((p) => [p.url.split('v=')[1] ?? '', p.ref]));
    const raw: YoutubeComment[] = await fetchYoutubeComments([...idByRef.keys()], 15);
    return raw.map((c) => ({
      postRef: idByRef.get(c.videoId) ?? '?',
      text: c.text,
      author: c.authorName,
      likeCount: c.likeCount,
    }));
  };

  // Own-site links rarely live in the channel description; video descriptions
  // usually repeat the same URL (a lead magnet, an ebook, a shop).
  if (profile.externalUrls.length === 0) {
    const candidateUrls = unified.slice(0, 15).flatMap((p) => extractUrls(p.caption));
    const counts = new Map<string, number>();
    for (const url of candidateUrls) {
      try {
        const host = new URL(url).hostname.replace(/^www\./, '');
        counts.set(host, (counts.get(host) ?? 0) + 1);
      } catch {
        /* ignore malformed url */
      }
    }
    const topHost = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (topHost) {
      const match = candidateUrls.find((u) => u.includes(topHost));
      if (match) profile.externalUrls = [match];
    }
  }

  return { profile, posts: unified, fetchComments };
}

function bestPosts(posts: UnifiedPost[], n: number): UnifiedPost[] {
  const pinned = posts.filter((p) => p.isPinned);
  const rest = [...posts]
    .filter((p) => !p.isPinned)
    .sort((a, b) => b.likeCount + b.commentCount * 3 - (a.likeCount + a.commentCount * 3));
  return [...pinned, ...rest].slice(0, n);
}

function imageSpread(posts: UnifiedPost[], n: number): UnifiedPost[] {
  const withImages = posts.filter((p) => p.imageUrl);
  const pinned = withImages.filter((p) => p.isPinned);
  const top = bestPosts(withImages, n);
  const merged = [...pinned, ...top].filter(
    (p, i, arr) => arr.findIndex((x) => x.ref === p.ref) === i,
  );
  return merged.slice(0, n);
}

// --- pass 1: extraction ------------------------------------------------------

function formatPostsBlock(posts: UnifiedPost[], commentsByRef: Map<string, UnifiedComment[]>, creatorNames: string[]): string {
  return posts
    .map((p) => {
      const lines = [
        `[${p.ref}]${p.isPinned ? ' (pinned)' : ''} ${p.timestamp} · ${p.likeCount} likes · ${p.commentCount} comments`,
        `caption: ${p.caption.trim().slice(0, 1200) || '(no caption)'}`,
      ];
      const comments = commentsByRef.get(p.ref);
      if (comments?.length) {
        lines.push(
          `comments on ${p.ref}:`,
          ...comments
            .slice(0, 20)
            .map((c) =>
              isCreatorName(c.author, creatorNames)
                ? `  - (creator's own reply — not evidence) "${c.text.trim().slice(0, 300)}"`
                : `  - @${c.author || 'follower'}: "${c.text.trim().slice(0, 300)}"`,
            ),
        );
      }
      return lines.join('\n');
    })
    .join('\n\n');
}

async function runExtraction(
  chunk: UnifiedPost[],
  commentsByRef: Map<string, UnifiedComment[]>,
  niche: string,
  topPosts: UnifiedPost[],
  creatorNames: string[],
): Promise<Extraction> {
  const { data } = await completeJSON({
    system: [
      "You are a research analyst preparing a creator audit for Creator Partnership OS, an internal tool that finds micro-creators and builds them a done-for-you digital product.",
      'Extract evidence ONLY from the posts/comments given below. Never invent a quote — every goldmine "quote" must be copied verbatim from a follower comment provided (captions and the creator\'s own replies are context, never the quote).',
      GOLDMINE_FILTER,
      'goldmineSignals: only comments that pass the filter and all three tests, each tied to the [Pn] post it came from. Zero is a valid answer — never pad with weaker comments.',
      'Top-performing posts are listed for the CREATOR-VALIDATED ANGLE check: their comments may sit in another batch, so match on topic/title.',
      'themes: recurring topics/content pillars.',
      'voiceSignals: how this creator actually writes — tone, sentence rhythm, recurring phrases, words they avoid, emoji habits, typical openers/closers.',
    ].join('\n'),
    prompt: `Creator niche (approx): ${niche || 'unknown, infer from content'}\n\nTop-performing posts (by likes + comments, across the whole channel):\n${formatTopPosts(topPosts)}\n\nPosts:\n\n${formatPostsBlock(chunk, commentsByRef, creatorNames)}`,
    schema: ExtractionSchema,
    schemaName: 'extract_evidence',
    tier: 'default',
    label: 'audit:extraction',
    maxTokens: 4096,
  });
  return data;
}

function mergeExtractions(chunks: Extraction[]): Extraction {
  return {
    goldmineSignals: chunks.flatMap((c) => c.goldmineSignals),
    themes: [...new Set(chunks.flatMap((c) => c.themes))],
    voiceSignals: {
      toneAdjectives: [...new Set(chunks.flatMap((c) => c.voiceSignals.toneAdjectives))],
      openers: [...new Set(chunks.flatMap((c) => c.voiceSignals.openers))],
      closers: [...new Set(chunks.flatMap((c) => c.voiceSignals.closers))],
      signaturePhrases: [...new Set(chunks.flatMap((c) => c.voiceSignals.signaturePhrases))],
      neverUsesWords: [...new Set(chunks.flatMap((c) => c.voiceSignals.neverUsesWords))],
      emojiUsage: chunks.map((c) => c.voiceSignals.emojiUsage).join(' '),
      sentenceLengthNote: chunks.map((c) => c.voiceSignals.sentenceLengthNote).join(' '),
    },
  };
}

// --- vision pass --------------------------------------------------------------

async function runVisualStyle(images: { data: string; mediaType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif' }[]): Promise<VisualStyle> {
  if (images.length === 0) {
    return {
      dominantColors: [
        { hex: '#000000', name: 'unknown — no images available' },
        { hex: '#ffffff', name: 'unknown — no images available' },
        { hex: '#808080', name: 'unknown — no images available' },
      ],
      fontFeel: 'unknown — no images available',
      layoutHabits: 'unknown — no images available',
    };
  }

  const { data } = await completeJSON({
    system: 'You read a creator\'s post images and describe their visual brand: the colours they actually use, the feel of any text/type on-image, and layout habits (grid rhythm, cropping, whitespace, carousel structure).',
    prompt: 'These images are recent posts from one creator, in no particular order. Identify 3-6 dominant colours as hex codes (estimate from what you see), describe the font/type feel, and describe layout habits.',
    images,
    schema: VisualStyleSchema,
    schemaName: 'visual_style',
    tier: 'default',
    label: 'audit:visual-style',
    maxTokens: 1024,
  });
  return data;
}

// --- pass 2: synthesis ---------------------------------------------------------

async function runSynthesis(input: {
  profile: ProfileInfo;
  platform: 'INSTAGRAM' | 'YOUTUBE';
  linkInBioText: string | null;
  evidence: Extraction;
  topPosts: UnifiedPost[];
  sampleSize: number;
  provenance: QuoteProvenance;
}): Promise<Synthesis> {
  const { profile, platform, linkInBioText, evidence, topPosts, sampleSize, provenance } = input;

  const system = [
    'You are Gerald\'s research analyst at Creator Partnership OS.',
    'The system finds micro-creators (10k-200k followers, engaged niche audience, no digital product yet), audits them, writes them personalised outreach, and — if they agree to partner — builds them a 35-50 page research-backed digital product and funnel published on Whop with a revenue share.',
    'This audit is the evidence pack that everything downstream is built from: the pitch to the creator, the product angle, the product itself.',
    'Ground every claim in the evidence given.',
    GOLDMINE_FILTER,
    `goldmineSignals: re-check every candidate from the evidence against the filter and all three tests, merge near-duplicates (union their repeatPostRefs and add up askerCount — a problem that shows up across several posts or from several commenters is ONE signal with every post listed), keep creator_validated/validatedBy on at most ONE signal — the strongest real match to a top-performing post — and set it false/null on every other, quote only follower comments (never the creator's caption or own reply), and keep the strongest ${GOLDMINE_MIN}-${GOLDMINE_MAX}, creator-validated signals first, then strongest. quote must be copied verbatim from the evidence (do not paraphrase into the quote field — paraphrase goes in "pain"). If fewer than ${GOLDMINE_MIN} pass, return only those that do — never pad; the creator is then flagged low product-fit and gets no outreach.`,
    'hookLines must sound like this specific creator wrote them — use their real phrases, sentence rhythm and emoji habits from voiceGuide, not generic marketing copy.',
    'productOpportunities: exactly 5 candidate digital products this creator could sell to this audience, each listing the goldmineSignals (by index) it solves in solvesSignals. Exactly one must have recommended: true — the one with the best score.',
    'Scoring weights heavily toward REPEAT OCCURRENCE: a problem that appears once is interesting, a problem that appears across 5+ posts/videos is a product. Reach = the larger of the number of distinct posts (postRef + repeatPostRefs) and askerCount, for the widest-reaching signal a product solves. Hard ceilings: reach 0 → 3, 1 → 5, 2 → 6.5, 3-4 → 8, 5+ → 10. A product solving THE creator_validated signal has no ceiling below 10 and should be the recommended one unless another product clearly beats it. Within the ceiling, score higher for multiple signals solved and for TRIED_EVERYTHING / SHAME_OR_EMBARRASSMENT signals (proven willingness to pay).',
    `If the niche touches health, medical conditions, mental health or money: ${SENSITIVE_PRODUCT_RULE}`,
    'partnershipPitchAngle: the single sharpest insight to open outreach with — something that proves you actually looked at their content, not a template line.',
  ].join('\n');

  const prompt = [
    `Platform: ${platform}`,
    `Handle: @${profile.handle}`,
    `Display name: ${profile.displayName}`,
    `Followers: ${profile.followers}`,
    `Bio: ${profile.bio || '(empty)'}`,
    `Link-in-bio / site (${profile.externalUrls[0] ?? 'none found'}):\n${linkInBioText ?? '(not fetched or unavailable)'}`,
    '',
    `Content themes observed: ${evidence.themes.join(', ') || '(none extracted)'}`,
    '',
    `Voice signals:\n${JSON.stringify(evidence.voiceSignals, null, 2)}`,
    '',
    `Top-performing posts (by likes + comments) — the CREATOR-VALIDATED ANGLE check uses these:\n${formatTopPosts(topPosts)}`,
    '',
    `Goldmine evidence (${evidence.goldmineSignals.length} candidate signals, each tagged with its source post ref and the posts it repeats on):`,
    ...evidence.goldmineSignals.map(
      (q) =>
        `- ${q.signalType} [${q.postRef}] (${q.source}) "${q.quote}" — ${q.pain} · repeats on: ${q.repeatPostRefs.join(', ') || q.postRef} · askers: ${q.askerCount} · creator_validated: ${q.creator_validated}${q.validatedBy ? ` (${q.validatedBy})` : ''} · format: ${q.productFormat} · test: ${q.whyItPasses}`,
    ),
    '',
    `Sample size analysed: ${sampleSize} posts/videos.`,
  ].join('\n');

  const { data } = await completeJSON({
    system,
    prompt,
    schema: synthesisSchema(new Set(topPosts.map((p) => p.ref)), provenance),
    schemaName: 'audit_report',
    tier: 'heavy',
    label: 'audit:synthesis',
    maxTokens: 8192,
  });
  return data;
}

// --- markdown rendering --------------------------------------------------------

function renderMarkdown(report: AuditReport, meta: {
  handle: string;
  platform: string;
  displayName: string;
  followers: number;
  sampleSize: number;
  profileUrl: string;
  socialLinks: SocialLinks;
}): string {
  const lines: string[] = [];
  lines.push(`# Creator Audit: ${meta.displayName || meta.handle} (@${meta.handle})`);
  lines.push('');
  lines.push(`${meta.platform} · ${meta.followers.toLocaleString()} followers · ${meta.profileUrl}`);
  lines.push(`Sample: ${meta.sampleSize} posts/videos analysed.`);
  lines.push('');

  lines.push('## Social Links');
  lines.push('');
  const s = meta.socialLinks;
  lines.push(`- YouTube: ${s.youtubeUrl ?? '_not found_'}`);
  lines.push(`- Instagram: ${s.instagramUrl ?? '_not found_'}`);
  lines.push(`- TikTok: ${s.tiktokUrl ?? '_not found_'}`);
  lines.push(`- Website / link-in-bio: ${s.websiteUrl ?? '_not found_'}`);
  lines.push(`- Business email: ${s.businessEmail ?? '_not found_'}`);
  lines.push('');

  lines.push('## 1. Niche & Audience');
  lines.push('');
  lines.push(`**Niche:** ${report.niche}`);
  lines.push('');
  lines.push('**Audience persona:**');
  lines.push(`- Who: ${report.audiencePersona.who}`);
  lines.push(`- Situation: ${report.audiencePersona.situation}`);
  lines.push(`- Already tried: ${report.audiencePersona.triedAlready}`);
  lines.push('');

  lines.push('## 2. Goldmine Signals');
  lines.push('');
  if (report.lowProductFit) {
    lines.push(`> ⚠️ **Low product-fit** — only ${report.goldmineSignals.length} signal(s) passed the Goldmine Test (minimum ${GOLDMINE_MIN}). Outreach not recommended.`);
    lines.push('');
  }
  report.goldmineSignals.forEach((g, i) => {
    lines.push(`${i + 1}. **${g.pain}** — ${g.signalType}${g.creator_validated ? ` · ✅ creator-validated (${g.validatedBy})` : ''} · ${g.askerCount} asker(s) · reach ${signalReach(g)}`);
    lines.push(`   > "${g.quote}" — ${g.source} on [${g.postRef}]`);
    lines.push(`   - Seen on: ${[...new Set([g.postRef, ...g.repeatPostRefs])].join(', ')}`);
    lines.push(`   - Passes the test: ${g.whyItPasses}`);
    lines.push(`   - Product format: ${g.productFormat}`);
  });
  lines.push('');

  lines.push('## 3. Voice Guide');
  lines.push('');
  lines.push(`- Tone: ${report.voiceGuide.toneAdjectives.join(', ')}`);
  lines.push(`- Sentence length: ${report.voiceGuide.sentenceLength}`);
  lines.push(`- Signature phrases: ${report.voiceGuide.signaturePhrases.map((p) => `"${p}"`).join(', ') || '—'}`);
  lines.push(`- Never uses: ${report.voiceGuide.neverUsesWords.join(', ') || '—'}`);
  lines.push(`- Emoji usage: ${report.voiceGuide.emojiUsage}`);
  lines.push(`- Opens with: ${report.voiceGuide.opensWith}`);
  lines.push(`- Closes with: ${report.voiceGuide.closesWith}`);
  lines.push('');

  lines.push('## 4. Visual Style');
  lines.push('');
  lines.push('| Color | Hex |');
  lines.push('| --- | --- |');
  for (const c of report.visualStyle.dominantColors) {
    lines.push(`| ${c.name} | \`${c.hex}\` |`);
  }
  lines.push('');
  lines.push(`- Font feel: ${report.visualStyle.fontFeel}`);
  lines.push(`- Layout habits: ${report.visualStyle.layoutHabits}`);
  lines.push('');

  lines.push('## 5. Product Opportunities');
  lines.push('');
  report.productOpportunities
    .slice()
    .sort((a, b) => b.score - a.score)
    .forEach((p) => {
      lines.push(`### ${p.recommended ? '⭐ ' : ''}${p.title}${p.recommended ? ' (recommended)' : ''}`);
      lines.push(`- Promise: ${p.promise}`);
      lines.push(`- Who it's for: ${p.whoItsFor}`);
      lines.push(`- Why it fits: ${p.whyItFits}`);
      lines.push(`- Solves goldmine signals: ${p.solvesSignals.map((n) => n + 1).join(', ') || '—'}`);
      lines.push(`- Score: ${p.score}/10 · Price band: ${p.priceBand}`);
      lines.push('');
    });

  lines.push('## 6. Hook Lines');
  lines.push('');
  report.hookLines.forEach((h, i) => lines.push(`${i + 1}. ${h}`));
  lines.push('');

  lines.push('## 7. Partnership Pitch Angle');
  lines.push('');
  lines.push(report.partnershipPitchAngle);
  lines.push('');

  return lines.join('\n');
}

// --- orchestration -------------------------------------------------------------

export interface AuditOptions {
  postCount?: number;
  refresh?: boolean;
}

/**
 * Which platform(s) to try, in order. An unambiguous URL/channel-id is a
 * stronger signal than anything on file, so it wins outright. Otherwise this
 * is a bare handle — consult the Creator record the finder already wrote
 * (its `platform` field is authoritative) rather than guessing. Only when
 * there's no record, or its platform is unset/BOTH, do we fall back to
 * trying both networks at fetch time.
 */
async function resolvePlatformOrder(
  handleOrUrl: string,
  handle: string,
): Promise<Array<'INSTAGRAM' | 'YOUTUBE'>> {
  if (/youtube\.com|youtu\.be/i.test(handleOrUrl)) return ['YOUTUBE'];
  if (/instagram\.com/i.test(handleOrUrl)) return ['INSTAGRAM'];
  if (/^UC[\w-]{22}$/.test(handleOrUrl.trim())) return ['YOUTUBE'];

  const creator = await prisma.creator.findUnique({ where: { handle } });
  if (creator?.platform === 'YOUTUBE') return ['YOUTUBE'];
  if (creator?.platform === 'INSTAGRAM') return ['INSTAGRAM'];

  return ['YOUTUBE', 'INSTAGRAM'];
}

export async function auditCreator(
  handleOrUrl: string,
  options: AuditOptions = {},
): Promise<AuditResult> {
  const postCount = Math.min(100, Math.max(10, options.postCount ?? 60));
  const handle = normalizeHandle(handleOrUrl);
  const platformOrder = await resolvePlatformOrder(handleOrUrl, handle);

  const dir = await ensureCreatorDir(handle);
  const rawPath = path.join(dir, 'research', 'raw.json');

  const cached = options.refresh ? null : await readCache(rawPath);

  let platform: 'INSTAGRAM' | 'YOUTUBE';
  let profile: ProfileInfo;
  let posts: UnifiedPost[];
  let comments: UnifiedComment[];

  if (cached) {
    log.info(`using cached ${cached.platform.toLowerCase()} fetch (pass --refresh to re-fetch)`);
    platform = cached.platform;
    ({ profile, posts, comments } = cached);
  } else {
    let fetched: Awaited<ReturnType<typeof fetchYoutubeSource>> | undefined;
    let lastError: Error | undefined;
    platform = platformOrder[0]!;

    for (const candidate of platformOrder) {
      log.info(`fetching ${candidate.toLowerCase()} source for ${handleOrUrl} (${postCount} posts)`);
      try {
        fetched =
          candidate === 'INSTAGRAM'
            ? await fetchInstagramSource(
                normalizeUsername(handleOrUrl),
                options.postCount ? postCount : INSTAGRAM_AUDIT.posts,
              )
            : await fetchYoutubeSource(handleOrUrl, postCount);
        platform = candidate;
        break;
      } catch (error) {
        lastError = error as Error;
        if (platformOrder.length > 1) {
          log.warn(`${candidate.toLowerCase()} fetch failed for ${handleOrUrl}: ${lastError.message}`);
        }
      }
    }

    if (!fetched) throw lastError ?? new Error(`Could not fetch a source for ${handleOrUrl}`);

    const top = bestPosts(fetched.posts, 20);
    comments = await fetched.fetchComments(top);
    profile = fetched.profile;
    posts = fetched.posts;

    await fs.mkdir(path.dirname(rawPath), { recursive: true });
    await fs.writeFile(
      rawPath,
      JSON.stringify({ platform, profile, posts, top, comments }, null, 2),
      'utf8',
    );
  }

  const commentsByRef = new Map<string, UnifiedComment[]>();
  for (const c of comments) {
    const list = commentsByRef.get(c.postRef) ?? [];
    list.push(c);
    commentsByRef.set(c.postRef, list);
  }

  // --- pass 1: extraction, chunked ---
  const CHUNK_SIZE = 20;
  const chunks: UnifiedPost[][] = [];
  for (let i = 0; i < posts.length; i += CHUNK_SIZE) chunks.push(posts.slice(i, i + CHUNK_SIZE));

  const topPosts = topPerformingPosts(posts);
  const existing = await prisma.creator.findUnique({ where: { handle } });
  const creatorNames = [handle, existing?.displayName ?? '', profile.handle, profile.displayName];
  log.info(`extraction pass: ${chunks.length} chunk(s) over ${posts.length} posts`);
  const extractions = await Promise.all(
    chunks.map((chunk) => runExtraction(chunk, commentsByRef, profile.bio, topPosts, creatorNames)),
  );
  const evidence = mergeExtractions(extractions);

  // --- canonical profile url ---
  const canonicalUrl =
    platform === 'INSTAGRAM'
      ? `https://www.instagram.com/${handle}/`
      : profile.handle.startsWith('@')
        ? `https://www.youtube.com/${profile.handle}`
        : `https://www.youtube.com/channel/${profile.handle}`;

  // --- link-in-bio + social links ---
  const captionUrls = posts.flatMap((p) => extractUrls(p.caption));
  const candidateUrls = [...profile.externalUrls, ...extractUrls(profile.bio), ...captionUrls];

  const linkUrl = pickLinkInBioUrl(candidateUrls);
  const linkInBioPage = linkUrl ? await fetchPage(linkUrl) : null;
  const linkInBioText = linkInBioPage?.text ?? null;

  if (linkInBioPage) {
    candidateUrls.push(...linkInBioPage.links, ...(linkInBioText ? extractUrls(linkInBioText) : []));
  }

  const socialLinks = resolveSocialLinks({
    platform,
    canonicalUrl,
    bioTexts: [profile.bio, linkInBioText].filter((t): t is string => Boolean(t)),
    candidateUrls,
  });
  log.info(`social links resolved: ${JSON.stringify(socialLinks)}`);

  // --- vision pass ---
  const spread = imageSpread(posts, 8);
  log.info(`visual style pass: ${spread.length} image(s)`);
  const images = await fetchImages(spread.map((p) => p.imageUrl!).filter(Boolean));
  const visualStyle = await runVisualStyle(images);

  // --- pass 2: synthesis ---
  log.info('synthesis pass');
  const synthesis = await runSynthesis({
    profile,
    platform,
    linkInBioText,
    evidence,
    topPosts,
    sampleSize: posts.length,
    provenance: {
      followerTexts: comments.filter((c) => !isCreatorName(c.author, creatorNames)).map((c) => c.text),
      creatorTexts: [
        ...posts.map((p) => p.caption),
        ...comments.filter((c) => isCreatorName(c.author, creatorNames)).map((c) => c.text),
      ],
    },
  });

  // Only the single strongest creator-validated signal keeps the flag.
  const kept = keptValidatedIndex(synthesis.goldmineSignals);
  synthesis.goldmineSignals.forEach((g, i) => {
    if (i !== kept && g.creator_validated) Object.assign(g, { creator_validated: false, validatedBy: null });
  });

  const report: AuditReport = {
    ...synthesis,
    top10Pains: synthesis.goldmineSignals.map(({ pain, quote, source, postRef }) => ({ pain, quote, source, postRef })),
    lowProductFit: false,
    visualStyle,
  };

  // --- goldmine quotes: only follower comments traced word for word to a post URL count ---
  const traced = resolveAuditQuotes(report.top10Pains, { posts, comments }, creatorNames);
  const resolved = traced.resolved.filter((q) => q.authorType === 'FOLLOWER_COMMENT');
  const dropped = [
    ...traced.dropped,
    ...traced.resolved
      .filter((q) => q.authorType !== 'FOLLOWER_COMMENT')
      .map((q) => ({ quote: q.text, reason: "the creator's own caption or reply, not a follower comment" })),
  ];
  report.lowProductFit = resolved.length < GOLDMINE_MIN;
  if (report.lowProductFit) {
    log.warn(`@${handle} low product-fit: ${resolved.length} sourced goldmine signal(s), need ${GOLDMINE_MIN} — no outreach`);
  }
  const fullReport = { ...report, socialLinks };

  // --- write artifacts ---
  const markdown = renderMarkdown(report, {
    handle,
    platform,
    displayName: profile.displayName,
    followers: profile.followers,
    sampleSize: posts.length,
    profileUrl: canonicalUrl,
    socialLinks,
  });

  const mdPath = await writeArtifact(handle, 'audit', 'audit.md', markdown);
  await writeJsonArtifact(handle, 'audit', 'audit.json', fullReport);

  // --- persist ---
  const recommended = report.productOpportunities.find((p) => p.recommended)!;
  // Sensitive niches: flag any product idea that crosses from a lifestyle guide into advice.
  const productFlag = isSensitiveNiche(`${report.niche} ${existing?.niche ?? ''}`)
    ? report.productOpportunities
        .map((p) => ({ p, flags: productLineFlags(`${p.title} ${p.promise}`) }))
        .filter((x) => x.flags.length)
        .map((x) => `"${x.p.title}": ${x.flags.join(', ')}`)
        .join('; ') || null
    : null;
  if (productFlag) log.warn(`@${handle} product idea(s) cross the lifestyle-guide line — ${productFlag}`);
  // Never overwrite an email the pipeline already found with "not found".
  const businessEmail = socialLinks.businessEmail ?? existing?.businessEmail ?? null;
  const emailSource = socialLinks.businessEmail ? 'audit (bio / link-in-bio page)' : (existing?.emailSource ?? null);
  const fit = report.lowProductFit
    ? {
        status: 'DISQUALIFIED',
        disqualifiedFor: `low product-fit: ${resolved.length} sourced goldmine signal(s), need ${GOLDMINE_MIN}`,
      }
    : { status: 'AUDITED' };
  const creator = await prisma.creator.upsert({
    where: { handle },
    create: {
      handle,
      platform,
      displayName: profile.displayName,
      profileUrl: canonicalUrl,
      niche: report.niche,
      bio: profile.bio,
      followers: profile.followers,
      postCount: profile.postCount,
      ...fit,
      outputDir: toRelative(creatorDir(handle)),
      youtubeUrl: socialLinks.youtubeUrl,
      instagramUrl: socialLinks.instagramUrl,
      tiktokUrl: socialLinks.tiktokUrl,
      websiteUrl: socialLinks.websiteUrl,
      businessEmail,
      emailSource,
      productFlag,
    },
    update: {
      platform,
      displayName: profile.displayName,
      profileUrl: canonicalUrl,
      niche: report.niche,
      bio: profile.bio,
      followers: profile.followers,
      postCount: profile.postCount,
      ...fit,
      youtubeUrl: socialLinks.youtubeUrl,
      instagramUrl: socialLinks.instagramUrl,
      tiktokUrl: socialLinks.tiktokUrl,
      websiteUrl: socialLinks.websiteUrl,
      businessEmail,
      emailSource,
      productFlag,
    },
  });

  const audit = await prisma.audit.create({
    data: {
      creatorId: creator.id,
      summary: report.niche,
      audienceProfile: report.audiencePersona,
      painPoints: report.top10Pains,
      productAngles: report.productOpportunities,
      toneNotes: report.voiceGuide.toneAdjectives.join(', '),
      opportunityScore: Math.round(recommended.score * 10),
      confidence: Math.min(1, posts.length / postCount),
      sampleSize: posts.length,
      evidence: {
        linkInBioUrl: linkUrl,
        goldmineCandidates: evidence.goldmineSignals,
        themes: evidence.themes,
        lowProductFit: report.lowProductFit,
      },
      raw: JSON.parse(JSON.stringify(fullReport)),
      artifactPath: toRelative(mdPath),
      model: 'multi-pass (see raw)',
    },
  });

  for (const d of dropped) log.warn(`quote not saved (${d.reason}): "${d.quote.slice(0, 80)}"`);
  for (const q of resolved) {
    await saveQuote({ ...q, creatorId: creator.id, foundAt: audit.createdAt, origin: originForPlatform(platform), auditId: audit.id });
  }
  log.info(`${resolved.length} sourced quote(s) saved, ${dropped.length} dropped`);
  await refreshReviewFlag(creator);

  return {
    handle,
    auditId: audit.id,
    opportunityScore: audit.opportunityScore ?? 0,
    goldmineSignals: resolved.length,
    lowProductFit: report.lowProductFit,
    productAngles: report.productOpportunities.map((p) => ({
      title: p.title,
      promise: p.promise,
      confidence: p.score / 10,
    })),
    artifactPath: toRelative(mdPath),
    socialLinks,
  };
}

function normalizeUsername(input: string): string {
  return input
    .trim()
    .replace(/^https?:\/\/(www\.)?instagram\.com\//i, '')
    .replace(/^@+/, '')
    .replace(/\/+$/, '');
}

async function readCache(rawPath: string): Promise<{
  platform: 'INSTAGRAM' | 'YOUTUBE';
  profile: ProfileInfo;
  posts: UnifiedPost[];
  comments: UnifiedComment[];
} | null> {
  try {
    const text = await fs.readFile(rawPath, 'utf8');
    const parsed = JSON.parse(text) as {
      platform?: 'INSTAGRAM' | 'YOUTUBE';
      profile: ProfileInfo;
      posts: UnifiedPost[];
      comments: UnifiedComment[];
    };
    // Pre-fallback cache format didn't record which platform it came from —
    // refetch rather than guess.
    if (!parsed.platform) return null;
    return {
      platform: parsed.platform,
      profile: parsed.profile,
      posts: parsed.posts,
      comments: parsed.comments,
    };
  } catch {
    return null;
  }
}
