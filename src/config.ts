import { ConfigError, KEY_SETTINGS_URL } from './core/errors.js';
import { parseGroups, unknownGroups } from './filters.js';
import { VERSION } from './version.js';

/**
 * Command-line and environment surface.
 *
 * A flag always beats the matching environment variable, because the env comes
 * from a config file the user edited once and the flag is what they typed on
 * this run. Both are optional except the key.
 */
export interface BridgeConfig {
  apiKey: string;
  /** API host with no trailing slash, e.g. `https://api.crmsolid.com`. */
  baseUrl: string;
  /** Full MCP endpoint, `baseUrl` + `/mcp`. */
  endpoint: string;
  /** Tool groups to expose, or `null` for all of them. */
  toolGroups: string[] | null;
  readOnly: boolean;
  /** Per-request timeout in milliseconds. */
  timeoutMs: number;
  /** Retry budget for idempotent upstream calls. */
  maxRetries: number;
  /** Whether to open the upstream Server-Sent Events notification channel. */
  sse: boolean;
  debug: boolean;
}

export const DEFAULT_BASE_URL = 'https://api.crmsolid.com';
export const DEFAULT_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_RETRIES = 3;

/** Long flags this binary accepts. Anything else is a usage error, never ignored. */
const BOOLEAN_FLAGS = new Set(['read-only', 'debug', 'no-sse', 'help', 'version']);
const VALUE_FLAGS = new Set(['api-key', 'base-url', 'tools', 'timeout', 'max-retries']);

export interface ParsedArgs {
  values: Record<string, string>;
  flags: Set<string>;
}

/**
 * Parses `--flag value`, `--flag=value` and the `-h` / `-v` shorthands.
 *
 * Deliberately hand-rolled rather than pulled from a dependency: the whole
 * surface is seven flags, and a bridge that npx installs on every launch should
 * not drag an argument parser and its transitive tree along for it.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const values: Record<string, string> = {};
  const flags = new Set<string>();

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;

    if (arg === '-h') {
      flags.add('help');
      continue;
    }
    if (arg === '-v') {
      flags.add('version');
      continue;
    }
    if (!arg.startsWith('--')) {
      throw new ConfigError(`Unexpected argument '${arg}'. Run crmsolid-mcp --help for the accepted flags.`);
    }

    const body = arg.slice(2);
    const eq = body.indexOf('=');
    const name = eq >= 0 ? body.slice(0, eq) : body;
    const inline = eq >= 0 ? body.slice(eq + 1) : null;

    if (BOOLEAN_FLAGS.has(name)) {
      if (inline !== null && !isTruthy(inline)) continue;
      flags.add(name);
      continue;
    }

    if (!VALUE_FLAGS.has(name)) {
      throw new ConfigError(`Unknown flag '--${name}'. Run crmsolid-mcp --help for the accepted flags.`);
    }

    const value = inline ?? argv[++i];
    if (value === undefined || value.startsWith('--')) {
      throw new ConfigError(`Flag '--${name}' needs a value, for example --${name}=<value>.`);
    }
    values[name] = value;
  }

  return { values, flags };
}

/** Builds the runtime configuration, or throws a ConfigError naming the fix. */
export function resolveConfig(parsed: ParsedArgs, env: NodeJS.ProcessEnv): BridgeConfig {
  const apiKey = (parsed.values['api-key'] ?? env.CRMSOLID_API_KEY ?? '').trim();
  if (!apiKey) {
    throw new ConfigError(
      'No API key. Set CRMSOLID_API_KEY in the "env" block of your MCP client configuration, or pass --api-key. ' +
        `Create a key at ${KEY_SETTINGS_URL}.`,
    );
  }
  if (!apiKey.startsWith('csk_')) {
    throw new ConfigError(
      `The API key does not look like a CRM Solid key: it must start with 'csk_'. Mint one at ${KEY_SETTINGS_URL}.`,
    );
  }

  const baseUrl = normalizeBaseUrl(parsed.values['base-url'] ?? env.CRMSOLID_BASE_URL ?? DEFAULT_BASE_URL);
  const toolGroups = parseGroups(parsed.values['tools'] ?? env.CRMSOLID_TOOLS);
  const unknown = unknownGroups(toolGroups);
  if (unknown.length > 0) {
    throw new ConfigError(
      `--tools names ${unknown.length === 1 ? 'a group' : 'groups'} this server does not recognise: ` +
        `${unknown.join(', ')}. Run crmsolid-mcp --help for the group list.`,
    );
  }

  return {
    apiKey,
    baseUrl,
    endpoint: `${baseUrl}/mcp`,
    toolGroups,
    readOnly: parsed.flags.has('read-only') || isTruthy(env.CRMSOLID_READ_ONLY),
    timeoutMs: readPositiveInt(parsed.values['timeout'] ?? env.CRMSOLID_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, '--timeout'),
    maxRetries: readNonNegativeInt(
      parsed.values['max-retries'] ?? env.CRMSOLID_MAX_RETRIES,
      DEFAULT_MAX_RETRIES,
      '--max-retries',
    ),
    sse: !parsed.flags.has('no-sse') && !isFalsy(env.CRMSOLID_SSE),
    debug: parsed.flags.has('debug') || isTruthy(env.CRMSOLID_DEBUG),
  };
}

/**
 * Accepts a host with or without a scheme, with or without a trailing slash, and
 * with or without the `/mcp` suffix someone will inevitably paste in.
 */
export function normalizeBaseUrl(raw: string): string {
  let value = raw.trim();
  if (!value) throw new ConfigError('--base-url cannot be empty.');
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ConfigError(`--base-url is not a valid URL: '${raw}'.`);
  }

  const path = parsed.pathname.replace(/\/+$/, '').replace(/\/mcp$/i, '');
  return `${parsed.origin}${path}`;
}

export function isTruthy(value: string | undefined | null): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function isFalsy(value: string | undefined | null): boolean {
  if (value === undefined || value === null) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off';
}

function readPositiveInt(value: string | undefined, fallback: number, flag: string): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new ConfigError(`${flag} must be a positive whole number of milliseconds, got '${value}'.`);
  }
  return parsed;
}

function readNonNegativeInt(value: string | undefined, fallback: number, flag: string): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new ConfigError(`${flag} must be zero or a positive whole number, got '${value}'.`);
  }
  return parsed;
}

/** The `--help` text. Printed to stdout and exits 0, with or without a key. */
export function helpText(): string {
  return `crmsolid-mcp ${VERSION}

  Manage every social media DM and post from your AI assistant, over MCP.

  A stdio Model Context Protocol server that bridges an MCP client (Claude Desktop,
  Claude Code, Cursor, ChatGPT and anything else that speaks MCP) to your CRM Solid
  workspace: Instagram, Facebook, X, LinkedIn, TikTok, YouTube, Threads, Pinterest,
  Reddit, Bluesky, Telegram and WhatsApp inboxes, plus scheduled posts.

USAGE
  crmsolid-mcp [options]

OPTIONS
  --api-key <key>        CRM Solid API key (csk_live_...). Required.
                         Env: CRMSOLID_API_KEY
  --base-url <url>       API host. Default: ${DEFAULT_BASE_URL}
                         Env: CRMSOLID_BASE_URL
  --tools <a,b,c>        Expose only these tool groups. Default: all.
                         Env: CRMSOLID_TOOLS
  --read-only            Expose only tools CRM Solid marks as read-only, and
                         refuse a write even if one is called anyway.
                         Env: CRMSOLID_READ_ONLY=1
  --timeout <ms>         Per-request timeout. Default: ${DEFAULT_TIMEOUT_MS}
                         Env: CRMSOLID_TIMEOUT_MS
  --max-retries <n>      Retries for idempotent calls. Default: ${DEFAULT_MAX_RETRIES}
                         Env: CRMSOLID_MAX_RETRIES
  --no-sse               Do not open the upstream notification stream.
                         Env: CRMSOLID_SSE=0
  --debug                Verbose diagnostics on stderr. The API key is never
                         written to any output.
                         Env: CRMSOLID_DEBUG=1
  -h, --help             Print this help and exit.
  -v, --version          Print the version and exit.

TOOL GROUPS
  social, posts, contacts, conversations, deals, tasks, email, finance,
  sequences, pipelines, webhooks, jobs, agents, accounts, telegram, twitter,
  analytics

CONFIGURATION
  Add this to your MCP client configuration:

  {
    "mcpServers": {
      "crmsolid": {
        "command": "npx",
        "args": ["-y", "@crmsolid/mcp-server"],
        "env": { "CRMSOLID_API_KEY": "csk_live_..." }
      }
    }
  }

  Create an API key at ${KEY_SETTINGS_URL}
  Documentation: https://docs.crmsolid.com/integrations/mcp/
`;
}
