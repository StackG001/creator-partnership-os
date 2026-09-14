import { runCli, type CliSpec } from '../../lib/cli.js';
import { compactNumber, percent, renderTable } from '../../lib/table.js';
import { QUALIFICATION } from '../../lib/constants.js';
import { findCreators, type FinderCandidate, type FinderPlatform } from './index.js';

export const spec: CliSpec = {
  name: 'finder',
  summary: 'Discover micro-creators (10k-200k) on Instagram, YouTube or from a CSV.',
  examples: [
    'npm run finder -- --platform ig --queries "credit repair tips,credit score tips" --limit 60',
    'npm run finder -- --platform yt --queries "notion templates" --minFollowers 20000',
    'npm run finder -- --platform csv --csv ./handles.csv --csvPlatform ig',
    'cat handles.csv | npm run finder -- --platform csv --csv -',
  ],
  flags: {
    platform: { type: 'string', description: 'ig | yt | csv.', required: true },
    queries: { type: 'string', description: 'Comma-separated search phrases.' },
    niche: { type: 'string', description: 'Niche label stored on every creator found.' },
    limit: { type: 'string', description: 'Max creators to keep from this run.', default: '60' },
    minFollowers: { type: 'string', description: 'Lower bound of the follower window.', default: String(QUALIFICATION.minFollowers) },
    maxFollowers: { type: 'string', description: 'Upper bound of the follower window.', default: String(QUALIFICATION.maxFollowers) },
    minEngagement: { type: 'string', description: 'Engagement floor, 0-1. Defaults per platform (see ENGAGEMENT_FLOORS). Flagged, not excluded.' },
    csv: { type: 'string', description: 'CSV path for --platform csv. Use "-" to read stdin.' },
    csvPlatform: { type: 'string', description: 'Backend for CSV rows with no platform column.', default: 'ig' },
    actor: { type: 'string', description: 'Override the Apify actor id.' },
  },
};

function toNumber(value: unknown, fallback: number, flag: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`--${flag} must be a number, got "${String(value)}"`);
  return parsed;
}

const PLATFORM_ALIASES: Record<string, FinderPlatform> = {
  ig: 'ig',
  instagram: 'ig',
  yt: 'yt',
  youtube: 'yt',
  csv: 'csv',
};

await runCli(spec, async ({ flags, log, dryRun, json }) => {
  const platformFlag = String(flags.platform ?? '').toLowerCase();
  const platform = PLATFORM_ALIASES[platformFlag];
  if (!platform) {
    throw new Error(`--platform must be one of ig, yt, csv (got "${flags.platform}")`);
  }

  const queries = String(flags.queries ?? '')
    .split(',')
    .map((q) => q.trim())
    .filter(Boolean);

  if (platform !== 'csv' && !queries.length) {
    throw new Error('--queries is required unless --platform is csv.');
  }

  const csvPlatform = PLATFORM_ALIASES[String(flags.csvPlatform ?? 'ig').toLowerCase()];

  const result = await findCreators({
    platform,
    queries,
    ...(flags.niche ? { niche: String(flags.niche) } : {}),
    limit: toNumber(flags.limit, 60, 'limit'),
    minFollowers: toNumber(flags.minFollowers, QUALIFICATION.minFollowers, 'minFollowers'),
    maxFollowers: toNumber(flags.maxFollowers, QUALIFICATION.maxFollowers, 'maxFollowers'),
    ...(flags.minEngagement !== undefined
      ? { minEngagement: toNumber(flags.minEngagement, 0, 'minEngagement') }
      : {}),
    ...(flags.csv ? { csvPath: String(flags.csv) } : {}),
    csvPlatform: csvPlatform === 'yt' ? 'YOUTUBE' : 'INSTAGRAM',
    ...(flags.actor ? { actor: String(flags.actor) } : {}),
    dryRun,
    log,
  });

  if (json) {
    console.log(
      JSON.stringify(
        {
          found: result.found,
          qualified: result.qualified,
          created: result.created,
          updated: result.updated,
          creators: result.candidates.map((c) => ({
            handle: c.profile.handle,
            platform: c.profile.platform,
            followers: c.profile.followers,
            ...c.metrics,
            hasDigitalProduct: c.detection.hasDigitalProduct,
            productEvidence: c.detection.signals,
            contactEmail: c.profile.contactEmail,
            qualified: c.qualified,
            reason: c.reason,
          })),
        },
        null,
        2,
      ),
    );
    return;
  }

  const qualified = result.candidates.filter((c) => c.qualified);

  const table = renderTable<FinderCandidate>(qualified, [
    { header: 'handle', value: (c) => c.profile.handle, maxWidth: 28 },
    { header: 'platform', value: (c) => (c.profile.platform === 'INSTAGRAM' ? 'ig' : 'yt') },
    { header: 'followers', value: (c) => compactNumber(c.profile.followers), align: 'right' },
    {
      header: 'eng',
      value: (c) =>
        percent(
          c.profile.platform === 'YOUTUBE' ? c.metrics.engagementPerView : c.metrics.engagementRate,
        ),
      align: 'right',
    },
    { header: 'views', value: (c) => compactNumber(c.metrics.avgViews), align: 'right' },
    { header: 'posts/wk', value: (c) => (c.metrics.postsPerWeek ?? '—').toString(), align: 'right' },
    { header: 'product?', value: (c) => (c.detection.hasDigitalProduct ? 'yes' : 'no') },
    { header: 'email', value: (c) => (c.profile.contactEmail ? 'yes' : '—') },
    { header: 'note', value: (c) => c.reason ?? '', maxWidth: 34 },
  ]);

  console.log(`\n${table}\n`);

  if (result.skipped.length) {
    console.log(`skipped (${result.skipped.length}):`);
    for (const item of result.skipped.slice(0, 15)) {
      console.log(`  ${item.handle.padEnd(28)} ${item.reason}`);
    }
    if (result.skipped.length > 15) console.log(`  … and ${result.skipped.length - 15} more`);
    console.log('');
  }

  const withoutProduct = qualified.filter((c) => !c.detection.hasDigitalProduct).length;
  console.log(
    `${result.found} fetched · ${result.qualified} in window · ${withoutProduct} with no product yet · ${result.created} new · ${result.updated} refreshed${dryRun ? ' (dry run — nothing written)' : ''}`,
  );
  console.log(
    result.qualified > 0
      ? 'Next: npm run scorer -- --all\n'
      : 'Nothing qualified. Widen --minFollowers/--maxFollowers or try other queries.\n',
  );
});
