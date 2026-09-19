import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { parseFlags, type CliSpec } from '../lib/cli.js';
import {
  loadEnv,
  OPTIONAL_ENV_KEYS,
  REQUIRED_ENV_KEYS,
  type Env,
} from '../lib/env.js';
import { ARTIFACT_DIRS } from '../lib/paths.js';

/**
 * `npm run doctor` — one command that answers "can this machine run the OS?".
 * Checks the toolchain, every environment variable, the database, the outputs
 * directory, Playwright's Chromium and every API we hold a key for.
 *
 * Exit codes: 0 all required checks pass, 1 something required is broken.
 */

const spec: CliSpec = {
  name: 'doctor',
  summary: 'Verify env vars, database, Chromium and every API connection.',
  examples: [
    'npm run doctor',
    'npm run doctor -- --skip-network',
    'npm run doctor -- --json',
  ],
  flags: {
    'skip-network': {
      type: 'boolean',
      description: 'Local checks only: no API calls are made.',
    },
    'skip-browser': { type: 'boolean', description: 'Skip the Chromium/PDF check.' },
  },
};

type Status = 'pass' | 'fail' | 'warn' | 'skip';

interface Check {
  group: string;
  name: string;
  status: Status;
  detail: string;
  /** What to do about it, printed under failures and warnings. */
  fix?: string;
  ms?: number;
}

const checks: Check[] = [];

function record(check: Omit<Check, 'ms'>, ms?: number): Check {
  const full = { ...check, ...(ms === undefined ? {} : { ms }) };
  checks.push(full);
  return full;
}

async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const start = Date.now();
  const value = await fn();
  return [value, Date.now() - start];
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.split('\n')[0] ?? error.message;
  return String(error);
}

// --- toolchain ---------------------------------------------------------------

function checkNode(): void {
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  const ok = major > 20 || (major === 20 && minor >= 11);
  record({
    group: 'toolchain',
    name: 'node',
    status: ok ? 'pass' : 'fail',
    detail: `v${process.versions.node}`,
    fix: ok ? undefined : 'Node 20.11+ is required (tsx and the Next 15 build depend on it).',
  });
}

async function checkEnvFile(): Promise<void> {
  const envPath = path.resolve(process.cwd(), '.env');

  try {
    await fs.access(envPath);
    record({ group: 'toolchain', name: '.env file', status: 'pass', detail: envPath });
    return;
  } catch {
    // No file is fine when the variables are supplied another way — a cloud
    // environment's variable list, a CI secret store, or an `export` in the
    // shell. Only the values matter; the file is just one way to set them.
  }

  const supplied = REQUIRED_ENV_KEYS.filter((key) => process.env[key]?.trim());

  record({
    group: 'toolchain',
    name: '.env file',
    status: supplied.length === REQUIRED_ENV_KEYS.length ? 'pass' : 'fail',
    detail:
      supplied.length === REQUIRED_ENV_KEYS.length
        ? 'not present — required variables come from the process environment'
        : 'not found, and the required variables are not in the environment either',
    fix:
      supplied.length === REQUIRED_ENV_KEYS.length
        ? undefined
        : 'Run `npm run key` to add your Anthropic key without it appearing on screen, or cp .env.example .env and edit it.',
  });
}

// --- environment -------------------------------------------------------------

/** Never print a secret; show enough to tell two keys apart. */
function mask(value: string): string {
  if (value.length <= 8) return `${value.slice(0, 2)}…(${value.length} chars)`;
  return `${value.slice(0, 6)}…${value.slice(-4)} (${value.length} chars)`;
}

const OPTIONAL_UNLOCKS: Record<(typeof OPTIONAL_ENV_KEYS)[number], string> = {
  YOUTUBE_API_KEY: 'finder: YouTube channel discovery and stats',
  APIFY_TOKEN: 'finder: Instagram profile and post scraping',
  BRAVE_SEARCH_API_KEY: 'product: web research with citations',
  SERPER_API_KEY: 'product: web research (alternative to Brave)',
  WHOP_API_KEY: 'publisher: creating products and checkout links',
  WHOP_COMPANY_ID: 'publisher: which Whop company to publish under',
  RESEND_API_KEY: 'outreach: sending APPROVED emails (drafting works without it)',
};

function checkEnv(): Env | undefined {
  const result = loadEnv();

  if (!result.success) {
    const byKey = new Map<string, string>();
    for (const issue of result.error.issues) {
      byKey.set(String(issue.path[0] ?? '(root)'), issue.message);
    }
    for (const key of REQUIRED_ENV_KEYS) {
      const problem = byKey.get(key);
      record({
        group: 'env',
        name: key,
        status: problem ? 'fail' : 'pass',
        detail: problem ?? 'set',
        fix: problem ? `Set ${key} in .env — see .env.example for where to get it.` : undefined,
      });
      byKey.delete(key);
    }
    for (const [key, message] of byKey) {
      record({
        group: 'env',
        name: key,
        status: 'fail',
        detail: message,
        fix: `Fix ${key} in .env.`,
      });
    }
    return undefined;
  }

  const env = result.data;

  for (const key of REQUIRED_ENV_KEYS) {
    const value = env[key];
    record({
      group: 'env',
      name: key,
      status: 'pass',
      detail: key.includes('KEY') ? mask(value) : value,
    });
  }

  for (const key of OPTIONAL_ENV_KEYS) {
    const value = env[key];
    record({
      group: 'env',
      name: key,
      status: value ? 'pass' : 'warn',
      detail: value ? mask(value) : 'not set',
      fix: value ? undefined : `Unlocks — ${OPTIONAL_UNLOCKS[key]}.`,
    });
  }

  record({
    group: 'env',
    name: 'models',
    status: 'pass',
    detail: `default=${env.ANTHROPIC_MODEL} heavy=${env.ANTHROPIC_MODEL_HEAVY} fast=${env.ANTHROPIC_MODEL_FAST}`,
  });

  return env;
}

// --- storage -----------------------------------------------------------------

async function checkOutputs(env: Env): Promise<void> {
  const dir = path.resolve(process.cwd(), env.OUTPUTS_DIR);
  try {
    await fs.mkdir(dir, { recursive: true });
    const probe = path.join(dir, '.doctor-write-test');
    await fs.writeFile(probe, 'ok', 'utf8');
    await fs.rm(probe);
    record({
      group: 'storage',
      name: 'outputs dir',
      status: 'pass',
      detail: `${dir} (writable · artifact folders: ${ARTIFACT_DIRS.join(', ')})`,
    });
  } catch (error) {
    record({
      group: 'storage',
      name: 'outputs dir',
      status: 'fail',
      detail: errorMessage(error),
      fix: `Make ${dir} writable, or point OUTPUTS_DIR somewhere else.`,
    });
  }
}

async function checkDatabase(env: Env): Promise<void> {
  try {
    const { prisma, disconnect } = await import('../lib/db.js');
    const [counts, ms] = await timed(async () => ({
      sources: await prisma.source.count(),
      creators: await prisma.creator.count(),
      audits: await prisma.audit.count(),
      products: await prisma.product.count(),
      messages: await prisma.outreachMessage.count(),
      launches: await prisma.launch.count(),
    }));
    await disconnect();

    const summary = Object.entries(counts)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ');
    record(
      {
        group: 'database',
        name: 'prisma + schema',
        status: 'pass',
        detail: `${env.DATABASE_URL} · ${summary}`,
      },
      ms,
    );
  } catch (error) {
    const message = errorMessage(error);
    const needsGenerate = /did not initialize|@prisma\/client/i.test(message);
    const needsPush = /does not exist|no such table/i.test(message);
    record({
      group: 'database',
      name: 'prisma + schema',
      status: 'fail',
      detail: message,
      fix: needsGenerate
        ? 'Run `npm run db:generate`.'
        : needsPush
          ? 'Run `npm run db:push` to create the tables.'
          : 'Check DATABASE_URL, then run `npm run db:push`.',
    });
  }
}

// --- browser -----------------------------------------------------------------

async function checkChromium(env: Env): Promise<void> {
  try {
    const { chromium } = await import('playwright');
    const [bytes, ms] = await timed(async () => {
      const browser = await chromium.launch({
        ...(env.PLAYWRIGHT_CHROMIUM_PATH
          ? { executablePath: env.PLAYWRIGHT_CHROMIUM_PATH }
          : {}),
      });
      try {
        const page = await browser.newPage();
        await page.setContent('<h1>doctor</h1>', { waitUntil: 'load' });
        const pdf = await page.pdf({ format: 'A4' });
        const target = path.join(os.tmpdir(), 'cpos-doctor.pdf');
        await fs.writeFile(target, pdf);
        await fs.rm(target, { force: true });
        return pdf.length;
      } finally {
        await browser.close();
      }
    });
    record(
      {
        group: 'browser',
        name: 'chromium html→pdf',
        status: 'pass',
        detail: `rendered a ${(bytes / 1024).toFixed(1)} KB PDF`,
      },
      ms,
    );
  } catch (error) {
    const message = errorMessage(error);
    record({
      group: 'browser',
      name: 'chromium html→pdf',
      status: 'fail',
      detail: message,
      fix: /Executable doesn't exist|browserType.launch/i.test(message)
        ? 'Run `npx playwright install chromium`, or set PLAYWRIGHT_CHROMIUM_PATH to an existing Chromium.'
        : 'Chromium could not render a PDF — see the error above.',
    });
  }
}

// --- apis --------------------------------------------------------------------

async function checkAnthropic(env: Env): Promise<void> {
  const models = [
    ['default', env.ANTHROPIC_MODEL],
    ['heavy', env.ANTHROPIC_MODEL_HEAVY],
    ['fast', env.ANTHROPIC_MODEL_FAST],
  ] as const;

  for (const [tier, model] of models) {
    try {
      const { ping } = await import('../lib/llm.js');
      const [result, ms] = await timed(() => ping(model));
      record(
        {
          group: 'api',
          name: `anthropic ${tier}`,
          status: result.ok ? 'pass' : 'warn',
          detail: result.ok
            ? `${model} responded`
            : `${model} responded, but not with the expected text`,
        },
        ms,
      );
    } catch (error) {
      const message = errorMessage(error);
      const auth = /401|authentication|invalid x-api-key/i.test(message);
      const missingModel = /404|not_found|model/i.test(message);
      record({
        group: 'api',
        name: `anthropic ${tier}`,
        status: 'fail',
        detail: `${model}: ${message}`,
        fix: auth
          ? 'ANTHROPIC_API_KEY is rejected — regenerate it at console.anthropic.com/settings/keys.'
          : missingModel
            ? `Model "${model}" is not available to this key. Change the matching ANTHROPIC_MODEL* value in .env.`
            : 'Could not reach the Anthropic API — check network access.',
      });
    }
  }
}

interface Probe {
  name: string;
  enabled: boolean;
  reason: string;
  run: () => Promise<Response>;
}

async function checkOptionalApis(env: Env): Promise<void> {
  const probes: Probe[] = [
    {
      name: 'youtube data api',
      enabled: Boolean(env.YOUTUBE_API_KEY),
      reason: 'YOUTUBE_API_KEY not set',
      run: () =>
        fetch(
          `https://www.googleapis.com/youtube/v3/channels?part=id&forHandle=%40youtube&key=${env.YOUTUBE_API_KEY}`,
        ),
    },
    {
      name: 'apify',
      enabled: Boolean(env.APIFY_TOKEN),
      reason: 'APIFY_TOKEN not set',
      run: () =>
        fetch('https://api.apify.com/v2/users/me', {
          headers: { Authorization: `Bearer ${env.APIFY_TOKEN}` },
        }),
    },
    {
      name: 'brave search',
      enabled: Boolean(env.BRAVE_SEARCH_API_KEY),
      reason: 'BRAVE_SEARCH_API_KEY not set',
      run: () =>
        fetch('https://api.search.brave.com/res/v1/web/search?q=test&count=1', {
          headers: {
            Accept: 'application/json',
            'X-Subscription-Token': env.BRAVE_SEARCH_API_KEY ?? '',
          },
        }),
    },
    {
      name: 'serper',
      enabled: Boolean(env.SERPER_API_KEY),
      reason: 'SERPER_API_KEY not set',
      run: () =>
        fetch('https://google.serper.dev/search', {
          method: 'POST',
          headers: {
            'X-API-KEY': env.SERPER_API_KEY ?? '',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ q: 'test', num: 1 }),
        }),
    },
    {
      name: 'whop',
      enabled: Boolean(env.WHOP_API_KEY),
      reason: 'WHOP_API_KEY not set',
      run: () =>
        fetch('https://api.whop.com/api/v5/me', {
          headers: { Authorization: `Bearer ${env.WHOP_API_KEY}` },
        }),
    },
  ];

  for (const probe of probes) {
    if (!probe.enabled) {
      record({
        group: 'api',
        name: probe.name,
        status: 'skip',
        detail: probe.reason,
        fix: 'Optional until the module that needs it is built.',
      });
      continue;
    }

    try {
      const [response, ms] = await timed(probe.run);
      const unauthorized = response.status === 401 || response.status === 403;
      record(
        {
          group: 'api',
          name: probe.name,
          status: unauthorized ? 'fail' : response.ok ? 'pass' : 'warn',
          detail: `HTTP ${response.status} ${response.statusText}`.trim(),
          fix: unauthorized
            ? `The key was rejected (HTTP ${response.status}). Check the credential in .env.`
            : response.ok
              ? undefined
              : 'Reachable but returned a non-2xx status — verify the plan/quota on that account.',
        },
        ms,
      );
    } catch (error) {
      record({
        group: 'api',
        name: probe.name,
        status: 'fail',
        detail: errorMessage(error),
        fix: 'Could not reach the service — check network access.',
      });
    }
  }
}

// --- reporting ---------------------------------------------------------------

const ICON: Record<Status, string> = { pass: '✔', fail: '✖', warn: '!', skip: '–' };
const TINT: Record<Status, string> = {
  pass: '\x1b[32m',
  fail: '\x1b[31m',
  warn: '\x1b[33m',
  skip: '\x1b[90m',
};

function report(): void {
  const color = process.stdout.isTTY;
  const paint = (status: Status, text: string) =>
    color ? `${TINT[status]}${text}\x1b[0m` : text;

  const groups = [...new Set(checks.map((c) => c.group))];
  const width = Math.max(...checks.map((c) => c.name.length)) + 2;

  console.log('\nCreator Partnership OS — doctor\n');

  for (const group of groups) {
    console.log(color ? `\x1b[1m${group}\x1b[0m` : group);
    for (const check of checks.filter((c) => c.group === group)) {
      const timing = check.ms !== undefined ? ` (${check.ms}ms)` : '';
      console.log(
        `  ${paint(check.status, ICON[check.status])} ${check.name.padEnd(width)}${check.detail}${timing}`,
      );
    }
    console.log('');
  }

  const failures = checks.filter((c) => c.status === 'fail');
  const warnings = checks.filter((c) => c.status === 'warn');

  if (failures.length || warnings.length) {
    console.log(color ? '\x1b[1mnext steps\x1b[0m' : 'next steps');
    for (const check of [...failures, ...warnings]) {
      if (check.fix) console.log(`  ${paint(check.status, ICON[check.status])} ${check.name}: ${check.fix}`);
    }
    console.log('');
  }

  const counts = {
    pass: checks.filter((c) => c.status === 'pass').length,
    fail: failures.length,
    warn: warnings.length,
    skip: checks.filter((c) => c.status === 'skip').length,
  };

  console.log(
    `${counts.pass} passed · ${counts.fail} failed · ${counts.warn} warnings · ${counts.skip} skipped`,
  );
  console.log(
    failures.length
      ? paint('fail', 'Not ready — fix the failures above.')
      : paint('pass', 'Ready. Run a module with `npm run <module> -- --help`.'),
  );
}

// --- main --------------------------------------------------------------------

async function main(): Promise<void> {
  const flags = parseFlags(spec);
  const skipNetwork = flags['skip-network'] === true;
  const skipBrowser = flags['skip-browser'] === true;

  checkNode();
  await checkEnvFile();
  const env = checkEnv();

  if (env) {
    await checkOutputs(env);
    await checkDatabase(env);

    if (skipBrowser) {
      record({
        group: 'browser',
        name: 'chromium html→pdf',
        status: 'skip',
        detail: '--skip-browser',
      });
    } else {
      await checkChromium(env);
    }

    if (skipNetwork) {
      record({ group: 'api', name: 'all api checks', status: 'skip', detail: '--skip-network' });
    } else {
      await checkAnthropic(env);
      await checkOptionalApis(env);
    }
  } else {
    record({
      group: 'api',
      name: 'all api checks',
      status: 'skip',
      detail: 'environment is invalid, nothing to connect with',
    });
  }

  const failed = checks.some((c) => c.status === 'fail');

  if (flags.json === true) {
    console.log(JSON.stringify({ ok: !failed, checks }, null, 2));
  } else {
    report();
  }

  process.exitCode = failed ? 1 : 0;
}

await main();
