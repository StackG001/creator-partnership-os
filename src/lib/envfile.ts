import fs from 'node:fs/promises';
import path from 'node:path';
import { OPTIONAL_ENV_KEYS, REQUIRED_ENV_KEYS } from './env.js';

/**
 * Reading and writing .env as a file — shared by `npm run key` and
 * `npm run setup`. Edits are surgical: the template's comments, ordering and
 * untouched values always survive.
 */

export const ENV_PATH = path.resolve(process.cwd(), '.env');
export const EXAMPLE_PATH = path.resolve(process.cwd(), '.env.example');

/** Credentials a person pastes in. DATABASE_URL is configuration, not a secret. */
export const CREDENTIAL_KEYS = [...REQUIRED_ENV_KEYS, ...OPTIONAL_ENV_KEYS].filter(
  (key) => key !== 'DATABASE_URL',
) as string[];

export const KEY_HELP: Record<string, { label: string; where: string; required: boolean }> = {
  ANTHROPIC_API_KEY: {
    label: 'Anthropic API key',
    where: 'console.anthropic.com/settings/keys',
    required: true,
  },
  YOUTUBE_API_KEY: {
    label: 'YouTube Data API v3 key',
    where: 'console.cloud.google.com → APIs & Services → Credentials',
    required: false,
  },
  APIFY_TOKEN: {
    label: 'Apify token (Instagram scraping)',
    where: 'console.apify.com/account/integrations',
    required: false,
  },
  BRAVE_SEARCH_API_KEY: {
    label: 'Brave Search key (product research)',
    where: 'api-dashboard.search.brave.com',
    required: false,
  },
  SERPER_API_KEY: {
    label: 'Serper key (alternative to Brave)',
    where: 'serper.dev/api-key',
    required: false,
  },
  WHOP_API_KEY: {
    label: 'Whop API key',
    where: 'whop.com/dashboard/developer',
    required: false,
  },
  WHOP_COMPANY_ID: {
    label: 'Whop company id',
    where: 'whop.com/dashboard — the biz_... id',
    required: false,
  },
};

/** Show enough to tell two keys apart, never the key. */
export function mask(value: string): string {
  if (!value) return '';
  if (value.length <= 8) return `${'•'.repeat(value.length)} (${value.length} chars)`;
  return `${value.slice(0, 5)}${'•'.repeat(10)}${value.slice(-4)} (${value.length} chars)`;
}

/** Current .env, falling back to the documented template on first run. */
export async function readEnvFile(): Promise<string> {
  try {
    return await fs.readFile(ENV_PATH, 'utf8');
  } catch {
    try {
      return (await fs.readFile(EXAMPLE_PATH, 'utf8')).replace(
        /^ANTHROPIC_API_KEY=.*$/m,
        'ANTHROPIC_API_KEY=',
      );
    } catch {
      return '';
    }
  }
}

export function parseEnv(contents: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const raw of contents.split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(raw.trim());
    if (!match) continue;
    const [, key, value] = match;
    if (key) values.set(key, (value ?? '').replace(/^["']|["']$/g, '').trim());
  }
  return values;
}

/** Replace KEY=... in place; append if the key is absent. Comments survive. */
export function upsert(contents: string, key: string, value: string): string {
  const line = `${key}=${/[\s#"']/.test(value) ? JSON.stringify(value) : value}`;
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  if (pattern.test(contents)) return contents.replace(pattern, line);
  const separator = contents.endsWith('\n') || contents === '' ? '' : '\n';
  return `${contents}${separator}${line}\n`;
}

/** Write .env and lock it down to the owner where the filesystem allows it. */
export async function writeEnvFile(contents: string): Promise<void> {
  await fs.writeFile(ENV_PATH, contents, 'utf8');
  await fs.chmod(ENV_PATH, 0o600).catch(() => {
    /* Windows and some mounts don't support it */
  });
}

/** The paste accidents that turn into a confusing 401 an hour later. */
export function valueWarnings(key: string, value: string): string[] {
  const warnings: string[] = [];
  if (/\s/.test(value)) warnings.push('it contains a space or line break');
  if (/^["'<].*[">']$/.test(value)) warnings.push('it is wrapped in quotes or angle brackets');
  if (key === 'ANTHROPIC_API_KEY' && !value.startsWith('sk-ant-')) {
    warnings.push('an Anthropic key normally starts with "sk-ant-"');
  }
  return warnings;
}
