import { runCli, type CliContext, type CliSpec } from '../../lib/cli.js';
import { scoreAllCreators, scoreCreator, type ScoreResult } from './index.js';

export const spec: CliSpec = {
  name: 'scorer',
  summary: "Score discovered creators 0-100 on product-fit and reachability.",
  examples: [
    'npm run scorer -- --handle jamesclearcoffee',
    'npm run scorer -- --all --limit 50',
    'npm run scorer -- --all --rescore',
  ],
  flags: {
    handle: { type: 'string', description: 'Score one creator by handle.' },
    all: { type: 'boolean', description: 'Score every creator with status DISCOVERED.' },
    rescore: { type: 'boolean', description: 'Recompute even if a score already exists.' },
    limit: { type: 'string', description: 'Cap how many creators a --all run touches.', default: '25' },
  },
};

function printResult(ctx: CliContext, result: ScoreResult): void {
  const b = result.breakdown;
  ctx.log.info(
    `@${result.handle} · ${result.score}/100${result.disqualifiedFor ? ` · DISQUALIFIED: ${result.disqualifiedFor}` : ''}`,
  );
  ctx.log.info(
    `  reach ${b.reach} · engagement ${b.engagement} · niche ${b.nicheClarity} · gap ${b.productGap} · monetisability ${b.monetisability} · reachability ${b.reachability}`,
  );
  ctx.log.info(`  ${result.rationale}`);
}

await runCli(spec, async (ctx) => {
  if (ctx.dryRun) {
    throw new Error(
      'scorer calls the Anthropic API to judge niche clarity and product gap — --dry-run is not supported.',
    );
  }

  const handle = ctx.flags.handle ? String(ctx.flags.handle) : undefined;
  const all = ctx.flags.all === true;

  if (!handle && !all) {
    throw new Error('Pass --handle <creator> or --all.');
  }
  if (handle && all) {
    throw new Error('Pass either --handle or --all, not both.');
  }

  if (handle) {
    const result = await scoreCreator(handle);
    if (ctx.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    printResult(ctx, result);
    return;
  }

  const { scored, skipped } = await scoreAllCreators({
    limit: Number(ctx.flags.limit ?? 25),
    rescore: ctx.flags.rescore === true,
  });

  if (ctx.json) {
    console.log(JSON.stringify({ scored, skipped }, null, 2));
    return;
  }

  for (const result of scored) printResult(ctx, result);
  ctx.log.info(`scored ${scored.length} creator(s)${skipped ? `, ${skipped} skipped` : ''}`);
});
