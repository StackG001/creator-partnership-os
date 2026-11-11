import { runCli, type CliSpec } from '../../lib/cli.js';
import { publishLaunch, syncLaunchStats } from './index.js';

export const spec: CliSpec = {
  name: 'publisher',
  summary: "Publish the funnel on Whop with revenue share and sync results.",
  examples: [
    'npm run publisher -- --handle emmarepairs --whop-user emmarepairs --dry-run   # print every Whop call, make none',
    'npm run publisher -- --handle emmarepairs --whop-user emmarepairs             # product → 50% rev-share override → checkout',
    'npm run publisher -- --handle jamesclearcoffee --rev-share 50',
    'npm run publisher -- --handle jamesclearcoffee --dry-run',
    'npm run publisher -- --sync-stats',
  ],
  flags: {
    handle: { type: 'string', description: 'Creator to publish for.' },
    product: { type: 'string', description: 'Product id. Defaults to the latest RENDERED one.' },
    'rev-share': { type: 'string', description: "The creator's revenue share, 0-100.", default: '50' },
    'whop-user': { type: 'string', description: "The creator's Whop username, email or user id — their revenue share is set on it (saved on the deal; later runs reuse it)." },
    'skip-rev-share': { type: 'boolean', description: 'Publish without setting the revenue share (it is recorded and flagged until set by hand in the dashboard).' },
    'sync-stats': { type: 'boolean', description: 'Refresh sales figures for every LIVE launch.' },
  },
};

await runCli(spec, async (ctx) => {
  if (ctx.flags['sync-stats']) {
    const stats = await syncLaunchStats();
    if (ctx.json) {
      console.log(JSON.stringify(stats, null, 2));
    } else {
      for (const s of stats) {
        ctx.log.info(`${s.launchId}: ${s.sales} sales, $${(s.revenueCents / 100).toFixed(2)} revenue`);
      }
      ctx.log.info(`synced ${stats.length} live launch(es)`);
    }
    return;
  }

  if (!ctx.flags.handle) {
    throw new Error('--handle is required unless --sync-stats is used.');
  }

  const result = await publishLaunch(String(ctx.flags.handle), Number(ctx.flags['rev-share'] ?? 50), {
    dryRun: ctx.dryRun,
    productId: ctx.flags.product ? String(ctx.flags.product) : undefined,
    whopUser: typeof ctx.flags['whop-user'] === 'string' ? ctx.flags['whop-user'] : undefined,
    skipRevShare: ctx.flags['skip-rev-share'] === true,
  });

  if (ctx.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (result.dryRun) {
    ctx.log.info('Dry run complete — nothing was published. Re-run without --dry-run to go live.');
  } else {
    ctx.log.info(`published: ${result.url}`);
    ctx.log.info(`launchId: ${result.launchId}`);
    ctx.log.info(result.revShare);
  }
});
