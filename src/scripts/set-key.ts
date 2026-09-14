import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { Writable } from 'node:stream';
import { parseFlags, type CliSpec } from '../lib/cli.js';
import { OPTIONAL_ENV_KEYS, REQUIRED_ENV_KEYS } from '../lib/env.js';

/**
 * `npm run key` — put a credential into .env without it ever being displayed.
 *
 * The value is typed into a hidden prompt: it is not echoed to the terminal,
 * not passed as an argument (so it never lands in shell history), and never
 * printed back. Only a masked fingerprint is shown so you can confirm the right
 * key went in.
 */

const SETTABLE = [...REQUIRED_ENV_KEYS, ...OPTIONAL_ENV_KEYS].filter(
  (key) => key !== 'DATABASE_URL',
);

const spec: CliSpec = {
  name: 'key',
  summary: 'Store an API key in .env via a hidden prompt (nothing is echoed).',
  examples: [
    'npm run key',
    'npm run key -- --name YOUTUBE_API_KEY',
    'npm run key -- --list',
  ],
  flags: {
    name: {
      type: 'string',
      description: `Which variable to set. One of: ${SETTABLE.join(', ')}.`,
      default: 'ANTHROPIC_API_KEY',
    },
    list: { type: 'boolean', description: 'Show which keys are set, masked, and exit.' },
  },
};

const ENV_PATH = path.resolve(process.cwd(), '.env');
const EXAMPLE_PATH = path.resolve(process.cwd(), '.env.example');

function mask(value: string): string {
  if (value.length <= 8) return `${'•'.repeat(value.length)} (${value.length} chars)`;
  return `${value.slice(0, 5)}${'•'.repeat(12)}${value.slice(-4)} (${value.length} chars)`;
}

async function readEnvFile(): Promise<string> {
  try {
    return await fs.readFile(ENV_PATH, 'utf8');
  } catch {
    try {
      // First run: start from the documented template so the comments survive.
      const template = await fs.readFile(EXAMPLE_PATH, 'utf8');
      return template.replace(/^ANTHROPIC_API_KEY=.*$/m, 'ANTHROPIC_API_KEY=');
    } catch {
      return '';
    }
  }
}

/** Replace KEY=... in place, preserving comments and ordering. Appends if absent. */
function upsert(contents: string, key: string, value: string): string {
  const line = `${key}=${/[\s#"']/.test(value) ? JSON.stringify(value) : value}`;
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  if (pattern.test(contents)) return contents.replace(pattern, line);
  const separator = contents.endsWith('\n') || contents === '' ? '' : '\n';
  return `${contents}${separator}${line}\n`;
}

function currentValues(contents: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const raw of contents.split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(raw.trim());
    if (!match) continue;
    const [, key, value] = match;
    if (key) values.set(key, (value ?? '').replace(/^["']|["']$/g, '').trim());
  }
  return values;
}

/** Prompt with the terminal echo suppressed. */
function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    let muted = false;
    const mutedOut = new Writable({
      write(chunk, encoding, callback) {
        if (!muted) process.stdout.write(chunk, encoding);
        callback();
      },
    });

    const rl = readline.createInterface({
      input: process.stdin,
      output: mutedOut,
      terminal: true,
    });

    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer.trim());
    });

    muted = true;
  });
}

async function main(): Promise<void> {
  const flags = parseFlags(spec);
  const contents = await readEnvFile();

  if (flags.list === true) {
    const values = currentValues(contents);
    console.log(`\n.env — ${ENV_PATH}\n`);
    for (const key of SETTABLE) {
      const value = values.get(key);
      const required = (REQUIRED_ENV_KEYS as readonly string[]).includes(key);
      console.log(
        `  ${value ? '✔' : required ? '✖' : '–'} ${key.padEnd(22)}${
          value ? mask(value) : required ? 'not set (required)' : 'not set (optional)'
        }`,
      );
    }
    console.log('');
    return;
  }

  const name = String(flags.name ?? 'ANTHROPIC_API_KEY').toUpperCase();
  if (!SETTABLE.includes(name as (typeof SETTABLE)[number])) {
    console.error(`Unknown key "${name}".\n\nSettable keys:\n  ${SETTABLE.join('\n  ')}`);
    process.exitCode = 1;
    return;
  }

  if (!process.stdin.isTTY) {
    console.error(
      'This command needs an interactive terminal so the value can be hidden as you type.\n' +
        'Run it directly in your terminal, not through a pipe or a CI job.',
    );
    process.exitCode = 1;
    return;
  }

  console.log(`\nSetting ${name} in ${ENV_PATH}`);
  console.log('Your input is hidden and is never printed back or logged.\n');

  const value = await promptHidden(`Paste ${name} (input hidden), then press Enter: `);

  if (!value) {
    console.error('Nothing entered — .env was not changed.');
    process.exitCode = 1;
    return;
  }

  // Catch the usual paste accidents before they become a confusing 401.
  const warnings: string[] = [];
  if (/\s/.test(value)) warnings.push('it contains whitespace');
  if (/^["'<].*[">']$/.test(value)) warnings.push('it is wrapped in quotes or angle brackets');
  if (name === 'ANTHROPIC_API_KEY' && !value.startsWith('sk-ant-')) {
    warnings.push('an Anthropic key normally starts with "sk-ant-"');
  }

  await fs.writeFile(ENV_PATH, upsert(contents, name, value), 'utf8');
  await fs.chmod(ENV_PATH, 0o600).catch(() => {
    /* best effort: Windows and some mounts don't support it */
  });

  console.log(`✔ ${name} saved as ${mask(value)}`);
  console.log(`  ${ENV_PATH} (permissions set to owner-only where supported)`);

  if (warnings.length) {
    console.log(`\n!  Saved, but check the value — ${warnings.join('; ')}.`);
    console.log('   Re-run this command to overwrite it.');
  }

  console.log('\nNext: npm run doctor\n');
}

await main();
