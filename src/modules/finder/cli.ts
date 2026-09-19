import { runCli, type CliSpec } from '../../lib/cli.js';
import { PLATFORMS, QUALIFICATION, type Platform } from '../../lib/constants.js';
import { findCreators } from './index.js';

export const spec: CliSpec = {
  name: 'finder',
  summary: "Discover micro-creators (10k-200k) from hashtags, searches and lookalikes.",
  examples: [
    "npm run finder -- --platform instagram --niche 'home barista' --limit 50",
    "npm run finder -- --source src_abc123 --limit 25",
    'npm run finder -- --platform youtube --query "notion templates" --min-engagement 0.03',
  ],
  flags: {
    platform: { type: 'string', description: 'instagram | youtube | both.', default: 'both' },
    query: {
      type: 'string',
      description:
        'Hashtag (#tag), seed handle/URL to find lookalikes of, or a plain keyword to search.',
    },
    niche: { type: 'string', description: 'Niche label stored on every creator found. Used as the query when --query is omitted.' },
    source: { type: 'string', description: 'Re-run an existing Source by id.' },
    limit: { type: 'string', description: 'Max creators to keep from this run.', default: '25' },
    'min-followers': {
      type: 'string',
      description: 'Lower bound of the follower window.',
      default: String(QUALIFICATION.minFollowers),
    },
    'max-followers': {
      type: 'string',
      description: 'Upper bound of the follower window.',
      default: String(QUALIFICATION.maxFollowers),
    },
    'min-engagement': {
      type: 'string',
      description: 'Minimum engagement rate, 0-1.',
      default: String(QUALIFICATION.minEngagementRate),
    },
  },
};

function parsePlatform(raw: string): Platform {
  const normalized = raw.trim().toUpperCase();
  if ((PLATFORMS as readonly string[]).includes(normalized)) return normalized as Platform;
  throw new Error(`Unknown platform "${raw}" — expected one of: ${PLATFORMS.map((p) => p.toLowerCase()).join(', ')}`);
}

await runCli(spec, async (ctx) => {
  if (ctx.dryRun) {
    throw new Error(
      'finder calls paid APIs (Apify/YouTube) at every stage — --dry-run is not supported.',
    );
  }

  const result = await findCreators({
    platform: parsePlatform(String(ctx.flags.platform ?? 'both')),
    query: ctx.flags.query ? String(ctx.flags.query) : undefined,
    niche: ctx.flags.niche ? String(ctx.flags.niche) : undefined,
    sourceId: ctx.flags.source ? String(ctx.flags.source) : undefined,
    limit: Number(ctx.flags.limit ?? 25),
    minFollowers: Number(ctx.flags['min-followers'] ?? QUALIFICATION.minFollowers),
    maxFollowers: Number(ctx.flags['max-followers'] ?? QUALIFICATION.maxFollowers),
    minEngagement: Number(ctx.flags['min-engagement'] ?? QUALIFICATION.minEngagementRate),
  });

  if (ctx.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  ctx.log.info(`source ${result.sourceId} · found ${result.found} · qualified ${result.qualified}`);
  for (const creator of result.created) {
    ctx.log.info(
      `  + @${creator.handle} (${creator.platform}) · ${creator.followers ?? 0} followers · ${((creator.engagementRate ?? 0) * 100).toFixed(2)}% engagement`,
    );
  }
  if (result.skipped.length) {
    ctx.log.info(`skipped ${result.skipped.length}:`);
    for (const s of result.skipped.slice(0, 20)) ctx.log.info(`  - @${s.handle}: ${s.reason}`);
    if (result.skipped.length > 20) ctx.log.info(`  ... and ${result.skipped.length - 20} more`);
  }
});
