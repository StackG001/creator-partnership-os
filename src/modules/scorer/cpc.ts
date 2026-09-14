import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

/**
 * CPC hints for the spending-power component.
 *
 * What an advertiser pays for a click in a niche is the cheapest available
 * proxy for what that audience is worth — an insurance lead costs 20x a
 * fitness one, and that gap shows up again in what each audience will pay for
 * a product. The file is optional and hand-maintained; a niche with no entry
 * falls back to the model's own estimate.
 */

const nicheSchema = z.object({
  cpcUsd: z.number().nonnegative(),
  notes: z.string().optional(),
});

const fileSchema = z.object({
  niches: z.record(z.string(), nicheSchema),
});

export type NicheCpc = z.infer<typeof nicheSchema>;

export interface CpcMatch extends NicheCpc {
  niche: string;
  /** 0-1: how much of the audience-value scale this CPC represents. */
  normalised: number;
}

export const DEFAULT_CPC_PATH = 'data/niche-cpc.json';

/**
 * $20+ per click is about as high as consumer verticals go, so the scale tops
 * out there. Anything above simply scores 1.
 */
const CPC_CEILING = 20;

export function normaliseCpc(cpcUsd: number): number {
  return Number(Math.min(1, Math.max(0, cpcUsd / CPC_CEILING)).toFixed(3));
}

export async function loadCpcTable(
  filePath = DEFAULT_CPC_PATH,
): Promise<Record<string, NicheCpc>> {
  const resolved = path.resolve(process.cwd(), filePath);
  let text: string;
  try {
    text = await fs.readFile(resolved, 'utf8');
  } catch {
    // Optional by design — no file just means no hints.
    return {};
  }

  const parsed = fileSchema.safeParse(JSON.parse(text));
  if (!parsed.success) {
    throw new Error(
      `${filePath} is not valid:\n${parsed.error.issues
        .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
        .join('\n')}`,
    );
  }
  return parsed.data.niches;
}

/**
 * Best match for a creator. Longest matching key wins, so "credit repair"
 * beats a bare "credit" entry when both are present.
 */
export function matchCpc(
  table: Record<string, NicheCpc>,
  haystacks: Array<string | null | undefined>,
): CpcMatch | undefined {
  const text = haystacks.filter(Boolean).join(' ').toLowerCase();
  if (!text) return undefined;

  let best: CpcMatch | undefined;
  for (const [niche, entry] of Object.entries(table)) {
    if (!text.includes(niche.toLowerCase())) continue;
    if (best && best.niche.length >= niche.length) continue;
    best = { ...entry, niche, normalised: normaliseCpc(entry.cpcUsd) };
  }
  return best;
}
