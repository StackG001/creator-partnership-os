export interface FunnelCopy {
  salesPage: {
    headline: string;
    subhead: string;
    problem: string;
    sections: Array<{ heading: string; body: string }>;
    bullets: string[];
    faq: Array<{ q: string; a: string }>;
    guarantee: string;
    cta: string;
  };
  orderBump: { title: string; pitch: string; priceCents: number };
  upsell: { title: string; pitch: string; priceCents: number };
}

/**
 * Writes funnel copy in the creator's voice, saves it on Product.funnel and
 * renders a previewable sales page to outputs/<handle>/funnel/.
 */
export async function buildFunnel(
  _handle: string,
  _pricing: { priceCents: number; bumpPriceCents: number; upsellPriceCents: number },
): Promise<FunnelCopy> {
  throw new Error('funnel: not implemented yet');
}
