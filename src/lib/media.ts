import type { ImageInput } from './llm.js';
import { createLogger } from './logger.js';

/**
 * Best-effort image download for vision calls (e.g. reading dominant colours
 * off post images). Never throws — a failed image is just dropped from the
 * batch, since visual style is read from whatever came back.
 */

const log = createLogger('media');

const MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

export async function fetchImage(
  url: string,
  maxBytes = 8_000_000,
): Promise<ImageInput | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const contentType = (res.headers.get('content-type') ?? 'image/jpeg').split(';')[0]!.trim();
    const mediaType = MEDIA_TYPES.has(contentType) ? contentType : 'image/jpeg';
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > maxBytes) return null;
    return { data: buf.toString('base64'), mediaType: mediaType as ImageInput['mediaType'] };
  } catch (error) {
    log.warn(`could not fetch image ${url}`, String(error));
    return null;
  }
}

export async function fetchImages(urls: string[], maxBytes?: number): Promise<ImageInput[]> {
  const results = await Promise.all(urls.map((url) => fetchImage(url, maxBytes)));
  return results.filter((image): image is ImageInput => image !== null);
}
