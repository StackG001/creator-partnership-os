import { HttpError, RateLimiter, query, requestJson, type FetchImpl } from '../../lib/http.js';
import { normalizeHandle } from '../../lib/paths.js';
import { extractEmail, extractLinks } from './product-signals.js';
import { POSTS_SAMPLED, type CommentMetric, type DiscoveredProfile, type PostMetric } from './types.js';

/**
 * YouTube Data API v3 backend.
 *
 * Four calls per run: search for channels, hydrate them in one batch, read each
 * channel's uploads playlist, then batch-fetch video statistics. Batching keeps
 * the daily quota manageable — search.list alone costs 100 units per call, so
 * we never call it per-creator.
 */

const BASE = 'https://www.googleapis.com/youtube/v3';

export interface YouTubeClientOptions {
  apiKey: string;
  fetchImpl?: FetchImpl;
  /** Overridden in tests so retries don't add real delay. */
  backoffMs?: number;
  minIntervalMs?: number;
}

interface SearchResponse {
  items?: Array<{ snippet?: { channelId?: string }; id?: { channelId?: string } }>;
  nextPageToken?: string;
}

interface ChannelResource {
  id?: string;
  snippet?: {
    title?: string;
    description?: string;
    customUrl?: string;
    country?: string;
    publishedAt?: string;
  };
  statistics?: {
    subscriberCount?: string;
    videoCount?: string;
    viewCount?: string;
    hiddenSubscriberCount?: boolean;
  };
  contentDetails?: { relatedPlaylists?: { uploads?: string } };
}

interface PlaylistItemsResponse {
  items?: Array<{ contentDetails?: { videoId?: string; videoPublishedAt?: string } }>;
  nextPageToken?: string;
}

interface VideosResponse {
  items?: Array<{
    id?: string;
    snippet?: {
      title?: string;
      description?: string;
      publishedAt?: string;
      thumbnails?: Record<string, { url?: string; width?: number }>;
    };
    statistics?: { viewCount?: string; likeCount?: string; commentCount?: string };
  }>;
}

interface CommentThreadsResponse {
  items?: Array<{
    snippet?: {
      topLevelComment?: {
        id?: string;
        snippet?: {
          textOriginal?: string;
          textDisplay?: string;
          likeCount?: number;
          publishedAt?: string;
          authorChannelId?: { value?: string };
        };
      };
    };
  }>;
}

/** Largest thumbnail available — more pixels means a truer palette. */
function bestThumbnail(thumbnails?: Record<string, { url?: string; width?: number }>): string | undefined {
  if (!thumbnails) return undefined;
  const sorted = Object.values(thumbnails)
    .filter((t): t is { url: string; width?: number } => Boolean(t?.url))
    .sort((a, b) => (b.width ?? 0) - (a.width ?? 0));
  return sorted[0]?.url;
}

/** API returns counts as strings; missing/hidden ones must stay undefined. */
function count(value?: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export class YouTubeClient {
  private readonly limiter: RateLimiter;

  constructor(private readonly options: YouTubeClientOptions) {
    this.limiter = new RateLimiter(options.minIntervalMs ?? 200);
  }

  private get<T>(path: string, params: Record<string, string | number | undefined>): Promise<T> {
    const url = `${BASE}/${path}?${query({ ...params, key: this.options.apiKey })}`;
    return requestJson<T>(url, {
      ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
      limiter: this.limiter,
      label: `youtube:${path}`,
      ...(this.options.backoffMs !== undefined ? { backoffMs: this.options.backoffMs } : {}),
    });
  }

  /** Channel ids matching a search phrase. Paginates until `limit` is reached. */
  async searchChannelIds(phrase: string, limit: number): Promise<string[]> {
    const ids: string[] = [];
    let pageToken: string | undefined;

    while (ids.length < limit) {
      const page: SearchResponse = await this.get('search', {
        part: 'snippet',
        type: 'channel',
        q: phrase,
        maxResults: Math.min(50, limit - ids.length),
        ...(pageToken ? { pageToken } : {}),
      });

      const found = (page.items ?? [])
        .map((item) => item.id?.channelId ?? item.snippet?.channelId)
        .filter((id): id is string => Boolean(id));

      if (!found.length) break;
      ids.push(...found);

      pageToken = page.nextPageToken;
      if (!pageToken) break;
    }

    return [...new Set(ids)].slice(0, limit);
  }

  /**
   * Hydrate channels, then attach their most recent videos. 50 per batch.
   * `postLimit` is 12 for discovery and up to 100 for an audit.
   */
  async fetchProfiles(channelIds: string[], postLimit = POSTS_SAMPLED): Promise<DiscoveredProfile[]> {
    const profiles: DiscoveredProfile[] = [];

    for (const batch of chunk(channelIds, 50)) {
      const response: { items?: ChannelResource[] } = await this.get('channels', {
        part: 'snippet,statistics,contentDetails',
        id: batch.join(','),
        maxResults: 50,
      });

      for (const channel of response.items ?? []) {
        const profile = this.toProfile(channel);
        if (profile) profiles.push(profile);
      }
    }

    // Videos are a separate round trip per channel's uploads playlist.
    for (const profile of profiles) {
      const uploads = (profile.raw as ChannelResource)?.contentDetails?.relatedPlaylists?.uploads;
      if (!uploads) continue;
      profile.posts = await this.fetchRecentVideos(uploads, postLimit);
    }

    return profiles;
  }

  private toProfile(channel: ChannelResource): DiscoveredProfile | undefined {
    const channelId = channel.id;
    if (!channelId) return undefined;

    const description = channel.snippet?.description ?? '';
    // customUrl is the @handle; fall back to the channel id, which is stable.
    const rawHandle = channel.snippet?.customUrl ?? channelId;

    let handle: string;
    try {
      handle = normalizeHandle(rawHandle);
    } catch {
      handle = normalizeHandle(channelId);
    }

    const subscriberCount = channel.statistics?.hiddenSubscriberCount
      ? undefined
      : count(channel.statistics?.subscriberCount);

    return {
      platform: 'YOUTUBE',
      handle,
      ...(channel.snippet?.title ? { displayName: channel.snippet.title } : {}),
      profileUrl: `https://www.youtube.com/channel/${channelId}`,
      ...(description ? { bio: description } : {}),
      ...(subscriberCount !== undefined ? { followers: subscriberCount } : {}),
      ...(count(channel.statistics?.videoCount) !== undefined
        ? { postCount: count(channel.statistics?.videoCount) as number }
        : {}),
      externalLinks: extractLinks(description),
      ...(extractEmail(description) ? { contactEmail: extractEmail(description) as string } : {}),
      ...(channel.snippet?.country ? { country: channel.snippet.country } : {}),
      posts: [],
      raw: channel,
    };
  }

  /** Uploads playlist -> video ids, paginating 50 at a time up to `limit`. */
  private async fetchVideoIds(uploadsPlaylistId: string, limit: number): Promise<string[]> {
    const ids: string[] = [];
    let pageToken: string | undefined;

    while (ids.length < limit) {
      const playlist: PlaylistItemsResponse = await this.get('playlistItems', {
        part: 'contentDetails',
        playlistId: uploadsPlaylistId,
        maxResults: Math.min(50, limit - ids.length),
        ...(pageToken ? { pageToken } : {}),
      });

      const page = (playlist.items ?? [])
        .map((item) => item.contentDetails?.videoId)
        .filter((id): id is string => Boolean(id));

      if (!page.length) break;
      ids.push(...page);

      pageToken = playlist.nextPageToken;
      if (!pageToken) break;
    }

    return ids.slice(0, limit);
  }

  private async fetchRecentVideos(
    uploadsPlaylistId: string,
    limit = POSTS_SAMPLED,
  ): Promise<PostMetric[]> {
    const videoIds = await this.fetchVideoIds(uploadsPlaylistId, limit);
    if (!videoIds.length) return [];

    const posts: PostMetric[] = [];
    for (const batch of chunk(videoIds, 50)) {
      const videos: VideosResponse = await this.get('videos', {
        part: 'snippet,statistics',
        id: batch.join(','),
      });

      for (const video of videos.items ?? []) {
        posts.push({
          id: video.id ?? '',
          url: video.id ? `https://www.youtube.com/watch?v=${video.id}` : undefined,
          // Title plus description: the description is where a creator puts
          // their calls to action and links, which the audit needs.
          caption: [video.snippet?.title, video.snippet?.description?.slice(0, 1200)]
            .filter(Boolean)
            .join('\n\n'),
          publishedAt: video.snippet?.publishedAt,
          views: count(video.statistics?.viewCount),
          likes: count(video.statistics?.likeCount),
          comments: count(video.statistics?.commentCount),
          imageUrl: bestThumbnail(video.snippet?.thumbnails),
        } as PostMetric);
      }
    }

    return posts;
  }

  /**
   * Top comments on one video, ordered by relevance — YouTube's own ranking
   * surfaces the questions an audience actually asks.
   *
   * Comments disabled on a video is normal and must not fail an audit, so a
   * 403 for that video resolves to an empty list.
   */
  async fetchComments(
    videoId: string,
    limit = 20,
    channelId?: string,
  ): Promise<CommentMetric[]> {
    let response: CommentThreadsResponse;
    try {
      response = await this.get('commentThreads', {
        part: 'snippet',
        videoId,
        maxResults: Math.min(100, limit),
        order: 'relevance',
        textFormat: 'plainText',
      });
    } catch (error) {
      if (error instanceof HttpError && (error.status === 403 || error.status === 404)) {
        return [];
      }
      throw error;
    }

    return (response.items ?? [])
      .map((thread) => {
        const comment = thread.snippet?.topLevelComment;
        const snippet = comment?.snippet;
        const text = snippet?.textOriginal ?? snippet?.textDisplay;
        if (!text) return undefined;
        return {
          id: comment?.id ?? '',
          text,
          likes: snippet?.likeCount,
          publishedAt: snippet?.publishedAt,
          byCreator: Boolean(channelId && snippet?.authorChannelId?.value === channelId),
        } as CommentMetric;
      })
      .filter((comment): comment is CommentMetric => Boolean(comment))
      .slice(0, limit);
  }
}
