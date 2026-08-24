import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { Bridge } from '../src/bridge.js';
import { DEFAULT_MAX_RETRIES, DEFAULT_TIMEOUT_MS, type BridgeConfig } from '../src/config.js';
import type { FetchLike } from '../src/upstream/client.js';
import type { ToolInfo } from '../src/upstream/types.js';

export const TEST_KEY = 'csk_test_abcdef123456ABCDEF0123456789abcdef01';

/** One request the stub upstream received. */
export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  /** Parsed JSON body, or undefined when the request had none. */
  body: Record<string, unknown> | undefined;
  rawBody: string | null;
  /** JSON-RPC method from the body, or `''` for a request without one. */
  rpcMethod: string;
}

/** One scripted upstream reply. */
export interface StubResponse {
  status?: number;
  /** JSON-RPC `result` member. Wrapped in an envelope for you. */
  result?: unknown;
  /** JSON-RPC `error` member. Wrapped in an envelope for you. */
  error?: { code: number; message: string; data?: unknown };
  /** Whole response body, verbatim, bypassing the envelope. */
  raw?: string;
  headers?: Record<string, string>;
  /** Reject instead of answering, to exercise the transport-failure path. */
  throws?: Error;
}

/**
 * Replies keyed by JSON-RPC method. An array is consumed in order and its last
 * entry repeats, which is what a retry test needs: two failures then a success.
 */
export type StubRoutes = Record<string, StubResponse | StubResponse[]>;

export interface StubOptions {
  routes?: StubRoutes;
  /** Reply for a method with no route of its own. */
  fallback?: StubResponse;
}

export interface StubUpstream {
  fetch: FetchLike;
  requests: RecordedRequest[];
  /** JSON-RPC methods received, in order. */
  methods(): string[];
  /** Every request that carried this JSON-RPC method. */
  received(method: string): RecordedRequest[];
  readonly callCount: number;
}

/**
 * A `fetch` standing in for `POST https://api.crmsolid.com/mcp`.
 *
 * Routing is by JSON-RPC method rather than by call order, because the bridge
 * legitimately sends calls a test did not ask for (the handshake, the
 * `notifications/initialized` ack, a tool-index fetch), and a positional script
 * would make every test depend on that internal ordering.
 */
export function stubUpstream(options: StubOptions = {}): StubUpstream {
  const requests: RecordedRequest[] = [];
  const cursors = new Map<string, number>();

  const routes: StubRoutes = {
    initialize: initializeResponse(),
    'notifications/initialized': { status: 202, raw: '' },
    ...options.routes,
  };

  const fetchImpl: FetchLike = async (url, init) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });

    const rawBody = typeof init.body === 'string' ? init.body : null;
    const body = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : undefined;
    const rpcMethod = String(body?.['method'] ?? '');
    requests.push({ url, method: init.method ?? 'GET', headers, body, rawBody, rpcMethod });

    const spec = pick(routes[rpcMethod], rpcMethod, cursors) ?? options.fallback ?? { result: {} };
    if (spec.throws) throw spec.throws;

    const status = spec.status ?? 200;
    const payload =
      spec.raw ??
      JSON.stringify({
        jsonrpc: '2.0',
        id: body?.['id'] ?? null,
        ...(spec.error ? { error: spec.error } : { result: spec.result ?? {} }),
      });

    return new Response(payload || null, {
      status,
      headers: { 'content-type': 'application/json', ...(spec.headers ?? {}) },
    });
  };

  return {
    fetch: fetchImpl,
    requests,
    methods: () => requests.map((request) => request.rpcMethod),
    received: (method: string) => requests.filter((request) => request.rpcMethod === method),
    get callCount() {
      return requests.length;
    },
  };
}

/** Next reply for a route, advancing through an array and repeating its last entry. */
function pick(
  route: StubResponse | StubResponse[] | undefined,
  method: string,
  cursors: Map<string, number>,
): StubResponse | undefined {
  if (!route) return undefined;
  if (!Array.isArray(route)) return route;
  const at = cursors.get(method) ?? 0;
  cursors.set(method, at + 1);
  return route[Math.min(at, route.length - 1)];
}

/** A config with everything defaulted, so a test only states what it is testing. */
export function testConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    apiKey: TEST_KEY,
    baseUrl: 'https://api.example.test',
    endpoint: 'https://api.example.test/mcp',
    toolGroups: null,
    readOnly: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxRetries: DEFAULT_MAX_RETRIES,
    sse: false,
    debug: false,
    ...overrides,
  };
}

export interface ConnectedBridge {
  bridge: Bridge;
  client: Client;
  upstream: StubUpstream;
  close(): Promise<void>;
}

/**
 * A bridge connected to a real MCP `Client` over the SDK's in-memory transport,
 * with the upstream side stubbed. Driving it through the real client means the
 * tests also cover the SDK's own request and result validation, not only our
 * handlers.
 *
 * SSE is off in this fixture: the notification stream has its own tests, and a
 * background reconnect loop leaking into an unrelated assertion is noise.
 */
export async function connectBridge(
  stub: StubOptions | StubUpstream = {},
  configOverrides: Partial<BridgeConfig> = {},
): Promise<ConnectedBridge> {
  const upstream = 'fetch' in stub ? stub : stubUpstream(stub);
  const bridge = new Bridge({
    config: testConfig(configOverrides),
    fetch: upstream.fetch,
    sleep: async () => undefined,
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' }, { capabilities: {} });

  await Promise.all([bridge.start(serverTransport), client.connect(clientTransport)]);

  return {
    bridge,
    client,
    upstream,
    async close() {
      await client.close();
      await bridge.stop();
    },
  };
}

/** The upstream `initialize` reply the backend sends. */
export const INITIALIZE_RESULT = {
  protocolVersion: '2025-06-18',
  capabilities: {
    tools: { listChanged: true },
    resources: { listChanged: true, subscribe: false },
    prompts: { listChanged: true },
    logging: {},
    experimental: {},
  },
  serverInfo: { name: 'crmsolid', title: 'CRM Solid', version: '1.0.0' },
};

/** Scripts an `initialize` reply carrying a session id, as the backend does. */
export function initializeResponse(sessionId = 'session-abc123'): StubResponse {
  return { result: INITIALIZE_RESULT, headers: { 'mcp-session-id': sessionId } };
}

/** Builds a tool definition the way the backend's registry does. */
export function tool(name: string, readOnly: boolean, extra: Partial<ToolInfo> = {}): ToolInfo {
  return {
    name,
    description: `${name} description`,
    inputSchema: { type: 'object', properties: {} },
    annotations: readOnly
      ? { title: name, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
      : { title: name, readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    ...extra,
  };
}

/**
 * The 13 social and post tools the contract freezes, annotated the way the
 * contract specifies. Used wherever a test needs a realistic tool list.
 */
export const SOCIAL_TOOLS: ToolInfo[] = [
  tool('crm_list_social_accounts', true),
  tool('crm_list_social_conversations', true),
  tool('crm_get_social_conversation', true),
  tool('crm_list_social_messages', true),
  tool('crm_send_social_message', false),
  tool('crm_mark_social_conversation_read', false),
  tool('crm_social_inbox_summary', true),
  tool('crm_list_social_posts', true),
  tool('crm_get_social_post', true),
  tool('crm_schedule_social_post', false),
  tool('crm_update_social_post', false),
  tool('crm_cancel_social_post', false),
  tool('crm_social_post_stats', true),
];

/** A handful of non-social tools, so group filtering has something to exclude. */
export const CRM_TOOLS: ToolInfo[] = [
  tool('crm_search_contacts', true),
  tool('crm_create_deal', false),
  tool('crm_list_tasks', true),
  tool('crm_finance_summary', true),
];

/** Convenience: a `tools/list` route returning `tools`. */
export function toolsRoute(tools: ToolInfo[]): StubResponse {
  return { result: { tools } };
}
