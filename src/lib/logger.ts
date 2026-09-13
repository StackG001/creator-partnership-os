import { getEnv } from './env.js';

type Level = 'debug' | 'info' | 'warn' | 'error';

const RANK: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const COLOR: Record<Level, string> = {
  debug: '\x1b[90m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
};

const RESET = '\x1b[0m';

function threshold(): number {
  try {
    return RANK[getEnv().LOG_LEVEL];
  } catch {
    return RANK.info; // env not loadable yet (e.g. the doctor is reporting why)
  }
}

function emit(level: Level, scope: string, message: string, extra?: unknown) {
  if (RANK[level] < threshold()) return;
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  const tint = stream.isTTY ? COLOR[level] : '';
  const reset = stream.isTTY ? RESET : '';
  const time = new Date().toISOString().slice(11, 19);
  stream.write(`${tint}${time} ${level.padEnd(5)} [${scope}]${reset} ${message}\n`);
  if (extra !== undefined) {
    stream.write(`${typeof extra === 'string' ? extra : JSON.stringify(extra, null, 2)}\n`);
  }
}

export function createLogger(scope: string) {
  return {
    debug: (m: string, extra?: unknown) => emit('debug', scope, m, extra),
    info: (m: string, extra?: unknown) => emit('info', scope, m, extra),
    warn: (m: string, extra?: unknown) => emit('warn', scope, m, extra),
    error: (m: string, extra?: unknown) => emit('error', scope, m, extra),
  };
}

export type Logger = ReturnType<typeof createLogger>;
