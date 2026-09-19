import { getEnv } from '../env.js';
import { createLogger } from '../logger.js';

/**
 * YouTube Data API v3 fetchers: channel, recent uploads, top comments on the
 * best-performing videos. Shared by finder and audit.
 */

const log = createLogger('sources:youtube');
const API = 'https://www.googleapis.com/youtube/v3';

export interface YoutubeChannel {
  channelId: string;
  title: string;
  description: string;
  customUrl: string;
  uploadsPlaylistId: string;
  subscriberCount: number;
  videoCount: number;
  viewCount: number;
  thumbnailUrl: string;
}

export interface YoutubeVideo {
  id: string;
  title: string;
  description: string;
  publishedAt: string;
  viewCount: number;
  likeCount: number;
  commentCount: number;
  url: string;
  thumbnailUrl: string;
}

export interface YoutubeComment {
  videoId: string;
  text: string;
  authorName: string;
  likeCount: number;
  publishedAt: string;
}

async function apiGet<T>(path: string, params: Record<string, string>): Promise<T> {
  const env = getEnv();
  if (!env.YOUTUBE_API_KEY) {
    throw new Error('YOUTUBE_API_KEY is not set — required to fetch YouTube data.');
  }
  const url = new URL(`${API}/${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  url.searchParams.set('key', env.YOUTUBE_API_KEY);

  const started = Date.now();
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`YouTube API ${path} failed: HTTP ${res.status} ${body.slice(0, 500)}`);
  }
  log.debug(`${path} · ${Date.now() - started}ms`);
  return (await res.json()) as T;
}

/** How the caller identified the channel — a URL is parsed into one of these. */
export interface ChannelLookup {
  id?: string;
  handle?: string;
  username?: string;
  searchQuery?: string;
}

export function parseYoutubeInput(input: string): ChannelLookup {
  const idMatch = input.match(/\/channel\/(UC[\w-]{22})/) ?? input.match(/^(UC[\w-]{22})$/);
  if (idMatch) return { id: idMatch[1] };

  const handleMatch = input.match(/\/@([\w.-]+)/) ?? input.match(/^@([\w.-]+)$/);
  if (handleMatch) return { handle: `@${handleMatch[1]}` };

  const userMatch = input.match(/\/user\/([\w.-]+)/);
  if (userMatch) return { username: userMatch[1] };

  const customMatch = input.match(/\/c\/([\w.-]+)/);
  if (customMatch) return { searchQuery: customMatch[1] };

  return { searchQuery: input.replace(/^https?:\/\/(www\.)?youtube\.com\//i, '').replace(/\/$/, '') };
}

interface ChannelListItem {
  id: string;
  snippet: {
    title: string;
    description: string;
    customUrl?: string;
    thumbnails?: { high?: { url: string }; medium?: { url: string }; default?: { url: string } };
  };
  statistics: { subscriberCount?: string; videoCount?: string; viewCount?: string };
  contentDetails: { relatedPlaylists: { uploads: string } };
}

function toChannel(item: ChannelListItem): YoutubeChannel {
  return {
    channelId: item.id,
    title: item.snippet.title,
    description: item.snippet.description ?? '',
    customUrl: item.snippet.customUrl ?? '',
    uploadsPlaylistId: item.contentDetails.relatedPlaylists.uploads,
    subscriberCount: Number(item.statistics.subscriberCount ?? 0),
    videoCount: Number(item.statistics.videoCount ?? 0),
    viewCount: Number(item.statistics.viewCount ?? 0),
    thumbnailUrl:
      item.snippet.thumbnails?.high?.url ?? item.snippet.thumbnails?.default?.url ?? '',
  };
}

const CHANNEL_PARTS = 'snippet,statistics,contentDetails';

export async function fetchYoutubeChannel(lookup: ChannelLookup): Promise<YoutubeChannel> {
  if (lookup.id) {
    const data = await apiGet<{ items: ChannelListItem[] }>('channels', {
      part: CHANNEL_PARTS,
      id: lookup.id,
    });
    if (!data.items[0]) throw new Error(`No YouTube channel found for id ${lookup.id}`);
    return toChannel(data.items[0]);
  }

  if (lookup.handle) {
    const data = await apiGet<{ items: ChannelListItem[] }>('channels', {
      part: CHANNEL_PARTS,
      forHandle: lookup.handle,
    });
    if (!data.items[0]) throw new Error(`No YouTube channel found for handle ${lookup.handle}`);
    return toChannel(data.items[0]);
  }

  if (lookup.username) {
    const data = await apiGet<{ items: ChannelListItem[] }>('channels', {
      part: CHANNEL_PARTS,
      forUsername: lookup.username,
    });
    if (data.items[0]) return toChannel(data.items[0]);
    // Legacy /user/ URLs don't always resolve via forUsername — fall through to search.
  }

  const query = lookup.searchQuery ?? lookup.username ?? lookup.handle;
  if (!query) throw new Error('Could not resolve a YouTube channel from the given input.');

  const search = await apiGet<{ items: Array<{ id: { channelId: string } }> }>('search', {
    part: 'snippet',
    type: 'channel',
    q: query,
    maxResults: '1',
  });
  const channelId = search.items[0]?.id.channelId;
  if (!channelId) throw new Error(`No YouTube channel found for "${query}"`);
  return fetchYoutubeChannel({ id: channelId });
}

/** Channel search for the finder's YT_SEARCH source kind — a plain keyword. */
export async function searchYoutubeChannels(query: string, limit: number): Promise<YoutubeChannel[]> {
  const search = await apiGet<{ items: Array<{ id: { channelId: string } }> }>('search', {
    part: 'snippet',
    type: 'channel',
    q: query,
    maxResults: String(Math.min(50, Math.max(1, limit))),
  });

  const ids = [...new Set(search.items.map((item) => item.id.channelId).filter(Boolean))];
  if (!ids.length) return [];

  // search.list doesn't return subscriber/video counts — fetch those in batch.
  const channels: YoutubeChannel[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const data = await apiGet<{ items: ChannelListItem[] }>('channels', {
      part: CHANNEL_PARTS,
      id: batch.join(','),
    });
    channels.push(...data.items.map(toChannel));
  }
  return channels;
}

interface PlaylistItemsResponse {
  items: Array<{ contentDetails: { videoId: string } }>;
  nextPageToken?: string;
}

async function fetchUploadIds(uploadsPlaylistId: string, limit: number): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;

  while (ids.length < limit) {
    const data = await apiGet<PlaylistItemsResponse>('playlistItems', {
      part: 'contentDetails',
      playlistId: uploadsPlaylistId,
      maxResults: String(Math.min(50, limit - ids.length)),
      ...(pageToken ? { pageToken } : {}),
    });
    ids.push(...data.items.map((item) => item.contentDetails.videoId));
    if (!data.nextPageToken || data.items.length === 0) break;
    pageToken = data.nextPageToken;
  }

  return ids.slice(0, limit);
}

interface VideoListItem {
  id: string;
  snippet: { title: string; description: string; publishedAt: string; thumbnails?: { high?: { url: string } } };
  statistics: { viewCount?: string; likeCount?: string; commentCount?: string };
}

export async function fetchYoutubeVideos(
  uploadsPlaylistId: string,
  limit: number,
): Promise<YoutubeVideo[]> {
  const ids = await fetchUploadIds(uploadsPlaylistId, limit);
  const videos: YoutubeVideo[] = [];

  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const data = await apiGet<{ items: VideoListItem[] }>('videos', {
      part: 'snippet,statistics',
      id: batch.join(','),
    });
    videos.push(
      ...data.items.map((item) => ({
        id: item.id,
        title: item.snippet.title,
        description: item.snippet.description ?? '',
        publishedAt: item.snippet.publishedAt,
        viewCount: Number(item.statistics.viewCount ?? 0),
        likeCount: Number(item.statistics.likeCount ?? 0),
        commentCount: Number(item.statistics.commentCount ?? 0),
        url: `https://www.youtube.com/watch?v=${item.id}`,
        thumbnailUrl: item.snippet.thumbnails?.high?.url ?? '',
      })),
    );
  }

  return videos;
}

interface CommentThreadsResponse {
  items: Array<{
    snippet: {
      videoId: string;
      topLevelComment: {
        snippet: { textOriginal: string; authorDisplayName: string; likeCount: number; publishedAt: string };
      };
    };
  }>;
}

/** Top comments for a specific set of videos. Skips videos with comments disabled. */
export async function fetchYoutubeComments(
  videoIds: string[],
  perVideo = 20,
): Promise<YoutubeComment[]> {
  const comments: YoutubeComment[] = [];

  for (const videoId of videoIds) {
    try {
      const data = await apiGet<CommentThreadsResponse>('commentThreads', {
        part: 'snippet',
        videoId,
        maxResults: String(perVideo),
        order: 'relevance',
      });
      comments.push(
        ...data.items.map((item) => ({
          videoId,
          text: item.snippet.topLevelComment.snippet.textOriginal,
          authorName: item.snippet.topLevelComment.snippet.authorDisplayName,
          likeCount: item.snippet.topLevelComment.snippet.likeCount,
          publishedAt: item.snippet.topLevelComment.snippet.publishedAt,
        })),
      );
    } catch (error) {
      log.warn(`comments disabled or unavailable for video ${videoId}`, String(error));
    }
  }

  return comments;
}
