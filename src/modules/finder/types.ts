import type { Platform } from '../../lib/constants.js';

/**
 * The shape every discovery backend normalises to. Instagram, YouTube and CSV
 * all produce this, so qualification, product detection and persistence are
 * written once and know nothing about where a creator came from.
 */

export interface CommentMetric {
  id: string;
  text: string;
  likes?: number;
  publishedAt?: string;
  /** True when the creator wrote it — evidence they reply to their audience. */
  byCreator?: boolean;
}

export interface PostMetric {
  id: string;
  url?: string;
  caption?: string;
  publishedAt?: string;
  views?: number;
  likes?: number;
  comments?: number;
  /** Thumbnail or post image, used for palette extraction. */
  imageUrl?: string;
  /** Best-effort: the platforms expose this inconsistently. */
  pinned?: boolean;
  /** Populated only by the audit's deeper fetch, not by discovery. */
  commentSample?: CommentMetric[];
}

export interface DiscoveredProfile {
  platform: Exclude<Platform, 'BOTH'>;
  /** Normalised, lowercase, no leading @. */
  handle: string;
  displayName?: string;
  profileUrl?: string;
  bio?: string;
  followers?: number;
  followingCount?: number;
  postCount?: number;
  /** Everything linked from the bio/about — the strongest product signal. */
  externalLinks: string[];
  /** Only ever a publicly published address. */
  contactEmail?: string;
  country?: string;
  /** Most recent posts/videos, newest first. Capped at POSTS_SAMPLED. */
  posts: PostMetric[];
  /** Untouched provider payload, stored on Creator.raw. */
  raw: unknown;
}

/** Posts pulled during discovery — enough to judge engagement cheaply. */
export const POSTS_SAMPLED = 12;

/** Posts pulled for an audit, where the brief asks for 50-100. */
export const AUDIT_POSTS_SAMPLED = 100;

export interface ProfileMetrics {
  avgViews?: number;
  avgLikes?: number;
  avgComments?: number;
  /**
   * Engagement per follower (0-1), not a percentage. Deliberately the same
   * formula on both platforms — (avg likes + avg comments) / followers — so a
   * YouTube channel and an Instagram account can sit in one sorted list.
   */
  engagementRate?: number;
  /**
   * Engagement per view (0-1): (avg likes + avg comments) / avg views. The
   * meaningful read on YouTube, where most viewers are not subscribers.
   * Undefined on Instagram photo posts, which report no view count.
   */
  engagementPerView?: number;
  postsPerWeek?: number;
}

/** Average of the values that are actually present; undefined if none are. */
function mean(values: Array<number | undefined>): number | undefined {
  const present = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  if (!present.length) return undefined;
  return present.reduce((sum, v) => sum + v, 0) / present.length;
}

/** Posting cadence from the spread of the sampled posts. */
function postsPerWeek(posts: PostMetric[]): number | undefined {
  const dates = posts
    .map((p) => (p.publishedAt ? Date.parse(p.publishedAt) : Number.NaN))
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => b - a);
  if (dates.length < 2) return undefined;

  const newest = dates[0] as number;
  const oldest = dates[dates.length - 1] as number;
  const weeks = (newest - oldest) / (7 * 24 * 60 * 60 * 1000);
  // All posts on one day tells us nothing about a weekly rate.
  if (weeks < 0.5) return undefined;
  return Number(((dates.length - 1) / weeks).toFixed(2));
}

export function computeMetrics(profile: DiscoveredProfile): ProfileMetrics {
  const avgViews = mean(profile.posts.map((p) => p.views));
  const avgLikes = mean(profile.posts.map((p) => p.likes));
  const avgComments = mean(profile.posts.map((p) => p.comments));

  const interactions = (avgLikes ?? 0) + (avgComments ?? 0);
  const engagementRate =
    profile.followers && profile.followers > 0 && (avgLikes !== undefined || avgComments !== undefined)
      ? Number((interactions / profile.followers).toFixed(5))
      : undefined;

  const engagementPerView =
    avgViews && avgViews > 0 && (avgLikes !== undefined || avgComments !== undefined)
      ? Number((interactions / avgViews).toFixed(5))
      : undefined;

  return {
    ...(avgViews !== undefined ? { avgViews: Math.round(avgViews) } : {}),
    ...(avgLikes !== undefined ? { avgLikes: Math.round(avgLikes) } : {}),
    ...(avgComments !== undefined ? { avgComments: Math.round(avgComments) } : {}),
    ...(engagementRate !== undefined ? { engagementRate } : {}),
    ...(engagementPerView !== undefined ? { engagementPerView } : {}),
    ...(postsPerWeek(profile.posts) !== undefined
      ? { postsPerWeek: postsPerWeek(profile.posts) as number }
      : {}),
  };
}
