import { runCli, type CliSpec } from '../lib/cli.js';
import { BACKUP, renderBackupResult, restoreDatabase, runBackup } from '../lib/backup.js';

export const spec: CliSpec = {
  name: 'backup',
  summary: `Back up the database (SQLite online snapshot + integrity check) and outputs/ (zip) to Google Drive, keeping the last ${BACKUP.keep} of each. .env is never backed up.`,
  examples: [
    'npm run backup                      # back up now',
    'npm run backup -- --dry-run         # show what it would write and delete; writes nothing',
    'npm run backup -- --restore db-2026-11-10_1830.sqlite             # check the backup, show what would happen',
    'npm run backup -- --restore db-2026-11-10_1830.sqlite --confirm   # safety copy of the current db, then restore',
  ],
  flags: {
    restore: { type: 'string', description: 'A db-*.sqlite backup (file name in the Drive backup folder, or a path) to put back in place.' },
    confirm: { type: 'boolean', description: 'With --restore: actually do it (takes a safety copy of the current database first).' },
  },
};

await runCli(spec, async (ctx) => {
  if (typeof ctx.flags.restore === 'string') {
    const r = await restoreDatabase(ctx.flags.restore, { confirm: ctx.flags.confirm === true && !ctx.dryRun });
    console.log(
      [
        `${r.dryRun ? '[check only] would restore' : 'Restored'}: ${r.from}`,
        `  → ${r.to}`,
        `- backup integrity_check: ${r.check.integrity} · ${r.check.deals} deal rows · ${r.check.creators} creator rows`,
        `- safety copy of the current database ${r.dryRun ? 'would be' : 'saved as'}: ${r.safetyCopy}`,
        r.dryRun ? 'Nothing changed. Add --confirm to restore.' : 'Done. If the backup predates a schema change, run `npm run db:push` to add any missing tables.',
      ].join('\n'),
    );
    return;
  }
  const r = await runBackup({ dryRun: ctx.dryRun });
  console.log(ctx.json ? JSON.stringify(r, null, 2) : renderBackupResult(r).join('\n'));
});
