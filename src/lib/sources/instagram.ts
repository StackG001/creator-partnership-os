import { getEnv } from '../env.js';
import { createLogger } from '../logger.js';

/**
 * Instagram has no official API for this, so profile/post/comment data comes
 * from Apify's `apify/instagram-scraper` actor (one actor covers all three
 * result types: details, posts, comments). Shared by finder and audit.
 */

const log = createLogger('sources:instagram');
const ACTOR = 'apify~instagram-scraper';

export interface InstagramProfile {
  username: string;
  fullName: string;
  biography: string;
  externalUrls: string[];
  followersCount: number;
  followsCount: number;
  postsCount: number;
  isBusinessAccount: boolean;
  verified: boolean;
  profilePicUrl: string;
  businessCategoryName: string | null;
}

export interface InstagramPost {
  id: string;
  url: string;
  type: string;
  caption: string;
  hashtags: string[];
  timestamp: string;
  likesCount: number;
  commentsCount: number;
  isPinned: boolean;
  displayUrl: string;
  images: string[];
  ownerUsername: string;
}

export interface InstagramComment {
  postUrl: string;
  text: string;
  ownerUsername: string;
  likesCount: number;
  timestamp: string;
}

async function runActor<T>(input: Record<string, unknown>): Promise<T[]> {
  const env = getEnv();
  if (!env.APIFY_TOKEN) {
    throw new Error('APIFY_TOKEN is not set — required to fetch Instagram data.');
  }

  const started = Date.now();
  const res = await fetch(
    `https://api.apify.com/v2/acts/${ACTOR}/run-sync-get-dataset-items`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.APIFY_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(input),
    },
  );

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `Apify instagram-scraper failed: HTTP ${res.status} ${res.statusText} ${body.slice(0, 500)}`,
    );
  }

  const items = (await res.json()) as T[];
  log.debug(`${input.resultsType} · ${items.length} item(s) · ${Date.now() - started}ms`);
  return items;
}

function profileUrl(username: string): string {
  return `https://www.instagram.com/${username}/`;
}

function toProfile(item: Record<string, unknown>, fallbackUsername: string): InstagramProfile {
  const externalUrls = Array.isArray(item.externalUrls)
    ? (item.externalUrls as unknown[])
        .map((entry) => (typeof entry === 'string' ? entry : (entry as { url?: string })?.url))
        .filter((url): url is string => Boolean(url))
    : [];

  return {
    username: String(item.username ?? fallbackUsername),
    fullName: String(item.fullName ?? ''),
    biography: String(item.biography ?? ''),
    externalUrls,
    followersCount: Number(item.followersCount ?? 0),
    followsCount: Number(item.followsCount ?? 0),
    postsCount: Number(item.postsCount ?? 0),
    isBusinessAccount: Boolean(item.isBusinessAccount),
    verified: Boolean(item.verified),
    profilePicUrl: String(item.profilePicUrlHD ?? item.profilePicUrl ?? ''),
    businessCategoryName: (item.businessCategoryName as string | null) ?? null,
  };
}

export async function fetchInstagramProfile(username: string): Promise<InstagramProfile> {
  const [item] = await runActor<Record<string, unknown>>({
    resultsType: 'details',
    directUrls: [profileUrl(username)],
    resultsLimit: 1,
  });

  if (!item) throw new Error(`No Instagram profile found for @${username}`);
  if (item.error) throw new Error(`Instagram profile @${username}: ${String(item.error)}`);

  return toProfile(item, username);
}

/**
 * Instagram has no public user-search API; this leans on the scraper actor's
 * `search` + `searchType: "user"` input (the same mechanism Instagram's own
 * search bar uses). Used by the finder for the IG_SEARCH source kind — a
 * plain keyword like "home barista" rather than a hashtag or a seed handle.
 */
export async function searchInstagramAccounts(
  query: string,
  limit: number,
): Promise<InstagramProfile[]> {
  const items = await runActor<Record<string, unknown>>({
    resultsType: 'details',
    search: query,
    searchType: 'user',
    searchLimit: limit,
    resultsLimit: limit,
  });

  return items
    .filter((item) => !item.error && typeof item.username === 'string')
    .map((item) => toProfile(item, String(item.username)));
}

/**
 * Best-effort "similar accounts" for the SIMILAR_TO source kind. Instagram
 * only surfaces related profiles for some accounts, and the scraper only
 * returns them when it can see them — an empty result here is a real
 * possibility, not a bug.
 */
export interface RelatedProfile {
  username: string;
  fullName: string;
  isPrivate: boolean;
}

export async function fetchInstagramRelatedProfiles(
  username: string,
  limit: number,
): Promise<RelatedProfile[]> {
  const [item] = await runActor<Record<string, unknown>>({
    resultsType: 'details',
    directUrls: [profileUrl(username)],
    resultsLimit: 1,
    addParentData: true,
  });

  if (!item || item.error) return [];

  const related = Array.isArray(item.relatedProfiles)
    ? (item.relatedProfiles as Record<string, unknown>[])
    : [];

  return related
    .filter((r) => typeof r.username === 'string')
    .slice(0, limit)
    .map((r) => ({
      username: String(r.username),
      fullName: String(r.fullName ?? r.full_name ?? ''),
      isPrivate: Boolean(r.isPrivate ?? r.is_private),
    }));
}

function toPost(item: Record<string, unknown>, fallbackOwner: string): InstagramPost {
  return {
    id: String(item.id),
    url: String(item.url ?? ''),
    type: String(item.type ?? 'Image'),
    caption: String(item.caption ?? ''),
    hashtags: Array.isArray(item.hashtags) ? (item.hashtags as string[]) : [],
    timestamp: String(item.timestamp ?? ''),
    likesCount: Number(item.likesCount ?? 0),
    commentsCount: Number(item.commentsCount ?? 0),
    isPinned: Boolean(item.isPinned),
    displayUrl: String(item.displayUrl ?? ''),
    images: Array.isArray(item.images)
      ? (item.images as string[])
      : item.displayUrl
        ? [String(item.displayUrl)]
        : [],
    ownerUsername: String(item.ownerUsername ?? fallbackOwner),
  };
}

export async function fetchInstagramPosts(
  username: string,
  limit: number,
): Promise<InstagramPost[]> {
  const items = await runActor<Record<string, unknown>>({
    resultsType: 'posts',
    directUrls: [profileUrl(username)],
    resultsLimit: limit,
  });

  return items
    .filter((item) => !item.error && typeof item.id === 'string')
    .map((item) => toPost(item, username));
}

/**
 * Posts under a hashtag, across every account using it — the finder's
 * HASHTAG source kind. `ownerUsername` on each post is the discovery signal;
 * the finder dedupes those into candidate handles.
 */
export async function searchInstagramHashtag(
  hashtag: string,
  limit: number,
): Promise<InstagramPost[]> {
  const tag = hashtag.replace(/^#/, '').trim();
  const items = await runActor<Record<string, unknown>>({
    resultsType: 'posts',
    directUrls: [`https://www.instagram.com/explore/tags/${encodeURIComponent(tag)}/`],
    resultsLimit: limit,
  });

  return items
    .filter((item) => !item.error && typeof item.id === 'string')
    .map((item) => toPost(item, 'unknown'));
}

/** Comments for a specific set of post URLs (used for the top-N best posts). */
export async function fetchInstagramComments(
  postUrls: string[],
  perPost = 30,
): Promise<InstagramComment[]> {
  if (!postUrls.length) return [];

  const items = await runActor<Record<string, unknown>>({
    resultsType: 'comments',
    directUrls: postUrls,
    resultsLimit: perPost,
  });

  return items
    .filter((item) => !item.error && typeof item.text === 'string')
    .map((item) => ({
      postUrl: String(item.postUrl ?? ''),
      text: String(item.text ?? ''),
      ownerUsername: String(item.ownerUsername ?? 'unknown'),
      likesCount: Number(item.likesCount ?? 0),
      timestamp: String(item.timestamp ?? ''),
    }));
}
