import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  PingRequestSchema,
  ReadResourceRequestSchema,
  SetLevelRequestSchema,
  type CallToolResult,
  type GetPromptResult,
  type ListPromptsResult,
  type ListResourcesResult,
  type ListToolsResult,
  type ReadResourceResult,
  type ServerCapabilities,
} from '@modelcontextprotocol/sdk/types.js';

import type { BridgeConfig } from './config.js';
import {
  AccessError,
  AuthenticationError,
  BridgeError,
  ConfigError,
  PlanError,
  RateLimitError,
  ScopeError,
  ToolNotAllowedError,
  UpstreamProtocolError,
  UpstreamRpcError,
  describeFailure,
} from './core/errors.js';
import type { Logger } from './core/log.js';
import { silentLogger } from './core/log.js';
import { registerSecret } from './core/redact.js';
import { assertToolAllowed, filterTools, type FilterOptions } from './filters.js';
import { UpstreamClient, type FetchLike } from './upstream/client.js';
import { openEventStream, type EventStream } from './upstream/sse.js';
import type {
  InitializeResult,
  JsonRpcNotification,
  PromptGetResult,
  PromptListResult,
  ResourceListResult,
  ResourceReadResult,
  ToolCallResult,
  ToolInfo,
  ToolListResult,
} from './upstream/types.js';
import { SERVER_NAME, SERVER_TITLE, VERSION } from './version.js';

/**
 * Capabilities this bridge advertises to the local client.
 *
 * They mirror `McpCapabilities` in the backend one for one, because everything
 * here is a pass-through: promising less would hide a feature the API has, and
 * promising more would advertise something the bridge cannot deliver. They have
 * to be declared before the local handshake, which is why they are a constant
 * rather than something derived from the upstream `initialize` result.
 */
const CAPABILITIES: ServerCapabilities = {
  tools: { listChanged: true },
  resources: { listChanged: true, subscribe: false },
  prompts: { listChanged: true },
  logging: {},
};

/** Shown by clients that surface server instructions to the model. */
const INSTRUCTIONS = [
  'CRM Solid manages social media direct messages and scheduled posts across Instagram, Facebook,',
  'X, LinkedIn, TikTok, YouTube, Threads, Pinterest, Reddit, Bluesky, Telegram and WhatsApp,',
  'alongside the contacts, deals, tasks and email threads of the CRM behind them.',
  '',
  'Read before you write: list conversations or posts first, then act on an id from that list.',
  'Sending a direct message and publishing a post both reach real people and cannot be undone,',
  'so confirm the recipient and the wording with the user before calling a tool that sends.',
].join('\n');

/** Notification methods the bridge relays from upstream, and what each one needs. */
const FORWARDABLE: Record<string, keyof ServerCapabilities | null> = {
  'notifications/progress': null,
  'notifications/message': 'logging',
  'notifications/tools/list_changed': 'tools',
  'notifications/resources/list_changed': 'resources',
  'notifications/resources/updated': 'resources',
  'notifications/prompts/list_changed': 'prompts',
};

export interface BridgeOptions {
  config: BridgeConfig;
  /** Injected for tests and for hosts that need a proxy agent. */
  fetch?: FetchLike;
  logger?: Logger;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * The stdio side of the server, wired to the remote side.
 *
 * Every MCP method is a pass-through with three things bolted on: the local
 * `--tools` / `--read-only` filters, the retry and session handling in
 * {@link UpstreamClient}, and error translation so a failure arrives as a
 * sentence rather than a JSON-RPC code.
 *
 * The upstream handshake is lazy on purpose. Doing it in `start()` would mean a
 * revoked key takes the process down at launch, and every MCP client renders
 * that as "server crashed" with the reason buried in a log file. Deferring it to
 * the first real request puts the explanation in the tool result, where the
 * model reads it and tells the user what to fix.
 */
export class Bridge {
  readonly server: Server;

  private readonly config: BridgeConfig;
  private readonly upstream: UpstreamClient;
  private readonly logger: Logger;
  private readonly filters: FilterOptions;

  private handshake: Promise<InitializeResult> | null = null;
  private stream: EventStream | null = null;
  private toolIndex: Map<string, ToolInfo> | null = null;
  private stopped = false;

  constructor(options: BridgeOptions) {
    this.config = options.config;
    this.logger = options.logger ?? silentLogger();
    this.filters = { groups: this.config.toolGroups, readOnly: this.config.readOnly };

    // Before anything can be logged, teach the redactor this process's key.
    registerSecret(this.config.apiKey);

    this.upstream = new UpstreamClient({
      url: this.config.endpoint,
      apiKey: this.config.apiKey,
      timeoutMs: this.config.timeoutMs,
      maxRetries: this.config.maxRetries,
      userAgent: `crmsolid-mcp/${VERSION} (+https://docs.crmsolid.com/integrations/mcp/)`,
      fetch: options.fetch,
      logger: this.logger,
      sleep: options.sleep,
    });

    this.server = new Server(
      { name: SERVER_NAME, title: SERVER_TITLE, version: VERSION },
      { capabilities: CAPABILITIES, instructions: INSTRUCTIONS },
    );

    this.registerHandlers();
  }

  /** Serves MCP over `transport` until {@link stop} is called. */
  async start(transport: Transport): Promise<void> {
    await this.server.connect(transport);
    this.logger.info('bridge listening on stdio', {
      endpoint: this.config.endpoint,
      readOnly: this.config.readOnly,
      tools: this.config.toolGroups ?? 'all',
    });
  }

  /** Closes the notification stream, drops the upstream session, closes the transport. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.stream?.stop();
    this.stream = null;
    await this.upstream.terminate();
    await this.server.close().catch((error: unknown) => {
      this.logger.debug('closing the local transport failed', { error: String(error) });
    });
  }

  private registerHandlers(): void {
    this.server.setRequestHandler(PingRequestSchema, async () => {
      // Forwarded rather than answered locally, so the upstream session stays
      // warm and a blocked network shows up in the log while the client is idle.
      //
      // The pong is unconditional even so. A client's ping is a transport
      // keepalive, and clients drop a server that fails one; letting a ten
      // second outage at the API tear down a working stdio session would trade
      // a transient problem for a session the user has to restart by hand.
      try {
        await this.ensureUpstream();
        await this.upstream.send('ping', undefined, { idempotent: true, subject: 'The connection check' });
      } catch (error) {
        this.logger.warn('the upstream connection check failed', { reason: describeFailure(error) });
      }
      return {};
    });

    this.server.setRequestHandler(SetLevelRequestSchema, async (request) => {
      // Forwarded rather than applied here. The backend filters its own log
      // notifications against the level it holds for this session, so applying
      // it locally as well would mean maintaining a second threshold that can
      // disagree with the one doing the work.
      await this.ensureUpstream();
      await this.upstream.send('logging/setLevel', { level: request.params.level }, {
        idempotent: true,
        subject: 'Changing the log level',
      });
      return {};
    });

    this.server.setRequestHandler(ListToolsRequestSchema, async (request) => {
      const result = await this.call<ToolListResult>('tools/list', cursorParams(request.params?.cursor), 'The tool list');
      const tools = result?.tools ?? [];
      this.indexTools(tools);
      const exposed = filterTools(tools, this.filters);
      this.logger.debug('tools/list', { upstream: tools.length, exposed: exposed.length });
      return { tools: exposed, nextCursor: result?.nextCursor ?? undefined } as ListToolsResult;
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const name = request.params.name;
      try {
        await this.ensureUpstream();
        const index = await this.ensureToolIndex();
        assertToolAllowed(name, index.get(name), this.filters);

        const params: Record<string, unknown> = {
          name,
          arguments: request.params.arguments ?? {},
        };
        // Pass the progress token through so the backend brackets the call with
        // notifications/progress on the event stream; the stream reader relays
        // them back to whichever client asked for them.
        const progressToken = request.params._meta?.progressToken;
        if (progressToken !== undefined) params['_meta'] = { progressToken };

        const result = await this.upstream.send<ToolCallResult>('tools/call', params, {
          // A tool call is the one method that is never retried. See SendOptions.
          idempotent: false,
          subject: `The tool '${name}'`,
        });
        return normalizeToolResult(result) as CallToolResult;
      } catch (error) {
        // A failed call comes back as a tool-level error rather than a protocol
        // error, because the model is the one that has to react to it and only
        // this path puts the explanation in front of the model.
        this.logger.warn(`tools/call '${name}' failed`, { reason: describeFailure(error) });
        return { content: [{ type: 'text', text: describeFailure(error) }], isError: true } as CallToolResult;
      }
    });

    // Resources and prompts pass through unfiltered. `--tools` names tool
    // groups, and `--read-only` describes an action a tool takes: a resource is
    // inert data and a prompt is a template, and neither can change anything.
    // The scopes on the key still gate what either one can read.
    this.server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
      const result = await this.call<ResourceListResult>(
        'resources/list',
        cursorParams(request.params?.cursor),
        'The resource list',
      );
      return {
        resources: result?.resources ?? [],
        nextCursor: result?.nextCursor ?? undefined,
      } as ListResourcesResult;
    });

    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const uri = request.params.uri;
      const result = await this.call<ResourceReadResult>('resources/read', { uri }, `The resource '${uri}'`);
      return { contents: result?.contents ?? [] } as ReadResourceResult;
    });

    this.server.setRequestHandler(ListPromptsRequestSchema, async (request) => {
      const result = await this.call<PromptListResult>(
        'prompts/list',
        cursorParams(request.params?.cursor),
        'The prompt list',
      );
      return {
        prompts: result?.prompts ?? [],
        nextCursor: result?.nextCursor ?? undefined,
      } as ListPromptsResult;
    });

    this.server.setRequestHandler(GetPromptRequestSchema, async (request) => {
      const name = request.params.name;
      const result = await this.call<PromptGetResult>(
        'prompts/get',
        { name, arguments: request.params.arguments ?? {} },
        `The prompt '${name}'`,
      );
      return {
        description: result?.description,
        messages: result?.messages ?? [],
      } as GetPromptResult;
    });
  }

  /**
   * One idempotent upstream call, with the handshake guaranteed and failures
   * translated into a JSON-RPC error the client can render.
   */
  private async call<T>(method: string, params: unknown, subject: string): Promise<T> {
    try {
      await this.ensureUpstream();
      return await this.upstream.send<T>(method, params, { idempotent: true, subject });
    } catch (error) {
      this.logger.warn(`${method} failed`, { reason: describeFailure(error) });
      throw toMcpError(error);
    }
  }

  /**
   * Handshakes upstream exactly once, then keeps the session for the life of the
   * process. A failed handshake is not memoized: a laptop that woke up with no
   * network must be able to recover without the user restarting their client.
   */
  private async ensureUpstream(): Promise<InitializeResult> {
    const existing = this.upstream.handshake;
    if (existing) return existing;

    if (!this.handshake) {
      this.handshake = this.upstream
        .initialize({ name: `${SERVER_NAME}-mcp-bridge`, version: VERSION })
        .then((result) => {
          this.openNotificationStream();
          return result;
        })
        .catch((error: unknown) => {
          this.handshake = null;
          throw error;
        });
    }
    return this.handshake;
  }

  /**
   * Subscribes to server-initiated notifications, once, after the handshake.
   *
   * Requires a session id: without one the backend's `GET /mcp` degrades to a
   * heartbeat with no frames, and holding a socket open for nothing is worse
   * than not holding it at all.
   */
  private openNotificationStream(): void {
    if (!this.config.sse || this.stream || this.stopped) return;
    if (!this.upstream.session) {
      this.logger.debug('no upstream session was issued; not opening the notification stream');
      return;
    }

    this.stream = openEventStream({
      url: this.config.endpoint,
      headers: this.upstream.buildHeaders(),
      fetch: this.upstream.fetchImpl,
      logger: this.logger,
      onNotification: (notification) => this.forward(notification),
    });
  }

  /**
   * Relays one upstream notification to the local client.
   *
   * Two gates. The client must have finished its own handshake, which is where
   * it declares itself: `getClientCapabilities()` is undefined until then, and
   * sending before that point violates the protocol. And the notification must
   * be one this bridge advertised in {@link CAPABILITIES}, because a client is
   * entitled to treat an unadvertised notification as a protocol error.
   * Progress is exempt from the second gate: it belongs to the base protocol and
   * has no capability to advertise.
   */
  private forward(notification: JsonRpcNotification): void {
    const clientCapabilities = this.server.getClientCapabilities();
    if (!clientCapabilities) {
      this.logger.debug('dropping a notification: the local client has not finished initializing', {
        method: notification.method,
      });
      return;
    }

    if (!(notification.method in FORWARDABLE)) {
      this.logger.debug('dropping an unrecognised notification', { method: notification.method });
      return;
    }

    const required = FORWARDABLE[notification.method];
    if (required && !CAPABILITIES[required]) {
      this.logger.debug('dropping a notification this server did not advertise', { method: notification.method });
      return;
    }

    // A changed tool list invalidates the read-only and group decisions cached
    // against the old one.
    if (notification.method === 'notifications/tools/list_changed') this.toolIndex = null;

    this.logger.debug('forwarding an upstream notification', { method: notification.method });
    void this.server
      .notification({ method: notification.method, params: notification.params as Record<string, unknown> })
      .catch((error: unknown) => {
        this.logger.debug('the local client rejected a notification', {
          method: notification.method,
          error: String(error),
        });
      });
  }

  /** The tool index, fetched on demand. Needed before any call can be authorized. */
  private async ensureToolIndex(): Promise<Map<string, ToolInfo>> {
    if (this.toolIndex) return this.toolIndex;
    const result = await this.upstream.send<ToolListResult>('tools/list', {}, {
      idempotent: true,
      subject: 'The tool list',
    });
    return this.indexTools(result?.tools ?? []);
  }

  private indexTools(tools: ToolInfo[]): Map<string, ToolInfo> {
    const index = new Map<string, ToolInfo>();
    for (const tool of tools) {
      if (tool?.name) index.set(tool.name, tool);
    }
    this.toolIndex = index;
    return index;
  }
}

/**
 * Chooses a JSON-RPC error code for a classified failure and keeps the message.
 *
 * Anything the user can fix by editing their configuration is `InvalidRequest`;
 * anything only CRM Solid or the network can fix is `InternalError`. Clients use
 * the code to decide whether to retry, and retrying a missing scope forever is
 * exactly the behaviour this split avoids.
 */
export function toMcpError(error: unknown): McpError {
  const message = describeFailure(error);

  if (
    error instanceof ConfigError ||
    error instanceof AuthenticationError ||
    error instanceof ScopeError ||
    error instanceof AccessError ||
    error instanceof PlanError
  ) {
    return new McpError(ErrorCode.InvalidRequest, message);
  }

  if (error instanceof ToolNotAllowedError) {
    return new McpError(ErrorCode.MethodNotFound, message);
  }

  if (error instanceof UpstreamRpcError) {
    return new McpError(error.code, message, error.data);
  }

  if (error instanceof RateLimitError || error instanceof UpstreamProtocolError || error instanceof BridgeError) {
    return new McpError(ErrorCode.InternalError, message);
  }

  return new McpError(ErrorCode.InternalError, message);
}

/**
 * Normalizes a tool result so the local client always gets a `content` array.
 * A tool may legitimately return nothing, and a missing array would fail the
 * MCP SDK's own result validation.
 */
function normalizeToolResult(result: ToolCallResult | undefined): ToolCallResult {
  if (!result) return { content: [], isError: false };
  return { ...result, content: result.content ?? [] };
}

/** `params` for a paginated list, omitting the member entirely when there is no cursor. */
function cursorParams(cursor: string | undefined): Record<string, unknown> {
  return cursor ? { cursor } : {};
}
