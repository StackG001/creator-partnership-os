import { PRODUCT_SIGNALS } from '../../lib/constants.js';
import type { DiscoveredProfile } from './types.js';

/**
 * "Do they already sell something?" — the single most important filter in the
 * whole system. A creator with a storefront is not a prospect; a creator with
 * an engaged audience and nothing to sell it is the entire thesis.
 *
 * Every hit is recorded with the text that triggered it, so a false positive
 * can be argued with rather than guessed at. Stored on Creator.productEvidence.
 */

export interface ProductSignal {
  /** 'platform' — a storefront URL. 'keyword' — selling language in the bio. */
  kind: 'platform' | 'keyword';
  /** The pattern that matched, e.g. "gumroad.com". */
  match: string;
  /** Where we saw it. */
  where: 'bio' | 'link' | 'caption';
  /** The surrounding text or full URL, so a human can check the call. */
  evidence: string;
}

export interface ProductDetection {
  hasDigitalProduct: boolean;
  /** 0-1. Platform links are near-conclusive; bio keywords alone are not. */
  confidence: number;
  signals: ProductSignal[];
}

/** ~40 characters either side of the match, for a readable quote. */
function excerpt(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 40);
  const end = Math.min(text.length, index + length + 40);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`;
}

export function detectDigitalProduct(
  profile: Pick<DiscoveredProfile, 'bio' | 'externalLinks'> & {
    /**
     * Post captions / video descriptions. Creators routinely sell from these
     * and never mention it in the bio, so a bio-only check reports a clean
     * prospect for someone running a full storefront.
     */
    captions?: string[];
  },
): ProductDetection {
  const signals: ProductSignal[] = [];
  const bio = profile.bio ?? '';
  const haystack = bio.toLowerCase();
  const captions = (profile.captions ?? []).join('\n');
  const captionHaystack = captions.toLowerCase();

  // A storefront domain anywhere in the bio text or the linked URLs.
  for (const platform of PRODUCT_SIGNALS.platforms) {
    const needle = platform.toLowerCase();

    for (const link of profile.externalLinks) {
      if (link.toLowerCase().includes(needle)) {
        signals.push({ kind: 'platform', match: platform, where: 'link', evidence: link });
      }
    }

    const index = haystack.indexOf(needle);
    if (index !== -1) {
      signals.push({
        kind: 'platform',
        match: platform,
        where: 'bio',
        evidence: excerpt(bio, index, needle.length),
      });
    }

    // Captions contribute storefront URLs only. Running the keyword list over
    // a hundred captions would flag every creator who ever said "guide", but a
    // checkout link in a description is as conclusive as one in the bio.
    const captionIndex = captionHaystack.indexOf(needle);
    if (captionIndex !== -1) {
      signals.push({
        kind: 'platform',
        match: platform,
        where: 'caption',
        evidence: excerpt(captions, captionIndex, needle.length),
      });
    }
  }

  // Selling language in the bio. Word-boundary matched so "coursework" and
  // "guidelines" don't count as a course or a guide.
  for (const keyword of PRODUCT_SIGNALS.keywords) {
    const pattern = new RegExp(`\\b${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    const found = pattern.exec(bio);
    if (found) {
      signals.push({
        kind: 'keyword',
        match: keyword,
        where: 'bio',
        evidence: excerpt(bio, found.index, found[0].length),
      });
    }
  }

  const platformHits = signals.filter((s) => s.kind === 'platform').length;
  const keywordHits = signals.filter((s) => s.kind === 'keyword').length;

  // One storefront link is enough. Bio keywords alone are suggestive but weak —
  // "guide" shows up in plenty of bios that sell nothing — so two are required
  // before we rule a creator out on keywords alone.
  const hasDigitalProduct = platformHits > 0 || keywordHits >= 2;
  const confidence = platformHits > 0 ? Math.min(1, 0.8 + 0.1 * platformHits) : Math.min(0.6, 0.25 * keywordHits);

  return { hasDigitalProduct, confidence: Number(confidence.toFixed(2)), signals };
}

/** Public email addresses published in a bio/about text. */
const EMAIL_PATTERN = /[\w.+-]+@[\w-]+\.[\w.-]{2,}/g;

export function extractEmail(text?: string): string | undefined {
  if (!text) return undefined;
  const matches = text.match(EMAIL_PATTERN);
  if (!matches?.length) return undefined;
  // Skip image/CDN filenames that happen to look like addresses.
  const usable = matches.find((m) => !/\.(png|jpe?g|gif|webp)$/i.test(m));
  return usable?.toLowerCase();
}

/** Every URL in a block of text — bios often list links as plain text. */
const URL_PATTERN = /https?:\/\/[^\s,)"'<>]+|(?:www\.)[^\s,)"'<>]+/gi;

export function extractLinks(text?: string): string[] {
  if (!text) return [];
  return [...new Set(text.match(URL_PATTERN) ?? [])].map((url) => url.replace(/[.,;:]+$/, ''));
}
