import { describe, expect, it } from 'vitest';

import {
  DEFAULT_BASE_URL,
  DEFAULT_MAX_RETRIES,
  DEFAULT_TIMEOUT_MS,
  helpText,
  normalizeBaseUrl,
  parseArgs,
  resolveConfig,
} from '../src/config.js';
import { ConfigError } from '../src/core/errors.js';
import { VERSION } from '../src/version.js';
import { TEST_KEY } from './helpers.js';

/** Resolve with an explicit environment, so a developer's own shell cannot leak in. */
function resolve(argv: string[], env: NodeJS.ProcessEnv = {}) {
  return resolveConfig(parseArgs(argv), env);
}

describe('argument parsing', () => {
  it('accepts both --flag value and --flag=value', () => {
    expect(parseArgs(['--api-key', TEST_KEY]).values['api-key']).toBe(TEST_KEY);
    expect(parseArgs([`--api-key=${TEST_KEY}`]).values['api-key']).toBe(TEST_KEY);
  });

  it('accepts the short forms of help and version', () => {
    expect(parseArgs(['-h']).flags.has('help')).toBe(true);
    expect(parseArgs(['-v']).flags.has('version')).toBe(true);
    expect(parseArgs(['--help']).flags.has('help')).toBe(true);
    expect(parseArgs(['--version']).flags.has('version')).toBe(true);
  });

  it('rejects an unknown flag instead of ignoring it', () => {
    // Silently ignoring a misspelled flag is how someone ends up believing they
    // are in read-only mode when they are not.
    expect(() => parseArgs(['--red-only'])).toThrow(ConfigError);
    expect(() => parseArgs(['--tools-list', 'social'])).toThrow(/Unknown flag/);
  });

  it('rejects a bare argument', () => {
    expect(() => parseArgs(['social'])).toThrow(/Unexpected argument/);
  });

  it('rejects a value flag with no value', () => {
    expect(() => parseArgs(['--tools'])).toThrow(/needs a value/);
    expect(() => parseArgs(['--tools', '--read-only'])).toThrow(/needs a value/);
  });
});

describe('configuration resolution', () => {
  it('requires a key and says where to get one', () => {
    expect(() => resolve([])).toThrow(/No API key/);
    expect(() => resolve([])).toThrow(/app\.crmsolid\.com\/settings\/developers/);
  });

  it('rejects something that is not a CRM Solid key', () => {
    expect(() => resolve(['--api-key', 'sk-not-ours'])).toThrow(/must start with 'csk_'/);
  });

  it('reads the key from the environment as well as the flag', () => {
    expect(resolve([], { CRMSOLID_API_KEY: TEST_KEY }).apiKey).toBe(TEST_KEY);
  });

  it('lets a flag beat the environment', () => {
    const config = resolve(['--base-url', 'https://staging.example.test'], {
      CRMSOLID_API_KEY: TEST_KEY,
      CRMSOLID_BASE_URL: 'https://env.example.test',
    });
    expect(config.baseUrl).toBe('https://staging.example.test');
  });

  it('defaults everything the contract defaults', () => {
    const config = resolve([], { CRMSOLID_API_KEY: TEST_KEY });
    expect(config).toMatchObject({
      baseUrl: DEFAULT_BASE_URL,
      endpoint: `${DEFAULT_BASE_URL}/mcp`,
      toolGroups: null,
      readOnly: false,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      maxRetries: DEFAULT_MAX_RETRIES,
      sse: true,
      debug: false,
    });
  });

  it('reads the tool filter from either source', () => {
    expect(resolve(['--tools', 'social,posts'], { CRMSOLID_API_KEY: TEST_KEY }).toolGroups).toEqual([
      'social',
      'posts',
    ]);
    expect(resolve([], { CRMSOLID_API_KEY: TEST_KEY, CRMSOLID_TOOLS: 'contacts' }).toolGroups).toEqual([
      'contacts',
    ]);
  });

  it('rejects a misspelled group rather than silently exposing nothing', () => {
    expect(() => resolve(['--tools', 'social,psots'], { CRMSOLID_API_KEY: TEST_KEY })).toThrow(/psots/);
  });

  it('reads read-only from either source', () => {
    expect(resolve(['--read-only'], { CRMSOLID_API_KEY: TEST_KEY }).readOnly).toBe(true);
    expect(resolve([], { CRMSOLID_API_KEY: TEST_KEY, CRMSOLID_READ_ONLY: '1' }).readOnly).toBe(true);
    expect(resolve([], { CRMSOLID_API_KEY: TEST_KEY, CRMSOLID_READ_ONLY: 'true' }).readOnly).toBe(true);
    expect(resolve([], { CRMSOLID_API_KEY: TEST_KEY, CRMSOLID_READ_ONLY: 'no' }).readOnly).toBe(false);
    expect(resolve([], { CRMSOLID_API_KEY: TEST_KEY, CRMSOLID_READ_ONLY: '' }).readOnly).toBe(false);
  });

  it('turns the notification stream off from either source', () => {
    expect(resolve(['--no-sse'], { CRMSOLID_API_KEY: TEST_KEY }).sse).toBe(false);
    expect(resolve([], { CRMSOLID_API_KEY: TEST_KEY, CRMSOLID_SSE: '0' }).sse).toBe(false);
    expect(resolve([], { CRMSOLID_API_KEY: TEST_KEY, CRMSOLID_SSE: '1' }).sse).toBe(true);
  });

  it('validates the numeric flags', () => {
    expect(resolve(['--timeout', '5000'], { CRMSOLID_API_KEY: TEST_KEY }).timeoutMs).toBe(5_000);
    expect(resolve(['--max-retries', '0'], { CRMSOLID_API_KEY: TEST_KEY }).maxRetries).toBe(0);
    expect(() => resolve(['--timeout', '0'], { CRMSOLID_API_KEY: TEST_KEY })).toThrow(/positive/);
    expect(() => resolve(['--timeout', 'soon'], { CRMSOLID_API_KEY: TEST_KEY })).toThrow(/positive/);
    expect(() => resolve(['--max-retries', '-1'], { CRMSOLID_API_KEY: TEST_KEY })).toThrow(/zero or/);
  });
});

describe('base url normalization', () => {
  it('adds a scheme, drops a trailing slash, and drops a pasted /mcp', () => {
    expect(normalizeBaseUrl('api.crmsolid.com')).toBe('https://api.crmsolid.com');
    expect(normalizeBaseUrl('https://api.crmsolid.com/')).toBe('https://api.crmsolid.com');
    expect(normalizeBaseUrl('https://api.crmsolid.com/mcp')).toBe('https://api.crmsolid.com');
    expect(normalizeBaseUrl('https://api.crmsolid.com/mcp/')).toBe('https://api.crmsolid.com');
  });

  it('keeps a path prefix, for a self-hosted deployment behind a sub-path', () => {
    expect(normalizeBaseUrl('https://internal.example.test/crm/')).toBe('https://internal.example.test/crm');
    expect(normalizeBaseUrl('http://localhost:8081')).toBe('http://localhost:8081');
  });

  it('rejects something that is not a URL', () => {
    expect(() => normalizeBaseUrl('   ')).toThrow(ConfigError);
    expect(() => normalizeBaseUrl('https://')).toThrow(ConfigError);
  });
});

describe('help text', () => {
  it('documents every flag and both configuration sources', () => {
    const help = helpText();
    for (const flag of [
      '--api-key',
      '--base-url',
      '--tools',
      '--read-only',
      '--timeout',
      '--max-retries',
      '--no-sse',
      '--debug',
      '--help',
      '--version',
    ]) {
      expect(help).toContain(flag);
    }
    for (const env of [
      'CRMSOLID_API_KEY',
      'CRMSOLID_BASE_URL',
      'CRMSOLID_TOOLS',
      'CRMSOLID_READ_ONLY',
      'CRMSOLID_TIMEOUT_MS',
      'CRMSOLID_MAX_RETRIES',
      'CRMSOLID_SSE',
      'CRMSOLID_DEBUG',
    ]) {
      expect(help).toContain(env);
    }
  });

  it('names the clients this server is meant to be configured in', () => {
    const help = helpText();
    expect(help).toContain('Claude Desktop');
    expect(help).toContain('Claude Code');
    expect(help).toContain('Cursor');
    expect(help).toContain('ChatGPT');
    expect(help).toContain('@crmsolid/mcp-server');
  });

  it('reports the package version', () => {
    expect(helpText()).toContain(`crmsolid-mcp ${VERSION}`);
  });
});
