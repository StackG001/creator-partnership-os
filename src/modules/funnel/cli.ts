import { runCli, notImplemented, type CliSpec } from '../../lib/cli.js';

export const spec: CliSpec = {
  name: 'funnel',
  summary: "Generate the sales page, order bump and upsell for a product.",
  examples: [
    'npm run funnel -- --handle jamesclearcoffee',
    'npm run funnel -- --handle jamesclearcoffee --price 3700 --bump-price 1700 --upsell-price 9700',
  ],
  flags: {
    handle: { type: 'string', description: 'Creator whose funnel this is.', required: true },
    product: { type: 'string', description: 'Product id. Defaults to the latest one.' },
    price: { type: 'string', description: 'Core offer price in cents.', default: '3700' },
    'bump-price': { type: 'string', description: 'Order bump price in cents.', default: '1700' },
    'upsell-price': { type: 'string', description: 'Upsell price in cents.', default: '9700' },
  },
};

await runCli(spec, async () => {
  notImplemented(spec);
});
