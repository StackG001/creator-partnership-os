import { pickLinkInBioUrl } from './linkInBio.js';

/**
 * Deterministic best-effort extraction of a creator's cross-platform links —
 * no additional API calls, no guessing by name. Everything here is pulled
 * from text/links the audit already fetched: bio, channel/video descriptions,
 * and the link-in-bio page's own text + anchor hrefs.
 */

export interface SocialLinks {
  youtubeUrl: string | null;
  instagramUrl: string | null;
  tiktokUrl: string | null;
  websiteUrl: string | null;
  businessEmail: string | null;
}

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const BUSINESS_EMAIL_HINT = /business|contact|hello|hey|partner|collab|press|management|inquir/i;

function findEmail(text: string): string | null {
  const matches = text.match(EMAIL_RE) ?? [];
  if (!matches.length) return null;
  return matches.find((m) => BUSINESS_EMAIL_HINT.test(m)) ?? matches[0]!;
}

function findProfileUrl(
  urls: string[],
  hosts: string[],
  excludePathPrefixes: string[] = [],
): string | null {
  for (const raw of urls) {
    try {
      const url = new URL(raw);
      const host = url.hostname.replace(/^www\./, '').toLowerCase();
      if (!hosts.some((h) => host === h || host.endsWith(`.${h}`))) continue;
      if (excludePathPrefixes.some((p) => url.pathname.toLowerCase().startsWith(p))) continue;
      const cleanPath = url.pathname.replace(/\/+$/, '');
      if (!cleanPath || cleanPath === '') continue; // bare host, not a profile
      return `${url.protocol}//${url.hostname}${cleanPath}`;
    } catch {
      // not a URL, skip
    }
  }
  return null;
}

export interface ResolveSocialLinksInput {
  platform: 'INSTAGRAM' | 'YOUTUBE';
  /** This creator's own canonical profile URL on the platform they were audited from. */
  canonicalUrl: string;
  /** Free text to search for an email: bio/description + the link-in-bio page text. */
  bioTexts: string[];
  /** Every URL seen anywhere: externalUrls, bio, post/video captions, link-in-bio hrefs. */
  candidateUrls: string[];
}

export function resolveSocialLinks(input: ResolveSocialLinksInput): SocialLinks {
  const { platform, canonicalUrl, bioTexts, candidateUrls } = input;

  const instagramUrl = findProfileUrl(candidateUrls, ['instagram.com'], [
    '/p/',
    '/reel/',
    '/reels/',
    '/explore/',
    '/accounts/',
    '/stories/',
    '/tv/',
  ]);
  const youtubeUrl = findProfileUrl(candidateUrls, ['youtube.com', 'youtu.be'], [
    '/watch',
    '/shorts/',
    '/playlist',
    '/embed/',
  ]);
  const tiktokUrl = findProfileUrl(candidateUrls, ['tiktok.com'], ['/video/']);

  return {
    youtubeUrl: platform === 'YOUTUBE' ? canonicalUrl : youtubeUrl,
    instagramUrl: platform === 'INSTAGRAM' ? canonicalUrl : instagramUrl,
    tiktokUrl,
    websiteUrl: pickLinkInBioUrl(candidateUrls),
    businessEmail: findEmail(bioTexts.join('\n')),
  };
}
