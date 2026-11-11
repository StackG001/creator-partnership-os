import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { prisma } from './db.js';
import { getEnv } from './env.js';
import { outputsRoot } from './paths.js';

/**
 * Backups of the database and outputs/ to Google Drive (shared with Linux on
 * the Chromebook). The database is snapshotted with SQLite's own VACUUM INTO —
 * never a plain copy of a live file — and integrity-checked before anything
 * lands in Drive. Only files this module names (db-*.sqlite, outputs-*.zip)
 * in its own folder are ever deleted. .env is never backed up (API keys).
 */

export const BACKUP = {
  /** Folder under My Drive. */
  driveSubdir: path.join('iClipmedia Backups', 'creator-partnership-os'),
  /** Backups of each kind kept (28 = about 14 days at two daily parts); older ones are deleted from that folder only. */
  keep: 28,
} as const;

/** Where ChromeOS mounts My Drive in Linux once it's shared ("Share with Linux"). */
const DRIVE_CANDIDATES = [
  '/mnt/chromeos/GoogleDrive/MyDrive',
  '/mnt/chromeos/shared/GoogleDrive/MyDrive',
  '/mnt/shared/GoogleDrive/MyDrive',
];

const DB_FILE = /^db-\d{4}-\d{2}-\d{2}_\d{4}(-\d{2})?\.sqlite$/;
const ZIP_FILE = /^outputs-\d{4}-\d{2}-\d{2}_\d{4}(-\d{2})?\.zip$/;

export const SHARE_DRIVE_HELP =
  'Google Drive is not shared with Linux. In the Files app: right-click "Google Drive" (or "My Drive") → "Share with Linux", then run the backup again.';

/** The real database file behind DATABASE_URL (Prisma resolves relative paths from prisma/). */
export function databasePath(): string {
  const url = getEnv().DATABASE_URL;
  if (!url.startsWith('file:')) throw new Error(`DATABASE_URL is not a SQLite file URL (${url.split(':')[0]}:…) — backup only handles SQLite.`);
  const file = url.slice('file:'.length).split('?')[0]!;
  return path.isAbsolute(file) ? file : path.resolve(process.cwd(), 'prisma', file);
}

/** My Drive in Linux, or null when Drive isn't shared. BACKUP_DIR overrides the whole target folder. */
export function backupDir(): { dir: string; myDrive: string | null } | null {
  const override = getEnv().BACKUP_DIR;
  if (override) return { dir: path.resolve(override), myDrive: null };
  const myDrive = DRIVE_CANDIDATES.find((d) => existsSync(d));
  return myDrive ? { dir: path.join(myDrive, BACKUP.driveSubdir), myDrive } : null;
}

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

export function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 ** 2).toFixed(1)} MB`;
}

async function dirBytes(dir: string): Promise<{ bytes: number; files: number }> {
  let bytes = 0;
  let files = 0;
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      const sub = await dirBytes(p);
      bytes += sub.bytes;
      files += sub.files;
    } else if (e.isFile()) {
      bytes += (await fs.stat(p)).size;
      files++;
    }
  }
  return { bytes, files };
}

const sqlString = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** A consistent snapshot of the live database, taken by SQLite itself. */
async function snapshotDatabase(to: string): Promise<void> {
  await prisma.$executeRawUnsafe(`VACUUM INTO ${sqlString(to)}`);
}

export interface DbCheck {
  integrity: string;
  deals: number;
  creators: number;
}

/** Opens a database file on its own and runs PRAGMA integrity_check plus row counts. */
export async function checkDatabaseFile(file: string): Promise<DbCheck> {
  const client = new PrismaClient({ datasourceUrl: `file:${file}` });
  try {
    const rows = await client.$queryRawUnsafe<Array<{ integrity_check: string }>>('PRAGMA integrity_check');
    const integrity = rows.map((r) => r.integrity_check).join('; ');
    const tables = await client.$queryRawUnsafe<Array<{ name: string }>>("SELECT name FROM sqlite_master WHERE type = 'table'");
    const has = (t: string) => tables.some((r) => r.name === t);
    const deals = has('Deal') ? await client.deal.count() : 0;
    const creators = has('Creator') ? await client.creator.count() : 0;
    return { integrity, deals, creators };
  } finally {
    await client.$disconnect();
  }
}

function python(args: string[]): void {
  const r = spawnSync('python3', ['-I', ...args], { encoding: 'utf8' });
  if (r.error) throw new Error(`python3 is needed to zip outputs/ (${r.error.message}).`);
  if (r.status !== 0) throw new Error(`python3 ${args.slice(0, 3).join(' ')} failed: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
}

/** Copy into Drive under a temporary name, check the size, then rename into place. */
async function copyInto(src: string, dest: string): Promise<number> {
  const partial = `${dest}.partial`;
  await fs.copyFile(src, partial);
  const [a, b] = await Promise.all([fs.stat(src), fs.stat(partial)]);
  if (a.size !== b.size) {
    await fs.rm(partial, { force: true });
    throw new Error(`copy to Drive came out ${b.size} bytes instead of ${a.size} — nothing written.`);
  }
  await fs.rename(partial, dest);
  return b.size;
}

/** Names of this module's backups beyond the newest `keep` of each kind (only matching files in `dir`). */
async function expired(dir: string, extraNew: { db?: string; zip?: string } = {}): Promise<string[]> {
  const names = existsSync(dir) ? await fs.readdir(dir) : [];
  const out: string[] = [];
  for (const [pattern, extra] of [[DB_FILE, extraNew.db], [ZIP_FILE, extraNew.zip]] as const) {
    const mine = [...new Set([...names.filter((n) => pattern.test(n)), ...(extra ? [extra] : [])])].sort().reverse();
    out.push(...mine.slice(BACKUP.keep).filter((n) => n !== extra));
  }
  return out;
}

export interface BackupResult {
  dryRun: boolean;
  dir: string;
  dbSource: { path: string; bytes: number };
  outputsSource: { path: string; bytes: number; files: number };
  envPath: string | null;
  dbFile: string;
  dbBytes: number | null;
  zipFile: string;
  zipBytes: number | null;
  check: DbCheck | null;
  deleted: string[];
}

export async function runBackup(opts: { dryRun?: boolean } = {}): Promise<BackupResult> {
  const target = backupDir();
  if (!target) throw new Error(SHARE_DRIVE_HELP);
  const dbPath = databasePath();
  if (!existsSync(dbPath)) throw new Error(`database not found at ${dbPath} (from DATABASE_URL).`);
  const outputs = outputsRoot();
  const envPath = existsSync(path.resolve('.env')) ? path.resolve('.env') : null;

  let ts = stamp();
  const taken = (t: string) => existsSync(path.join(target.dir, `db-${t}.sqlite`)) || existsSync(path.join(target.dir, `outputs-${t}.zip`));
  if (taken(ts)) ts = `${ts}-${String(new Date().getSeconds()).padStart(2, '0')}`;
  const dbFile = `db-${ts}.sqlite`;
  const zipFile = `outputs-${ts}.zip`;

  const result: BackupResult = {
    dryRun: Boolean(opts.dryRun),
    dir: target.dir,
    dbSource: { path: dbPath, bytes: (await fs.stat(dbPath)).size },
    outputsSource: { path: outputs, ...(await dirBytes(outputs)) },
    envPath,
    dbFile,
    dbBytes: null,
    zipFile,
    zipBytes: null,
    check: null,
    deleted: await expired(target.dir, { db: dbFile, zip: zipFile }),
  };
  if (opts.dryRun) return result;

  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'cpos-backup-'));
  try {
    // 1. snapshot + verify locally — nothing reaches Drive unless it checks out
    const snap = path.join(work, dbFile);
    await snapshotDatabase(snap);
    result.check = await checkDatabaseFile(snap);
    if (result.check.integrity !== 'ok') throw new Error(`integrity_check on the backup copy returned "${result.check.integrity}" — backup aborted, nothing written to Drive.`);

    // 2. zip outputs/ and test the archive
    const zip = path.join(work, zipFile);
    python(['-m', 'zipfile', '-c', zip, outputs]);
    python(['-m', 'zipfile', '-t', zip]);

    // 3. into Drive, then trim old backups (ours only)
    await fs.mkdir(target.dir, { recursive: true });
    result.dbBytes = await copyInto(snap, path.join(target.dir, dbFile));
    result.zipBytes = await copyInto(zip, path.join(target.dir, zipFile));
    result.deleted = await expired(target.dir);
    for (const name of result.deleted) await fs.rm(path.join(target.dir, name));
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
  return result;
}

export function renderBackupResult(r: BackupResult): string[] {
  const lines = [
    `${r.dryRun ? '[dry run] would write to' : 'Backup written to'}: ${r.dir}`,
    `- database: ${r.dbSource.path} (${humanBytes(r.dbSource.bytes)}) → ${r.dbFile}${r.dbBytes != null ? ` (${humanBytes(r.dbBytes)})` : ''}`,
    `- outputs/: ${r.outputsSource.path} (${r.outputsSource.files} files, ${humanBytes(r.outputsSource.bytes)}) → ${r.zipFile}${r.zipBytes != null ? ` (${humanBytes(r.zipBytes)})` : ''}`,
    `- not backed up (API keys): ${r.envPath ?? '.env not found'}`,
  ];
  if (r.check) lines.push(`- integrity_check: ${r.check.integrity} · ${r.check.deals} deal rows · ${r.check.creators} creator rows`);
  lines.push(r.deleted.length ? `- ${r.dryRun ? 'would delete' : 'deleted'} (older than the last ${BACKUP.keep}): ${r.deleted.join(', ')}` : `- nothing to delete (keeping the last ${BACKUP.keep} of each)`);
  return lines;
}

// --- restore -----------------------------------------------------------------------------------

export interface RestoreResult {
  from: string;
  to: string;
  safetyCopy: string;
  check: DbCheck;
  dryRun: boolean;
}

/**
 * Put a backup database back in place: check the backup opens and passes
 * integrity_check, snapshot the current database next to it first, then copy
 * the backup over it. Refuses while the pipeline lock is held.
 */
export async function restoreDatabase(file: string, opts: { confirm?: boolean } = {}): Promise<RestoreResult> {
  const target = backupDir();
  const from = path.isAbsolute(file) || existsSync(file) || !target ? path.resolve(file) : path.join(target.dir, file);
  if (!existsSync(from)) throw new Error(`backup not found: ${from}`);
  const to = databasePath();
  const lock = path.join(outputsRoot(), '_pipeline', 'pipeline.lock');
  if (existsSync(lock)) throw new Error(`the daily pipeline is running (${lock}) — wait for it to finish, then restore.`);

  // Check a local copy, never the file in Drive directly.
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'cpos-restore-'));
  try {
    const local = path.join(work, 'restore.sqlite');
    await fs.copyFile(from, local);
    const check = await checkDatabaseFile(local);
    if (check.integrity !== 'ok') throw new Error(`backup failed integrity_check ("${check.integrity}") — not restored.`);
    const safetyCopy = `${to}.before-restore-${stamp()}`;
    if (!opts.confirm) return { from, to, safetyCopy, check, dryRun: true };

    await snapshotDatabase(safetyCopy);
    await prisma.$disconnect();
    await fs.copyFile(local, `${to}.restoring`);
    // The old database's journal/WAL must not be replayed onto the restored file.
    for (const side of ['-journal', '-wal', '-shm']) await fs.rm(`${to}${side}`, { force: true });
    await fs.rename(`${to}.restoring`, to);
    return { from, to, safetyCopy, check, dryRun: false };
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}
