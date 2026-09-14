import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InstagramClient, toHashtag } from './instagram.js';
import { YouTubeClient } from './youtube.js';
import { parseHandlesCsv, splitCsvLine } from './csv.js';
import { detectDigitalProduct, extractEmail, extractLinks } from './product-signals.js';
import { computeMetrics, type DiscoveredProfile } from './types.js';
import { findCreators } from './index.js';

/** A fetch stub that answers from a URL-keyed fixture map. */
function fixtureFetch(routes: Array<{ match: string; body: unknown }>) {
  const calls: string[] = [];
  const impl = (async (url: string | URL | Request) => {
    const href = String(url);
    calls.push(href);
    const route = routes.find((r) => href.includes(r.match));
    if (!route) throw new Error(`no fixture for ${href}`);
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers(),
      json: async () => route.body,
      text: async () => JSON.stringify(route.body),
    } as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('product signal detection', () => {
  it('flags a storefront link as an existing product', () => {
    const result = detectDigitalProduct({
      bio: 'Credit tips daily',
      externalLinks: ['https://stan.store/creditqueen'],
    });
    assert.equal(result.hasDigitalProduct, true);
    assert.ok(result.confidence >= 0.8);
    assert.equal(result.signals[0]?.kind, 'platform');
    assert.equal(result.signals[0]?.evidence, 'https://stan.store/creditqueen');
  });

  it('finds a storefront named in the bio text, not just the link field', () => {
    const result = detectDigitalProduct({
      bio: 'DM for coaching · gumroad.com/mycredit',
      externalLinks: [],
    });
    assert.equal(result.hasDigitalProduct, true);
    assert.ok(result.signals.some((s) => s.match === 'gumroad.com'));
  });

  it('does not flag a single weak keyword', () => {
    const result = detectDigitalProduct({
      bio: 'Your guide to better credit',
      externalLinks: ['https://instagram.com/someone'],
    });
    assert.equal(result.hasDigitalProduct, false, 'one bio keyword is not proof of a product');
  });

  it('flags two keywords together', () => {
    const result = detectDigitalProduct({
      bio: 'Free ebook and a full course on credit repair',
      externalLinks: [],
    });
    assert.equal(result.hasDigitalProduct, true);
  });

  it('does not match keywords inside longer words', () => {
    const result = detectDigitalProduct({
      bio: 'Following the guidelines of coursework and templates everywhere',
      externalLinks: [],
    });
    // "templates" matches; "guidelines"/"coursework" must not.
    assert.ok(!result.signals.some((s) => ['guide', 'course'].includes(s.match)));
  });

  it('treats a clean profile as a prospect', () => {
    const result = detectDigitalProduct({
      bio: 'I teach people how to read their credit report. Questions welcome.',
      externalLinks: ['https://linktr.ee/me'],
    });
    assert.equal(result.hasDigitalProduct, false);
    assert.equal(result.signals.length, 0);
  });
});

describe('contact extraction', () => {
  it('pulls a public email out of a bio', () => {
    assert.equal(extractEmail('Business: Hello@CreditCo.com'), 'hello@creditco.com');
  });

  it('ignores image filenames that look like addresses', () => {
    assert.equal(extractEmail('logo@2x.png'), undefined);
  });

  it('returns undefined when there is no address', () => {
    assert.equal(extractEmail('no contact here'), undefined);
  });

  it('extracts links written as plain text', () => {
    const links = extractLinks('Shop www.example.com and https://stan.store/x, today');
    assert.deepEqual(links, ['www.example.com', 'https://stan.store/x']);
  });
});

describe('metrics', () => {
  const base: DiscoveredProfile = {
    platform: 'INSTAGRAM',
    handle: 'test',
    followers: 10_000,
    externalLinks: [],
    posts: [],
    raw: {},
  };

  it('averages likes and comments into an engagement rate', () => {
    const metrics = computeMetrics({
      ...base,
      posts: [
        { id: '1', likes: 200, comments: 50 },
        { id: '2', likes: 300, comments: 50 },
      ],
    });
    assert.equal(metrics.avgLikes, 250);
    assert.equal(metrics.avgComments, 50);
    // (250 + 50) / 10000
    assert.equal(metrics.engagementRate, 0.03);
  });

  it('computes engagement per view when views are present', () => {
    const metrics = computeMetrics({
      ...base,
      platform: 'YOUTUBE',
      posts: [{ id: '1', views: 1000, likes: 40, comments: 10 }],
    });
    assert.equal(metrics.engagementPerView, 0.05);
  });

  it('leaves engagement undefined when followers are unknown', () => {
    const metrics = computeMetrics({
      ...base,
      followers: undefined as unknown as number,
      posts: [{ id: '1', likes: 10, comments: 1 }],
    });
    assert.equal(metrics.engagementRate, undefined);
  });

  it('derives posting cadence from timestamps', () => {
    const metrics = computeMetrics({
      ...base,
      posts: [
        { id: '1', publishedAt: '2026-01-15T00:00:00Z' },
        { id: '2', publishedAt: '2026-01-08T00:00:00Z' },
        { id: '3', publishedAt: '2026-01-01T00:00:00Z' },
      ],
    });
    assert.equal(metrics.postsPerWeek, 1);
  });

  it('does not invent a cadence from posts made the same day', () => {
    const metrics = computeMetrics({
      ...base,
      posts: [
        { id: '1', publishedAt: '2026-01-01T10:00:00Z' },
        { id: '2', publishedAt: '2026-01-01T12:00:00Z' },
      ],
    });
    assert.equal(metrics.postsPerWeek, undefined);
  });
});

describe('csv import', () => {
  it('splits quoted fields containing commas', () => {
    assert.deepEqual(splitCsvLine('a,"b,c",d'), ['a', 'b,c', 'd']);
  });

  it('handles doubled quotes', () => {
    assert.deepEqual(splitCsvLine('"say ""hi""",x'), ['say "hi"', 'x']);
  });

  it('reads a header row and a platform column', () => {
    const rows = parseHandlesCsv('handle,platform\n@CreditQueen,ig\nsomechannel,yt');
    assert.deepEqual(rows, [
      { handle: 'creditqueen', platform: 'INSTAGRAM', extra: {} },
      { handle: 'somechannel', platform: 'YOUTUBE', extra: {} },
    ]);
  });

  it('treats a headerless file as one handle per line', () => {
    const rows = parseHandlesCsv('@one\ntwo\nhttps://instagram.com/three/');
    assert.deepEqual(rows.map((r) => r.handle), ['one', 'two', 'three']);
  });

  it('dedupes repeated handles and skips comments', () => {
    const rows = parseHandlesCsv('# a comment\n@dup\ndup\nother');
    assert.deepEqual(rows.map((r) => r.handle), ['dup', 'other']);
  });

  it('keeps extra columns as provenance', () => {
    const rows = parseHandlesCsv('handle,note\nabc,found via newsletter');
    assert.equal(rows[0]?.extra.note, 'found via newsletter');
  });
});

describe('instagram client', () => {
  it('turns a phrase into a hashtag', () => {
    assert.equal(toHashtag('credit repair tips'), 'creditrepairtips');
    assert.equal(toHashtag('#Credit Score!'), 'creditscore');
  });

  it('collects distinct handles from hashtag search results', async () => {
    const { impl } = fixtureFetch([
      {
        match: 'run-sync-get-dataset-items',
        body: [
          { ownerUsername: 'CreditQueen' },
          { ownerUsername: 'creditqueen' },
          { ownerUsername: 'scoreguy' },
        ],
      },
    ]);
    const client = new InstagramClient({ token: 't', fetchImpl: impl, minIntervalMs: 0 });
    const handles = await client.searchHandles('credit repair tips', 10);
    assert.deepEqual(handles, ['creditqueen', 'scoreguy'], 'case variants are one creator');
  });

  it('normalises a profile payload into a DiscoveredProfile', async () => {
    const { impl } = fixtureFetch([
      {
        match: 'run-sync-get-dataset-items',
        body: [
          {
            username: 'creditqueen',
            fullName: 'Credit Queen',
            biography: 'Fix your score. hello@creditqueen.com',
            externalUrl: 'https://stan.store/creditqueen',
            followersCount: 48_000,
            followsCount: 300,
            postsCount: 900,
            latestPosts: [
              { shortCode: 'abc', caption: 'How to dispute', timestamp: '2026-01-10T00:00:00Z', likesCount: 1200, commentsCount: 80, videoPlayCount: 40_000 },
            ],
          },
        ],
      },
    ]);
    const client = new InstagramClient({ token: 't', fetchImpl: impl, minIntervalMs: 0 });
    const [profile] = await client.fetchProfiles(['creditqueen']);

    assert.ok(profile);
    assert.equal(profile.handle, 'creditqueen');
    assert.equal(profile.followers, 48_000);
    assert.equal(profile.contactEmail, 'hello@creditqueen.com');
    assert.ok(profile.externalLinks.includes('https://stan.store/creditqueen'));
    assert.equal(profile.posts[0]?.views, 40_000);
  });

  it('skips items the actor reported as errors', async () => {
    const { impl } = fixtureFetch([
      { match: 'run-sync', body: [{ error: 'private profile' }, { username: 'ok_one' }] },
    ]);
    const client = new InstagramClient({ token: 't', fetchImpl: impl, minIntervalMs: 0 });
    const profiles = await client.fetchProfiles(['a', 'b']);
    assert.equal(profiles.length, 1);
    assert.equal(profiles[0]?.handle, 'ok_one');
  });
});

describe('youtube client', () => {
  const routes = [
    { match: '/search?', body: { items: [{ id: { channelId: 'UC1' } }, { id: { channelId: 'UC2' } }] } },
    {
      match: '/channels?',
      body: {
        items: [
          {
            id: 'UC1',
            snippet: { title: 'Credit Shop', description: 'Weekly credit repair. team@shop.com', customUrl: '@creditshop', country: 'US' },
            statistics: { subscriberCount: '95000', videoCount: '412' },
            contentDetails: { relatedPlaylists: { uploads: 'UU1' } },
          },
        ],
      },
    },
    { match: '/playlistItems?', body: { items: [{ contentDetails: { videoId: 'v1' } }] } },
    {
      match: '/videos?',
      body: {
        items: [
          {
            id: 'v1',
            snippet: { title: 'Fix your score', publishedAt: '2026-01-10T00:00:00Z' },
            statistics: { viewCount: '5000', likeCount: '200', commentCount: '30' },
          },
        ],
      },
    },
  ];

  it('searches, hydrates and attaches recent videos', async () => {
    const { impl } = fixtureFetch(routes);
    const client = new YouTubeClient({ apiKey: 'k', fetchImpl: impl, minIntervalMs: 0 });

    const ids = await client.searchChannelIds('credit repair tips', 10);
    assert.deepEqual(ids, ['UC1', 'UC2']);

    const [profile] = await client.fetchProfiles(ids);
    assert.ok(profile);
    assert.equal(profile.handle, 'creditshop', 'the @customUrl becomes the handle');
    assert.equal(profile.followers, 95_000);
    assert.equal(profile.contactEmail, 'team@shop.com');
    assert.equal(profile.posts.length, 1);
    assert.equal(profile.posts[0]?.views, 5000);
  });

  it('leaves followers undefined when the count is hidden', async () => {
    const { impl } = fixtureFetch([
      routes[0]!,
      {
        match: '/channels?',
        body: {
          items: [
            {
              id: 'UC9',
              snippet: { title: 'Hidden', description: '' },
              statistics: { hiddenSubscriberCount: true, subscriberCount: '0' },
              contentDetails: { relatedPlaylists: {} },
            },
          ],
        },
      },
    ]);
    const client = new YouTubeClient({ apiKey: 'k', fetchImpl: impl, minIntervalMs: 0 });
    const [profile] = await client.fetchProfiles(['UC9']);
    assert.equal(profile?.followers, undefined, 'hidden is not zero');
  });
});

describe('findCreators', () => {
  /** Injected backends: no network, no database (dry run). */
  function fakeYouTube(profiles: DiscoveredProfile[]) {
    return {
      searchChannelIds: async () => profiles.map((p) => p.handle),
      fetchProfiles: async () => profiles,
    };
  }

  function profile(overrides: Partial<DiscoveredProfile>): DiscoveredProfile {
    return {
      platform: 'YOUTUBE',
      handle: 'someone',
      followers: 50_000,
      externalLinks: [],
      posts: [{ id: '1', views: 10_000, likes: 500, comments: 60 }],
      raw: {},
      ...overrides,
    };
  }

  it('keeps creators inside the follower window and rejects the rest', async () => {
    const result = await findCreators({
      platform: 'yt',
      queries: ['credit repair tips'],
      limit: 10,
      minFollowers: 10_000,
      maxFollowers: 200_000,
      dryRun: true,
      clients: {
        youtube: fakeYouTube([
          profile({ handle: 'toosmall', followers: 900 }),
          profile({ handle: 'justright', followers: 50_000 }),
          profile({ handle: 'toobig', followers: 900_000 }),
        ]),
      },
    });

    assert.equal(result.found, 3);
    assert.equal(result.qualified, 1);
    assert.equal(result.candidates.find((c) => c.qualified)?.profile.handle, 'justright');
    assert.equal(result.skipped.length, 2);
    assert.match(result.skipped[0]?.reason ?? '', /followers/);
  });

  it('dedupes a handle returned by two different queries', async () => {
    const shared = profile({ handle: 'repeated' });
    const result = await findCreators({
      platform: 'yt',
      queries: ['one', 'two'],
      limit: 10,
      minFollowers: 10_000,
      maxFollowers: 200_000,
      dryRun: true,
      clients: { youtube: fakeYouTube([shared]) },
    });
    assert.equal(result.found, 1, 'the same creator must not be counted twice');
  });

  it('records an existing product without excluding the creator', async () => {
    const result = await findCreators({
      platform: 'yt',
      queries: ['q'],
      limit: 10,
      minFollowers: 10_000,
      maxFollowers: 200_000,
      dryRun: true,
      clients: {
        youtube: fakeYouTube([
          profile({ handle: 'seller', externalLinks: ['https://whop.com/seller'] }),
        ]),
      },
    });
    const candidate = result.candidates[0];
    assert.equal(candidate?.detection.hasDigitalProduct, true);
    assert.equal(candidate?.qualified, true, 'scoring decides, not discovery');
  });

  it('flags low engagement but still qualifies the creator', async () => {
    const result = await findCreators({
      platform: 'yt',
      queries: ['q'],
      limit: 10,
      minFollowers: 10_000,
      maxFollowers: 200_000,
      dryRun: true,
      clients: {
        youtube: fakeYouTube([
          profile({ handle: 'quiet', posts: [{ id: '1', views: 100_000, likes: 5, comments: 0 }] }),
        ]),
      },
    });
    assert.equal(result.qualified, 1);
    assert.match(result.candidates[0]?.reason ?? '', /low engagement/);
  });

  it('stops at the limit', async () => {
    const many = Array.from({ length: 9 }, (_, i) => profile({ handle: `creator${i}` }));
    const result = await findCreators({
      platform: 'yt',
      queries: ['q'],
      limit: 4,
      minFollowers: 10_000,
      maxFollowers: 200_000,
      dryRun: true,
      clients: { youtube: fakeYouTube(many) },
    });
    assert.equal(result.found, 4);
  });
});
