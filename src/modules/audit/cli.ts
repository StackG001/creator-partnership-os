import { runCli, notImplemented, type CliSpec } from '../../lib/cli.js';

export const spec: CliSpec = {
  name: 'audit',
  summary: "Research-backed audit of a creator's audience, pains and product angles.",
  examples: [
    'npm run audit -- --handle jamesclearcoffee',
    'npm run audit -- --handle jamesclearcoffee --posts 40 --refresh',
  ],
  flags: {
    handle: { type: 'string', description: 'Creator handle to audit.', required: true },
    posts: { type: 'string', description: 'How many recent posts/videos to analyse.', default: '30' },
    refresh: { type: 'boolean', description: 'Re-fetch source content instead of using cached artifacts.' },
  },
};

await runCli(spec, async () => {
  notImplemented(spec);
});
