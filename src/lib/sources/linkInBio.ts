import { getEnv } from '../env.js';
import { createLogger } from '../logger.js';

/**
 * Best-effort text read of a creator's link-in-bio / personal site. These are
 * almost always JS-rendered (Linktree, Stan Store, Beacons, Squarespace), so
 * this uses Playwright rather than a raw fetch + HTML strip.
 */

const log = createLogger('sources:link-in-bio');

const IGNORED_HOSTS = [
  'instagram.com',
  'youtube.com',
  'youtu.be',
  'tiktok.com',
  'twitter.com',
  'x.com',
  'facebook.com',
  'threads.net',
  'snapchat.com',
  'pinterest.com',
  'amazon.com',
  'amzn.to',
  'apple.com',
  'spotify.com',
];

/** Pick the most likely "own site / link hub" URL out of a pile of candidate URLs. */
export function pickLinkInBioUrl(candidates: string[]): string | null {
  const byHost = new Map<string, string>();

  for (const raw of candidates) {
    try {
      const url = new URL(raw);
      const host = url.hostname.replace(/^www\./, '').toLowerCase();
      if (IGNORED_HOSTS.some((ignored) => host === ignored || host.endsWith(`.${ignored}`))) {
        continue;
      }
      if (!byHost.has(host)) byHost.set(host, `${url.protocol}//${url.hostname}`);
    } catch {
      // not a URL, skip
    }
  }

  return byHost.values().next().value ?? null;
}

/** Every http(s) URL found in a blob of free text (bios, video descriptions). */
export function extractUrls(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s)"'<>]+/g) ?? [];
  return matches;
}

export interface PageContent {
  text: string | null;
  /** Every anchor href on the page — the reliable way to find social icons whose
   *  visible label is just "Instagram", not the URL itself. */
  links: string[];
}

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractHrefs(html: string): string[] {
  return [...html.matchAll(/<a\b[^>]*href=["']([^"'#][^"']*)["']/gi)].map((m) => m[1]!);
}

/** Fast path: plain HTTP GET + regex parse. Works for server-rendered pages. */
async function fetchViaPlainFetch(url: string): Promise<PageContent | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html,application/xhtml+xml' },
    });
    if (!res.ok) return null;
    const html = await res.text();
    return { text: stripHtml(html).slice(0, 8000) || null, links: extractHrefs(html) };
  } catch {
    return null;
  }
}

/** Slow path: a real browser, for JS-rendered link-in-bio pages (Linktree, Stan, Beacons). */
async function fetchViaPlaywright(url: string, timeoutMs: number): Promise<PageContent | null> {
  const env = getEnv();
  try {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({
      ...(env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: env.PLAYWRIGHT_CHROMIUM_PATH } : {}),
    });
    try {
      const page = await browser.newPage();
      await page.goto(url, { waitUntil: 'networkidle', timeout: timeoutMs });
      const text = await page.evaluate(() => document.body?.innerText ?? '');
      const links = await page.$$eval('a[href]', (els) =>
        els.map((el) => (el as HTMLAnchorElement).href),
      );
      return { text: text.replace(/\n{3,}/g, '\n\n').trim().slice(0, 8000) || null, links };
    } finally {
      await browser.close();
    }
  } catch (error) {
    log.warn(`playwright could not read ${url}`, String(error));
    return null;
  }
}

/**
 * Reads a page's visible text and every link on it. Tries a plain fetch first
 * (fast, no browser dependency) and only falls back to Playwright when that
 * comes back too thin to be a real page — the common signal for a JS-rendered
 * SPA shell (Linktree, Stan Store, Beacons all render client-side).
 */
export async function fetchPage(url: string, timeoutMs = 20_000): Promise<PageContent> {
  const plain = await fetchViaPlainFetch(url);
  if (plain && (plain.text?.length ?? 0) > 300 && plain.links.length > 0) return plain;

  const rendered = await fetchViaPlaywright(url, timeoutMs);
  if (rendered && (rendered.text || rendered.links.length)) return rendered;

  return plain ?? { text: null, links: [] };
}
