import type { Creator, Source } from '@prisma/client';
import { prisma } from '../../lib/db.js';
import { createLogger } from '../../lib/logger.js';
import { IG_BRAND_CATEGORIES, QUALIFICATION } from '../../lib/constants.js';
import type { Platform, SourceKind } from '../../lib/constants.js';
import { ensureCreatorDir, normalizeHandle, toRelative } from '../../lib/paths.js';
import { extractUrls, fetchPage, pickLinkInBioUrl } from '../../lib/sources/linkInBio.js';
import { analyzeMonetization, type ProductSignalResult } from '../../lib/sources/productSignals.js';
import {
  fetchInstagramProfiles,
  fetchInstagramRelatedProfiles,
  searchInstagramAccounts,
  searchInstagramHashtag,
  type InstagramPost,
  type InstagramProfile,
} from '../../lib/sources/instagram.js';
import { ApifyBudgetError } from '../../lib/sources/apify.js';
import { findInstagramProfilesOnGoogle } from '../../lib/sources/instagramGoogle.js';
import {
  fetchYoutubeChannel,
  fetchYoutubeVideos,
  parseYoutubeInput,
  searchYoutubeChannels,
  type YoutubeChannel,
  type YoutubeVideo,
} from '../../lib/sources/youtube.js';

const log = createLogger('finder');

export interface FinderOptions {
  platform: Platform;
  query?: string;
  niche?: string;
  sourceId?: string;
  limit: number;
  minFollowers: number;
  maxFollowers: number;
  minEngagement: number;
  /**
   * Skip creators already in the database instead of refreshing them, so
   * `limit` counts only brand-new creators. The pipeline's daily cap relies on this.
   */
  newOnly?: boolean;
}

/** IG_GOOGLE only: what the free Google/Serper pre-filter did before anything was paid for. */
export interface PrefilterStats {
  serperSearches: number;
  profilesFound: number;
  snippetKept: number;
  droppedOutOfRange: number;
  droppedNoCount: number;
  alreadyKnown: number;
  sentToApify: number;
}

export interface FinderResult {
  sourceId: string;
  prefilter?: PrefilterStats;
  found: number;
  qualified: number;
  created: Creator[];
  skipped: Array<{ handle: string; reason: string }>;
}

// --- candidate shape, unified across platforms ------------------------------

interface Candidate {
  handle: string;
  platform: 'INSTAGRAM' | 'YOUTUBE';
  displayName: string;
  profileUrl: string;
  bio: string;
  followers: number;
  followingCount?: number;
  postCount: number;
  avgViews?: number;
  avgLikes: number;
  avgComments: number;
  engagementRate: number;
  postsPerWeek: number;
  externalUrls: string[];
  /** Instagram's business category ("Digital creator", "Product/service"…), when the account has one. */
  businessCategory?: string | null;
  /** The link-in-bio URL that stage 1 opened, when there was one. */
  linkInBioUrl?: string | null;
  raw: unknown;
}

// --- handles we've already paid to look at ---------------------------------------

/** Handles already in Creator or SeenHandle — never pay to scrape these again, from any search or niche. */
async function knownHandles(platform: 'INSTAGRAM' | 'YOUTUBE', handles: string[]): Promise<Set<string>> {
  if (!handles.length) return new Set();
  const [creators, seen] = await Promise.all([
    // A retired creator who was never messaged may be rediscovered by a new search;
    // everyone else in the database (incl. every do-not-contact creator) is known.
    prisma.creator.findMany({
      where: { handle: { in: handles }, NOT: { status: 'RETIRED', doNotContact: false } },
      select: { handle: true },
    }),
    prisma.seenHandle.findMany({ where: { platform, handle: { in: handles } }, select: { handle: true } }),
  ]);
  return new Set([...creators, ...seen].map((c) => c.handle));
}

async function markSeen(
  platform: 'INSTAGRAM' | 'YOUTUBE',
  handle: string,
  outcome: 'KEPT' | 'REJECTED',
  reason: string | null,
  sourceId: string,
): Promise<void> {
  await prisma.seenHandle.upsert({
    where: { platform_handle: { platform, handle } },
    create: { platform, handle, outcome, reason, sourceId },
    update: { outcome, reason },
  });
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function normalizeIgUsername(input: string): string {
  return input
    .trim()
    .replace(/^https?:\/\/(www\.)?instagram\.com\//i, '')
    .replace(/^@+/, '')
    .replace(/\/+$/, '');
}

function estimateCadence(timestamps: string[]): number {
  const dates = timestamps
    .map((t) => new Date(t).getTime())
    .filter((t) => !Number.isNaN(t))
    .sort((a, b) => b - a);
  if (dates.length < 2) return 0;
  const spanDays = (dates[0]! - dates[dates.length - 1]!) / 86_400_000;
  if (spanDays <= 0) return dates.length;
  return Number(((dates.length / spanDays) * 7).toFixed(2));
}

// --- classifying a query into a source kind ---------------------------------

function classifyQuery(query: string): 'hashtag' | 'seed' | 'keyword' {
  const trimmed = query.trim();
  if (trimmed.startsWith('#')) return 'hashtag';
  if (
    /^https?:\/\//i.test(trimmed) ||
    /instagram\.com|youtube\.com|youtu\.be/i.test(trimmed) ||
    /^@/.test(trimmed) ||
    /^UC[\w-]{22}$/.test(trimmed)
  ) {
    return 'seed';
  }
  return 'keyword';
}

async function resolveSource(options: FinderOptions): Promise<Source> {
  if (options.sourceId) {
    const existing = await prisma.source.findUnique({ where: { id: options.sourceId } });
    if (!existing) throw new Error(`No source found with id "${options.sourceId}"`);
    return existing;
  }

  const rawQuery = (options.query ?? options.niche ?? '').trim();
  if (!rawQuery) {
    throw new Error('Provide --query, --niche, or --source to run the finder.');
  }

  const shape = classifyQuery(rawQuery);
  const platform = options.platform;

  let kind: SourceKind;
  if (shape === 'hashtag') {
    if (platform === 'YOUTUBE') {
      throw new Error(
        'Hashtag discovery is Instagram-only — pass --platform instagram, or use a plain keyword for YouTube.',
      );
    }
    kind = 'HASHTAG';
  } else if (shape === 'seed') {
    kind = 'SIMILAR_TO';
  } else {
    kind = platform === 'YOUTUBE' ? 'YT_SEARCH' : 'IG_SEARCH';
  }

  const query = shape === 'hashtag' ? rawQuery.replace(/^#/, '').toLowerCase() : rawQuery;

  const existing = await prisma.source.findUnique({
    where: { platform_kind_query: { platform, kind, query } },
  });
  if (existing) return existing;

  return prisma.source.create({
    data: { platform, kind, query, niche: options.niche ?? null },
  });
}

// --- Instagram discovery ------------------------------------------------------

/**
 * Who to look at. IG_SEARCH already returns full profile details; hashtag and
 * similar-account sources only give usernames, which are looked up one
 * details result each. Every result is a paid Apify result, so this never
 * fetches more than it needs.
 */
async function collectInstagramProfiles(
  source: Source,
  wantCount: number,
): Promise<{ profiles: InstagramProfile[]; usernames: string[]; prefilter?: PrefilterStats }> {
  const overfetch = Math.max(wantCount * 3, wantCount + 10);

  if (source.kind === 'IG_GOOGLE') {
    const g = await findInstagramProfilesOnGoogle(source.query);
    return {
      profiles: [],
      usernames: g.kept.map((k) => k.handle),
      prefilter: {
        serperSearches: g.serperSearches,
        profilesFound: g.profilesFound,
        snippetKept: g.kept.length,
        droppedOutOfRange: g.droppedOutOfRange,
        droppedNoCount: g.droppedNoCount,
        alreadyKnown: 0,
        sentToApify: 0,
      },
    };
  }

  if (source.kind === 'HASHTAG') {
    const posts: InstagramPost[] = await searchInstagramHashtag(source.query, overfetch);
    return { profiles: [], usernames: dedupe(posts.map((p) => p.ownerUsername)).slice(0, overfetch) };
  }
  if (source.kind === 'IG_SEARCH') {
    return { profiles: await searchInstagramAccounts(source.query, overfetch), usernames: [] };
  }
  if (source.kind === 'SIMILAR_TO') {
    const seed = normalizeIgUsername(source.query);
    const related = await fetchInstagramRelatedProfiles(seed, overfetch);
    if (!related.length) {
      log.warn(
        `no related profiles returned for @${seed} — Instagram only exposes these for some accounts.`,
      );
    }
    return { profiles: [], usernames: dedupe(related.map((r) => r.username)) };
  }
  throw new Error(`Instagram discovery does not support source kind "${source.kind}".`);
}

function summarizeInstagram(posts: InstagramPost[], followers: number) {
  const recent = posts.slice(0, 12);
  const n = recent.length || 1;
  const avgLikes = Math.round(recent.reduce((s, p) => s + p.likesCount, 0) / n);
  const avgComments = Math.round(recent.reduce((s, p) => s + p.commentsCount, 0) / n);
  const engagementRate = followers > 0 ? (avgLikes + avgComments) / followers : 0;
  const postsPerWeek = estimateCadence(recent.map((p) => p.timestamp));
  return { avgLikes, avgComments, engagementRate, postsPerWeek };
}

async function discoverInstagram(
  source: Source,
  wantCount: number,
  newOnly: boolean,
): Promise<{ candidates: Candidate[]; prefilter?: PrefilterStats }> {
  const collected = await collectInstagramProfiles(source, wantCount);
  let usernames = collected.usernames;
  if (usernames.length) {
    // Never pay to look up anyone we've already looked at, from any search or niche
    // (always for Google-found handles; for other kinds when newOnly).
    if (newOnly || source.kind === 'IG_GOOGLE') {
      const known = await knownHandles('INSTAGRAM', usernames.map((u) => normalizeHandle(u)));
      const before = usernames.length;
      usernames = usernames.filter((u) => !known.has(normalizeHandle(u)));
      if (collected.prefilter) collected.prefilter.alreadyKnown = before - usernames.length;
      if (before > usernames.length) log.info(`skipped ${before - usernames.length} already-seen handle(s) before any paid lookup`);
    }
  }
  if (collected.prefilter) collected.prefilter.sentToApify = usernames.length;

  // One batched actor run for every username, not one run per profile.
  const profiles = [...collected.profiles];
  if (usernames.length) {
    try {
      profiles.push(...(await fetchInstagramProfiles(usernames)));
    } catch (error) {
      if (error instanceof ApifyBudgetError) throw error;
      log.warn(`profile lookup for ${usernames.length} handle(s) failed: ${(error as Error).message}`);
    }
  }

  const candidates: Candidate[] = [];
  for (const profile of profiles) {
    // Stage 1 is profile-only: the details result carries the latest ~12
    // posts, enough to measure engagement. No separate paid posts run here —
    // a profile without them is judged on what it has.
    const posts = profile.latestPosts;
    const stats = summarizeInstagram(posts, profile.followersCount);
    candidates.push({
      handle: normalizeHandle(profile.username),
      platform: 'INSTAGRAM',
      displayName: profile.fullName,
      profileUrl: `https://www.instagram.com/${profile.username}/`,
      bio: profile.biography,
      followers: profile.followersCount,
      followingCount: profile.followsCount,
      postCount: profile.postsCount,
      avgLikes: stats.avgLikes,
      avgComments: stats.avgComments,
      engagementRate: stats.engagementRate,
      postsPerWeek: stats.postsPerWeek,
      externalUrls: [...profile.externalUrls, ...posts.flatMap((p) => extractUrls(p.caption))],
      businessCategory: profile.businessCategoryName,
      linkInBioUrl: pickLinkInBioUrl(profile.externalUrls),
      raw: { profile, posts },
    });
  }

  return { candidates, prefilter: collected.prefilter };
}

// --- YouTube discovery ---------------------------------------------------------

async function collectYoutubeChannels(source: Source, wantCount: number): Promise<YoutubeChannel[]> {
  const overfetch = Math.max(wantCount * 3, wantCount + 10);

  if (source.kind === 'YT_SEARCH') {
    return searchYoutubeChannels(source.query, overfetch);
  }
  if (source.kind === 'SIMILAR_TO') {
    const seed = await fetchYoutubeChannel(parseYoutubeInput(source.query));
    const keywords = seed.title.split(/\s+/).slice(0, 4).join(' ');
    const results = await searchYoutubeChannels(keywords, overfetch + 1);
    return results.filter((c) => c.channelId !== seed.channelId).slice(0, overfetch);
  }
  throw new Error(`YouTube discovery does not support source kind "${source.kind}".`);
}

function summarizeYoutube(videos: YoutubeVideo[], subscribers: number) {
  const recent = videos.slice(0, 12);
  const n = recent.length || 1;
  const avgViews = Math.round(recent.reduce((s, v) => s + v.viewCount, 0) / n);
  const avgLikes = Math.round(recent.reduce((s, v) => s + v.likeCount, 0) / n);
  const avgComments = Math.round(recent.reduce((s, v) => s + v.commentCount, 0) / n);
  const engagementRate = subscribers > 0 ? (avgLikes + avgComments) / subscribers : 0;
  const postsPerWeek = estimateCadence(recent.map((v) => v.publishedAt));
  return { avgViews, avgLikes, avgComments, engagementRate, postsPerWeek };
}

function channelUrl(channel: YoutubeChannel): string {
  if (channel.customUrl) {
    const handle = channel.customUrl.startsWith('@') ? channel.customUrl : `@${channel.customUrl}`;
    return `https://www.youtube.com/${handle}`;
  }
  return `https://www.youtube.com/channel/${channel.channelId}`;
}

/** A YouTube channel's handle; a custom URL with no Latin characters (e.g. "@トレントン") falls back to the channel id. */
function youtubeHandle(c: { customUrl?: string | null; channelId: string }): string {
  if (c.customUrl) {
    try {
      return normalizeHandle(c.customUrl);
    } catch {
      // fall through to the channel id
    }
  }
  return normalizeHandle(c.channelId);
}

async function discoverYoutube(source: Source, wantCount: number, newOnly: boolean): Promise<Candidate[]> {
  let channels = await collectYoutubeChannels(source, wantCount);
  if (newOnly) {
    const known = await knownHandles('YOUTUBE', channels.map((c) => youtubeHandle(c)));
    channels = channels.filter((c) => !known.has(youtubeHandle(c)));
  }
  const candidates: Candidate[] = [];

  for (const channel of channels) {
    try {
      const videos = await fetchYoutubeVideos(channel.uploadsPlaylistId, 12);
      const stats = summarizeYoutube(videos, channel.subscriberCount);

      candidates.push({
        handle: youtubeHandle(channel),
        platform: 'YOUTUBE',
        displayName: channel.title,
        profileUrl: channelUrl(channel),
        bio: channel.description,
        followers: channel.subscriberCount,
        postCount: channel.videoCount,
        avgViews: stats.avgViews,
        avgLikes: stats.avgLikes,
        avgComments: stats.avgComments,
        engagementRate: stats.engagementRate,
        postsPerWeek: stats.postsPerWeek,
        externalUrls: [
          ...extractUrls(channel.description),
          ...videos.flatMap((v) => extractUrls(v.description)),
        ],
        raw: { channel, videos },
      });
    } catch (error) {
      log.warn(`skipping channel "${channel.title}": ${(error as Error).message}`);
    }
  }

  return candidates;
}

// --- qualification -------------------------------------------------------------

function evaluateQualification(
  candidate: Candidate,
  options: FinderOptions,
  signals: ProductSignalResult,
): { qualifies: boolean; reason?: string } {
  if (candidate.followers < options.minFollowers) {
    return {
      qualifies: false,
      reason: `followers ${candidate.followers} below minimum ${options.minFollowers}`,
    };
  }
  if (candidate.followers > options.maxFollowers) {
    return {
      qualifies: false,
      reason: `followers ${candidate.followers} above maximum ${options.maxFollowers}`,
    };
  }
  if (candidate.engagementRate < options.minEngagement) {
    return {
      qualifies: false,
      reason: `engagement rate ${(candidate.engagementRate * 100).toFixed(2)}% below minimum ${(options.minEngagement * 100).toFixed(2)}%`,
    };
  }
  if (candidate.businessCategory && IG_BRAND_CATEGORIES.test(candidate.businessCategory)) {
    return { qualifies: false, reason: `brand/business account (Instagram category "${candidate.businessCategory}")` };
  }
  if (signals.hasDigitalProduct) {
    return {
      qualifies: false,
      reason: `already sells a digital product (${signals.evidence[0] ?? 'signal found'})`,
    };
  }
  return { qualifies: true };
}

/** Money near a product word on a link page — "Sourdough Guide $19", "$27 · the course". */
const PRICED_PRODUCT =
  /\b(course|e-?book|guide|masterclass|template|workshop|program|class|bundle|printable)s?\b[^\n.]{0,40}[$£€]\s?\d|[$£€]\s?\d[^\n.]{0,40}\b(course|e-?book|guide|masterclass|template|workshop|program|class|bundle|printable)s?\b/i;

async function withLinkInBio(signals: ProductSignalResult, url: string): Promise<ProductSignalResult> {
  try {
    const page = await fetchPage(url, 15_000);
    const fromPage = analyzeMonetization(page.text ?? '', page.links);
    const priced = PRICED_PRODUCT.exec(page.text ?? '');
    const evidence = [
      ...signals.evidence,
      ...fromPage.evidence.map((e) => `link-in-bio ${url}: ${e}`),
      ...(priced ? [`link-in-bio ${url}: "${priced[0]}"`] : []),
    ];
    return {
      hasDigitalProduct: signals.hasDigitalProduct || fromPage.hasDigitalProduct || Boolean(priced),
      evidence,
      monetization: signals.monetization,
    };
  } catch (error) {
    log.warn(`link-in-bio ${url} could not be read (${(error as Error).message}) — judged on bio only`);
    return signals;
  }
}

// --- persistence -----------------------------------------------------------------

async function upsertCreator(
  candidate: Candidate,
  signals: ProductSignalResult,
  source: Source,
): Promise<Creator> {
  const dir = await ensureCreatorDir(candidate.handle);
  const existing = await prisma.creator.findUnique({ where: { handle: candidate.handle } });

  const shared = {
    platform: candidate.platform,
    displayName: candidate.displayName,
    profileUrl: candidate.profileUrl,
    bio: candidate.bio,
    followers: candidate.followers,
    followingCount: candidate.followingCount ?? null,
    postCount: candidate.postCount,
    avgViews: candidate.avgViews ?? null,
    avgLikes: candidate.avgLikes,
    avgComments: candidate.avgComments,
    engagementRate: candidate.engagementRate,
    postsPerWeek: candidate.postsPerWeek,
    metricsAt: new Date(),
    hasDigitalProduct: signals.hasDigitalProduct,
    productEvidence: signals.evidence,
    monetization: JSON.parse(JSON.stringify(signals.monetization)),
    raw: JSON.parse(JSON.stringify(candidate.raw)),
  };

  if (existing?.doNotContact) {
    throw new Error(`@${candidate.handle} is do-not-contact — never re-added`);
  }
  if (existing && existing.status === 'RETIRED') {
    // Rediscovered by the new pipeline: back in at DISCOVERED under the new source.
    // Their old quotes stay; any without a source still block drafting.
    log.info(`@${candidate.handle} (retired, never contacted) rediscovered — back in the pipeline`);
    return prisma.creator.update({
      where: { id: existing.id },
      data: {
        ...shared,
        status: 'DISCOVERED',
        sourceId: source.id,
        niche: source.niche ?? existing.niche,
        score: null,
        disqualifiedFor: null,
        retiredAt: null,
        retiredReason: null,
        outputDir: existing.outputDir ?? toRelative(dir),
      },
    });
  }
  if (existing) {
    return prisma.creator.update({
      where: { id: existing.id },
      data: {
        ...shared,
        niche: existing.niche ?? source.niche ?? null,
        // Re-running a source refreshes metrics without bouncing a creator
        // that has already moved past DISCOVERED back down the pipeline.
        sourceId: existing.sourceId ?? source.id,
        outputDir: existing.outputDir ?? toRelative(dir),
      },
    });
  }

  return prisma.creator.create({
    data: {
      handle: candidate.handle,
      status: 'DISCOVERED',
      sourceId: source.id,
      outputDir: toRelative(dir),
      niche: source.niche,
      ...shared,
    },
  });
}

// --- orchestration -----------------------------------------------------------------

/**
 * Pull candidates from a discovery source, apply the qualification window
 * (follower range, engagement floor, no existing digital product), and upsert
 * them as Creators with status DISCOVERED.
 */
export async function findCreators(options: FinderOptions): Promise<FinderResult> {
  const source = await resolveSource(options);
  log.info(`source: ${source.platform} ${source.kind} "${source.query}"`);

  const platforms: Array<'INSTAGRAM' | 'YOUTUBE'> =
    source.platform === 'BOTH' ? ['INSTAGRAM', 'YOUTUBE'] : [source.platform as 'INSTAGRAM' | 'YOUTUBE'];

  const candidates: Candidate[] = [];
  let prefilter: PrefilterStats | undefined;
  for (const platform of platforms) {
    try {
      if (platform === 'INSTAGRAM') {
        const r = await discoverInstagram(source, options.limit, Boolean(options.newOnly));
        candidates.push(...r.candidates);
        prefilter = r.prefilter;
      } else {
        candidates.push(...(await discoverYoutube(source, options.limit, Boolean(options.newOnly))));
      }
    } catch (error) {
      if (platforms.length > 1) {
        log.warn(`${platform} discovery skipped: ${(error as Error).message}`);
      } else {
        throw error;
      }
    }
  }

  const evaluated = [];
  for (const candidate of candidates) {
    let signals = analyzeMonetization(candidate.bio, candidate.externalUrls);
    let verdict = evaluateQualification(candidate, options, signals);
    // Stage 1, last check (free — a plain page fetch): open their link-in-bio
    // and drop anyone already selling a course, ebook, guide or paid product.
    if (verdict.qualifies && candidate.platform === 'INSTAGRAM' && candidate.linkInBioUrl) {
      signals = await withLinkInBio(signals, candidate.linkInBioUrl);
      verdict = evaluateQualification(candidate, options, signals);
    }
    evaluated.push({ candidate, signals, verdict });
  }

  const found = evaluated.length;
  const skipped = evaluated
    .filter((e) => !e.verdict.qualifies)
    .map((e) => ({ handle: e.candidate.handle, reason: e.verdict.reason! }));

  let qualifying = evaluated.filter((e) => e.verdict.qualifies);
  if (options.newOnly && qualifying.length) {
    const known = await prisma.creator.findMany({
      where: { handle: { in: qualifying.map((e) => e.candidate.handle) }, NOT: { status: 'RETIRED', doNotContact: false } },
      select: { handle: true },
    });
    const knownHandles = new Set(known.map((c) => c.handle));
    for (const e of qualifying) {
      if (knownHandles.has(e.candidate.handle)) {
        skipped.push({ handle: e.candidate.handle, reason: 'already in the database' });
      }
    }
    qualifying = qualifying.filter((e) => !knownHandles.has(e.candidate.handle));
  }

  const toPersist = qualifying.slice(0, options.limit);

  // Remember everyone we paid to look at, so no later search re-scrapes them.
  // Qualified-but-over-the-limit candidates aren't marked: a later run may want them.
  const kept = new Set(toPersist.map((e) => e.candidate.handle));
  const overflow = new Set(qualifying.slice(options.limit).map((e) => e.candidate.handle));
  for (const { candidate, verdict } of evaluated) {
    if (overflow.has(candidate.handle)) continue;
    await markSeen(
      candidate.platform,
      candidate.handle,
      kept.has(candidate.handle) ? 'KEPT' : 'REJECTED',
      verdict.reason ?? (kept.has(candidate.handle) ? null : 'already in the database'),
      source.id,
    );
  }

  const created: Creator[] = [];
  for (const { candidate, signals } of toPersist) {
    created.push(await upsertCreator(candidate, signals, source));
  }

  await prisma.source.update({
    where: { id: source.id },
    data: {
      lastRunAt: new Date(),
      runCount: { increment: 1 },
      foundCount: { increment: found },
      qualifiedCount: { increment: toPersist.length },
    },
  });

  log.info(`found ${found}, qualified ${toPersist.length}, upserted ${created.length}`);

  return { sourceId: source.id, ...(prefilter ? { prefilter } : {}), found, qualified: toPersist.length, created, skipped };
}
