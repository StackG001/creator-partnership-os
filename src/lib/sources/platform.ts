import type { Platform } from '../constants.js';

/** Bare handles default to Instagram; YouTube requires a recognisable URL or channel id. */
export function detectPlatform(input: string): Extract<Platform, 'INSTAGRAM' | 'YOUTUBE'> {
  if (/youtube\.com|youtu\.be/i.test(input)) return 'YOUTUBE';
  if (/instagram\.com/i.test(input)) return 'INSTAGRAM';
  if (/^UC[\w-]{22}$/.test(input.trim())) return 'YOUTUBE';
  return 'INSTAGRAM';
}
