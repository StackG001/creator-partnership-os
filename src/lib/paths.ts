import fs from 'node:fs/promises';
import path from 'node:path';
import { getEnv } from './env.js';

/**
 * Every generated artifact lives under <OUTPUTS_DIR>/<creator-handle>/ so a
 * creator's whole package — audit, product, funnel, outreach — is one folder.
 */

export const ARTIFACT_DIRS = [
  'audit',
  'brand',
  'product',
  'research',
  'funnel',
  'outreach',
  'launch',
] as const;

export type ArtifactDir = (typeof ARTIFACT_DIRS)[number];

/** Lowercase, strip @ and url wrappers, keep only handle-safe characters. */
export function normalizeHandle(input: string): string {
  const trimmed = input
    .trim()
    .replace(/^https?:\/\/(www\.)?(instagram|youtube)\.com\//i, '')
    .replace(/^@+/, '')
    .replace(/\/+$/, '');
  const handle = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  if (!handle) throw new Error(`Cannot derive a handle from "${input}"`);
  return handle;
}

export function outputsRoot(): string {
  return path.resolve(process.cwd(), getEnv().OUTPUTS_DIR);
}

export function creatorDir(handle: string): string {
  return path.join(outputsRoot(), normalizeHandle(handle));
}

export function artifactPath(handle: string, dir: ArtifactDir, file: string): string {
  return path.join(creatorDir(handle), dir, file);
}

/** Create <outputs>/<handle>/ with all artifact subfolders. Idempotent. */
export async function ensureCreatorDir(handle: string): Promise<string> {
  const base = creatorDir(handle);
  await Promise.all(
    ARTIFACT_DIRS.map((d) => fs.mkdir(path.join(base, d), { recursive: true })),
  );
  return base;
}

/** Write a text artifact, creating parent folders. Returns the absolute path. */
export async function writeArtifact(
  handle: string,
  dir: ArtifactDir,
  file: string,
  contents: string,
): Promise<string> {
  const target = artifactPath(handle, dir, file);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, contents, 'utf8');
  return target;
}

export async function writeJsonArtifact(
  handle: string,
  dir: ArtifactDir,
  file: string,
  data: unknown,
): Promise<string> {
  return writeArtifact(handle, dir, file, `${JSON.stringify(data, null, 2)}\n`);
}

/** Path relative to the repo root — what we store in the database. */
export function toRelative(absolute: string): string {
  return path.relative(process.cwd(), absolute);
}
