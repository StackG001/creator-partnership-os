/**
 * The niche shown for a creator anywhere in a table or on a screen: their own
 * profile niche (Creator.niche, set from their profile/audit), never the niche
 * of the search that happened to find them. Cut at a word, with "…".
 */
export function creatorNiche(c: { niche: string | null }, max = 60): string {
  const n = c.niche?.trim();
  if (!n) return '—';
  if (n.length <= max) return n;
  const cut = n.slice(0, max);
  return `${cut.slice(0, cut.lastIndexOf(' ') > max / 2 ? cut.lastIndexOf(' ') : max).replace(/[\s,;:—–-]+$/, '')}…`;
}
