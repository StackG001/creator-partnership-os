export interface BrandProfile {
  voice: { tone: string[]; sentenceLength: string; vocabulary: string[]; avoid: string[] };
  palette: { primary: string; secondary: string; accent: string; ink: string; paper: string };
  typography: { heading: string; body: string };
  coverDirection: string;
  samplePhrases: string[];
}

/**
 * Derives the creator's written voice and visual identity, stored on
 * Creator.brandProfile and used by the product and funnel modules.
 */
export async function buildBrandProfile(_handle: string): Promise<BrandProfile> {
  throw new Error('brand: not implemented yet');
}
