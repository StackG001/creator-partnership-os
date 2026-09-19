import { runCli, type CliSpec } from '../../lib/cli.js';
import { auditCreator } from './index.js';

export const spec: CliSpec = {
  name: 'audit',
  summary: "Research-backed audit of a creator's audience, pains and product angles.",
  examples: [
    'npm run audit -- --handle jamesclearcoffee',
    'npm run audit -- --handle jamesclearcoffee --posts 40 --refresh',
  ],
  flags: {
    handle: { type: 'string', description: 'Creator handle to audit.', required: true },
    posts: { type: 'string', description: 'How many recent posts/videos to analyse (10-100).', default: '60' },
    refresh: { type: 'boolean', description: 'Re-fetch source content instead of using cached artifacts.' },
  },
};

await runCli(spec, async (ctx) => {
  if (ctx.dryRun) {
    throw new Error(
      'audit calls paid APIs at every stage (Apify/YouTube + Anthropic) — --dry-run is not supported.',
    );
  }

  const result = await auditCreator(String(ctx.flags.handle), {
    postCount: Number(ctx.flags.posts ?? 60),
    refresh: ctx.flags.refresh === true,
  });

  if (ctx.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  ctx.log.info(`audited @${result.handle} · opportunity score ${result.opportunityScore}/100`);
  for (const angle of result.productAngles) {
    ctx.log.info(`  - ${angle.title} (${Math.round(angle.confidence * 100)}%): ${angle.promise}`);
  }
  ctx.log.info(`written to ${result.artifactPath}`);
});
