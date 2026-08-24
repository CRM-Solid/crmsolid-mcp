import { redact } from './redact.js';

/**
 * Typed error hierarchy for the bridge.
 *
 * Every failure the upstream endpoint can produce is classified here into one
 * class whose `message` is already the sentence a human should read. That is
 * deliberate: the reader of these messages is either a person squinting at a
 * desktop client's log pane or a language model deciding what to tell its user,
 * and neither can do anything useful with `{"jsonrpc":"2.0","error":{"code":-32002}}`.
 *
 * Rules every message in this file follows:
 *   - name what failed in plain words;
 *   - name the exact thing to change (a scope, an env var, a plan);
 *   - carry no secret, because the constructor redacts before it calls super.
 */

/** Where a person goes to mint, scope or rotate a key. Quoted in several messages. */
export const KEY_SETTINGS_URL = 'https://app.crmsolid.com/settings/developers';

/** Where a person goes to change plan. */
export const BILLING_URL = 'https://app.crmsolid.com/billing';

/** Base class for everything this package throws. `instanceof BridgeError` catches all of it. */
export class BridgeError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(redact(message));
    this.name = new.target.name;
    if (options?.cause !== undefined) this.cause = options.cause;
    // Keeps `instanceof` working when the package is consumed as transpiled CJS.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Bad flags or missing environment. Raised before a single byte goes over the wire. */
export class ConfigError extends BridgeError {}

/** The request never produced an HTTP response: DNS, TLS, proxy, socket reset, timeout. */
export class UpstreamConnectionError extends BridgeError {}

/** A response arrived but was not a JSON-RPC frame this bridge can read. */
export class UpstreamProtocolError extends BridgeError {}

/** 401, or JSON-RPC -32001. The key is missing, malformed, revoked or expired. */
export class AuthenticationError extends BridgeError {}

/** 403 for a reason other than scope, for example the key's IP allow list. */
export class AccessError extends BridgeError {}

/**
 * The key authenticated but is not scoped for what was asked. Carries the scope
 * to add, which is the only fact that makes this error actionable.
 */
export class ScopeError extends BridgeError {
  /** The scope the caller must add to the key, e.g. `social:write`. */
  readonly requiredScope: string;
  /** Scopes the key currently carries, when the server reported them. */
  readonly grantedScopes: string[];

  constructor(init: { requiredScope: string; grantedScopes?: string[]; subject: string }) {
    const granted = init.grantedScopes ?? [];
    const grantedText = granted.length
      ? `The key currently has: ${granted.join(', ')}.`
      : 'The key carries no matching scope.';
    super(
      `${init.subject} needs the '${init.requiredScope}' scope. ${grantedText} ` +
        `Add '${init.requiredScope}' to this API key at ${KEY_SETTINGS_URL} (Developers, then edit the key's scopes), ` +
        `then restart the MCP server so it picks up the change.`,
    );
    this.requiredScope = init.requiredScope;
    this.grantedScopes = granted;
  }
}

/** HTTP 402. The workspace's plan does not include the feature behind this call. */
export class PlanError extends BridgeError {
  /** Entitlement key the backend named, e.g. `dev_mcp_server`. */
  readonly featureKey: string | null;

  constructor(init: { featureKey: string | null; detail?: string }) {
    const feature = init.featureKey ? ` (feature '${init.featureKey}')` : '';
    super(
      `Your CRM Solid plan does not include this${feature}. ` +
        (init.detail ? `${init.detail} ` : '') +
        `Upgrade at ${BILLING_URL}, then restart the MCP server.`,
    );
    this.featureKey = init.featureKey;
  }
}

/** HTTP 429 after the bridge exhausted its own retries. */
export class RateLimitError extends BridgeError {
  /** Seconds the server asked us to wait, when it said. */
  readonly retryAfterSeconds: number | null;

  constructor(init: { retryAfterSeconds: number | null }) {
    const wait =
      init.retryAfterSeconds === null
        ? 'Wait a moment and try again.'
        : `Try again in about ${init.retryAfterSeconds} second${init.retryAfterSeconds === 1 ? '' : 's'}.`;
    super(`CRM Solid is rate limiting this API key. ${wait} ` +
      `Per-key limits are shown next to the key at ${KEY_SETTINGS_URL}.`);
    this.retryAfterSeconds = init.retryAfterSeconds;
  }
}

/** HTTP 5xx after the bridge exhausted its own retries. */
export class UpstreamServerError extends BridgeError {
  readonly status: number;

  constructor(init: { status: number; detail?: string }) {
    super(
      `CRM Solid returned a server error (HTTP ${init.status})` +
        (init.detail ? `: ${init.detail}` : '.') +
        ` This is not something your configuration can fix. Retry shortly, and check https://health.crmsolid.com if it persists.`,
    );
    this.status = init.status;
  }
}

/** Any other non-2xx response. */
export class UpstreamHttpError extends BridgeError {
  readonly status: number;
  readonly body: string | null;

  constructor(init: { status: number; statusText?: string; body?: string | null }) {
    const detail = init.body ? `: ${truncate(init.body, 300)}` : '';
    super(`CRM Solid rejected the request with HTTP ${init.status} ${init.statusText ?? ''}`.trimEnd() + detail);
    this.status = init.status;
    this.body = init.body ?? null;
  }
}

/** A JSON-RPC `error` envelope that is not one of the classified cases above. */
export class UpstreamRpcError extends BridgeError {
  readonly code: number;
  readonly data: unknown;

  constructor(init: { code: number; message: string; data?: unknown }) {
    super(`CRM Solid could not run that request: ${init.message} (code ${init.code}).`);
    this.code = init.code;
    this.data = init.data;
  }
}

/** A tool exists upstream but this bridge was started with filters that hide it. */
export class ToolNotAllowedError extends BridgeError {
  readonly toolName: string;

  constructor(init: { toolName: string; reason: string }) {
    super(`${init.reason} The tool '${init.toolName}' is not available in this session.`);
    this.toolName = init.toolName;
  }
}

/**
 * The sentence to show for any failure, including one this package did not
 * raise. The classified errors already carry their own wording; anything else
 * (a bug in the bridge, a transport fault from the MCP SDK) is reduced to a
 * single redacted line rather than a stack dump.
 */
export function describeFailure(error: unknown): string {
  if (error instanceof BridgeError) return error.message;
  if (error instanceof Error) return redact(`Unexpected failure: ${error.message}`);
  return redact(`Unexpected failure: ${String(error)}`);
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}...`;
}
