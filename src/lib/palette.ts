import { chromium, type Browser } from 'playwright';
import { getEnv } from './env.js';
import { createLogger } from './logger.js';
import type { FetchImpl } from './http.js';

/**
 * Dominant colours from a creator's actual post images.
 *
 * The audit's visualStyle section has to be evidence, not a guess — a model
 * shown a caption cannot know a feed is teal and cream. So the hex values come
 * from decoding real images: Node fetches the bytes, Chromium decodes them on a
 * canvas, and the pixels are quantised here.
 *
 * Fetching in Node rather than letting the page load the URLs keeps the canvas
 * un-tainted (no cross-origin readback problem) and means one network policy
 * governs every request the system makes.
 */

const log = createLogger('palette');

export interface SwatchColor {
  hex: string;
  /** Share of sampled pixels in this colour's bucket, 0-1. */
  share: number;
}

export interface PaletteResult {
  colors: SwatchColor[];
  /** How many images actually decoded. */
  sampled: number;
  /** Images that could not be fetched or decoded, with the reason. */
  failed: Array<{ url: string; error: string }>;
}

/** Buckets per channel. 4 gives 64 buckets — coarse enough to group a gradient. */
const BUCKETS = 4;

interface Pixel {
  r: number;
  g: number;
  b: number;
}

function toHex({ r, g, b }: Pixel): string {
  const part = (v: number) => Math.round(v).toString(16).padStart(2, '0');
  return `#${part(r)}${part(g)}${part(b)}`;
}

/**
 * Quantise into coarse buckets, then average the true pixels in each bucket so
 * the reported hex is a colour that really appears rather than a bucket centre.
 */
export function quantise(pixels: Pixel[], limit = 6): SwatchColor[] {
  if (!pixels.length) return [];

  const buckets = new Map<string, { count: number; r: number; g: number; b: number }>();
  const size = 256 / BUCKETS;

  for (const pixel of pixels) {
    const key = [pixel.r, pixel.g, pixel.b].map((v) => Math.min(BUCKETS - 1, Math.floor(v / size))).join(',');
    const bucket = buckets.get(key) ?? { count: 0, r: 0, g: 0, b: 0 };
    bucket.count += 1;
    bucket.r += pixel.r;
    bucket.g += pixel.g;
    bucket.b += pixel.b;
    buckets.set(key, bucket);
  }

  const total = pixels.length;
  return [...buckets.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, limit)
    .map((bucket) => ({
      hex: toHex({ r: bucket.r / bucket.count, g: bucket.g / bucket.count, b: bucket.b / bucket.count }),
      share: Number((bucket.count / total).toFixed(3)),
    }));
}

/** Fetch image bytes and hand them to the page as a data URL. */
async function toDataUrl(url: string, fetchImpl: FetchImpl, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
    const type = response.headers.get('content-type') ?? 'image/jpeg';
    if (!type.startsWith('image/')) throw new Error(`not an image (${type})`);
    const buffer = Buffer.from(await response.arrayBuffer());
    return `data:${type};base64,${buffer.toString('base64')}`;
  } finally {
    clearTimeout(timer);
  }
}

export interface PaletteOptions {
  fetchImpl?: FetchImpl;
  /** Longest edge the image is scaled to before sampling. */
  sampleSize?: number;
  timeoutMs?: number;
  /** Reuse a browser across calls; otherwise one is launched and closed. */
  browser?: Browser;
}

/**
 * Extract a shared palette across several images.
 * Never throws for a single bad image — it is recorded in `failed` instead.
 */
export async function extractPalette(
  imageUrls: string[],
  options: PaletteOptions = {},
): Promise<PaletteResult> {
  const { fetchImpl = fetch, sampleSize = 64, timeoutMs = 15_000 } = options;
  const failed: PaletteResult['failed'] = [];

  if (!imageUrls.length) return { colors: [], sampled: 0, failed };

  const dataUrls: string[] = [];
  for (const url of imageUrls) {
    try {
      dataUrls.push(await toDataUrl(url, fetchImpl, timeoutMs));
    } catch (error) {
      failed.push({ url, error: (error as Error).message });
    }
  }

  if (!dataUrls.length) {
    log.debug(`no images could be fetched (${failed.length} failed)`);
    return { colors: [], sampled: 0, failed };
  }

  const own = !options.browser;
  const browser =
    options.browser ??
    (await chromium.launch({
      ...(getEnv().PLAYWRIGHT_CHROMIUM_PATH
        ? { executablePath: getEnv().PLAYWRIGHT_CHROMIUM_PATH as string }
        : {}),
    }));

  try {
    const page = await browser.newPage();
    const pixels = await page.evaluate(
      async ({ sources, size }) => {
        const out: Array<{ r: number; g: number; b: number }> = [];
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) return out;

        for (const source of sources) {
          const image = new Image();
          const loaded = await new Promise<boolean>((resolve) => {
            image.onload = () => resolve(true);
            image.onerror = () => resolve(false);
            image.src = source;
          });
          if (!loaded) continue;

          // Downscale: we want the feel of the image, not every pixel.
          const scale = Math.min(size / image.width, size / image.height, 1);
          canvas.width = Math.max(1, Math.round(image.width * scale));
          canvas.height = Math.max(1, Math.round(image.height * scale));
          context.clearRect(0, 0, canvas.width, canvas.height);
          context.drawImage(image, 0, 0, canvas.width, canvas.height);

          const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
          for (let i = 0; i < data.length; i += 4) {
            // Skip transparent pixels; they are padding, not design.
            if ((data[i + 3] ?? 0) < 128) continue;
            out.push({ r: data[i] as number, g: data[i + 1] as number, b: data[i + 2] as number });
          }
        }
        return out;
      },
      { sources: dataUrls, size: sampleSize },
    );

    await page.close();
    return { colors: quantise(pixels), sampled: dataUrls.length, failed };
  } finally {
    if (own) await browser.close();
  }
}
