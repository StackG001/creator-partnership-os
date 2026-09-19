import { runCli, type CliSpec } from '../../lib/cli.js';
import { buildProduct, type ProductStage } from './index.js';

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
    title: { type: 'string', description: 'Override the product title (defaults to the chosen angle\'s title).' },
    pages: { type: 'string', description: 'Target page count, 35-50.', default: '40' },
    stage: { type: 'string', description: 'research | outline | write | render | all.', default: 'all' },
    resume: { type: 'boolean', description: 'Continue the last unfinished build (stages are cached to disk by default).' },
    refresh: { type: 'boolean', description: 'Force the targeted stage to redo its work instead of reusing cached output.' },
  },
};

const VALID_STAGES: ProductStage[] = ['research', 'outline', 'write', 'render', 'all'];

await runCli(spec, async (ctx) => {
  if (ctx.dryRun) {
    throw new Error(
      'product calls paid APIs at every stage (Serper + Anthropic, Playwright for render) — --dry-run is not supported.',
    );
  }

  const stageFlag = String(ctx.flags.stage ?? 'all');
  if (!VALID_STAGES.includes(stageFlag as ProductStage)) {
    throw new Error(`Unknown stage "${stageFlag}" — expected one of: ${VALID_STAGES.join(', ')}`);
  }

  const result = await buildProduct(String(ctx.flags.handle), {
    angle: Number(ctx.flags.angle ?? 1),
    title: ctx.flags.title ? String(ctx.flags.title) : undefined,
    pages: Number(ctx.flags.pages ?? 40),
    stage: stageFlag as ProductStage,
    resume: ctx.flags.resume === true,
    refresh: ctx.flags.refresh === true,
  });

  if (ctx.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  ctx.log.info(`"${result.title}" — ${result.sources} sources`);
  if (result.pageCount) ctx.log.info(`~${result.pageCount} pages, ~${result.wordCount} words`);
  if (result.htmlPath) ctx.log.info(`HTML: ${result.htmlPath}`);
  if (result.pdfPath) ctx.log.info(`PDF: ${result.pdfPath}`);
  ctx.log.info(`productId: ${result.productId}`);
});
