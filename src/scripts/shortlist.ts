import path from 'node:path';
import fs from 'node:fs/promises';
import { runCli, type CliSpec } from '../lib/cli.js';
import { prisma } from '../lib/db.js';
import { compactNumber, renderTable, toCsv } from '../lib/table.js';

/**
 * The handover artifact: the top N scored creators, ranked, as a table on
 * screen and a CSV on disk. This is what actually gets worked — everything
 * upstream exists to produce it.
 */

const spec: CliSpec = {
  name: 'shortlist',
  summary: 'Print the top scored creators and write outputs/shortlist.csv.',
  examples: [
    'npm run shortlist -- --top 15',
    'npm run shortlist -- --top 25 --verdict GO',
    'npm run shortlist -- --top 15 --out outputs/credit-shortlist.csv',
  ],
  flags: {
    top: { type: 'string', description: 'How many creators to list.', default: '15' },
    verdict: { type: 'string', description: 'Only include this verdict: GO | MAYBE | NO.' },
    'no-product': { type: 'boolean', description: 'Exclude creators who already sell something.' },
    out: { type: 'string', description: 'Where to write the CSV.', default: 'outputs/shortlist.csv' },
  },
};

interface ScoreJson {
  reasons?: string[];
  redFlags?: string[];
  recommendedProductType?: string;
  priceBand?: string;
  verdict?: string;
  llm?: boolean;
}

await runCli(spec, async ({ flags, json, log }) => {
  const top = Number(flags.top ?? 15);
  if (!Number.isFinite(top) || top < 1) throw new Error(`--top must be a positive number.`);

  const verdict = flags.verdict ? String(flags.verdict).toUpperCase() : undefined;
  if (verdict && !['GO', 'MAYBE', 'NO'].includes(verdict)) {
    throw new Error(`--verdict must be GO, MAYBE or NO (got "${flags.verdict}").`);
  }

  const creators = await prisma.creator.findMany({
    where: {
      score: { not: null },
      ...(verdict ? { scoreVerdict: verdict } : {}),
      ...(flags['no-product'] ? { hasDigitalProduct: false } : {}),
    },
    orderBy: [{ score: 'desc' }, { followers: 'desc' }],
    take: top,
  });

  if (!creators.length) {
    console.log('\nNothing scored yet. Run `npm run finder` then `npm run scorer -- --all`.\n');
    return;
  }

  const rows = creators.map((creator) => {
    const scoreJson = (creator.scoreJson ?? {}) as ScoreJson;
    return {
      handle: creator.handle,
      platform: creator.platform === 'INSTAGRAM' ? 'ig' : 'yt',
      followers: creator.followers,
      score: creator.score ?? 0,
      verdict: creator.scoreVerdict ?? scoreJson.verdict ?? '—',
      // The brief asks for one line; the first reason is the headline one.
      reason: scoreJson.reasons?.[0] ?? '',
      productType: scoreJson.recommendedProductType ?? '',
      priceBand: scoreJson.priceBand ?? '',
      email: creator.contactEmail ?? '',
      profileUrl: creator.profileUrl ?? '',
      hasProduct: creator.hasDigitalProduct ? 'yes' : 'no',
      scoredBy: scoreJson.llm === false ? 'metrics-only' : 'llm+metrics',
    };
  });

  if (json) {
    console.log(JSON.stringify(rows, null, 2));
  } else {
    console.log(
      `\n${renderTable(rows, [
        { header: 'handle', value: (r) => r.handle, maxWidth: 26 },
        { header: 'followers', value: (r) => compactNumber(r.followers), align: 'right' },
        { header: 'score', value: (r) => String(r.score), align: 'right' },
        { header: 'verdict', value: (r) => r.verdict },
        { header: 'reason', value: (r) => r.reason, maxWidth: 62 },
      ])}\n`,
    );
  }

  const outPath = path.resolve(process.cwd(), String(flags.out ?? 'outputs/shortlist.csv'));
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(
    outPath,
    toCsv(rows, [
      { header: 'handle', value: (r) => r.handle },
      { header: 'platform', value: (r) => r.platform },
      { header: 'followers', value: (r) => r.followers },
      { header: 'score', value: (r) => r.score },
      { header: 'verdict', value: (r) => r.verdict },
      { header: 'reason', value: (r) => r.reason },
      { header: 'recommended_product', value: (r) => r.productType },
      { header: 'price_band', value: (r) => r.priceBand },
      { header: 'has_product', value: (r) => r.hasProduct },
      { header: 'email', value: (r) => r.email },
      { header: 'profile_url', value: (r) => r.profileUrl },
      { header: 'scored_by', value: (r) => r.scoredBy },
    ]),
    'utf8',
  );

  log.info(`wrote ${path.relative(process.cwd(), outPath)} (${rows.length} rows)`);
});
