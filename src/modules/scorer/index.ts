export interface ScoreBreakdown {
  reach: number;
  engagement: number;
  nicheClarity: number;
  productGap: number;
  monetisability: number;
  reachability: number;
}

export interface ScoreResult {
  handle: string;
  score: number;
  breakdown: ScoreBreakdown;
  rationale: string;
  disqualifiedFor?: string;
}

/**
 * Deterministic metric scoring blended with an LLM read of niche clarity and
 * product gap. Writes score, scoreBreakdown and status SCORED.
 */
export async function scoreCreator(_handle: string): Promise<ScoreResult> {
  throw new Error('scorer: not implemented yet');
}
