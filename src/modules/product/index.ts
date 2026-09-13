export type ProductStage = 'research' | 'outline' | 'write' | 'render' | 'all';

export interface ProductBuildResult {
  productId: string;
  title: string;
  pageCount: number;
  wordCount: number;
  htmlPath: string;
  pdfPath: string;
  sources: number;
}

/**
 * Four stages, each resumable and each writing its own artifact:
 *   research -> cited claims       outputs/<handle>/research/
 *   outline  -> chapter plan       outputs/<handle>/product/outline.json
 *   write    -> chapter bodies     outputs/<handle>/product/chapters/
 *   render   -> branded HTML + PDF outputs/<handle>/product/
 * Rendering is Playwright HTML->PDF against the creator's brand profile.
 */
export async function buildProduct(
  _handle: string,
  _options: { angle?: number; pages?: number; stage?: ProductStage } = {},
): Promise<ProductBuildResult> {
  throw new Error('product: not implemented yet');
}
