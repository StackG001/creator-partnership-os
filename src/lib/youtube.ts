import { z } from 'zod';
import { getEnv } from './env.js';
import { createLogger } from './logger.js';
import { looksBlocked, proxyBlock, unblockFix } from './proxy.js';

/**
 * YouTube Data API v3 — the finder's and the audit's only source of truth about
 * a channel. Scraping youtube.com is deliberately not a fallback: it breaks
 * constantly and is blocked outright in hosted environments.
 *
 * Quota matters. The daily allowance is 10,000 units and the costs are wildly
 * uneven: `search.list` is 100 units per call while `channels.list`,
 * `playlistItems.list`, `videos.list` and `commentThreads.list` are 1 each. So
 * discovery by search is rationed and everything else is cheap — which is why
 * the finder prefers resolving a known channel over searching for one.
 */

const log = createLogger('youtube');
const API = 'https://www.googleapis.com/youtube/v3';

/** Quota units per call, for the budget the CLIs report. */
export const QUOTA_COST = { search: 100, channels: 1, playlistItems: 1, videos: 1, comments: 1 } as const;

export class YouTubeError extends Error {
  constructor(message: string, readonly retryable = false) {
    super(message);
    this.name = 'YouTubeError';
  }
}

function apiKey(): string {
  const key = getEnv().YOUTUBE_API_KEY;
  if (!key) {
    throw new YouTubeError(
      'YOUTUBE_API_KEY is not set. Add it with `npm run key -- --name YOUTUBE_API_KEY`.',
    );
  }
  return key;
}

const errorEnvelope = z.object({
  error: z.object({
    code: z.number(),
    message: z.string(),
    errors: z.array(z.object({ reason: z.string().optional() })).optional(),
  }),
});

/** One GET against the API, with the failure modes named rather than guessed. */
async function call<T>(resource: string, params: Record<string, string>, schema: z.ZodType<T>): Promise<T> {
  const url = new URL(`${API}/${resource}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('key', apiKey());

  let response: Response;
  try {
    response = await fetch(url);
  } catch (error) {
    const message = (error as Error).message;
    if (looksBlocked(message)) throw new YouTubeError(unblockFix('www.googleapis.com'));
    throw new YouTubeError(`Could not reach the YouTube API: ${message}`, true);
  }

  const blocked = await proxyBlock(response.clone());
  if (blocked) throw new YouTubeError(unblockFix('www.googleapis.com'));

  const body: unknown = await response.json().catch(() => ({}));

  if (!response.ok) {
    const parsed = errorEnvelope.safeParse(body);
    const message = parsed.success ? parsed.data.error.message : `HTTP ${response.status}`;
    const reason = parsed.success ? parsed.data.error.errors?.[0]?.reason : undefined;

    if (reason === 'quotaExceeded') {
      throw new YouTubeError('YouTube API quota exhausted for today — it resets at midnight Pacific.');
    }
    if (response.status === 400 && /API key not valid/i.test(message)) {
      throw new YouTubeError('YOUTUBE_API_KEY was rejected. Check it at console.cloud.google.com.');
    }
    if (response.status === 403) {
      throw new YouTubeError(
        `YouTube API refused the request: ${message}. Is "YouTube Data API v3" enabled for this key?`,
      );
    }
    throw new YouTubeError(`YouTube API error (HTTP ${response.status}): ${message}`, response.status >= 500);
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new YouTubeError(`Unexpected ${resource} response shape: ${parsed.error.issues[0]?.message}`);
  }
  return parsed.data;
}

// --- channels ----------------------------------------------------------------

const channelItem = z.object({
  id: z.string(),
  snippet: z.object({
    title: z.string(),
    description: z.string().default(''),
    customUrl: z.string().optional(),
    publishedAt: z.string().optional(),
    country: z.string().optional(),
    defaultLanguage: z.string().optional(),
    thumbnails: z.record(z.string(), z.object({ url: z.string() })).optional(),
  }),
  statistics: z.object({
    viewCount: z.string().optional(),
    subscriberCount: z.string().optional(),
    hiddenSubscriberCount: z.boolean().optional(),
    videoCount: z.string().optional(),
  }),
  contentDetails: z.object({
    relatedPlaylists: z.object({ uploads: z.string().optional() }),
  }),
});

const channelList = z.object({ items: z.array(channelItem).default([]) });

export interface Channel {
  id: string;
  title: string;
  handle?: string;
  description: string;
  publishedAt?: string;
  country?: string;
  language?: string;
  subscribers?: number;
  hiddenSubscribers: boolean;
  videoCount?: number;
  viewCount?: number;
  uploadsPlaylistId?: string;
  url: string;
}

const int = (v?: string): number | undefined => {
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

function toChannel(item: z.infer<typeof channelItem>): Channel {
  const handle = item.snippet.customUrl?.replace(/^@/, '');
  return {
    id: item.id,
    title: item.snippet.title,
    ...(handle ? { handle } : {}),
    description: item.snippet.description,
    ...(item.snippet.publishedAt ? { publishedAt: item.snippet.publishedAt } : {}),
    ...(item.snippet.country ? { country: item.snippet.country } : {}),
    ...(item.snippet.defaultLanguage ? { language: item.snippet.defaultLanguage } : {}),
    ...(int(item.statistics.subscriberCount) !== undefined
      ? { subscribers: int(item.statistics.subscriberCount) }
      : {}),
    hiddenSubscribers: item.statistics.hiddenSubscriberCount ?? false,
    ...(int(item.statistics.videoCount) !== undefined ? { videoCount: int(item.statistics.videoCount) } : {}),
    ...(int(item.statistics.viewCount) !== undefined ? { viewCount: int(item.statistics.viewCount) } : {}),
    ...(item.contentDetails.relatedPlaylists.uploads
      ? { uploadsPlaylistId: item.contentDetails.relatedPlaylists.uploads }
      : {}),
    url: `https://www.youtube.com/channel/${item.id}`,
  };
}

const CHANNEL_PARTS = 'snippet,statistics,contentDetails';

/**
 * Accepts whatever the user has to hand: a channel URL, a UC… id, an @handle,
 * or a bare handle. Returns undefined when YouTube knows of no such channel —
 * a deleted, suspended or private channel looks exactly like a typo here, and
 * the API will not say which.
 */
export async function resolveChannel(input: string): Promise<Channel | undefined> {
  const raw = input.trim();

  const byUrlId = raw.match(/youtube\.com\/channel\/(UC[\w-]{20,})/i)?.[1];
  const byUrlHandle = raw.match(/youtube\.com\/@([\w.-]+)/i)?.[1];
  const bareId = /^UC[\w-]{20,}$/.test(raw) ? raw : undefined;
  const handle = byUrlHandle ?? (raw.startsWith('@') ? raw.slice(1) : undefined);

  const id = byUrlId ?? bareId;
  if (id) {
    const { items } = await call('channels', { part: CHANNEL_PARTS, id }, channelList);
    return items[0] ? toChannel(items[0]) : undefined;
  }

  // forHandle is the documented lookup; a bare word is treated as one too,
  // since that is what a handle without its @ looks like.
  const candidate = handle ?? raw.replace(/^https?:\/\/(www\.)?youtube\.com\//i, '');
  if (!candidate) return undefined;

  const { items } = await call(
    'channels',
    { part: CHANNEL_PARTS, forHandle: candidate.replace(/^@/, '') },
    channelList,
  );
  return items[0] ? toChannel(items[0]) : undefined;
}

export async function getChannels(ids: string[]): Promise<Channel[]> {
  const out: Channel[] = [];
  // The API takes up to 50 ids per call, and each call is 1 unit either way.
  for (let i = 0; i < ids.length; i += 50) {
    const { items } = await call(
      'channels',
      { part: CHANNEL_PARTS, id: ids.slice(i, i + 50).join(',') },
      channelList,
    );
    out.push(...items.map(toChannel));
  }
  return out;
}

// --- search ------------------------------------------------------------------

const searchList = z.object({
  items: z
    .array(z.object({ snippet: z.object({ channelId: z.string() }).optional() }))
    .default([]),
});

/**
 * Channel discovery by keyword. 100 quota units per call — a hundred searches
 * exhaust the day — so the finder caps this and prefers cheaper paths.
 */
export async function searchChannelIds(query: string, limit: number): Promise<string[]> {
  const { items } = await call(
    'search',
    { part: 'snippet', type: 'channel', q: query, maxResults: String(Math.min(Math.max(limit, 1), 50)) },
    searchList,
  );
  const ids = items.map((i) => i.snippet?.channelId).filter((id): id is string => Boolean(id));
  log.debug(`search "${query}" → ${ids.length} channels (${QUOTA_COST.search} units)`);
  return [...new Set(ids)];
}

// --- videos ------------------------------------------------------------------

const playlistItems = z.object({
  items: z
    .array(z.object({ contentDetails: z.object({ videoId: z.string() }).optional() }))
    .default([]),
  nextPageToken: z.string().optional(),
});

const videoList = z.object({
  items: z
    .array(
      z.object({
        id: z.string(),
        snippet: z.object({
          title: z.string(),
          description: z.string().default(''),
          publishedAt: z.string(),
          tags: z.array(z.string()).optional(),
        }),
        statistics: z.object({
          viewCount: z.string().optional(),
          likeCount: z.string().optional(),
          commentCount: z.string().optional(),
        }),
        contentDetails: z.object({ duration: z.string().optional() }).optional(),
      }),
    )
    .default([]),
});

export interface Video {
  id: string;
  title: string;
  description: string;
  publishedAt: string;
  tags: string[];
  views: number;
  likes: number;
  comments: number;
  /** ISO 8601 duration, e.g. PT12M3S. Shorts are typically under a minute. */
  duration?: string;
  url: string;
}

/** Recent uploads with their stats. Costs 1 unit per 50 ids, twice over. */
export async function getRecentVideos(channel: Channel, limit: number): Promise<Video[]> {
  if (!channel.uploadsPlaylistId) return [];

  const ids: string[] = [];
  let pageToken: string | undefined;

  while (ids.length < limit) {
    const page = await call(
      'playlistItems',
      {
        part: 'contentDetails',
        playlistId: channel.uploadsPlaylistId,
        maxResults: String(Math.min(50, limit - ids.length)),
        ...(pageToken ? { pageToken } : {}),
      },
      playlistItems,
    );
    const pageIds = page.items.map((i) => i.contentDetails?.videoId).filter((v): v is string => Boolean(v));
    ids.push(...pageIds);
    if (!page.nextPageToken || pageIds.length === 0) break;
    pageToken = page.nextPageToken;
  }

  const videos: Video[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const { items } = await call(
      'videos',
      { part: 'snippet,statistics,contentDetails', id: ids.slice(i, i + 50).join(',') },
      videoList,
    );
    for (const v of items) {
      videos.push({
        id: v.id,
        title: v.snippet.title,
        description: v.snippet.description,
        publishedAt: v.snippet.publishedAt,
        tags: v.snippet.tags ?? [],
        views: int(v.statistics.viewCount) ?? 0,
        likes: int(v.statistics.likeCount) ?? 0,
        comments: int(v.statistics.commentCount) ?? 0,
        ...(v.contentDetails?.duration ? { duration: v.contentDetails.duration } : {}),
        url: `https://www.youtube.com/watch?v=${v.id}`,
      });
    }
  }
  return videos;
}

// --- comments ----------------------------------------------------------------

const commentThreads = z.object({
  items: z
    .array(
      z.object({
        snippet: z.object({
          topLevelComment: z.object({
            snippet: z.object({
              textOriginal: z.string().default(''),
              authorDisplayName: z.string().default(''),
              likeCount: z.number().default(0),
              publishedAt: z.string().optional(),
            }),
          }),
        }),
      }),
    )
    .default([]),
});

export interface Comment {
  videoId: string;
  text: string;
  author: string;
  likes: number;
  url: string;
}

/**
 * Top comments on one video. This is where audience pain points actually live,
 * so the audit leans on it heavily. Comments can be disabled per video, which
 * the API reports as a 403 — not an error worth aborting a run for.
 */
export async function getTopComments(videoId: string, limit: number): Promise<Comment[]> {
  try {
    const { items } = await call(
      'commentThreads',
      {
        part: 'snippet',
        videoId,
        order: 'relevance',
        maxResults: String(Math.min(Math.max(limit, 1), 100)),
        textFormat: 'plainText',
      },
      commentThreads,
    );
    return items.map((i) => {
      const c = i.snippet.topLevelComment.snippet;
      return {
        videoId,
        text: c.textOriginal,
        author: c.authorDisplayName,
        likes: c.likeCount,
        url: `https://www.youtube.com/watch?v=${videoId}&lc=`,
      };
    });
  } catch (error) {
    if (error instanceof YouTubeError && /refused the request/.test(error.message)) {
      log.debug(`comments disabled on ${videoId}`);
      return [];
    }
    throw error;
  }
}
