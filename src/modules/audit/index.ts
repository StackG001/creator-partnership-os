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
  productAngles: Array<{ title: string; promise: string; confidence: number }>;
  artifactPath: string;
  socialLinks: SocialLinks;
}

// --- zod schemas: extraction (pass 1, per chunk) ----------------------------

const ExtractionSchema = z.object({
  painQuotes: z
    .array(
      z.object({
        pain: z.string().describe('one-line paraphrase of the pain point'),
        quote: z.string().describe('verbatim quote copied from the source text'),
        source: z.enum(['comment', 'caption']),
        postRef: z.string().describe('the [Pn] reference the quote came from'),
      }),
    )
    .max(15),
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
  score: z.number().min(0).max(10),
  priceBand: z.string(),
  recommended: z.boolean(),
});

const SynthesisSchema = z
  .object({
    niche: z.string().describe('one sentence'),
    audiencePersona: z.object({
      who: z.string(),
      situation: z.string(),
      triedAlready: z.string(),
    }),
    top10Pains: z
      .array(
        z.object({
          pain: z.string(),
          quote: z.string().describe('verbatim, taken from the evidence provided'),
          source: z.enum(['comment', 'caption']),
          postRef: z.string(),
        }),
      )
      .length(10),
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
  });
type Synthesis = z.infer<typeof SynthesisSchema>;

export interface AuditReport extends Synthesis {
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

  const fetchComments = async (top: UnifiedPost[]): Promise<UnifiedComment[]> => {
    const raw: InstagramComment[] = await fetchInstagramComments(
      top.map((p) => p.url),
      25,
    );
    const refByUrl = new Map(top.map((p) => [p.url, p.ref]));
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

function formatPostsBlock(posts: UnifiedPost[], commentsByRef: Map<string, UnifiedComment[]>): string {
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
          ...comments.slice(0, 20).map((c) => `  - "${c.text.trim().slice(0, 300)}"`),
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
): Promise<Extraction> {
  const { data } = await completeJSON({
    system: [
      "You are a research analyst preparing a creator audit for Creator Partnership OS, an internal tool that finds micro-creators and builds them a done-for-you digital product.",
      'Extract evidence ONLY from the posts/comments given below. Never invent a quote — every "quote" must be copied verbatim from the caption or comment text provided.',
      'painQuotes: real audience pain points, stated or clearly implied, each tied to the [Pn] post it came from.',
      'themes: recurring topics/content pillars.',
      'voiceSignals: how this creator actually writes — tone, sentence rhythm, recurring phrases, words they avoid, emoji habits, typical openers/closers.',
    ].join('\n'),
    prompt: `Creator niche (approx): ${niche || 'unknown, infer from content'}\n\nPosts:\n\n${formatPostsBlock(chunk, commentsByRef)}`,
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
    painQuotes: chunks.flatMap((c) => c.painQuotes),
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
  sampleSize: number;
}): Promise<Synthesis> {
  const { profile, platform, linkInBioText, evidence, sampleSize } = input;

  const system = [
    'You are Gerald\'s research analyst at Creator Partnership OS.',
    'The system finds micro-creators (10k-200k followers, engaged niche audience, no digital product yet), audits them, writes them personalised outreach, and — if they agree to partner — builds them a 35-50 page research-backed digital product and funnel published on Whop with a revenue share.',
    'This audit is the evidence pack that everything downstream is built from: the pitch to the creator, the product angle, the product itself.',
    'Ground every claim in the evidence given. top10Pains.quote must be copied verbatim from the painQuotes evidence (do not paraphrase into the quote field — paraphrase goes in "pain"). Pick and rank the strongest, most distinct 10; merge near-duplicates.',
    'hookLines must sound like this specific creator wrote them — use their real phrases, sentence rhythm and emoji habits from voiceGuide, not generic marketing copy.',
    'productOpportunities: exactly 5 candidate digital products this creator could sell to this audience. Exactly one must have recommended: true — the one with the best score.',
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
    `Pain point evidence (${evidence.painQuotes.length} quotes, each tagged with its source post ref):`,
    ...evidence.painQuotes.map((q) => `- [${q.postRef}] (${q.source}) "${q.quote}" — ${q.pain}`),
    '',
    `Sample size analysed: ${sampleSize} posts/videos.`,
  ].join('\n');

  const { data } = await completeJSON({
    system,
    prompt,
    schema: SynthesisSchema,
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

  lines.push('## 2. Top 10 Pains');
  lines.push('');
  report.top10Pains.forEach((p, i) => {
    lines.push(`${i + 1}. **${p.pain}**`);
    lines.push(`   > "${p.quote}" — ${p.source} on [${p.postRef}]`);
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
            ? await fetchInstagramSource(normalizeUsername(handleOrUrl), postCount)
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

  log.info(`extraction pass: ${chunks.length} chunk(s) over ${posts.length} posts`);
  const extractions = await Promise.all(
    chunks.map((chunk) => runExtraction(chunk, commentsByRef, profile.bio)),
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
    sampleSize: posts.length,
  });

  const report: AuditReport = { ...synthesis, visualStyle };
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
      status: 'AUDITED',
      outputDir: toRelative(creatorDir(handle)),
      youtubeUrl: socialLinks.youtubeUrl,
      instagramUrl: socialLinks.instagramUrl,
      tiktokUrl: socialLinks.tiktokUrl,
      websiteUrl: socialLinks.websiteUrl,
      businessEmail: socialLinks.businessEmail,
    },
    update: {
      niche: report.niche,
      bio: profile.bio,
      followers: profile.followers,
      postCount: profile.postCount,
      status: 'AUDITED',
      youtubeUrl: socialLinks.youtubeUrl,
      instagramUrl: socialLinks.instagramUrl,
      tiktokUrl: socialLinks.tiktokUrl,
      websiteUrl: socialLinks.websiteUrl,
      businessEmail: socialLinks.businessEmail,
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
      evidence: { linkInBioUrl: linkUrl, painQuotes: evidence.painQuotes, themes: evidence.themes },
      raw: JSON.parse(JSON.stringify(fullReport)),
      artifactPath: toRelative(mdPath),
      model: 'multi-pass (see raw)',
    },
  });

  return {
    handle,
    auditId: audit.id,
    opportunityScore: audit.opportunityScore ?? 0,
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
