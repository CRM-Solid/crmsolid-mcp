import { redact, redactValue } from './redact.js';

/**
 * Diagnostics for the bridge itself.
 *
 * stdout belongs to the MCP transport. A single stray `console.log` lands in the
 * middle of the JSON-RPC stream and the host client drops the connection with a
 * parse error, so every line this package emits goes to stderr, which desktop
 * clients capture into their own log files.
 *
 * `warn` and `error` are always on, because a silent bridge that cannot reach
 * the API is indistinguishable from one with nothing to do. `debug` is behind
 * CRMSOLID_DEBUG / --debug.
 */
export interface Logger {
  debug(message: string, detail?: unknown): void;
  info(message: string, detail?: unknown): void;
  warn(message: string, detail?: unknown): void;
  error(message: string, detail?: unknown): void;
}

/** Writes to stderr. `debug` and `info` are suppressed unless `debugEnabled`. */
export function createLogger(debugEnabled: boolean, write: (line: string) => void = writeStderr): Logger {
  const emit = (level: string, message: string, detail?: unknown): void => {
    const stamp = new Date().toISOString();
    const suffix = detail === undefined ? '' : ` ${safeJson(detail)}`;
    write(`[crmsolid-mcp] ${stamp} ${level} ${redact(message)}${suffix}`);
  };

  return {
    debug: (message, detail) => {
      if (debugEnabled) emit('debug', message, detail);
    },
    info: (message, detail) => {
      if (debugEnabled) emit('info', message, detail);
    },
    warn: (message, detail) => emit('warn', message, detail),
    error: (message, detail) => emit('error', message, detail),
  };
}

/** A logger that discards everything. Used by tests and by embedded hosts. */
export function silentLogger(): Logger {
  const noop = (): void => undefined;
  return { debug: noop, info: noop, warn: noop, error: noop };
}

function writeStderr(line: string): void {
  process.stderr.write(`${line}\n`);
}

/**
 * Serializes a detail object for the log line, redacted, and never throws:
 * a circular structure in a debug payload must not take the process down.
 */
function safeJson(detail: unknown): string {
  try {
    return JSON.stringify(redactValue(detail)) ?? String(detail);
  } catch {
    return redact(String(detail));
  }
}
