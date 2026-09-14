import fs from 'node:fs/promises';
import { normalizeHandle } from '../../lib/paths.js';
import type { Platform } from '../../lib/constants.js';

/**
 * CSV fallback for when scraping is unavailable — a blocked host, an expired
 * Apify plan, or a list built by hand. The rows only supply handles; the same
 * profile fetch used by the live backends enriches them, so a CSV creator ends
 * up with exactly the same fields as a discovered one.
 */

export interface CsvRow {
  handle: string;
  platform: Exclude<Platform, 'BOTH'>;
  /** Anything else in the row, kept for provenance. */
  extra: Record<string, string>;
}

/** Split one CSV line, honouring quoted fields and doubled quotes. */
export function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quoted) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        current += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      fields.push(current);
      current = '';
    } else {
      current += char;
    }
  }

  fields.push(current);
  return fields.map((f) => f.trim());
}

function resolvePlatform(value: string | undefined, fallback: Exclude<Platform, 'BOTH'>) {
  const normalised = (value ?? '').trim().toLowerCase();
  if (['ig', 'instagram'].includes(normalised)) return 'INSTAGRAM' as const;
  if (['yt', 'youtube'].includes(normalised)) return 'YOUTUBE' as const;
  return fallback;
}

/**
 * Parse a CSV of handles.
 *
 * A header row is used when present (any of handle/username/channel, plus an
 * optional platform column). A file with no recognisable header is treated as
 * one handle per line, which is what a pasted list usually looks like.
 */
export function parseHandlesCsv(
  text: string,
  defaultPlatform: Exclude<Platform, 'BOTH'> = 'INSTAGRAM',
): CsvRow[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));

  if (!lines.length) return [];

  const HANDLE_COLUMNS = ['handle', 'username', 'user', 'channel', 'account', 'profile'];
  const header = splitCsvLine(lines[0] as string).map((h) => h.toLowerCase());
  const handleIndex = header.findIndex((h) => HANDLE_COLUMNS.includes(h));
  const hasHeader = handleIndex !== -1;
  const platformIndex = hasHeader ? header.findIndex((h) => h === 'platform') : -1;

  const rows: CsvRow[] = [];
  const seen = new Set<string>();

  for (const line of lines.slice(hasHeader ? 1 : 0)) {
    const fields = splitCsvLine(line);
    const rawHandle = (hasHeader ? fields[handleIndex] : fields[0]) ?? '';
    if (!rawHandle) continue;

    let handle: string;
    try {
      handle = normalizeHandle(rawHandle);
    } catch {
      continue;
    }

    const platform = resolvePlatform(
      platformIndex >= 0 ? fields[platformIndex] : undefined,
      defaultPlatform,
    );

    const key = `${platform}:${handle}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const extra: Record<string, string> = {};
    if (hasHeader) {
      header.forEach((name, index) => {
        const value = fields[index];
        if (value && index !== handleIndex && index !== platformIndex) extra[name] = value;
      });
    }

    rows.push({ handle, platform, extra });
  }

  return rows;
}

export async function readHandlesCsv(
  filePath: string,
  defaultPlatform: Exclude<Platform, 'BOTH'> = 'INSTAGRAM',
): Promise<CsvRow[]> {
  const text = await fs.readFile(filePath, 'utf8');
  return parseHandlesCsv(text, defaultPlatform);
}

/** Read a pasted list from stdin, for `--csv -`. */
export async function readHandlesStdin(
  defaultPlatform: Exclude<Platform, 'BOTH'> = 'INSTAGRAM',
): Promise<CsvRow[]> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return parseHandlesCsv(Buffer.concat(chunks).toString('utf8'), defaultPlatform);
}
