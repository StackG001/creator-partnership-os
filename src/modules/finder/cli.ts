import { runCli, type CliSpec } from '../../lib/cli.js';
import { findCreators } from './index.js';

export const spec: CliSpec = {
  name: 'finder',
  summary: 'Discover YouTube micro-creators and record their metrics.',
  examples: [
    'npm run finder -- --channel @veritasium',
    'npm run finder -- --query "budget meal prep" --limit 10 --niche cooking',
    'npm run finder -- --channel @someone --dry-run',
  ],
  flags: {
    channel: { type: 'string', description: 'A channel URL, @handle or UC… id. Costs 1 quota unit.' },
    query: { type: 'string', description: 'Keyword search for channels. Costs 100 quota units.' },
    limit: { type: 'string', description: 'Max channels to profile from a search.', default: '10' },
    videos: { type: 'string', description: 'Recent uploads sampled for metrics.', default: '12' },
    niche: { type: 'string', description: 'Niche label recorded on the source and creators.' },
  },
};

await runCli(spec, async ({ flags, log, dryRun, json }) => {
  const result = await findCreators({
    ...(flags.channel ? { channel: String(flags.channel) } : {}),
    ...(flags.query ? { query: String(flags.query) } : {}),
    limit: Number(flags.limit),
    videos: Number(flags.videos),
    ...(flags.niche ? { niche: String(flags.niche) } : {}),
    dryRun,
  });

  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  for (const c of result.found) {
    const mark = c.qualified ? '✔' : '·';
    console.log(`\n${mark} ${c.handle}  ${c.displayName}`);
    console.log(`    ${c.url}`);
    console.log(
      `    ${c.followers?.toLocaleString() ?? 'hidden'} subs · ${c.metrics.avgViews.toLocaleString()} avg views · ` +
        `${(c.metrics.engagementRate * 100).toFixed(2)}% engagement · ${c.metrics.postsPerWeek}/wk` +
        ` (n=${c.metrics.sampleSize})`,
    );
    if (c.evidence.hasDigitalProduct) {
      console.log(`    sells already: ${c.evidence.matches.map((m) => m.domain).join(', ')}`);
    }
    if (!c.qualified) console.log(`    skipped: ${c.disqualifiedFor}`);
  }

  console.log(
    `\n${result.found.length} profiled · ${result.qualified} qualified · ~${result.quotaUnits} quota units` +
      (dryRun ? ' · dry run, nothing written' : ''),
  );
  log.info(dryRun ? 'dry run complete' : 'creators written');
});
