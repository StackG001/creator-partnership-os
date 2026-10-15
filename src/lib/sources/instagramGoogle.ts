import { getEnv } from '../env.js';
import { createLogger } from '../logger.js';

/**
 * Free pre-filter for Instagram discovery. Google (via Serper) indexes
 * Instagram profile pages with snippets like "45K Followers, 812 Following,
 * 1,204 Posts - See Instagram photos and videos from Jane (@jane)". We read the
 * follower count from the snippet and keep only accounts roughly in range, so
 * Apify is only paid to confirm profiles that are likely 10k–200k. Snippets are
 * stale and rounded, so the window is wider (IG_GOOGLE.minSnippet–maxSnippet)
 * and Apify's real count decides.
 */

const log = createLogger('sources:ig-google');

export const IG_GOOGLE = {
  /** Snippet follower window — wider than 10k–200k because snippets are stale/rounded. */
  minSnippet: 8_000,
  maxSnippet: 220_000,
  /** Google result pages per term (10 results each). Stops early on a page with no profiles. */
  maxPages: 3,
} as const;

// Paths that are Instagram pages but not profiles.
const NOT_PROFILES = new Set([
  'p', 'reel', 'reels', 'explore', 'stories', 'tv', 'accounts', 'about', 'directory', 'legal', 'developer',
  'web', 'challenge', 'privacy', 'terms', 'popular', 'topics', 'locations', 'tags', 'music',
]);
// A profile page, or one of its tabs (/handle/reels/ etc. — Google often indexes those).
const PROFILE_URL = /^https?:\/\/(?:www\.|[a-z]{2}\.)?instagram\.com\/([A-Za-z0-9._]{1,30})\/?(?:(?:reels|tagged|guides|channel)\/?)?(?:[?#].*)?$/i;

/** The Instagram handle a creator can be DMed at: their own (Instagram creators) or the one their YouTube links to. */
export function instagramDmHandle(c: { platform: string; handle: string; instagramUrl: string | null }): string | null {
  if (c.platform === 'INSTAGRAM') return c.handle;
  return c.instagramUrl ? profileHandle(c.instagramUrl) : null;
}

export function profileHandle(url: string): string | null {
  const m = PROFILE_URL.exec(url.trim());
  if (!m) return null;
  const handle = m[1]!.toLowerCase();
  return NOT_PROFILES.has(handle) ? null : handle;
}

/** "45K Followers", "1.2M followers", "12,345 Followers", "980 Followers" → number. Null when absent. */
export function followersFromSnippet(text: string): number | null {
  const m = /(\d[\d,.]*)\s*([KkMm])?\+?\s+followers\b/i.exec(text);
  if (!m) return null;
  const raw = m[1]!;
  const unit = m[2]?.toUpperCase();
  const n = unit ? Number(raw.replace(/,/g, '')) : Number(raw.replace(/[,.]/g, ''));
  if (!Number.isFinite(n)) return null;
  return Math.round(unit === 'M' ? n * 1_000_000 : unit === 'K' ? n * 1_000 : n);
}

export interface SnippetProfile {
  handle: string;
  followers: number;
  snippet: string;
}

export interface GoogleIgResult {
  serperSearches: number;
  profilesFound: number;
  kept: SnippetProfile[];
  droppedOutOfRange: number;
  droppedNoCount: number;
}

async function serper(q: string, page: number): Promise<Array<{ title?: string; link?: string; snippet?: string }>> {
  const env = getEnv();
  if (!env.SERPER_API_KEY) throw new Error('SERPER_API_KEY is not set — required for Instagram discovery.');
  const res = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'X-API-KEY': env.SERPER_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ q, num: 10, page }),
  });
  if (!res.ok) throw new Error(`Serper "${q}" page ${page}: HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
  const data = (await res.json()) as { organic?: Array<{ title?: string; link?: string; snippet?: string }> };
  return data.organic ?? [];
}

/** Google-search Instagram profiles for a term and keep the ones whose snippet shows ~10k–200k followers. */
export async function findInstagramProfilesOnGoogle(term: string): Promise<GoogleIgResult> {
  // Unquoted words find more profiles than an exact phrase; "followers" plus the -inurl
  // exclusions steer Google to profile pages (whose snippets carry the count), not posts.
  const words = term.replace(/^#/, '');
  const q = `site:instagram.com ${words} "followers" -inurl:p -inurl:reel -inurl:popular`;
  const out: GoogleIgResult = { serperSearches: 0, profilesFound: 0, kept: [], droppedOutOfRange: 0, droppedNoCount: 0 };
  const seen = new Set<string>();
  for (let page = 1; page <= IG_GOOGLE.maxPages; page++) {
    const results = await serper(q, page);
    out.serperSearches++;
    let profilesOnPage = 0;
    for (const r of results) {
      const handle = r.link ? profileHandle(r.link) : null;
      if (!handle || seen.has(handle)) continue;
      seen.add(handle);
      profilesOnPage++;
      out.profilesFound++;
      const followers = followersFromSnippet(`${r.snippet ?? ''} ${r.title ?? ''}`);
      if (followers === null) out.droppedNoCount++;
      else if (followers < IG_GOOGLE.minSnippet || followers > IG_GOOGLE.maxSnippet) out.droppedOutOfRange++;
      else out.kept.push({ handle, followers, snippet: (r.snippet ?? '').slice(0, 160) });
    }
    if (!profilesOnPage || results.length < 10) break;
  }
  log.info(
    `"${q}": ${out.serperSearches} Serper search(es), ${out.profilesFound} profile(s) — ${out.kept.length} kept (8k–220k in snippet), ${out.droppedOutOfRange} out of range, ${out.droppedNoCount} no follower count`,
  );
  return out;
}
