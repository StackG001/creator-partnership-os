import { createLogger } from './logger.js';

/**
 * The one place the system makes outbound HTTP calls to non-Anthropic services.
 *
 * Discovery APIs are metered, rate limited and occasionally flaky, and the
 * finder walks them in loops — so every call goes through here to get three
 * things it must never be without: a minimum gap between requests to the same
 * host, bounded retries with exponential backoff, and a hard timeout.
 *
 * `fetchImpl` is the test seam: pass a stub and no socket is ever opened.
 */

const log = createLogger('http');

export type FetchImpl = typeof fetch;

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
    readonly url: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }

  /** 401/403 mean "stop" — retrying a rejected credential just burns quota. */
  get isAuth(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

/**
 * Spaces calls out so we never hammer an endpoint. One limiter per client
 * instance; callers await `wait()` before every request.
 */
export class RateLimiter {
  private last = 0;
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly minIntervalMs: number) {}

  /** Serialised: concurrent callers queue rather than all firing at once. */
  async wait(): Promise<void> {
    const turn = this.chain.then(async () => {
      const gap = Date.now() - this.last;
      const remaining = this.minIntervalMs - gap;
      if (remaining > 0) await sleep(remaining);
      this.last = Date.now();
    });
    this.chain = turn.catch(() => undefined);
    return turn;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface RequestOptions {
  init?: RequestInit;
  fetchImpl?: FetchImpl;
  limiter?: RateLimiter;
  retries?: number;
  timeoutMs?: number;
  /** Shown in logs, e.g. "apify:profile". */
  label?: string;
  /** Backoff base in ms; the test suite drops this to keep runs instant. */
  backoffMs?: number;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function backoffDelay(attempt: number, base: number): number {
  // Exponential with jitter, so parallel workers don't retry in lockstep.
  const ceiling = base * 2 ** (attempt - 1);
  return Math.round(ceiling / 2 + Math.random() * (ceiling / 2));
}

/** Honour Retry-After when the service tells us how long to wait. */
function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get('retry-after');
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

/**
 * GET/POST JSON with rate limiting, retries and a timeout.
 * Throws HttpError on a non-2xx that survives its retries.
 */
export async function requestJson<T>(url: string, options: RequestOptions = {}): Promise<T> {
  const {
    init = {},
    fetchImpl = fetch,
    limiter,
    retries = 3,
    timeoutMs = 30_000,
    label = 'request',
    backoffMs = 500,
  } = options;

  let lastError: unknown;

  for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
    if (limiter) await limiter.wait();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetchImpl(url, { ...init, signal: controller.signal });

      if (response.ok) return (await response.json()) as T;

      const body = await response.text().catch(() => '');
      // Put a slice of the body in the message: services put the actual reason
      // there, and a bare "403 Forbidden" sends people off rotating a key that
      // was never the problem.
      const snippet = body.replace(/\s+/g, ' ').trim().slice(0, 160);
      const error = new HttpError(
        `${label}: HTTP ${response.status} ${response.statusText}${snippet ? ` — ${snippet}` : ''}`.trim(),
        response.status,
        body.slice(0, 500),
        url,
      );

      // A rejected credential will be rejected again; fail fast and loudly.
      if (error.isAuth || !RETRYABLE_STATUS.has(response.status)) throw error;

      lastError = error;
      if (attempt <= retries) {
        const delay = retryAfterMs(response) ?? backoffDelay(attempt, backoffMs);
        log.warn(`${label}: HTTP ${response.status}, retrying in ${delay}ms (${attempt}/${retries})`);
        await sleep(delay);
      }
    } catch (error) {
      if (error instanceof HttpError) throw error;
      // Network error, DNS failure or timeout — worth another go.
      lastError = error;
      if (attempt <= retries) {
        const delay = backoffDelay(attempt, backoffMs);
        const reason = (error as Error).name === 'AbortError' ? `timed out after ${timeoutMs}ms` : (error as Error).message;
        log.warn(`${label}: ${reason}, retrying in ${delay}ms (${attempt}/${retries})`);
        await sleep(delay);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`${label}: failed after ${retries + 1} attempts`);
}

/** Build a query string, dropping undefined values. */
export function query(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value));
  }
  return search.toString();
}
