import type { FetchImpl } from './http.js';
import { createLogger } from './logger.js';

/**
 * Fetch a link-in-bio page and reduce it to readable text.
 *
 * A creator's Linktree/Stan/Beacons page is the single densest statement of
 * what they sell and what they want people to do next, so the audit reads it
 * directly rather than inferring from the bio.
 *
 * No HTML parser dependency: we only need visible text, and a tag-stripping
 * pass over the body is enough for the link pages these sites produce.
 */

const log = createLogger('page-text');

/** Elements whose contents are never visible prose. */
const INVISIBLE = /<(script|style|noscript|svg|head|template)\b[^>]*>[\s\S]*?<\/\1>/gi;

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  '#39': "'",
  apos: "'",
  nbsp: ' ',
};

export function htmlToText(html: string): string {
  return html
    .replace(INVISIBLE, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#?\w+);/g, (match, entity: string) => ENTITIES[entity.toLowerCase()] ?? match)
    .split('\n')
    .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
    .filter(Boolean)
    // Link pages repeat their button labels in markup; collapse runs of dupes.
    .filter((line, index, lines) => line !== lines[index - 1])
    .join('\n');
}

/** Every href on the page — where a link-in-bio page actually points. */
export function extractHrefs(html: string, base?: string): string[] {
  const hrefs = [...html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1] as string);
  const absolute = hrefs
    .filter((href) => !href.startsWith('#') && !href.startsWith('javascript:'))
    .map((href) => {
      try {
        return base ? new URL(href, base).toString() : href;
      } catch {
        return href;
      }
    });
  return [...new Set(absolute)];
}

export interface PageText {
  url: string;
  ok: boolean;
  text: string;
  links: string[];
  /** Why it could not be read, when ok is false. */
  error?: string;
}

/**
 * Best effort by design: a dead or blocked link-in-bio page must degrade the
 * audit, not fail it. Callers get `ok: false` and a reason they can surface.
 */
export async function fetchPageText(
  url: string,
  options: { fetchImpl?: FetchImpl; timeoutMs?: number; maxChars?: number } = {},
): Promise<PageText> {
  const { fetchImpl = fetch, timeoutMs = 15_000, maxChars = 8_000 } = options;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        signal: controller.signal,
        headers: {
          // Some link hosts serve a stub to unknown agents.
          'User-Agent': 'Mozilla/5.0 (compatible; CreatorPartnershipOS/0.1)',
          Accept: 'text/html,application/xhtml+xml',
        },
      });

      if (!response.ok) {
        return { url, ok: false, text: '', links: [], error: `HTTP ${response.status} ${response.statusText}`.trim() };
      }

      const html = await response.text();
      return {
        url,
        ok: true,
        text: htmlToText(html).slice(0, maxChars),
        links: extractHrefs(html, url),
      };
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    const message = (error as Error).name === 'AbortError' ? `timed out after ${timeoutMs}ms` : (error as Error).message;
    log.debug(`${url}: ${message}`);
    return { url, ok: false, text: '', links: [], error: message };
  }
}
