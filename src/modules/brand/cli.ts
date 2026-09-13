import { runCli, notImplemented, type CliSpec } from '../../lib/cli.js';

export const spec: CliSpec = {
  name: 'brand',
  summary: "Extract a creator's voice, palette and visual style into a brand profile.",
  examples: [
    'npm run brand -- --handle jamesclearcoffee',
    'npm run brand -- --handle jamesclearcoffee --refresh',
  ],
  flags: {
    handle: { type: 'string', description: 'Creator handle to profile.', required: true },
    refresh: { type: 'boolean', description: 'Rebuild the profile from scratch.' },
  },
};

await runCli(spec, async () => {
  notImplemented(spec);
});
