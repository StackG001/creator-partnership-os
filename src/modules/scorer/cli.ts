import { runCli, notImplemented, type CliSpec } from '../../lib/cli.js';

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

await runCli(spec, async () => {
  notImplemented(spec);
});
