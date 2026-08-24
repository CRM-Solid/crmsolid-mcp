import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { main } from '../src/cli.js';
import { VERSION } from '../src/version.js';

/**
 * These drive `main()` in-process with stdout and stderr captured.
 *
 * The point is the contract a user hits before anything works: `--help` and
 * `--version` have to answer with no key and no network, a configuration
 * mistake has to exit non-zero with the fix on stderr, and nothing that is not
 * a JSON-RPC frame may ever reach stdout once a session is running.
 */

interface Captured {
  stdout: string;
  stderr: string;
}

let captured: Captured;
let restore: () => void;
let originalExitCode: number | string | undefined = undefined;
let originalKey: string | undefined;

beforeEach(() => {
  captured = { stdout: '', stderr: '' };
  const realStdout = process.stdout.write.bind(process.stdout);
  const realStderr = process.stderr.write.bind(process.stderr);

  process.stdout.write = ((chunk: string | Uint8Array) => {
    captured.stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    captured.stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;

  restore = () => {
    process.stdout.write = realStdout;
    process.stderr.write = realStderr;
  };

  originalExitCode = process.exitCode ?? undefined;
  originalKey = process.env.CRMSOLID_API_KEY;
  delete process.env.CRMSOLID_API_KEY;
});

afterEach(() => {
  restore();
  process.exitCode = originalExitCode;
  if (originalKey === undefined) delete process.env.CRMSOLID_API_KEY;
  else process.env.CRMSOLID_API_KEY = originalKey;
});

describe('--version', () => {
  it('prints the version with no key and no network', async () => {
    await main(['--version']);
    expect(captured.stdout.trim()).toBe(VERSION);
    expect(captured.stderr).toBe('');
    expect(process.exitCode).toBeUndefined();
  });

  it('answers to -v as well', async () => {
    await main(['-v']);
    expect(captured.stdout.trim()).toBe(VERSION);
  });
});

describe('--help', () => {
  it('prints usage with no key and no network', async () => {
    await main(['--help']);
    expect(captured.stdout).toContain('crmsolid-mcp');
    expect(captured.stdout).toContain('USAGE');
    expect(captured.stdout).toContain('--read-only');
    expect(captured.stderr).toBe('');
    expect(process.exitCode).toBeUndefined();
  });

  it('wins over an invalid configuration, so it is always reachable', async () => {
    // Someone whose key is wrong needs the help text to find out how to fix it.
    await main(['--help', '--api-key', 'not-a-key']);
    expect(captured.stdout).toContain('USAGE');
    expect(process.exitCode).toBeUndefined();
  });
});

describe('configuration failures', () => {
  it('exits 2 and explains a missing key, on stderr only', async () => {
    await main([]);
    expect(process.exitCode).toBe(2);
    expect(captured.stdout).toBe('');
    expect(captured.stderr).toContain('No API key');
    expect(captured.stderr).toContain('CRMSOLID_API_KEY');
  });

  it('exits 2 on an unknown flag rather than starting with it ignored', async () => {
    await main(['--reed-only']);
    expect(process.exitCode).toBe(2);
    expect(captured.stderr).toContain("Unknown flag '--reed-only'");
  });

  it('exits 2 on a misspelled tool group', async () => {
    process.env.CRMSOLID_API_KEY = 'csk_test_abcdef123456ABCDEF0123456789abcdef01';
    await main(['--tools', 'socail']);
    expect(process.exitCode).toBe(2);
    expect(captured.stderr).toContain('socail');
  });

  it('never writes a diagnostic to stdout', async () => {
    // stdout is the MCP transport. One stray line there and the host client
    // drops the connection with a parse error.
    await main(['--api-key', 'wrong']);
    expect(captured.stdout).toBe('');
    expect(captured.stderr).toContain("must start with 'csk_'");
  });
});
