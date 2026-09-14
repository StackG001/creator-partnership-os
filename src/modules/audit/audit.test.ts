import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createLogger } from '../../lib/logger.js';
import { extractHrefs, htmlToText } from '../../lib/page-text.js';
import { quantise } from '../../lib/palette.js';
import { collect, resolveTarget } from './collect.js';
import { runExtraction, runSynthesis } from './passes.js';
import { renderAuditMarkdown } from './render.js';
import { auditSchema, extractionSchema, type Audit } from './schema.js';
import type { DiscoveredProfile, PostMetric } from '../finder/types.js';

const log = createLogger('test');

describe('resolveTarget', () => {
  it('reads a YouTube channel URL', () => {
    const target = resolveTarget('https://www.youtube.com/channel/UCUI7EQCC1VrDCrznn4dj8xw');
    assert.equal(target.platform, 'YOUTUBE');
    assert.equal(target.lookup, 'UCUI7EQCC1VrDCrznn4dj8xw');
  });

  it('reads a bare channel id', () => {
    assert.equal(resolveTarget('UCUI7EQCC1VrDCrznn4dj8xw').platform, 'YOUTUBE');
  });

  it('treats a plain handle as Instagram', () => {
    const target = resolveTarget('@CreditQueen');
    assert.equal(target.platform, 'INSTAGRAM');
    assert.equal(target.lookup, 'creditqueen');
  });

  it('refuses a YouTube vanity URL rather than guessing the channel', () => {
    assert.throws(
      () => resolveTarget('https://www.youtube.com/@somechannel'),
      /channel-id URL/,
    );
  });
});

describe('page text', () => {
  it('strips tags and scripts, keeping visible prose', () => {
    const text = htmlToText('<head><title>t</title></head><body><script>var x=1</script><h1>Shop</h1><p>Buy my &amp; guide</p></body>');
    assert.match(text, /Shop/);
    assert.match(text, /Buy my & guide/);
    assert.doesNotMatch(text, /var x/);
  });

  it('collapses repeated adjacent lines', () => {
    assert.equal(htmlToText('<p>Same</p><p>Same</p><p>Other</p>'), 'Same\nOther');
  });

  it('resolves hrefs against the page URL', () => {
    const links = extractHrefs('<a href="/buy">x</a><a href="https://x.test/y">y</a>', 'https://site.test/page');
    assert.deepEqual(links, ['https://site.test/buy', 'https://x.test/y']);
  });

  it('drops anchors and javascript hrefs', () => {
    assert.deepEqual(extractHrefs('<a href="#top">t</a><a href="javascript:void(0)">j</a>'), []);
  });
});

describe('palette quantise', () => {
  it('ranks the most common colour first', () => {
    const pixels = [
      ...Array.from({ length: 10 }, () => ({ r: 250, g: 250, b: 250 })),
      ...Array.from({ length: 3 }, () => ({ r: 10, g: 10, b: 10 })),
    ];
    const colors = quantise(pixels);
    assert.equal(colors[0]?.hex, '#fafafa');
    assert.ok((colors[0]?.share ?? 0) > (colors[1]?.share ?? 1));
  });

  it('returns an empty palette for no pixels', () => {
    assert.deepEqual(quantise([]), []);
  });

  it('reports shares that sum to about 1', () => {
    const pixels = Array.from({ length: 30 }, (_, i) => ({ r: i * 8, g: 100, b: 200 }));
    const total = quantise(pixels, 64).reduce((sum, c) => sum + c.share, 0);
    assert.ok(Math.abs(total - 1) < 0.02);
  });
});

// --- fixtures ---------------------------------------------------------------

function post(index: number, overrides: Partial<PostMetric> = {}): PostMetric {
  return {
    id: `v${index}`,
    url: `https://www.youtube.com/watch?v=v${index}`,
    caption: `Post ${index} about disputing a charge-off`,
    publishedAt: `2026-0${(index % 9) + 1}-01T00:00:00Z`,
    views: 1000 * (index + 1),
    likes: 50,
    comments: 5,
    imageUrl: `https://img.test/${index}.jpg`,
    ...overrides,
  };
}

function fakeProfile(posts: PostMetric[]): DiscoveredProfile {
  return {
    platform: 'YOUTUBE',
    handle: 'creditcoach',
    displayName: 'Credit Coach',
    bio: 'I teach credit repair',
    followers: 50_000,
    externalLinks: [],
    posts,
    raw: { id: 'UC123' },
  };
}

function fakeYouTube(posts: PostMetric[], comments: Record<string, string[]> = {}) {
  return {
    fetchProfiles: async () => [fakeProfile(posts)],
    fetchComments: async (videoId: string) =>
      (comments[videoId] ?? []).map((text, i) => ({ id: `${videoId}-c${i}`, text })),
  };
}

describe('collect', () => {
  it('gathers posts and comments from the top posts', async () => {
    const posts = Array.from({ length: 12 }, (_, i) => post(i));
    const collected = await collect({
      handle: 'UCAAAAAAAAAAAAAAAAAAAAAA',
      posts: 12,
      topPosts: 2,
      skipImages: true,
      skipLinks: true,
      log,
      clients: { youtube: fakeYouTube(posts, { v11: ['how do I dispute this?'], v10: ['what next?'] }) },
    });

    assert.equal(collected.summary.postsAnalysed, 12);
    assert.equal(collected.comments.length, 2, 'comments come from the two best posts');
    // v11 has the most views, so it must be ranked first.
    assert.equal(collected.topPosts[0]?.id, 'v11');
  });

  it('records a gap when fewer than 50 posts are available', async () => {
    const collected = await collect({
      handle: 'UCAAAAAAAAAAAAAAAAAAAAAA',
      posts: 100,
      skipImages: true,
      skipLinks: true,
      log,
      clients: { youtube: fakeYouTube([post(0)]) },
    });
    assert.ok(collected.summary.gaps.some((gap) => /Only 1 posts/.test(gap)));
  });

  it('records a gap, not a failure, when no comments are readable', async () => {
    const collected = await collect({
      handle: 'UCAAAAAAAAAAAAAAAAAAAAAA',
      posts: 5,
      skipImages: true,
      skipLinks: true,
      log,
      clients: { youtube: fakeYouTube([post(0), post(1)]) },
    });
    assert.equal(collected.comments.length, 0);
    assert.ok(collected.summary.gaps.some((gap) => /No comments/.test(gap)));
  });

  it('reuses comments already embedded on a post instead of refetching', async () => {
    const posts = [post(0, { commentSample: [{ id: 'c1', text: 'embedded question?' }] })];
    let fetched = 0;
    const collected = await collect({
      handle: 'UCAAAAAAAAAAAAAAAAAAAAAA',
      posts: 5,
      skipImages: true,
      skipLinks: true,
      log,
      clients: {
        youtube: {
          fetchProfiles: async () => [fakeProfile(posts)],
          fetchComments: async () => {
            fetched += 1;
            return [];
          },
        },
      },
    });
    assert.equal(fetched, 0, 'a post that already has comments must not trigger a fetch');
    assert.equal(collected.comments[0]?.text, 'embedded question?');
  });

  it('surfaces a clear error for an unreadable profile', async () => {
    await assert.rejects(
      () =>
        collect({
          handle: 'UCAAAAAAAAAAAAAAAAAAAAAA',
          skipImages: true,
          skipLinks: true,
          log,
          clients: { youtube: { fetchProfiles: async () => [], fetchComments: async () => [] } },
        }),
      /Could not read YOUTUBE profile/,
    );
  });
});

// --- model passes, with the model stubbed -----------------------------------

const extractionFixture = {
  painSignals: [
    {
      quote: 'how do I get this forgiven?',
      source: { type: 'comment' as const, reference: 'https://www.youtube.com/watch?v=v1', label: 'Post 1' },
      theme: 'loan forgiveness',
      isQuestion: true,
    },
  ],
  voiceSignals: {
    openings: ["Here's the thing"],
    closings: ['Drop a comment'],
    signaturePhrases: ['know your rights'],
    emojis: ['💪'],
    toneAdjectives: ['direct', 'warm'],
  },
  topics: [{ topic: 'charge-offs', evidence: 'Post 1' }],
  audienceSignals: [
    {
      observation: 'Already disputed once',
      quote: 'I disputed it twice already',
      source: { type: 'comment' as const, reference: 'https://www.youtube.com/watch?v=v1' },
    },
  ],
};

function auditFixture(): Audit {
  return {
    niche: 'Teaching US consumers to remove charge-offs and win disputes under the FCRA.',
    audiencePersona: {
      who: 'Americans with damaged credit trying to qualify for a mortgage or car loan.',
      situation: 'They have one or more collections and have already sent a dispute letter that failed.',
      whatTheyveTried: ['Generic dispute letter templates', 'Calling the collection agency directly'],
    },
    top10Pains: Array.from({ length: 10 }, (_, i) => ({
      pain: `Pain number ${i + 1} about disputes and collections`,
      quote: 'how do I get this forgiven?',
      source: { type: 'comment' as const, reference: 'https://www.youtube.com/watch?v=v1', label: 'Post 1' },
      severity: 'high' as const,
      frequency: 'common' as const,
    })),
    voiceGuide: {
      toneAdjectives: ['direct', 'warm', 'no-nonsense'],
      sentenceLength: 'short, 8-14 words, often fragments',
      signaturePhrases: ['know your rights'],
      neverUses: ['corporate jargon'],
      emojiUsage: 'sparing, 💪 for encouragement',
      howTheyOpen: 'With the mistake the viewer is about to make',
      howTheyClose: 'With a direct ask to comment',
    },
    visualStyle: {
      dominantColors: [{ hex: '#1b2a41', share: 0.4, role: 'background' }],
      fontFeel: 'Heavy condensed sans, all caps',
      layoutHabits: 'Face left, bold text right, arrows for emphasis',
    },
    productOpportunities: Array.from({ length: 5 }, (_, i) => ({
      title: `Opportunity ${i + 1}`,
      promise: 'Go from a failed dispute to a removed collection in 60 days',
      whoItsFor: 'Someone 60 days from a mortgage application with two collections',
      whyItFits: 'The audience asks this exact question repeatedly in the comments sampled',
      score: 9 - i,
      priceBand: '$39-79' as const,
      recommended: i === 0,
      pocket: {
        specificPerson: 'Mortgage applicant with two collections',
        problemTheyAreAlreadyFixing: 'A dispute they already filed and lost',
      },
    })),
    hookLines: Array.from({ length: 10 }, (_, i) => `Hook line number ${i + 1} in their voice`),
    partnershipPitchAngle:
      'Their audience keeps asking one question the channel has never answered in one place, and that gap is the product.',
  };
}

/** A stub standing in for completeJSON: returns the fixture for each schema. */
function stubComplete(overrides: { failChunks?: number[] } = {}) {
  let extractionCalls = 0;
  const calls: string[] = [];

  const fn = (async (options: { schemaName?: string; prompt: string }) => {
    calls.push(options.schemaName ?? '');
    if (options.schemaName === 'extract_signals') {
      extractionCalls += 1;
      if (overrides.failChunks?.includes(extractionCalls)) {
        throw new Error(`chunk ${extractionCalls} blew up`);
      }
      return { data: extractionSchema.parse(extractionFixture), model: 'stub-fast' };
    }
    return { data: auditSchema.parse(auditFixture()), model: 'stub-heavy' };
  }) as never;

  return { fn, calls, get extractionCalls() { return extractionCalls; } };
}

describe('extraction pass', () => {
  it('chunks the posts and calls the model once per chunk', async () => {
    const posts = Array.from({ length: 25 }, (_, i) => post(i));
    const collected = await collect({
      handle: 'UCAAAAAAAAAAAAAAAAAAAAAA',
      posts: 25,
      skipImages: true,
      skipLinks: true,
      log,
      clients: { youtube: fakeYouTube(posts) },
    });

    const stub = stubComplete();
    const result = await runExtraction(collected, { log, chunkSize: 10, completeJsonFn: stub.fn });

    assert.equal(stub.extractionCalls, 3, '25 posts in chunks of 10');
    assert.equal(result.chunks.length, 3);
    assert.equal(result.model, 'stub-fast');
  });

  it('tolerates one failed chunk without losing the audit', async () => {
    const posts = Array.from({ length: 20 }, (_, i) => post(i));
    const collected = await collect({
      handle: 'UCAAAAAAAAAAAAAAAAAAAAAA',
      posts: 20,
      skipImages: true,
      skipLinks: true,
      log,
      clients: { youtube: fakeYouTube(posts) },
    });

    const stub = stubComplete({ failChunks: [1] });
    const result = await runExtraction(collected, { log, chunkSize: 10, completeJsonFn: stub.fn });

    assert.equal(result.chunks.length, 1, 'the surviving chunk is kept');
    assert.equal(result.failures.length, 1);
    assert.match(result.failures[0] ?? '', /chunk 1/);
  });

  it('throws when every chunk fails, rather than synthesising from nothing', async () => {
    const collected = await collect({
      handle: 'UCAAAAAAAAAAAAAAAAAAAAAA',
      posts: 10,
      skipImages: true,
      skipLinks: true,
      log,
      clients: { youtube: fakeYouTube([post(0)]) },
    });

    const stub = stubComplete({ failChunks: [1] });
    await assert.rejects(
      () => runExtraction(collected, { log, chunkSize: 10, completeJsonFn: stub.fn }),
      /Extraction produced nothing/,
    );
  });
});

describe('synthesis pass', () => {
  it('uses the heavy tier and returns a validated audit', async () => {
    const collected = await collect({
      handle: 'UCAAAAAAAAAAAAAAAAAAAAAA',
      posts: 5,
      skipImages: true,
      skipLinks: true,
      log,
      clients: { youtube: fakeYouTube([post(0)]) },
    });

    const stub = stubComplete();
    const extraction = await runExtraction(collected, { log, chunkSize: 10, completeJsonFn: stub.fn });
    const { audit, model } = await runSynthesis(collected, extraction, { log, completeJsonFn: stub.fn });

    assert.equal(model, 'stub-heavy');
    assert.equal(audit.top10Pains.length, 10);
    assert.equal(audit.hookLines.length, 10);
    assert.equal(audit.productOpportunities.filter((o) => o.recommended).length, 1);
  });
});

describe('audit schema', () => {
  it('rejects more than one recommended opportunity', () => {
    const audit = auditFixture();
    audit.productOpportunities[1]!.recommended = true;
    const result = auditSchema.safeParse(audit);
    assert.equal(result.success, false);
    assert.match(JSON.stringify(result), /exactly one|Exactly one/i);
  });

  it('rejects zero recommended opportunities', () => {
    const audit = auditFixture();
    audit.productOpportunities[0]!.recommended = false;
    assert.equal(auditSchema.safeParse(audit).success, false);
  });

  it('requires exactly ten pains', () => {
    const audit = auditFixture();
    audit.top10Pains = audit.top10Pains.slice(0, 9);
    assert.equal(auditSchema.safeParse(audit).success, false);
  });

  it('requires exactly ten hook lines', () => {
    const audit = auditFixture();
    audit.hookLines = audit.hookLines.slice(0, 8);
    assert.equal(auditSchema.safeParse(audit).success, false);
  });

  it('requires a quote on every pain', () => {
    const audit = auditFixture();
    audit.top10Pains[0]!.quote = '';
    assert.equal(auditSchema.safeParse(audit).success, false);
  });

  it('accepts the full fixture', () => {
    assert.equal(auditSchema.safeParse(auditFixture()).success, true);
  });
});

describe('markdown rendering', () => {
  const summary = {
    handle: 'creditcoach',
    platform: 'YOUTUBE',
    postsAnalysed: 100,
    commentsAnalysed: 28,
    pinnedPosts: 0,
    imagesSampled: 0,
    linkPagesRead: 0,
    gaps: ['No images could be read for the palette.'],
    collectedAt: '2026-09-14T00:00:00.000Z',
  };
  const meta = { extractionModel: 'stub-fast', synthesisModel: 'stub-heavy' };

  it('leads with the pitch angle and the recommended product', () => {
    const md = renderAuditMarkdown(auditFixture(), summary, meta);
    const pitchIndex = md.indexOf('Lead with this');
    const painsIndex = md.indexOf('Top 10 pains');
    assert.ok(pitchIndex > 0 && pitchIndex < painsIndex, 'the pitch angle comes first');
    assert.match(md, /\*\*Recommended product:\*\* Opportunity 1/);
  });

  it('states the collection gaps near the top', () => {
    const md = renderAuditMarkdown(auditFixture(), summary, meta);
    assert.match(md, /What this audit could not see/);
    assert.ok(md.indexOf('could not see') < md.indexOf('Top 10 pains'));
  });

  it('renders every pain with its quote and source link', () => {
    const md = renderAuditMarkdown(auditFixture(), summary, meta);
    assert.equal((md.match(/^> how do I get this forgiven\?$/gm) ?? []).length, 10);
    assert.match(md, /\[Post 1\]\(https:\/\/www\.youtube\.com\/watch\?v=v1\)/);
  });

  it('marks the recommended opportunity and sorts by score', () => {
    const md = renderAuditMarkdown(auditFixture(), summary, meta);
    assert.match(md, /### ★ Opportunity 1/);
    assert.ok(md.indexOf('Opportunity 1') < md.indexOf('Opportunity 5'));
  });

  it('says so plainly when no palette could be measured', () => {
    const audit = auditFixture();
    audit.visualStyle.dominantColors = [];
    const md = renderAuditMarkdown(audit, summary, meta);
    assert.match(md, /No images could be sampled.*Do not guess/s);
  });

  it('numbers all ten hook lines', () => {
    const md = renderAuditMarkdown(auditFixture(), summary, meta);
    assert.match(md, /^10\. Hook line number 10/m);
  });
});
