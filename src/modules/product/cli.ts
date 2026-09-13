import { runCli, notImplemented, type CliSpec } from '../../lib/cli.js';

export const spec: CliSpec = {
  name: 'product',
  summary: "Research and write the 35-50 page PDF in the creator's voice.",
  examples: [
    'npm run product -- --handle jamesclearcoffee --angle 1',
    'npm run product -- --handle jamesclearcoffee --pages 42 --stage outline',
    'npm run product -- --handle jamesclearcoffee --resume',
  ],
  flags: {
    handle: { type: 'string', description: 'Creator the product is built for.', required: true },
    angle: { type: 'string', description: 'Which audit product angle to build (1-based).', default: '1' },
    pages: { type: 'string', description: 'Target page count, 35-50.', default: '40' },
    stage: { type: 'string', description: 'research | outline | write | render | all.', default: 'all' },
    resume: { type: 'boolean', description: 'Continue the last unfinished build.' },
  },
};

await runCli(spec, async () => {
  notImplemented(spec);
});
