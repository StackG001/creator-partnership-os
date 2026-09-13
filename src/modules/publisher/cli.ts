import { runCli, notImplemented, type CliSpec } from '../../lib/cli.js';

export const spec: CliSpec = {
  name: 'publisher',
  summary: "Publish the funnel on Whop with revenue share and sync results.",
  examples: [
    'npm run publisher -- --handle jamesclearcoffee --rev-share 50',
    'npm run publisher -- --handle jamesclearcoffee --dry-run',
    'npm run publisher -- --sync-stats',
  ],
  flags: {
    handle: { type: 'string', description: 'Creator to publish for.' },
    product: { type: 'string', description: 'Product id. Defaults to the latest RENDERED one.' },
    'rev-share': { type: 'string', description: "The creator's revenue share, 0-100.", default: '50' },
    'sync-stats': { type: 'boolean', description: 'Refresh sales figures for every LIVE launch.' },
  },
};

await runCli(spec, async () => {
  notImplemented(spec);
});
