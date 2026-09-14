import 'dotenv/config';
import { z } from 'zod';

/**
 * Every environment variable the system reads, in one validated object.
 * Import `env` anywhere; call `loadEnv()` directly only when you want the
 * raw result (the doctor does, so it can report problems instead of throwing).
 */

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const intFrom = (fallback: number) =>
  z.coerce.number().int().positive().default(fallback);

export const envSchema = z.object({
  // required
  ANTHROPIC_API_KEY: z
    .string({
      error: 'missing — get a key at console.anthropic.com/settings/keys',
    })
    .min(1, 'missing — get a key at console.anthropic.com/settings/keys'),
  DATABASE_URL: z
    .string({ error: 'missing — e.g. file:./dev.db' })
    .min(1, 'missing — e.g. file:./dev.db'),

  // models
  ANTHROPIC_MODEL: z.string().default('claude-sonnet-5'),
  ANTHROPIC_MODEL_HEAVY: z.string().default('claude-opus-5'),
  ANTHROPIC_MODEL_FAST: z.string().default('claude-haiku-4-5-20251001'),
  ANTHROPIC_BASE_URL: z.string().url().optional(),

  // llm behaviour
  LLM_MAX_TOKENS: intFrom(8192),
  LLM_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  LLM_TRACE: bool.default(false),

  // discovery (optional until the finder lands)
  // YT_API_KEY is accepted as an alias — see ALIASES below.
  YOUTUBE_API_KEY: z.string().optional(),
  APIFY_TOKEN: z.string().optional(),
  BRAVE_SEARCH_API_KEY: z.string().optional(),
  SERPER_API_KEY: z.string().optional(),

  // publishing (optional until the publisher lands)
  WHOP_API_KEY: z.string().optional(),
  WHOP_COMPANY_ID: z.string().optional(),

  // local behaviour
  OUTPUTS_DIR: z.string().default('./outputs'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  PLAYWRIGHT_CHROMIUM_PATH: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

/** Which keys are hard requirements vs. nice-to-haves, for the doctor's report. */
export const REQUIRED_ENV_KEYS = ['ANTHROPIC_API_KEY', 'DATABASE_URL'] as const;

export const OPTIONAL_ENV_KEYS = [
  'YOUTUBE_API_KEY',
  'APIFY_TOKEN',
  'BRAVE_SEARCH_API_KEY',
  'SERPER_API_KEY',
  'WHOP_API_KEY',
  'WHOP_COMPANY_ID',
] as const;

/**
 * Variables we answer to under more than one name. The canonical name wins when
 * both are set; the alias is only a fallback, so nothing silently overrides an
 * explicit value.
 */
const ALIASES: Record<string, string> = {
  YT_API_KEY: 'YOUTUBE_API_KEY',
  YOUTUBE_DATA_API_KEY: 'YOUTUBE_API_KEY',
};

/** Blank strings in .env mean "unset", not "set to empty". */
function compact(source: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'string' && value.trim() !== '') out[key] = value.trim();
  }
  for (const [alias, canonical] of Object.entries(ALIASES)) {
    const aliased = out[alias];
    if (aliased && !out[canonical]) out[canonical] = aliased;
  }
  return out;
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env) {
  return envSchema.safeParse(compact(source));
}

let cached: Env | undefined;

/** Validated env. Throws with a readable list of problems on first bad access. */
export function getEnv(): Env {
  if (cached) return cached;
  const result = loadEnv();
  if (!result.success) {
    const problems = result.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(
      `Invalid environment:\n${problems}\n\nCopy .env.example to .env and run \`npm run doctor\`.`,
    );
  }
  cached = result.data;
  return cached;
}

/** Test seam: forget the memoised env. */
export function resetEnv(): void {
  cached = undefined;
}
