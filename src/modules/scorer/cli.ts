import { runCli, type CliSpec } from '../../lib/cli.js';
import { renderTable } from '../../lib/table.js';
import { DEFAULT_CPC_PATH } from './cpc.js';
import { scoreCreators, type ScoreRecord } from './index.js';

export const spec: CliSpec = {
  name: 'scorer',
  summary: 'Score FOUND creators 0-100 on product-fit, spending power and reachability.',
  examples: [
    'npm run scorer -- --all',
    'npm run scorer -- --handle thecreditrepairshop',
    'npm run scorer -- --all --limit 50 --rescore',
    'npm run scorer -- --all --offline   # metrics only, no API key needed',
  ],
  flags: {
    handle: { type: 'string', description: 'Score one creator by handle.' },
    all: { type: 'boolean', description: 'Score every creator with status FOUND.' },
    rescore: { type: 'boolean', description: 'Recompute even if a score already exists.' },
    limit: { type: 'string', description: 'Cap how many creators a --all run touches.', default: '25' },
    offline: {
      type: 'boolean',
      description: 'Skip the model: deterministic metrics only. Weaker, but needs no API key.',
    },
    cpc: { type: 'string', description: 'Path to the niche CPC hints file.', default: DEFAULT_CPC_PATH },
  },
};

await runCli(spec, async ({ flags, log, dryRun, json }) => {
  if (!flags.all && !flags.handle) {
    throw new Error('Pass --all to score every FOUND creator, or --handle <handle> for one.');
  }

  const result = await scoreCreators({
    ...(flags.handle ? { handle: String(flags.handle) } : {}),
    all: flags.all === true,
    rescore: flags.rescore === true,
    limit: Number(flags.limit ?? 25),
    offline: flags.offline === true,
    ...(flags.cpc ? { cpcPath: String(flags.cpc) } : {}),
    dryRun,
    log,
  });

  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const ranked = [...result.scored].sort((a, b) => b.score - a.score);

  console.log(
    `\n${renderTable<ScoreRecord>(ranked, [
      { header: 'handle', value: (r) => r.handle, maxWidth: 26 },
      { header: 'score', value: (r) => String(r.score), align: 'right' },
      { header: 'verdict', value: (r) => r.verdict },
      { header: 'price', value: (r) => r.priceBand },
      { header: 'product', value: (r) => r.recommendedProductType, maxWidth: 34 },
      { header: 'flags', value: (r) => String(r.redFlags.length), align: 'right' },
    ])}\n`,
  );

  for (const item of result.skipped) console.log(`  skipped ${item.handle}: ${item.reason}`);
  for (const item of result.failed) console.log(`  failed  ${item.handle}: ${item.error}`);

  const offline = ranked.filter((r) => !r.llm).length;
  console.log(
    `${result.scored.length} scored${offline ? ` (${offline} without the model — run without --offline for the full read)` : ''}${dryRun ? ' · dry run, nothing written' : ''}`,
  );
  console.log('Next: npm run shortlist -- --top 15\n');
});
