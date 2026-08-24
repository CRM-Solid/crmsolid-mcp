#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { Bridge } from './bridge.js';
import { helpText, parseArgs, resolveConfig, type BridgeConfig } from './config.js';
import { ConfigError, describeFailure } from './core/errors.js';
import { createLogger } from './core/log.js';
import { registerSecret } from './core/redact.js';
import { VERSION } from './version.js';

/**
 * Entry point for the `crmsolid-mcp` binary.
 *
 * Two rules govern everything below.
 *
 * stdout belongs to the MCP transport from the moment the bridge starts, so the
 * only things ever written there are `--help` and `--version`, both of which
 * exit before a transport exists. Every other message goes to stderr.
 *
 * And configuration is validated before the transport opens. A missing key or a
 * misspelled `--tools` group is a mistake in the user's client configuration,
 * and the fastest way to tell them is a non-zero exit with the sentence printed
 * plainly, not an MCP session that answers every request with the same error.
 */

/** Exit code for a configuration mistake, distinct from a runtime failure. */
const EXIT_CONFIG = 2;

/** Exit code for a runtime failure the user cannot fix by editing flags. */
const EXIT_RUNTIME = 1;

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  let config: BridgeConfig;
  try {
    const parsed = parseArgs(argv);

    // Both of these have to work with no key and no network, because they are
    // what someone runs first to find out how to supply the key.
    if (parsed.flags.has('help')) {
      process.stdout.write(helpText());
      return;
    }
    if (parsed.flags.has('version')) {
      process.stdout.write(`${VERSION}\n`);
      return;
    }

    config = resolveConfig(parsed, process.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`crmsolid-mcp: ${error.message}\n`);
      process.exitCode = EXIT_CONFIG;
      return;
    }
    throw error;
  }

  // Register before the first log line: from here on every string that reaches
  // stderr is scrubbed of the key.
  registerSecret(config.apiKey);
  const logger = createLogger(config.debug);

  const bridge = new Bridge({ config, logger });
  const transport = new StdioServerTransport();

  let shuttingDown = false;
  const shutdown = (reason: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutting down', { reason });
    void bridge.stop().finally(() => {
      process.exit(0);
    });
  };

  // SIGINT and SIGTERM arrive when a desktop client closes the server; stdin
  // ending is how the same clients signal it on Windows, where the signal is
  // not always delivered.
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.stdin.on('close', () => shutdown('stdin closed'));

  // An unhandled rejection from a background task (the notification stream, a
  // teardown) must not take the transport down while requests are still working.
  process.on('unhandledRejection', (reason: unknown) => {
    logger.error('unhandled rejection', { reason: describeFailure(reason) });
  });

  try {
    await bridge.start(transport);
  } catch (error) {
    process.stderr.write(`crmsolid-mcp: ${describeFailure(error)}\n`);
    process.exitCode = EXIT_RUNTIME;
    await bridge.stop();
  }
}

// tsup emits this file as the `crmsolid-mcp` bin. Running it starts the server;
// importing it (the smoke test does) gets `main` without side effects.
if (isDirectRun()) {
  void main();
}

/**
 * True when this file is the process entry point.
 *
 * `process.argv[1]` is compared rather than `import.meta.url`, because tsup
 * bundles to CJS-compatible output for some consumers and `import.meta` is not
 * available in every shape this file can end up in.
 */
function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return /(^|[\\/])cli\.(js|cjs|mjs|ts)$/.test(entry) || /(^|[\\/])crmsolid-mcp$/.test(entry);
}
