import readline from 'node:readline';
import { Writable } from 'node:stream';
import { parseFlags, type CliSpec } from '../lib/cli.js';
import { REQUIRED_ENV_KEYS } from '../lib/env.js';
import {
  CREDENTIAL_KEYS,
  ENV_PATH,
  mask,
  parseEnv,
  readEnvFile,
  upsert,
  valueWarnings,
  writeEnvFile,
} from '../lib/envfile.js';

/**
 * `npm run key` — put a credential into .env without it ever being displayed.
 *
 * The value is typed into a hidden prompt: it is not echoed to the terminal,
 * not passed as an argument (so it never lands in shell history), and never
 * printed back. Only a masked fingerprint is shown so you can confirm the right
 * key went in.
 */

const SETTABLE = CREDENTIAL_KEYS;

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
    const values = parseEnv(contents);
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
  if (!SETTABLE.includes(name)) {
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
  const warnings = valueWarnings(name, value);

  await writeEnvFile(upsert(contents, name, value));

  console.log(`✔ ${name} saved as ${mask(value)}`);
  console.log(`  ${ENV_PATH} (permissions set to owner-only where supported)`);

  if (warnings.length) {
    console.log(`\n!  Saved, but check the value — ${warnings.join('; ')}.`);
    console.log('   Re-run this command to overwrite it.');
  }

  console.log('\nNext: npm run doctor\n');
}

await main();
