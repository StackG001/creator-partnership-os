import { runCli, type CliSpec } from '../../lib/cli.js';
import { dryRunDaily, renderDailySummary, runDailyPart, type DailyPart } from './index.js';

export const spec: CliSpec = {
  name: 'pipeline',
  summary:
    'The daily automated loop in two parts — youtube (09:00) and instagram (10:00): niche-library searches → score → find email → audit → draft seq 1; draft due seq 2/3; auto-send emails that pass every check (when AUTO_SEND.enabled); write outputs/_pipeline/latest.md.',
  examples: [
    'npm run pipeline -- --dry-run                  # full plan: Apify plan, run size, first week of searches; nothing scraped, drafted or sent',
    'npm run pipeline -- --daily --part youtube     # cron 09:00',
    'npm run pipeline -- --daily --part instagram   # cron 10:00',
    'npm run pipeline -- --daily --part instagram --force',
    'npm run pipeline -- --summary                  # rewrite today\'s summary from the database',
  ],
  flags: {
    daily: { type: 'boolean', description: 'Run one daily part (needs --part). Each part runs once a day.' },
    part: { type: 'string', description: 'youtube | instagram.' },
    force: { type: 'boolean', description: 'With --daily: run even if this part already ran today.' },
    summary: { type: 'boolean', description: 'Print today\'s summary from the database.' },
  },
};

await runCli(spec, async (ctx) => {
  if (ctx.dryRun) {
    console.log(await dryRunDaily());
    return;
  }
  if (ctx.flags.summary) {
    const d = new Date();
    console.log(await renderDailySummary(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`));
    return;
  }
  if (!ctx.flags.daily) throw new Error('pass --daily --part youtube|instagram, --dry-run, or --summary.');
  const part = String(ctx.flags.part ?? '').toLowerCase();
  if (part !== 'youtube' && part !== 'instagram') throw new Error('--part must be youtube or instagram.');
  const result = await runDailyPart(part as DailyPart, { force: Boolean(ctx.flags.force) });
  if ('skipped' in result) {
    ctx.log.info(result.skipped);
    return;
  }
  ctx.log.info(`${part} done — summary in ${result.summaryPath} and outputs/_pipeline/latest.md`);
});
