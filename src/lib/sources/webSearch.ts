import { getEnv } from '../env.js';
import { createLogger } from '../logger.js';

/**
 * Web research for the product module's research stage. Serper (a Google
 * Search API wrapper) is the configured provider — Brave is the documented
 * alternative but no key is set for it here.
 */

const log = createLogger('sources:web-search');

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  position: number;
}

export async function webSearch(query: string, num = 10): Promise<SearchResult[]> {
  const env = getEnv();
  if (!env.SERPER_API_KEY) {
    throw new Error('SERPER_API_KEY is not set — required for product research.');
  }

  const started = Date.now();
  const res = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'X-API-KEY': env.SERPER_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: query, num }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Serper search failed for "${query}": HTTP ${res.status} ${body.slice(0, 300)}`);
  }

  const data = (await res.json()) as { organic?: Array<{ title?: string; link?: string; snippet?: string; position?: number }> };
  const results = (data.organic ?? [])
    .filter((r) => r.link && r.title)
    .map((r) => ({
      title: r.title!,
      url: r.link!,
      snippet: r.snippet ?? '',
      position: r.position ?? 0,
    }));

  log.debug(`"${query}" · ${results.length} result(s) · ${Date.now() - started}ms`);
  return results;
}
