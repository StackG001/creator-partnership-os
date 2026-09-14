/**
 * Plain-text column tables for CLI summaries. No dependency, no colour codes in
 * the width maths, and long cells truncate rather than wrapping — a summary
 * table that reflows is unreadable in a terminal.
 */

export interface Column<T> {
  header: string;
  /** Cell text. Return '' for blank, never undefined. */
  value: (row: T) => string;
  align?: 'left' | 'right';
  /** Truncate anything longer, with an ellipsis. */
  maxWidth?: number;
}

function clamp(text: string, max?: number): string {
  if (!max || text.length <= max) return text;
  return `${text.slice(0, Math.max(1, max - 1))}…`;
}

export function renderTable<T>(rows: T[], columns: Array<Column<T>>): string {
  if (!rows.length) return '(nothing to show)';

  const cells = rows.map((row) => columns.map((col) => clamp(col.value(row), col.maxWidth)));
  const widths = columns.map((col, i) =>
    Math.max(col.header.length, ...cells.map((row) => (row[i] ?? '').length)),
  );

  const pad = (text: string, width: number, align: 'left' | 'right' = 'left') =>
    align === 'right' ? text.padStart(width) : text.padEnd(width);

  const header = columns.map((col, i) => pad(col.header, widths[i] as number, col.align)).join('  ');
  const rule = widths.map((w) => '─'.repeat(w)).join('  ');
  const body = cells.map((row) =>
    row.map((cell, i) => pad(cell, widths[i] as number, columns[i]?.align)).join('  '),
  );

  return [header, rule, ...body].join('\n');
}

/** 12345 -> "12.3k". Keeps follower columns narrow. */
export function compactNumber(value?: number | null): string {
  if (value === undefined || value === null) return '—';
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

/** 0.0342 -> "3.42%". */
export function percent(value?: number | null, digits = 2): string {
  if (value === undefined || value === null) return '—';
  return `${(value * 100).toFixed(digits)}%`;
}

/** Quote a value for CSV output. */
export function csvCell(value: unknown): string {
  const text = value === undefined || value === null ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv<T>(rows: T[], columns: Array<{ header: string; value: (row: T) => unknown }>): string {
  const lines = [columns.map((c) => csvCell(c.header)).join(',')];
  for (const row of rows) lines.push(columns.map((c) => csvCell(c.value(row))).join(','));
  return `${lines.join('\n')}\n`;
}
