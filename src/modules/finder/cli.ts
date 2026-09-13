import { runCli, notImplemented, type CliSpec } from '../../lib/cli.js';

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
    query: { type: 'string', description: 'Hashtag, search phrase or seed handle to expand from.' },
    niche: { type: 'string', description: 'Niche label stored on every creator found.' },
    source: { type: 'string', description: 'Re-run an existing Source by id.' },
    limit: { type: 'string', description: 'Max creators to keep from this run.', default: '25' },
    'min-followers': { type: 'string', description: 'Lower bound of the follower window.', default: '10000' },
    'max-followers': { type: 'string', description: 'Upper bound of the follower window.', default: '200000' },
    'min-engagement': { type: 'string', description: 'Minimum engagement rate, 0-1.', default: '0.02' },
  },
};

await runCli(spec, async () => {
  notImplemented(spec);
});
