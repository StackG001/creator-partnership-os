import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HttpError, RateLimiter, requestJson } from './http.js';

/** Build a fetch stub that replays a queue of responses and records calls. */
function stubFetch(responses: Array<Omit<Partial<Response>, 'json' | 'body'> & { payload?: unknown }>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let index = 0;

  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), ...(init ? { init } : {}) });
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (!next) throw new Error('stub exhausted');
    return {
      ok: next.ok ?? true,
      status: next.status ?? 200,
      statusText: next.statusText ?? 'OK',
      headers: next.headers ?? new Headers(),
      json: async () => next.payload ?? {},
      text: async () => JSON.stringify(next.payload ?? {}),
    } as Response;
  }) as unknown as typeof fetch;

  return { impl, calls };
}

describe('requestJson', () => {
  it('returns parsed JSON on success', async () => {
    const { impl } = stubFetch([{ payload: { hello: 'world' } }]);
    const result = await requestJson<{ hello: string }>('https://example.test/a', {
      fetchImpl: impl,
    });
    assert.equal(result.hello, 'world');
  });

  it('retries a 429 and succeeds on the next attempt', async () => {
    const { impl, calls } = stubFetch([
      { ok: false, status: 429, statusText: 'Too Many Requests' },
      { payload: { ok: true } },
    ]);
    const result = await requestJson<{ ok: boolean }>('https://example.test/b', {
      fetchImpl: impl,
      backoffMs: 1,
    });
    assert.equal(result.ok, true);
    assert.equal(calls.length, 2);
  });

  it('retries 5xx up to the limit then throws', async () => {
    const { impl, calls } = stubFetch([{ ok: false, status: 503, statusText: 'Unavailable' }]);
    await assert.rejects(
      () => requestJson('https://example.test/c', { fetchImpl: impl, retries: 2, backoffMs: 1 }),
      (error: unknown) => error instanceof HttpError && error.status === 503,
    );
    assert.equal(calls.length, 3, 'initial attempt plus two retries');
  });

  it('does not retry a rejected credential', async () => {
    const { impl, calls } = stubFetch([{ ok: false, status: 401, statusText: 'Unauthorized' }]);
    await assert.rejects(
      () => requestJson('https://example.test/d', { fetchImpl: impl, retries: 3, backoffMs: 1 }),
      (error: unknown) => error instanceof HttpError && error.isAuth,
    );
    assert.equal(calls.length, 1, 'a 401 must fail fast, not burn quota');
  });

  it('does not retry a 404', async () => {
    const { impl, calls } = stubFetch([{ ok: false, status: 404, statusText: 'Not Found' }]);
    await assert.rejects(() =>
      requestJson('https://example.test/e', { fetchImpl: impl, retries: 3, backoffMs: 1 }),
    );
    assert.equal(calls.length, 1);
  });

  it('honours Retry-After over the backoff schedule', async () => {
    const { impl } = stubFetch([
      {
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
        headers: new Headers({ 'retry-after': '0' }),
      },
      { payload: { done: true } },
    ]);
    const started = Date.now();
    await requestJson('https://example.test/f', { fetchImpl: impl, backoffMs: 10_000 });
    assert.ok(Date.now() - started < 1_000, 'Retry-After: 0 should not wait for the backoff');
  });

  it('retries a network failure', async () => {
    let attempts = 0;
    const impl = (async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('ECONNRESET');
      return { ok: true, status: 200, statusText: 'OK', headers: new Headers(), json: async () => ({ ok: 1 }), text: async () => '' } as Response;
    }) as unknown as typeof fetch;

    const result = await requestJson<{ ok: number }>('https://example.test/g', {
      fetchImpl: impl,
      backoffMs: 1,
    });
    assert.equal(result.ok, 1);
    assert.equal(attempts, 2);
  });
});

describe('RateLimiter', () => {
  it('spaces successive calls by at least the interval', async () => {
    const limiter = new RateLimiter(40);
    const started = Date.now();
    await limiter.wait();
    await limiter.wait();
    await limiter.wait();
    assert.ok(Date.now() - started >= 80, 'three calls need two gaps of 40ms');
  });

  it('serialises concurrent waiters instead of releasing them together', async () => {
    const limiter = new RateLimiter(30);
    const started = Date.now();
    await Promise.all([limiter.wait(), limiter.wait(), limiter.wait()]);
    assert.ok(Date.now() - started >= 60);
  });
});

describe('error messages', () => {
  it('includes the response body, which names the real cause', async () => {
    const impl = (async () =>
      ({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
        headers: new Headers(),
        json: async () => ({}),
        text: async () => 'Host not in allowlist: api.apify.com',
      }) as Response) as unknown as typeof fetch;

    await assert.rejects(
      () => requestJson('https://api.apify.com/x', { fetchImpl: impl, label: 'apify:search' }),
      (error: unknown) =>
        error instanceof HttpError && /Host not in allowlist/.test(error.message),
    );
  });
});
