import { runCli, type CliSpec } from '../../lib/cli.js';
import { QUOTE_ORIGINS, type QuoteOrigin } from '../../lib/constants.js';
import { describeAuthor } from '../../lib/quotes.js';
import { addQuote, backfill, checkAllCreators, dropQuote, fixQuote, listQuotes } from './index.js';

export const spec: CliSpec = {
  name: 'quotes',
  summary:
    'Sourced quotes per creator: check every creator for unsourced quotes / placeholder fields, add a quote with its post link, fix or drop one.',
  examples: [
    'npm run quotes                       # check every creator, list the ones flagged for review',
    'npm run quotes -- --list --handle therealnicolesvenson',
    'npm run quotes -- --add --handle grantbakes --text "my starter never rises" --url https://youtube.com/watch?v=… --author @bakerbob',
    'npm run quotes -- --add --handle grantbakes --text "…" --url https://… --author creator --origin chrome',
    'npm run quotes -- --fix <quoteId> --url https://www.instagram.com/p/ABC123/ --author @follower',
    'npm run quotes -- --drop <quoteId>',
  ],
  flags: {
    list: { type: 'boolean', description: 'List one creator\'s quotes (needs --handle).' },
    add: { type: 'boolean', description: 'Save a new quote. Needs --handle, --text, --url, --author.' },
    fix: { type: 'string', description: 'Quote id to give its missing source (--url, --author, --found).' },
    drop: { type: 'string', description: 'Quote id to delete.' },
    backfill: { type: 'boolean', description: 'One-time: trace existing audit quotes, import hand-seeded ones, clean seeded bios.' },
    handle: { type: 'string', description: 'Creator handle.' },
    text: { type: 'string', description: 'The quote, word for word (or exactly the excerpt kept, with --trimmed).' },
    url: { type: 'string', description: 'Post/video URL the quote is from. Required to save.' },
    author: { type: 'string', description: '"creator" for their own caption, the follower\'s @handle, or "follower" if the handle wasn\'t recorded (saved but stays blocked).' },
    full: { type: 'string', description: 'The full comment/caption, if --text is an excerpt. Trimming is then detected.' },
    trimmed: { type: 'boolean', description: '--text was cut from a longer comment (when --full isn\'t available).' },
    origin: { type: 'string', description: 'manual | chrome (Claude in Chrome research).', default: 'manual' },
    found: { type: 'string', description: 'Date the quote was found, YYYY-MM-DD.', default: 'today' },
    pain: { type: 'string', description: 'Optional: what the quote shows, paraphrased.' },
  },
};

function parseOrigin(raw: string): QuoteOrigin {
  const map: Record<string, QuoteOrigin> = { manual: 'MANUAL', chrome: 'CHROME_RESEARCH' };
  const origin = map[raw.trim().toLowerCase()] ?? raw.trim().toUpperCase();
  if (!(QUOTE_ORIGINS as readonly string[]).includes(origin)) throw new Error(`Unknown --origin "${raw}" — manual | chrome.`);
  return origin as QuoteOrigin;
}

const str = (v: string | boolean | undefined) => (typeof v === 'string' ? v : undefined);

await runCli(spec, async (ctx) => {
  const f = ctx.flags;
  if (ctx.dryRun) throw new Error('quotes only reads/writes the local database — --dry-run has nothing to skip.');

  if (f.backfill) {
    const r = await backfill();
    if (ctx.json) return void console.log(JSON.stringify(r, null, 2));
    for (const a of r.auditQuotes) {
      ctx.log.info(`@${a.handle}: ${a.saved} audit quote(s) traced to their post${a.dropped.length ? `, ${a.dropped.length} dropped (not word for word in the fetched text)` : ''}`);
    }
    ctx.log.info(`hand-seeded quotes imported (no link yet): ${r.legacyQuotes.join(', ') || 'none'}`);
    for (const b of r.biosCleaned) ctx.log.info(`@${b.handle}: seeded text removed from bio`);
    return;
  }

  if (f.add) {
    if (!f.handle || !f.text) throw new Error('--add needs --handle and --text (plus --url and --author).');
    const q = await addQuote({
      handle: String(f.handle),
      text: String(f.text),
      url: str(f.url),
      author: str(f.author),
      fullText: str(f.full),
      trimmed: Boolean(f.trimmed),
      origin: parseOrigin(String(f.origin ?? 'manual')),
      found: f.found && f.found !== 'today' ? String(f.found) : undefined,
      pain: str(f.pain),
    });
    if (ctx.json) return void console.log(JSON.stringify(q, null, 2));
    ctx.log.info(`saved ${q.id}: "${q.text}" — ${describeAuthor(q)}${q.isTrimmed ? ' (trimmed excerpt)' : ''} · ${q.sourceUrl}`);
    return;
  }

  if (f.fix) {
    const q = await fixQuote(String(f.fix), {
      url: str(f.url),
      author: str(f.author),
      found: f.found && f.found !== 'today' ? String(f.found) : undefined,
      trimmed: Boolean(f.trimmed),
      fullText: str(f.full),
      text: str(f.text),
    });
    if (ctx.json) return void console.log(JSON.stringify(q, null, 2));
    ctx.log.info(`updated ${q.id}: ${describeAuthor(q)} · ${q.sourceUrl ?? '(still no URL)'}`);
    return;
  }

  if (f.drop) {
    const r = await dropQuote(String(f.drop));
    ctx.log.info(`@${r.handle}: dropped "${r.text}"`);
    return;
  }

  if (f.list) {
    if (!f.handle) throw new Error('--list needs --handle.');
    const quotes = await listQuotes(String(f.handle));
    if (ctx.json) return void console.log(JSON.stringify(quotes, null, 2));
    if (!quotes.length) ctx.log.info('no quotes saved for this creator');
    for (const q of quotes) {
      console.log(`${q.id}  ${q.problems.length ? `BLOCKED (${q.problems.join(', ')})` : 'ok'}`);
      console.log(`  "${q.text}"${q.isTrimmed ? ' [trimmed]' : ''}`);
      console.log(`  ${describeAuthor(q)} · ${q.sourceUrl ?? 'no URL'} · found ${q.foundAt?.toISOString().slice(0, 10) ?? '?'} · ${q.origin}`);
    }
    return;
  }

  const { checked, flagged } = await checkAllCreators();
  if (ctx.json) return void console.log(JSON.stringify({ checked, flagged }, null, 2));
  if (!flagged.length) {
    ctx.log.info(`checked ${checked} creators — every quote has a source, no placeholder text found.`);
    return;
  }
  console.log(`Checked ${checked} creators — ${flagged.length} flagged for review (drafting, approving and sending are blocked for them):\n`);
  for (const c of flagged) {
    console.log(`@${c.handle}${c.displayName ? ` (${c.displayName})` : ''} · ${c.status} · ${c.sentMessages} sent, ${c.pendingMessages} draft/approved waiting`);
    for (const q of c.quotes) {
      console.log(`  ${q.id}  "${q.text}"`);
      console.log(`    ${q.problems.join('; ')}`);
    }
    for (const p of c.placeholders) console.log(`  ${p.field}: ${p.label}`);
    console.log('');
  }
  console.log('Fix:  npm run quotes -- --fix <quoteId> --url <post url> --author creator|@follower');
  console.log('Drop: npm run quotes -- --drop <quoteId>');
});
