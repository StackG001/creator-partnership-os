import { parseArgs } from 'node:util';
import { disconnect } from './db.js';
import { createLogger } from './logger.js';
import { loadEnv } from './env.js';

/**
 * Every module is a CLI first. This gives them one shape: declared flags,
 * a generated --help, env validation before anything runs, and a single
 * place where errors turn into a non-zero exit code.
 */

export interface FlagSpec {
  type: 'string' | 'boolean';
  short?: string;
  description: string;
  default?: string | boolean;
  required?: boolean;
}

export interface CliSpec {
  /** npm script name, e.g. "finder". */
  name: string;
  summary: string;
  /** Example invocations, shown under --help. */
  examples?: string[];
  flags: Record<string, FlagSpec>;
}

export type ParsedFlags = Record<string, string | boolean | undefined>;

const COMMON_FLAGS: Record<string, FlagSpec> = {
  help: { type: 'boolean', short: 'h', description: 'Show this help and exit.' },
  'dry-run': {
    type: 'boolean',
    description: 'Run without writing to the database or calling paid APIs.',
  },
  json: { type: 'boolean', description: 'Emit machine-readable JSON on stdout.' },
};

export function renderHelp(spec: CliSpec): string {
  const flags = { ...spec.flags, ...COMMON_FLAGS };
  const width = Math.max(...Object.keys(flags).map((f) => f.length)) + 6;

  const lines = [
    `${spec.name} — ${spec.summary}`,
    '',
    `Usage: npm run ${spec.name} -- [options]`,
    '',
    'Options:',
    ...Object.entries(flags).map(([name, flag]) => {
      const short = flag.short ? `-${flag.short}, ` : '    ';
      const label = `${short}--${name}${flag.type === 'string' ? ' <value>' : ''}`;
      const suffix = [
        flag.required ? '(required)' : '',
        flag.default !== undefined ? `(default: ${flag.default})` : '',
      ]
        .filter(Boolean)
        .join(' ');
      return `  ${label.padEnd(width + 10)} ${flag.description}${suffix ? ` ${suffix}` : ''}`;
    }),
  ];

  if (spec.examples?.length) {
    lines.push('', 'Examples:', ...spec.examples.map((e) => `  ${e}`));
  }

  return lines.join('\n');
}

/**
 * Parse argv against the spec. Exits 0 on --help, exits 1 on a bad or missing
 * flag with the help text attached.
 */
export function parseFlags(spec: CliSpec, argv = process.argv.slice(2)): ParsedFlags {
  const flags = { ...spec.flags, ...COMMON_FLAGS };
  const options = Object.fromEntries(
    Object.entries(flags).map(([name, flag]) => [
      name,
      {
        type: flag.type,
        ...(flag.short ? { short: flag.short } : {}),
        ...(flag.default !== undefined ? { default: flag.default } : {}),
      },
    ]),
  );

  let values: ParsedFlags;
  try {
    ({ values } = parseArgs({ args: argv, options, allowPositionals: false }) as {
      values: ParsedFlags;
    });
  } catch (error) {
    console.error(`${(error as Error).message}\n\n${renderHelp(spec)}`);
    process.exit(1);
  }

  if (values.help) {
    console.log(renderHelp(spec));
    process.exit(0);
  }

  const missing = Object.entries(spec.flags)
    .filter(([name, flag]) => flag.required && values[name] === undefined)
    .map(([name]) => `--${name}`);

  if (missing.length) {
    console.error(`Missing required option(s): ${missing.join(', ')}\n\n${renderHelp(spec)}`);
    process.exit(1);
  }

  return values;
}

export interface CliContext {
  flags: ParsedFlags;
  log: ReturnType<typeof createLogger>;
  dryRun: boolean;
  json: boolean;
}

/** Wire up a module's entry point: parse, validate env, run, disconnect. */
export async function runCli(
  spec: CliSpec,
  handler: (ctx: CliContext) => Promise<void>,
): Promise<void> {
  const flags = parseFlags(spec);
  const log = createLogger(spec.name);

  const env = loadEnv();
  if (!env.success) {
    log.error('Environment is not valid. Run `npm run doctor` for the full report.');
    for (const issue of env.error.issues) {
      log.error(`  ${issue.path.join('.') || '(root)'}: ${issue.message}`);
    }
    process.exitCode = 1;
    return;
  }

  try {
    await handler({
      flags,
      log,
      dryRun: flags['dry-run'] === true,
      json: flags.json === true,
    });
  } catch (error) {
    log.error((error as Error).message);
    if (process.env.LOG_LEVEL === 'debug') console.error(error);
    process.exitCode = 1;
  } finally {
    await disconnect();
  }
}

/** Placeholder body for modules that are scaffolded but not built yet. */
export function notImplemented(spec: CliSpec): never {
  console.error(
    [
      `${spec.name} is scaffolded but not implemented yet.`,
      '',
      renderHelp(spec),
      '',
      `Implement it in src/modules/${spec.name}/index.ts, then wire it into cli.ts.`,
    ].join('\n'),
  );
  process.exit(2);
}
