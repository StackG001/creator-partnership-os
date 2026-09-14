import { RateLimiter, query, requestJson, type FetchImpl } from '../../lib/http.js';
import { normalizeHandle } from '../../lib/paths.js';
import { extractEmail, extractLinks } from './product-signals.js';
import { POSTS_SAMPLED, type DiscoveredProfile, type PostMetric } from './types.js';

/**
 * Instagram backend, via an Apify actor — there is no official API that returns
 * public profile metrics, so scraping through Apify is the practical route.
 *
 * Two passes, both through the actor's run-sync-get-dataset-items endpoint:
 *   1. search a hashtag for recent posts and collect their authors;
 *   2. fetch those authors' profiles with their last 12 posts.
 *
 * Actor output field names have shifted between versions, so every read below
 * accepts the known aliases and falls back to undefined rather than throwing.
 * `--actor` overrides the default if this ever points somewhere else.
 */

const BASE = 'https://api.apify.com/v2';
export const DEFAULT_ACTOR = 'apify~instagram-scraper';

export interface ApifyClientOptions {
  token: string;
  actor?: string;
  fetchImpl?: FetchImpl;
  backoffMs?: number;
  /** Apify runs are expensive; one per second is already generous. */
  minIntervalMs?: number;
  /** A sync actor run can legitimately take minutes. */
  timeoutMs?: number;
}

/** One dataset item — either a post (search pass) or a profile (details pass). */
interface ApifyItem {
  // profile shape
  username?: string;
  fullName?: string;
  biography?: string;
  externalUrl?: string;
  externalUrls?: Array<{ url?: string } | string>;
  followersCount?: number;
  followsCount?: number;
  postsCount?: number;
  publicEmail?: string;
  businessEmail?: string;
  latestPosts?: ApifyPost[];
  // post shape (search pass)
  ownerUsername?: string;
  error?: string;
}

interface ApifyPost {
  id?: string;
  shortCode?: string;
  url?: string;
  caption?: string;
  timestamp?: string;
  likesCount?: number;
  commentsCount?: number;
  videoViewCount?: number;
  videoPlayCount?: number;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** A phrase becomes a hashtag: "credit repair tips" -> "creditrepairtips". */
export function toHashtag(phrase: string): string {
  return phrase
    .trim()
    .replace(/^#/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function toPostMetric(post: ApifyPost): PostMetric {
  const shortCode = post.shortCode ?? post.id ?? '';
  return {
    id: shortCode,
    url: post.url ?? (shortCode ? `https://www.instagram.com/p/${shortCode}/` : undefined),
    caption: post.caption,
    publishedAt: post.timestamp,
    // Only video posts carry a view count; photos legitimately have none.
    views: num(post.videoPlayCount) ?? num(post.videoViewCount),
    likes: num(post.likesCount),
    comments: num(post.commentsCount),
  } as PostMetric;
}

export class InstagramClient {
  private readonly limiter: RateLimiter;
  private readonly actor: string;

  constructor(private readonly options: ApifyClientOptions) {
    this.limiter = new RateLimiter(options.minIntervalMs ?? 1_000);
    this.actor = options.actor ?? DEFAULT_ACTOR;
  }

  /** Run the actor synchronously and get its dataset items back in one call. */
  private run(input: Record<string, unknown>, label: string): Promise<ApifyItem[]> {
    const url = `${BASE}/acts/${this.actor}/run-sync-get-dataset-items?${query({
      token: this.options.token,
    })}`;

    return requestJson<ApifyItem[]>(url, {
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      },
      ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
      limiter: this.limiter,
      label: `apify:${label}`,
      timeoutMs: this.options.timeoutMs ?? 300_000,
      ...(this.options.backoffMs !== undefined ? { backoffMs: this.options.backoffMs } : {}),
    });
  }

  /**
   * Handles that posted recently under a hashtag. Returns them in first-seen
   * order — an account posting repeatedly under the tag surfaces early, which
   * is the behaviour we want.
   */
  async searchHandles(phrase: string, limit: number): Promise<string[]> {
    const hashtag = toHashtag(phrase);
    if (!hashtag) return [];

    const items = await this.run(
      {
        search: hashtag,
        searchType: 'hashtag',
        searchLimit: 1,
        resultsType: 'posts',
        // Over-fetch: many posts share an author, so posts != distinct handles.
        resultsLimit: Math.max(limit * 3, 30),
        addParentData: false,
      },
      `search:${hashtag}`,
    );

    const handles: string[] = [];
    const seen = new Set<string>();

    for (const item of items) {
      const raw = item.ownerUsername ?? item.username;
      if (!raw) continue;
      let handle: string;
      try {
        handle = normalizeHandle(raw);
      } catch {
        continue;
      }
      if (seen.has(handle)) continue;
      seen.add(handle);
      handles.push(handle);
      if (handles.length >= limit) break;
    }

    return handles;
  }

  /** Full profiles, with the last 12 posts, for a set of handles. */
  async fetchProfiles(handles: string[]): Promise<DiscoveredProfile[]> {
    if (!handles.length) return [];

    const items = await this.run(
      {
        directUrls: handles.map((h) => `https://www.instagram.com/${h}/`),
        resultsType: 'details',
        resultsLimit: POSTS_SAMPLED,
        addParentData: false,
      },
      `profiles:${handles.length}`,
    );

    const profiles: DiscoveredProfile[] = [];

    for (const item of items) {
      // The actor reports per-URL failures (private, deleted) as items.
      if (item.error || !item.username) continue;

      const biography = item.biography ?? '';
      const linkFields = [
        item.externalUrl,
        ...(item.externalUrls ?? []).map((entry) =>
          typeof entry === 'string' ? entry : entry?.url,
        ),
      ].filter((url): url is string => Boolean(url));

      const posts = (item.latestPosts ?? []).slice(0, POSTS_SAMPLED).map(toPostMetric);

      let handle: string;
      try {
        handle = normalizeHandle(item.username);
      } catch {
        continue;
      }

      const email = item.publicEmail ?? item.businessEmail ?? extractEmail(biography);

      profiles.push({
        platform: 'INSTAGRAM',
        handle,
        ...(item.fullName ? { displayName: item.fullName } : {}),
        profileUrl: `https://www.instagram.com/${handle}/`,
        ...(biography ? { bio: biography } : {}),
        ...(num(item.followersCount) !== undefined
          ? { followers: num(item.followersCount) as number }
          : {}),
        ...(num(item.followsCount) !== undefined
          ? { followingCount: num(item.followsCount) as number }
          : {}),
        ...(num(item.postsCount) !== undefined
          ? { postCount: num(item.postsCount) as number }
          : {}),
        // Bios list links as plain text as often as in the link field.
        externalLinks: [...new Set([...linkFields, ...extractLinks(biography)])],
        ...(email ? { contactEmail: email.toLowerCase() } : {}),
        posts,
        raw: item,
      });
    }

    return profiles;
  }
}
