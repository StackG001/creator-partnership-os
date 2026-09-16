import { runCli, type CliSpec } from '../../lib/cli.js';
import { SCORE_WEIGHTS } from '../../lib/constants.js';
import { scoreCreator, scorePending, type ScoreResult } from './index.js';

export const spec: CliSpec = {
  name: 'scorer',
  summary: 'Score a discovered creator 0-100 as a product partner.',
  examples: [
    'npm run scorer -- --handle grantbakes',
    'npm run scorer -- --all --limit 5',
    'npm run scorer -- --handle grantbakes --dry-run',
  ],
  flags: {
    handle: { type: 'string', description: 'Creator handle to score.' },
    all: { type: 'boolean', description: 'Score every creator still at DISCOVERED.' },
    limit: { type: 'string', description: 'Max creators to score with --all.', default: '10' },
  },
};

function render(result: ScoreResult): void {
  console.log(`\n${result.handle} — ${result.score}/100`);
  console.log(`  ${result.summary}`);
  for (const [dimension, weight] of Object.entries(SCORE_WEIGHTS)) {
    const value = result.breakdown[dimension as keyof typeof result.breakdown];
    const bar = '█'.repeat(Math.round(value / 10)).padEnd(10, '·');
    const reason = result.reasons[dimension];
    console.log(`  ${dimension.padEnd(15)} ${bar} ${String(value).padStart(3)}  (weight ${weight}%)`);
    if (reason) console.log(`  ${''.padEnd(15)} ${reason}`);
  }
}

await runCli(spec, async ({ flags, dryRun, json }) => {
  const handle = flags.handle ? String(flags.handle) : undefined;
  if (!handle && flags.all !== true) throw new Error('scorer needs either --handle or --all');

  const results = handle
    ? [await scoreCreator(handle, { dryRun })]
    : await scorePending(Number(flags.limit), { dryRun });

  if (json) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  if (results.length === 0) {
    console.log('Nothing to score: no creators at DISCOVERED. Run the finder first.');
    return;
  }

  results.forEach(render);
  console.log(`\n${results.length} scored${dryRun ? ' · dry run, nothing written' : ''}`);
});
