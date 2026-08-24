import type { Logger } from '../core/log.js';
import { silentLogger } from '../core/log.js';
import type { FetchLike } from './client.js';
import type { JsonRpcNotification } from './types.js';

/**
 * Reader for the upstream notification channel (`GET /mcp`, Server-Sent Events).
 *
 * The backend holds this connection open and writes two kinds of line: a comment
 * heartbeat (`: ping`) every 15 seconds so proxies do not reap the socket, and
 * `data:` frames carrying server-initiated JSON-RPC notifications (progress,
 * log, list-changed). Only the second kind reaches the callback.
 *
 * The channel is strictly optional. A network that blocks long-lived responses,
 * a proxy that buffers them into uselessness, or a backend build without the
 * stream all degrade to the same thing: request and response still work, the
 * client just never receives an unsolicited notification. So every failure here
 * is logged and retried, never thrown at the caller.
 */
export interface EventStreamOptions {
  url: string;
  headers: Headers;
  fetch: FetchLike;
  logger?: Logger;
  onNotification: (notification: JsonRpcNotification) => void;
  /** Backoff floor between reconnect attempts. */
  reconnectDelayMs?: number;
  /** Backoff ceiling. */
  maxReconnectDelayMs?: number;
  /** Stop reconnecting after this many consecutive failures. `0` means never stop. */
  maxConsecutiveFailures?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface EventStream {
  /** Closes the stream and stops reconnecting. Safe to call more than once. */
  stop(): void;
  /** Resolves when the read loop has exited. */
  readonly done: Promise<void>;
}

/**
 * Opens the stream and keeps it open, reconnecting with backoff.
 *
 * Returns immediately: the loop runs in the background so the caller (the
 * bridge's startup path) is never blocked on a channel that may not exist.
 */
export function openEventStream(options: EventStreamOptions): EventStream {
  const logger = options.logger ?? silentLogger();
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const reconnectDelayMs = options.reconnectDelayMs ?? 1_000;
  const maxReconnectDelayMs = options.maxReconnectDelayMs ?? 30_000;
  const maxConsecutiveFailures = options.maxConsecutiveFailures ?? 0;

  const controller = new AbortController();
  let stopped = false;

  const done = (async () => {
    let failures = 0;
    while (!stopped) {
      try {
        await readOnce(options.url, options.headers, options.fetch, controller.signal, options.onNotification, logger);
        // A clean end of stream is normal: the server restarted, or a proxy
        // closed an idle socket. Reconnect without counting it as a failure.
        failures = 0;
        logger.debug('upstream notification stream closed, reconnecting');
      } catch (error) {
        if (stopped) break;
        failures++;
        logger.debug('upstream notification stream failed', { failures, error: String(error) });
        if (maxConsecutiveFailures > 0 && failures >= maxConsecutiveFailures) {
          logger.warn(
            'giving up on the upstream notification stream; tools and resources keep working, ' +
              'but server-initiated notifications will not arrive',
          );
          break;
        }
      }

      if (stopped) break;
      const wait = Math.min(reconnectDelayMs * 2 ** Math.min(failures, 5), maxReconnectDelayMs);
      await sleep(wait);
    }
  })();

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      controller.abort();
    },
    done,
  };
}

/** One connection: open it, parse until it ends, resolve. */
async function readOnce(
  url: string,
  headers: Headers,
  fetchImpl: FetchLike,
  signal: AbortSignal,
  onNotification: (notification: JsonRpcNotification) => void,
  logger: Logger,
): Promise<void> {
  const streamHeaders = new Headers(headers);
  streamHeaders.set('Accept', 'text/event-stream');
  streamHeaders.set('Cache-Control', 'no-cache');

  const response = await fetchImpl(url, { method: 'GET', headers: streamHeaders, signal });
  if (!response.ok) {
    await response.text().catch(() => undefined);
    throw new Error(`notification stream returned HTTP ${response.status}`);
  }
  if (!response.body) throw new Error('notification stream returned no body');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE separates events with a blank line. CRLF is tolerated because a
      // proxy in between may rewrite line endings.
      for (;;) {
        const boundary = findBoundary(buffer);
        if (boundary < 0) break;
        const raw = buffer.slice(0, boundary);
        const skip = boundaryLength(buffer, boundary);
        buffer = buffer.slice(boundary + skip);
        const frame = parseEvent(raw);
        if (frame) dispatch(frame, onNotification, logger);
      }
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
}

function findBoundary(buffer: string): number {
  const lf = buffer.indexOf('\n\n');
  const crlf = buffer.indexOf('\r\n\r\n');
  if (lf < 0) return crlf;
  if (crlf < 0) return lf;
  return Math.min(lf, crlf);
}

function boundaryLength(buffer: string, index: number): number {
  return buffer.startsWith('\r\n\r\n', index) ? 4 : 2;
}

/**
 * Extracts the `data:` payload of one SSE event.
 *
 * Comment lines (`: ping`) and any other field (`event:`, `id:`, `retry:`) are
 * dropped: the backend only uses `data`, and inventing meaning for the rest
 * would be guessing.
 */
function parseEvent(raw: string): string | null {
  const parts: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue;
    if (!line.startsWith('data:')) continue;
    parts.push(line.slice('data:'.length).trimStart());
  }
  const payload = parts.join('\n').trim();
  return payload.length > 0 ? payload : null;
}

/** Parses one payload and forwards it if it is a JSON-RPC notification. */
function dispatch(
  payload: string,
  onNotification: (notification: JsonRpcNotification) => void,
  logger: Logger,
): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    logger.debug('discarding a non-JSON frame from the notification stream');
    return;
  }

  const frame = parsed as Partial<JsonRpcNotification> & { id?: unknown };
  // A notification has a method and no id. Anything with an id is a response to
  // a request this channel never sent, so it is not ours to deliver.
  if (typeof frame?.method !== 'string' || frame.id !== undefined) {
    logger.debug('discarding a stream frame that is not a notification');
    return;
  }

  onNotification({ jsonrpc: '2.0', method: frame.method, params: frame.params });
}
