import { runCli, type CliSpec } from '../../lib/cli.js';
import { DealStageSchema } from '../../lib/constants.js';
import {
  addLedgerEntry,
  day,
  addNote,
  addPromo,
  getDeal,
  listDeals,
  renderList,
  renderShow,
  setAgreement,
  setNext,
  setStage,
  setTerms,
  syncDeals,
} from './index.js';
import { renderDealsReport } from './report.js';

export const spec: CliSpec = {
  name: 'deals',
  summary:
    'Deal tracker: every creator deal from first find to monthly payout. Reads the local database only — no outreach, no Whop or Apify calls. Terms: docs/partnership-terms.md.',
  allowPositionals: true,
  examples: [
    'npm run deals -- --sync                                   # create/advance deals from existing data, write this month\'s ledger rows',
    'npm run deals -- --list --stage REPLIED',
    'npm run deals -- --show @emmarepairs',
    'npm run deals -- --stage @emmarepairs AGREED --note "said yes by email"',
    'npm run deals -- --stage @emmarepairs --auto              # hand the stage back to auto-sync',
    'npm run deals -- --agreement @emmarepairs sent --url https://claude.ai/artifact/… --date 2026-11-12',
    'npm run deals -- --terms @emmarepairs --share 50 --basis after_fees --window 2026-12-01:2026-12-14 --posts 3',
    'npm run deals -- --promo @emmarepairs --done +1',
    'npm run deals -- --notes @uswa_arshad_ "Education niche — no medical claims"',
    'npm run deals -- --next @emmarepairs "send the outline" --due 2026-11-11',
    'npm run deals -- --ledger @emmarepairs --period 2026-12 --gross 49.00 --fees 3.10 --refunds 0 --sales 2',
    'npm run deals -- --report',
  ],
  flags: {
    sync: { type: 'boolean', description: 'Run auto-sync.' },
    list: { type: 'boolean', description: 'Table of deals (optionally --stage X).' },
    show: { type: 'string', description: '@handle: everything about one deal, incl. stage history and ledger.' },
    stage: { type: 'string', description: 'With --list: filter by stage. Otherwise @handle STAGE: set the stage by hand (MANUAL). Refuses BUILDING without a SIGNED agreement.' },
    auto: { type: 'boolean', description: 'With --stage @handle: hand the stage back to auto-sync.' },
    note: { type: 'string', description: 'Note for --stage (stage history; the lost reason for LOST) or --ledger.' },
    agreement: { type: 'string', description: '@handle sent|signed|ended.' },
    url: { type: 'string', description: 'With --agreement: link to this creator\'s filled-in agreement.' },
    date: { type: 'string', description: 'With --agreement: YYYY-MM-DD (default today).' },
    terms: { type: 'string', description: '@handle: change --share, --basis, --window, --posts.' },
    share: { type: 'string', description: 'Creator share %, 0-100.' },
    basis: { type: 'string', description: 'after_fees | gross.' },
    window: { type: 'string', description: 'Launch window YYYY-MM-DD:YYYY-MM-DD.' },
    posts: { type: 'string', description: 'Promo posts agreed for the launch window.' },
    'whop-user': { type: 'string', description: "With --terms: the creator's Whop username, email or user id (the publisher sets their revenue share on it)." },
    notes: { type: 'string', description: '@handle "text": add a dated note to the deal (--replace overwrites).' },
    replace: { type: 'boolean', description: 'With --notes: replace the existing notes.' },
    promo: { type: 'string', description: '@handle: record promo posts done (with --done +1).' },
    done: { type: 'string', description: '+N, -N or N.' },
    next: { type: 'string', description: '@handle "text": set the next action (with optional --due).' },
    due: { type: 'string', description: 'YYYY-MM-DD.' },
    ledger: { type: 'string', description: '@handle: manual ledger entry (dollars in, cents stored). Needs --period --gross --fees --refunds --sales.' },
    period: { type: 'string', description: 'YYYY-MM.' },
    gross: { type: 'string', description: 'Gross sales in dollars, e.g. 49.00.' },
    fees: { type: 'string', description: 'Whop fees in dollars.', default: '0' },
    refunds: { type: 'string', description: 'Refunds in dollars.', default: '0' },
    sales: { type: 'string', description: 'Number of sales.' },
    report: { type: 'boolean', description: 'Weekly report (funnel, deals needing action, money), ending with the Qualified leads table.' },
  },
};

const str = (v: string | boolean | undefined) => (typeof v === 'string' ? v : undefined);

await runCli(spec, async (ctx) => {
  const f = ctx.flags;
  const [word, ...rest] = ctx.positionals;
  if (rest.length) throw new Error(`unexpected extra argument(s): ${rest.join(' ')}`);
  const print = (lines: string[] | string) => console.log(Array.isArray(lines) ? lines.join('\n') : lines);

  if (f.sync) {
    const r = await syncDeals({ dryRun: ctx.dryRun });
    if (ctx.json) return print(JSON.stringify(r, null, 2));
    print([
      `${ctx.dryRun ? '[dry run] ' : ''}${r.total} deal(s) checked · ${r.created.length} created · ${r.moved.length} moved`,
      ...r.moved.map((m) => `  @${m.handle}: ${m.from} → ${m.to}`),
      ...r.manualKept.map((m) => `  @${m.handle}: kept at ${m.stage} (manual) — data says ${m.dataSays}`),
      ...r.flagged.map((m) => `  ⚠ @${m.handle}: ${m.flag}`),
      r.handHandled.length ? `  handled by hand — no automated outreach: ${r.handHandled.map((h) => `@${h}`).join(', ')}` : '',
      r.ledger.length ? `  ledger: ${r.ledger.map((l) => `@${l.handle} ${l.period}`).join(', ')}` : '  ledger: no launches with sales yet',
    ].filter(Boolean));
    return;
  }
  if (f.report) return print(await renderDealsReport());
  if (ctx.dryRun) throw new Error('--dry-run only applies to --sync.');

  if (f.list) {
    const stage = str(f.stage) ? DealStageSchema.parse(str(f.stage)!.toUpperCase()) : undefined;
    const deals = await listDeals(stage);
    return print(ctx.json ? JSON.stringify(deals.map((d) => ({ handle: d.creator.handle, stage: d.stage, agreement: d.agreementStatus, nextAction: d.nextAction, nextActionDue: d.nextActionDue })), null, 2) : renderList(deals));
  }
  if (str(f.show)) return print(renderShow(await getDeal(str(f.show)!)));

  if (str(f.stage)) {
    if (!f.auto && !word) throw new Error('usage: --stage @handle STAGE [--note "…"], or --stage @handle --auto');
    const d = await setStage(str(f.stage)!, word ?? '', { note: str(f.note), auto: Boolean(f.auto) });
    return print(`@${d.creator.handle}: ${d.stage} (${d.stageSource.toLowerCase()})`);
  }
  if (str(f.agreement)) {
    if (!word) throw new Error('usage: --agreement @handle sent|signed|ended [--url …] [--date YYYY-MM-DD]');
    const d = await setAgreement(str(f.agreement)!, word, { url: str(f.url), date: str(f.date) });
    return print(`@${d.creator.handle}: agreement ${d.agreementStatus}${d.endsAt ? ` · ends ${day(d.endsAt)}` : ''}`);
  }
  if (str(f.terms)) {
    const d = await setTerms(str(f.terms)!, { share: str(f.share), basis: str(f.basis), window: str(f.window), posts: str(f.posts), whopUser: str(f['whop-user']) });
    return print(`@${d.creator.handle}: creator ${d.creatorSharePct}% · ${d.feeBasis} · posts ${d.promoPostsDone}/${d.promoPostsAgreed ?? '—'}`);
  }
  if (str(f.notes)) {
    if (!word) throw new Error('usage: --notes @handle "text" [--replace]');
    const d = await addNote(str(f.notes)!, word, { replace: Boolean(f.replace) });
    return print(`@${d.creator.handle}: notes —\n${d.notes}`);
  }
  if (str(f.promo)) {
    if (!str(f.done)) throw new Error('usage: --promo @handle --done +1');
    const d = await addPromo(str(f.promo)!, str(f.done)!);
    return print(`@${d.creator.handle}: promo posts ${d.promoPostsDone}/${d.promoPostsAgreed ?? '—'}`);
  }
  if (str(f.next)) {
    if (!word) throw new Error('usage: --next @handle "text" --due YYYY-MM-DD');
    const d = await setNext(str(f.next)!, word, str(f.due));
    return print(`@${d.creator.handle}: next — ${d.nextAction}${d.nextActionDue ? ` (due ${day(d.nextActionDue)})` : ''}`);
  }
  if (str(f.ledger)) {
    const need = ['period', 'gross', 'sales'].filter((k) => !str(f[k]));
    if (need.length) throw new Error(`--ledger needs ${need.map((k) => `--${k}`).join(', ')}`);
    const d = await addLedgerEntry(str(f.ledger)!, {
      period: str(f.period)!, gross: str(f.gross)!, fees: str(f.fees) ?? '0', refunds: str(f.refunds) ?? '0', sales: str(f.sales)!, note: str(f.note),
    });
    return print(renderShow(d).slice(renderShow(d).indexOf('## Ledger')));
  }
  throw new Error('nothing to do — see --help.');
});
