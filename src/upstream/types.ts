/**
 * Wire shapes for the remote endpoint, MCP rev 2025-06-18 over Streamable HTTP.
 *
 * These mirror `TelegramSimple/Services/Mcp/McpProtocol.cs` field for field.
 * Every property there carries an explicit `[JsonPropertyName]`, which overrides
 * the backend's PascalCase serializer policy, so this one surface is camelCase
 * natively and nothing in this package renames a JSON key.
 *
 * Optional members are typed as optional rather than required-with-default so a
 * server that omits `annotations` or `nextCursor` round-trips unchanged: the
 * bridge forwards what it received and never invents a field.
 */

/** JSON-RPC 2.0 error object. */
export interface JsonRpcErrorBody {
  code: number;
  message: string;
  data?: unknown;
}

/** JSON-RPC 2.0 response envelope. */
export interface JsonRpcResponse<T = unknown> {
  jsonrpc: string;
  id?: string | number | null;
  result?: T;
  error?: JsonRpcErrorBody;
}

/** JSON-RPC 2.0 notification: a method call with no id and no reply. */
export interface JsonRpcNotification {
  jsonrpc: string;
  method: string;
  params?: unknown;
}

/**
 * JSON-RPC error codes the backend uses. -32001 and -32002 are the MCP custom
 * range and are the two that carry actionable meaning for an end user.
 */
export const RpcErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  Unauthorized: -32001,
  Forbidden: -32002,
} as const;

export interface ServerInfo {
  name: string;
  title?: string;
  version: string;
}

export interface InitializeResult {
  /** Protocol revision the server speaks, e.g. `2025-06-18`. */
  protocolVersion: string;
  /** Advertised capability set. Kept loose so forward-compatible members survive. */
  capabilities: Record<string, unknown>;
  serverInfo: ServerInfo;
}

/** Advisory hints. The backend never enforces them; `--read-only` in this package does. */
export interface ToolAnnotations {
  title?: string;
  /** `true` when the tool does not modify state. Anything else counts as a write. */
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolInfo {
  name: string;
  description: string;
  /** JSON Schema for the tool's `arguments` object. Forwarded verbatim. */
  inputSchema: unknown;
  annotations?: ToolAnnotations;
  [key: string]: unknown;
}

export interface ToolListResult {
  tools: ToolInfo[];
  nextCursor?: string | null;
}

export interface ContentBlock {
  /** `text`, `image`, `resource`, ... Today the backend emits `text`. */
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface ToolCallResult {
  content: ContentBlock[];
  /** `true` when the tool ran but reported a failure. Not a protocol error. */
  isError?: boolean;
  structuredContent?: unknown;
  [key: string]: unknown;
}

export interface ResourceInfo {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
  [key: string]: unknown;
}

export interface ResourceListResult {
  resources: ResourceInfo[];
  nextCursor?: string | null;
}

export interface ResourceContent {
  uri: string;
  mimeType: string;
  text: string;
  [key: string]: unknown;
}

export interface ResourceReadResult {
  contents: ResourceContent[];
}

export interface PromptArgument {
  name: string;
  description?: string;
  required?: boolean;
}

export interface PromptInfo {
  name: string;
  title?: string;
  description: string;
  arguments: PromptArgument[];
  [key: string]: unknown;
}

export interface PromptListResult {
  prompts: PromptInfo[];
  nextCursor?: string | null;
}

export interface PromptMessage {
  role: string;
  content: ContentBlock;
}

export interface PromptGetResult {
  description?: string;
  messages: PromptMessage[];
}

/** Shape of the `data` member on a -32002 (Forbidden) error from the backend. */
export interface ForbiddenErrorData {
  requiredScope?: string;
  granted?: string[];
}
