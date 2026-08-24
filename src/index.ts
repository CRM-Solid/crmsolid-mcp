/**
 * `@crmsolid/mcp-server` as a library.
 *
 * The published artifact people actually run is the `crmsolid-mcp` binary. This
 * entry point exists for the two cases where spawning a process is the wrong
 * shape: a desktop app that hosts the bridge in-process over its own transport,
 * and a test harness that wants the pieces without stdio.
 */

export { Bridge, toMcpError, type BridgeOptions } from './bridge.js';
export {
  DEFAULT_BASE_URL,
  DEFAULT_MAX_RETRIES,
  DEFAULT_TIMEOUT_MS,
  helpText,
  normalizeBaseUrl,
  parseArgs,
  resolveConfig,
  type BridgeConfig,
  type ParsedArgs,
} from './config.js';
export {
  AccessError,
  AuthenticationError,
  BILLING_URL,
  BridgeError,
  ConfigError,
  KEY_SETTINGS_URL,
  PlanError,
  RateLimitError,
  ScopeError,
  ToolNotAllowedError,
  UpstreamConnectionError,
  UpstreamHttpError,
  UpstreamProtocolError,
  UpstreamRpcError,
  UpstreamServerError,
  describeFailure,
} from './core/errors.js';
export { createLogger, silentLogger, type Logger } from './core/log.js';
export { REDACTED, clearRegisteredSecrets, redact, redactValue, registerSecret } from './core/redact.js';
export {
  KNOWN_GROUPS,
  assertToolAllowed,
  filterTools,
  isReadOnlyTool,
  parseGroups,
  toolGroup,
  toolRejection,
  unknownGroups,
  type FilterOptions,
} from './filters.js';
export {
  PROTOCOL_VERSION,
  SESSION_HEADER,
  UpstreamClient,
  connectionErrorFor,
  httpErrorFor,
  retryAfterMs,
  retryAfterSeconds,
  rpcErrorFor,
  type FetchLike,
  type SendOptions,
  type UpstreamClientOptions,
} from './upstream/client.js';
export { openEventStream, type EventStream, type EventStreamOptions } from './upstream/sse.js';
export type * from './upstream/types.js';
export { RpcErrorCode } from './upstream/types.js';
export { SERVER_NAME, SERVER_TITLE, VERSION } from './version.js';
