import {
  AccessError,
  AuthenticationError,
  PlanError,
  RateLimitError,
  ScopeError,
  UpstreamConnectionError,
  UpstreamHttpError,
  UpstreamProtocolError,
  UpstreamRpcError,
  UpstreamServerError,
} from '../core/errors.js';
import type { Logger } from '../core/log.js';
import { silentLogger } from '../core/log.js';
import {
  RpcErrorCode,
  type ForbiddenErrorData,
  type InitializeResult,
  type JsonRpcResponse,
} from './types.js';

/** Minimal `fetch` shape, so a proxy agent or a test double can be injected. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Streamable HTTP session correlation header (MCP spec rev 2025-06-18). */
export const SESSION_HEADER = 'Mcp-Session-Id';

/** Protocol revision this bridge negotiates upstream. Matches the backend. */
export const PROTOCOL_VERSION = '2025-06-18';

export interface UpstreamClientOptions {
  /** Absolute URL of the remote MCP endpoint, e.g. `https://api.crmsolid.com/mcp`. */
  url: string;
  /** Bearer key. Never logged: it is registered with the redactor at startup. */
  apiKey: string;
  /** Per-request timeout in milliseconds. */
  timeoutMs: number;
  /** Retry budget for idempotent calls. `0` disables retries. */
  maxRetries: number;
  initialRetryDelayMs?: number;
  maxRetryDelayMs?: number;
  userAgent: string;
  fetch?: FetchLike;
  logger?: Logger;
  /** Sleep hook. Tests replace it so a backoff assertion does not take seconds. */
  sleep?: (ms: number) => Promise<void>;
  /** Jitter source. Tests pin it to make the backoff deterministic. */
  random?: () => number;
}

export interface SendOptions {
  /**
   * Whether this call may be re-sent after a 429, a 5xx or a socket failure.
   *
   * Every list and read is idempotent. `tools/call` is NOT, and passes false:
   * a retried send is a second Instagram DM to a real person, and no backoff
   * policy is worth that. The upstream `IdempotencyKey` argument on the write
   * tools exists for callers who want at-most-once semantics explicitly.
   */
  idempotent: boolean;
  /** Human name for the thing being attempted, used in scope error messages. */
  subject?: string;
  signal?: AbortSignal;
}

/** Statuses worth another attempt when the call is idempotent. */
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

/**
 * JSON-RPC client for the remote CRM Solid MCP endpoint.
 *
 * Owns exactly three pieces of state: the bearer key, the `Mcp-Session-Id`
 * minted by `initialize`, and the initialize result. Everything else is a
 * stateless request, which is what makes the bridge safe to reconnect: if the
 * session is lost the next `initialize` mints a new one and no local state has
 * to be reconciled.
 */
export class UpstreamClient {
  private readonly options: Required<Pick<UpstreamClientOptions, 'initialRetryDelayMs' | 'maxRetryDelayMs'>> &
    UpstreamClientOptions;
  /**
   * The transport this client was built with. Public so the notification stream
   * goes through the same one: an injected proxy agent or test double has to
   * cover both channels, not only the request path.
   */
  readonly fetchImpl: FetchLike;

  private readonly logger: Logger;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  private sessionId: string | null = null;
  private initializeResult: InitializeResult | null = null;
  private nextId = 0;

  constructor(options: UpstreamClientOptions) {
    this.options = {
      initialRetryDelayMs: 500,
      maxRetryDelayMs: 8_000,
      ...options,
    };
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.logger = options.logger ?? silentLogger();
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;
  }

  /** The session id the last `initialize` minted, or null if not handshaken yet. */
  get session(): string | null {
    return this.sessionId;
  }

  /** The result of the last successful `initialize`, or null. */
  get handshake(): InitializeResult | null {
    return this.initializeResult;
  }

  get endpoint(): string {
    return this.options.url;
  }

  /**
   * Performs the upstream handshake and remembers the session.
   *
   * Also sends `notifications/initialized`, which the backend acknowledges with
   * 202. Skipping it would leave a spec-compliant peer waiting for the client
   * half of the handshake to complete.
   */
  async initialize(clientInfo: { name: string; version: string }): Promise<InitializeResult> {
    const result = await this.send<InitializeResult>(
      'initialize',
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo,
      },
      { idempotent: true, subject: 'Connecting to CRM Solid' },
    );

    this.initializeResult = result;
    this.logger.info('upstream handshake complete', {
      protocolVersion: result?.protocolVersion,
      serverInfo: result?.serverInfo,
      session: this.sessionId ? 'issued' : 'none',
    });

    // Fire and forget by design: a peer that does not care about the ack must
    // not stall the bridge's startup on it.
    await this.notify('notifications/initialized').catch((error: unknown) => {
      this.logger.debug('notifications/initialized was not acknowledged', { error: String(error) });
    });

    return result;
  }

  /** Sends one JSON-RPC request and returns its `result` member. */
  async send<T>(method: string, params: unknown, options: SendOptions): Promise<T> {
    const id = `crmsolid-${(this.nextId++).toString(36)}-${Date.now().toString(36)}`;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    const response = await this.dispatch(method, payload, options);

    // 202 with no body is the ack for a notification-shaped call.
    const text = await response.text();
    if (!text.trim()) {
      if (response.status === 202) return undefined as T;
      throw new UpstreamProtocolError(`CRM Solid returned an empty body for '${method}'.`);
    }

    let frame: JsonRpcResponse<T>;
    try {
      frame = JSON.parse(text) as JsonRpcResponse<T>;
    } catch {
      throw new UpstreamProtocolError(
        `CRM Solid returned a response for '${method}' that is not JSON. ` +
          `This usually means something between this machine and the API (a proxy, a captive portal) ` +
          `replaced the response.`,
      );
    }

    if (frame?.error) throw rpcErrorFor(frame.error, options.subject ?? `The '${method}' call`);
    return frame?.result as T;
  }

  /** Sends a JSON-RPC notification (no id, no result). Failures are non-fatal to callers. */
  async notify(method: string, params?: unknown): Promise<void> {
    const payload = JSON.stringify({ jsonrpc: '2.0', method, params });
    const response = await this.dispatch(method, payload, { idempotent: true });
    // Drain so the socket can be reused.
    await response.text().catch(() => undefined);
  }

  /**
   * Terminates the upstream session (`DELETE /mcp`).
   *
   * Best effort on purpose: this runs while the process is shutting down, and a
   * session the server never hears about simply ages out of its session table.
   */
  async terminate(): Promise<void> {
    const sessionId = this.sessionId;
    if (!sessionId) return;
    this.sessionId = null;
    try {
      const response = await this.fetchImpl(this.options.url, {
        method: 'DELETE',
        headers: this.buildHeaders({ [SESSION_HEADER]: sessionId }),
      });
      await response.text().catch(() => undefined);
      this.logger.debug('upstream session terminated', { status: response.status });
    } catch (error) {
      this.logger.debug('upstream session teardown failed', { error: String(error) });
    }
  }

  /** Headers for a request. Never merged into anything that gets logged. */
  buildHeaders(extra: Record<string, string> = {}): Headers {
    const headers = new Headers({
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${this.options.apiKey}`,
      'User-Agent': this.options.userAgent,
      'MCP-Protocol-Version': PROTOCOL_VERSION,
    });
    if (this.sessionId) headers.set(SESSION_HEADER, this.sessionId);
    for (const [key, value] of Object.entries(extra)) headers.set(key, value);
    return headers;
  }

  /**
   * POSTs one serialized frame, retrying idempotent calls on transient failure.
   *
   * The body and the id are serialized once and reused across attempts, so a
   * retry is the same request rather than a second one.
   */
  private async dispatch(method: string, payload: string, options: SendOptions): Promise<Response> {
    const maxAttempts = options.idempotent ? this.options.maxRetries + 1 : 1;

    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await this.post(payload, options.signal);
      } catch (error) {
        if (attempt + 1 < maxAttempts && !isAbort(error)) {
          const wait = this.backoff(attempt, null);
          this.logger.debug(`upstream transport failure on '${method}', retrying`, {
            attempt: attempt + 1,
            waitMs: wait,
            error: String(error),
          });
          await this.sleep(wait);
          continue;
        }
        throw connectionErrorFor(error, this.options.url, this.options.timeoutMs);
      }

      // `initialize` is the only call that mints a session, and the id arrives
      // on the response header rather than in the JSON-RPC result.
      const issued = response.headers.get(SESSION_HEADER.toLowerCase()) ?? response.headers.get(SESSION_HEADER);
      if (issued) this.sessionId = issued;

      if (response.ok || response.status === 202) return response;

      if (attempt + 1 < maxAttempts && RETRYABLE_STATUSES.has(response.status)) {
        const hinted = retryAfterMs(response.headers);
        await response.text().catch(() => undefined);
        const wait = this.backoff(attempt, hinted);
        this.logger.debug(`upstream returned ${response.status} on '${method}', retrying`, {
          attempt: attempt + 1,
          waitMs: wait,
        });
        await this.sleep(wait);
        continue;
      }

      throw await httpErrorFor(response);
    }
  }

  private async post(payload: string, callerSignal?: AbortSignal): Promise<Response> {
    const controller = new AbortController();
    const timer =
      this.options.timeoutMs > 0
        ? setTimeout(() => controller.abort(new TimeoutSignal()), this.options.timeoutMs)
        : undefined;
    const onCallerAbort = (): void => controller.abort(callerSignal?.reason);
    callerSignal?.addEventListener('abort', onCallerAbort, { once: true });

    try {
      return await this.fetchImpl(this.options.url, {
        method: 'POST',
        headers: this.buildHeaders({ 'Content-Type': 'application/json; charset=utf-8' }),
        body: payload,
        signal: controller.signal,
      });
    } finally {
      if (timer) clearTimeout(timer);
      callerSignal?.removeEventListener('abort', onCallerAbort);
    }
  }

  /**
   * Delay before the next attempt.
   *
   * A server hint (`Retry-After`, then `X-RateLimit-Reset`) wins over the
   * computed backoff, because the server knows when the window reopens. It is
   * capped at `maxRetryDelayMs` so a reset an hour out cannot hang the client,
   * and floored at `initialRetryDelayMs` so a zero or already-past hint cannot
   * turn the retry loop into an instant re-hammer.
   *
   * With no hint: exponential backoff with full jitter, which spreads out a
   * herd of clients that were all limited at the same moment.
   */
  backoff(attempt: number, hintedMs: number | null): number {
    if (hintedMs !== null) {
      const floored = Math.max(hintedMs, this.options.initialRetryDelayMs);
      return Math.min(floored, this.options.maxRetryDelayMs);
    }
    const exponential = this.options.initialRetryDelayMs * 2 ** attempt;
    const capped = Math.min(exponential, this.options.maxRetryDelayMs);
    return Math.round(capped * (0.5 + this.random() * 0.5));
  }
}

/** Marker reason for an abort this client raised itself, as opposed to the caller's. */
class TimeoutSignal extends Error {
  constructor() {
    super('timeout');
    this.name = 'CrmSolidTimeout';
  }
}

/**
 * Classifies a JSON-RPC `error` envelope.
 *
 * -32002 is the one that matters most: the backend puts the scope it wanted in
 * `data.requiredScope` and the scopes the key actually has in `data.granted`,
 * which is exactly enough to tell someone what to click.
 */
export function rpcErrorFor(error: { code: number; message: string; data?: unknown }, subject: string): Error {
  if (error.code === RpcErrorCode.Forbidden) {
    const data = (error.data ?? {}) as ForbiddenErrorData;
    const scope = data.requiredScope ?? scopeFromMessage(error.message);
    if (scope) {
      return new ScopeError({
        requiredScope: scope,
        grantedScopes: Array.isArray(data.granted) ? data.granted : [],
        subject,
      });
    }
    return new AccessError(`${subject} was refused by CRM Solid: ${error.message}`);
  }

  if (error.code === RpcErrorCode.Unauthorized) {
    return new AuthenticationError(
      `CRM Solid did not accept the API key: ${error.message}. ` +
        `Check CRMSOLID_API_KEY (or --api-key) and confirm the key is still active.`,
    );
  }

  return new UpstreamRpcError({ code: error.code, message: error.message, data: error.data });
}

/**
 * Last-resort scope extraction from the message text, for the case where a
 * future backend build stops populating `data`. The message format is
 * `Tool 'x' requires scope 'y'` (McpController).
 */
function scopeFromMessage(message: string): string | null {
  const match = /requires scope '([^']+)'/.exec(message);
  return match?.[1] ?? null;
}

/** Classifies a non-2xx HTTP response. Reads the body once, for the detail line. */
export async function httpErrorFor(response: Response): Promise<Error> {
  const body = await response.text().catch(() => '');

  if (response.status === 401) {
    return new AuthenticationError(
      `CRM Solid rejected the API key (HTTP 401). The key is missing, malformed, revoked or expired. ` +
        `Check CRMSOLID_API_KEY (or --api-key), and mint a replacement at https://app.crmsolid.com/settings/developers if needed.`,
    );
  }

  if (response.status === 402) {
    const parsed = parseJson(body);
    return new PlanError({
      featureKey: readString(parsed, ['Data', 'FeatureKey']) ?? readString(parsed, ['data', 'featureKey']),
      detail: readString(parsed, ['Error']) ?? readString(parsed, ['error']) ?? undefined,
    });
  }

  if (response.status === 403) {
    return new AccessError(
      `CRM Solid refused this API key (HTTP 403). The usual cause is the key's IP allow list: ` +
        `this machine's address is not on it. Review the key at https://app.crmsolid.com/settings/developers.`,
    );
  }

  if (response.status === 429) {
    return new RateLimitError({ retryAfterSeconds: retryAfterSeconds(response.headers) });
  }

  if (response.status >= 500) {
    return new UpstreamServerError({ status: response.status, detail: firstLine(body) ?? undefined });
  }

  if (response.status === 404) {
    return new UpstreamHttpError({
      status: 404,
      statusText: 'Not Found',
      body:
        `The MCP endpoint was not found at this base URL. Check CRMSOLID_BASE_URL (or --base-url): ` +
        `it must be the API host, for example https://api.crmsolid.com, with no /mcp suffix.`,
    });
  }

  return new UpstreamHttpError({ status: response.status, statusText: response.statusText, body: firstLine(body) });
}

/** Turns a transport-level throw into the one sentence a user can act on. */
export function connectionErrorFor(error: unknown, url: string, timeoutMs: number): Error {
  if (isTimeout(error)) {
    return new UpstreamConnectionError(
      `CRM Solid did not answer within ${timeoutMs}ms (${url}). ` +
        `The request may still have been received. Retry, or raise the timeout with --timeout.`,
    );
  }
  const detail = error instanceof Error ? error.message : String(error);
  return new UpstreamConnectionError(
    `Could not reach CRM Solid at ${url}: ${detail}. ` +
      `Check this machine's internet connection, any corporate proxy or firewall, and that CRMSOLID_BASE_URL is right.`,
    { cause: error },
  );
}

/** Seconds the server asked us to wait, from `Retry-After` then `X-RateLimit-Reset`. */
export function retryAfterSeconds(headers: Headers): number | null {
  const ms = retryAfterMs(headers);
  return ms === null ? null : Math.ceil(ms / 1000);
}

/**
 * How long to wait, in milliseconds, according to the server. `Retry-After`
 * (delta-seconds or HTTP-date) is the explicit instruction and is checked first;
 * `X-RateLimit-Reset` (unix seconds) is the fallback.
 */
export function retryAfterMs(headers: Headers): number | null {
  const retryAfter = headers.get('retry-after');
  if (retryAfter) {
    const seconds = Number.parseInt(retryAfter, 10);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }

  const reset = headers.get('x-ratelimit-reset');
  if (reset) {
    const unixSeconds = Number.parseInt(reset, 10);
    if (Number.isFinite(unixSeconds)) return Math.max(0, unixSeconds * 1000 - Date.now());
  }

  return null;
}

function isAbort(error: unknown): boolean {
  return (
    isTimeout(error) ||
    (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError'))
  );
}

function isTimeout(error: unknown): boolean {
  if (error instanceof TimeoutSignal) return true;
  if (!(error instanceof Error)) return false;
  if (error.name === 'CrmSolidTimeout' || error.name === 'TimeoutError') return true;
  const cause: unknown = (error as Error & { cause?: unknown }).cause;
  return cause instanceof TimeoutSignal || (cause instanceof Error && cause.name === 'CrmSolidTimeout');
}

function parseJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Reads a nested string property by path, tolerating a missing branch. */
function readString(value: unknown, path: string[]): string | null {
  let cursor: unknown = value;
  for (const key of path) {
    if (cursor === null || typeof cursor !== 'object') return null;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return typeof cursor === 'string' && cursor.length > 0 ? cursor : null;
}

/** First line of an error body, so a 500-line HTML proxy page does not fill the log. */
function firstLine(body: string): string | null {
  const trimmed = body.trim();
  if (!trimmed) return null;
  return trimmed.split('\n', 1)[0] ?? null;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
