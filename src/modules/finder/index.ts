import type { Creator, Source } from '@prisma/client';
import { prisma } from '../../lib/db.js';
import { createLogger } from '../../lib/logger.js';
import { QUALIFICATION } from '../../lib/constants.js';
import type { Platform, SourceKind } from '../../lib/constants.js';
import { ensureCreatorDir, normalizeHandle, toRelative } from '../../lib/paths.js';
import { extractUrls } from '../../lib/sources/linkInBio.js';
import { analyzeMonetization, type ProductSignalResult } from '../../lib/sources/productSignals.js';
import {
  fetchInstagramProfile,
  fetchInstagramPosts,
  fetchInstagramRelatedProfiles,
  searchInstagramAccounts,
  searchInstagramHashtag,
  type InstagramPost,
} from '../../lib/sources/instagram.js';
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
}

export interface FinderResult {
  sourceId: string;
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
  raw: unknown;
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

async function collectInstagramUsernames(source: Source, wantCount: number): Promise<string[]> {
  const overfetch = Math.max(wantCount * 3, wantCount + 10);

  if (source.kind === 'HASHTAG') {
    const posts: InstagramPost[] = await searchInstagramHashtag(source.query, overfetch);
    return dedupe(posts.map((p) => p.ownerUsername)).slice(0, overfetch);
  }
  if (source.kind === 'IG_SEARCH') {
    const profiles = await searchInstagramAccounts(source.query, overfetch);
    return dedupe(profiles.map((p) => p.username)).slice(0, overfetch);
  }
  if (source.kind === 'SIMILAR_TO') {
    const seed = normalizeIgUsername(source.query);
    const related = await fetchInstagramRelatedProfiles(seed, overfetch);
    if (!related.length) {
      log.warn(
        `no related profiles returned for @${seed} — Instagram only exposes these for some accounts.`,
      );
    }
    return dedupe(related.map((r) => r.username));
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

async function discoverInstagram(source: Source, wantCount: number): Promise<Candidate[]> {
  const usernames = await collectInstagramUsernames(source, wantCount);
  const candidates: Candidate[] = [];

  for (const username of usernames) {
    try {
      const [profile, posts] = await Promise.all([
        fetchInstagramProfile(username),
        fetchInstagramPosts(username, 12),
      ]);
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
        raw: { profile, posts },
      });
    } catch (error) {
      log.warn(`skipping @${username}: ${(error as Error).message}`);
    }
  }

  return candidates;
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

async function discoverYoutube(source: Source, wantCount: number): Promise<Candidate[]> {
  const channels = await collectYoutubeChannels(source, wantCount);
  const candidates: Candidate[] = [];

  for (const channel of channels) {
    try {
      const videos = await fetchYoutubeVideos(channel.uploadsPlaylistId, 12);
      const stats = summarizeYoutube(videos, channel.subscriberCount);

      candidates.push({
        handle: normalizeHandle(channel.customUrl || channel.channelId),
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
  if (signals.hasDigitalProduct) {
    return {
      qualifies: false,
      reason: `already sells a digital product (${signals.evidence[0] ?? 'signal found'})`,
    };
  }
  return { qualifies: true };
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
  for (const platform of platforms) {
    try {
      const found =
        platform === 'INSTAGRAM'
          ? await discoverInstagram(source, options.limit)
          : await discoverYoutube(source, options.limit);
      candidates.push(...found);
    } catch (error) {
      if (platforms.length > 1) {
        log.warn(`${platform} discovery skipped: ${(error as Error).message}`);
      } else {
        throw error;
      }
    }
  }

  const evaluated = candidates.map((candidate) => {
    const signals = analyzeMonetization(candidate.bio, candidate.externalUrls);
    return { candidate, signals, verdict: evaluateQualification(candidate, options, signals) };
  });

  const found = evaluated.length;
  const skipped = evaluated
    .filter((e) => !e.verdict.qualifies)
    .map((e) => ({ handle: e.candidate.handle, reason: e.verdict.reason! }));

  const toPersist = evaluated.filter((e) => e.verdict.qualifies).slice(0, options.limit);

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

  return { sourceId: source.id, found, qualified: toPersist.length, created, skipped };
}
