import { runCli, notImplemented, type CliSpec } from '../../lib/cli.js';

export const spec: CliSpec = {
  name: 'outreach',
  summary: "Write personalised first-touch and follow-up messages per creator.",
  examples: [
    'npm run outreach -- --handle jamesclearcoffee --channel email',
    'npm run outreach -- --handle jamesclearcoffee --channel ig_dm --variants 3',
    'npm run outreach -- --handle jamesclearcoffee --sequence 2',
  ],
  flags: {
    handle: { type: 'string', description: 'Creator handle to write to.', required: true },
    channel: { type: 'string', description: 'email | ig_dm | yt_about | x_dm.', default: 'email' },
    sequence: { type: 'string', description: '1 = first touch, 2+ = follow-up.', default: '1' },
    variants: { type: 'string', description: 'How many variants to draft.', default: '2' },
  },
};

await runCli(spec, async () => {
  notImplemented(spec);
});
