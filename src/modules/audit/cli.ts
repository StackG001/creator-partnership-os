import { runCli, type CliSpec } from '../../lib/cli.js';
import { auditCreator } from './index.js';

export const spec: CliSpec = {
  name: 'audit',
  summary: "Research one creator: pains, voice, visual style and product angles.",
  examples: [
    'npm run audit -- --handle thecreditrepairshop',
    'npm run audit -- --handle https://www.youtube.com/channel/UCUI7EQCC1VrDCrznn4dj8xw',
    'npm run audit -- --handle creditqueen --posts 60 --topPosts 15',
    'npm run audit -- --handle creditqueen --collect-only   # what can be gathered, no model calls',
  ],
  flags: {
    handle: {
      type: 'string',
      description: 'Instagram handle, or a YouTube channel URL / UC... id.',
      required: true,
    },
    posts: { type: 'string', description: 'How many recent posts to pull (50-100).', default: '100' },
    topPosts: { type: 'string', description: 'How many top posts to read comments on.', default: '20' },
    comments: { type: 'string', description: 'Comments to pull per top post.', default: '20' },
    images: { type: 'string', description: 'Images to sample for the palette.', default: '12' },
    chunkSize: { type: 'string', description: 'Posts per extraction chunk.', default: '10' },
    'skip-images': { type: 'boolean', description: 'Skip palette extraction (no Chromium needed).' },
    'skip-links': { type: 'boolean', description: 'Skip fetching the link-in-bio page.' },
    'collect-only': {
      type: 'boolean',
      description: 'Gather the evidence and stop. No model calls, no API key needed.',
    },
  },
};

function toNumber(value: unknown, fallback: number, flag: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`--${flag} must be a positive number, got "${String(value)}"`);
  }
  return parsed;
}

await runCli(spec, async ({ flags, log, dryRun, json }) => {
  const result = await auditCreator({
    handle: String(flags.handle),
    posts: toNumber(flags.posts, 100, 'posts'),
    topPosts: toNumber(flags.topPosts, 20, 'topPosts'),
    commentsPerPost: toNumber(flags.comments, 20, 'comments'),
    images: toNumber(flags.images, 12, 'images'),
    chunkSize: toNumber(flags.chunkSize, 10, 'chunkSize'),
    skipImages: flags['skip-images'] === true,
    skipLinks: flags['skip-links'] === true,
    collectOnly: flags['collect-only'] === true,
    dryRun,
    log,
  });

  if (json) {
    console.log(JSON.stringify({ ...result, collected: undefined }, null, 2));
    return;
  }

  const { summary } = result;
  console.log('');
  console.log(`audit — @${summary.handle} (${summary.platform})`);
  console.log(
    `  ${summary.postsAnalysed} posts · ${summary.commentsAnalysed} comments · ` +
      `${summary.pinnedPosts} pinned · ${summary.linkPagesRead} link page(s) · ${summary.imagesSampled} image(s)`,
  );

  if (result.collected.palette.length) {
    console.log(`  palette: ${result.collected.palette.map((c) => c.hex).join(' ')}`);
  }

  if (summary.gaps.length) {
    console.log('\n  could not collect:');
    for (const gap of summary.gaps) console.log(`    - ${gap}`);
  }

  if (result.extractionFailures.length) {
    console.log('\n  extraction chunks that failed:');
    for (const failure of result.extractionFailures) console.log(`    - ${failure}`);
  }

  if (!result.audit) {
    console.log('\n  --collect-only: no model calls made, nothing written.\n');
    return;
  }

  const recommended = result.audit.productOpportunities.find((o) => o.recommended);
  console.log('');
  console.log(`  niche: ${result.audit.niche}`);
  if (recommended) {
    console.log(`  recommended: ${recommended.title} (${recommended.priceBand}, ${recommended.score}/10)`);
  }
  console.log('');
  console.log(`  ${result.paths.markdown}`);
  console.log(`  ${result.paths.json}`);
  console.log(`\nNext: npm run outreach -- --handle ${summary.handle}\n`);
});
