import { runCli, type CliSpec } from '../../lib/cli.js';
import { NICHE_LIBRARY } from '../../lib/constants.js';
import { ensureLegacyNiches, generateNiches, libraryReport } from './index.js';

export const spec: CliSpec = {
  name: 'niches',
  summary:
    'The niche library: list it, or generate new niches + search terms (the daily pipeline does this weekly on its own).',
  examples: ['npm run niches', 'npm run niches -- --generate', 'npm run niches -- --generate --count 10'],
  flags: {
    generate: { type: 'boolean', description: `Add new niches now (Anthropic call) plus similar-accounts searches for qualified Instagram creators.` },
    count: { type: 'string', description: 'How many niches to generate.', default: String(NICHE_LIBRARY.newNichesPerWeek) },
  },
};

await runCli(spec, async (ctx) => {
  if (ctx.flags.generate) {
    if (ctx.dryRun) throw new Error('--generate calls the Anthropic API — there is nothing to dry-run.');
    const r = await generateNiches(Number(ctx.flags.count));
    if (ctx.json) {
      console.log(JSON.stringify(r, null, 2));
      return;
    }
    for (const n of r.created) {
      console.log(`+ ${n.name} [${n.category}${n.sensitive ? ', sensitive' : ''}, ${n.origin}] — ${n.why}`);
      console.log(`    ${n.terms.join(' · ')}`);
    }
    if (r.similar.length) console.log(`+ similar-accounts searches: ${r.similar.join(', ')}`);
    return;
  }
  await ensureLegacyNiches();
  console.log((await libraryReport()).join('\n'));
});
