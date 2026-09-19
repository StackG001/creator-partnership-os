import { runCli, type CliSpec } from '../../lib/cli.js';
import { buildFunnel } from './index.js';

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

await runCli(spec, async (ctx) => {
  if (ctx.dryRun) {
    throw new Error('funnel calls the Anthropic API to write copy — --dry-run is not supported.');
  }

  const copy = await buildFunnel(
    String(ctx.flags.handle),
    {
      priceCents: Number(ctx.flags.price ?? 3700),
      bumpPriceCents: Number(ctx.flags['bump-price'] ?? 1700),
      upsellPriceCents: Number(ctx.flags['upsell-price'] ?? 9700),
    },
    ctx.flags.product ? String(ctx.flags.product) : undefined,
  );

  if (ctx.json) {
    console.log(JSON.stringify(copy, null, 2));
    return;
  }

  ctx.log.info(`headline: ${copy.salesPage.headline}`);
  ctx.log.info(`order bump: ${copy.orderBump.title}`);
  ctx.log.info(`upsell: ${copy.upsell.title}`);
});
