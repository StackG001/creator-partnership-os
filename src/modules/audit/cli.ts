import fs from 'node:fs/promises';
import { runCli, type CliSpec } from '../../lib/cli.js';
import { auditCreator } from './index.js';

export const spec: CliSpec = {
  name: 'audit',
  summary: "Research-backed audit of a creator's audience, pains and product angles.",
  examples: [
    'npm run audit -- --handle jamesclearcoffee',
    'npm run audit -- --handle jamesclearcoffee --posts 40 --refresh',
    'npm run audit -- --handle woomaamee --test --extra-comments extra.json   # nothing saved to the database',
  ],
  flags: {
    handle: { type: 'string', description: 'Creator handle to audit.', required: true },
    posts: { type: 'string', description: 'How many recent posts/videos to analyse (10-100).', default: '60' },
    refresh: { type: 'boolean', description: 'Re-fetch source content instead of using cached artifacts.' },
    test: { type: 'boolean', description: 'Full audit without touching the database (status, Audit row, quotes); report goes to audit/test-audit.{md,json}.' },
    'extra-comments': {
      type: 'string',
      description: 'JSON file of real comments the fetch missed: [{ "postRef": "P7", "author": "handle", "text": "…", "likeCount": 8 }].',
    },
  },
};

await runCli(spec, async (ctx) => {
  if (ctx.dryRun) {
    throw new Error(
      'audit calls paid APIs at every stage (Apify/YouTube + Anthropic) — --dry-run is not supported.',
    );
  }

  const extraFile = ctx.flags['extra-comments'];
  const result = await auditCreator(String(ctx.flags.handle), {
    postCount: Number(ctx.flags.posts ?? 60),
    refresh: ctx.flags.refresh === true,
    test: ctx.flags.test === true,
    extraComments: extraFile ? JSON.parse(await fs.readFile(String(extraFile), 'utf8')) : undefined,
  });

  if (ctx.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  ctx.log.info(`audited @${result.handle} · opportunity score ${result.opportunityScore}/100 · ${result.goldmineSignals} goldmine signal(s)`);
  if (result.lowProductFit) ctx.log.warn(`  low product-fit — disqualified, outreach not recommended`);
  for (const angle of result.productAngles) {
    ctx.log.info(`  - ${angle.title} (${Math.round(angle.confidence * 100)}%): ${angle.promise}`);
  }
  ctx.log.info(`written to ${result.artifactPath}`);
});
