/**
 * Secret scrubbing. Everything this process writes to stderr, and every message
 * that reaches an error class, goes through here first.
 *
 * The bridge runs inside a desktop MCP client, so its stderr is captured into a
 * log file the user is likely to paste into a support ticket. A key that leaks
 * once into that file is a key that has to be rotated, and the person pasting it
 * will not notice. Two layers, because either one alone has a hole:
 *
 *   1. A shape rule that catches anything that looks like a CRM Solid key, even
 *      one this process was never given (a key pasted into a tool argument, a
 *      key echoed back inside an upstream error body).
 *   2. An exact-value rule for the key this process IS holding, which covers a
 *      key that does not match the shape (a future format, an operator-issued
 *      token) at the cost of remembering the literal.
 */

/** `csk_live_<12 char id><32 char secret>`, plus any future env label or length. */
const KEY_PATTERN = /csk_[A-Za-z0-9]{1,16}_[A-Za-z0-9]{8,}/g;

/** `Authorization: Bearer <anything>`, in a header dump or a serialized request. */
const BEARER_PATTERN = /(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi;

/** Placeholder written in place of a secret. Deliberately obvious in a log. */
export const REDACTED = '[redacted]';

/**
 * Exact secret values registered at startup. A Set rather than one value so a
 * host embedding the bridge can run more than one workspace in one process.
 */
const registered = new Set<string>();

/**
 * Remember a literal secret so {@link redact} scrubs it even when it does not
 * match the key shape. Short values are ignored: registering something like
 * `abc` would blank out unrelated text.
 */
export function registerSecret(secret: string | null | undefined): void {
  if (typeof secret !== 'string') return;
  const trimmed = secret.trim();
  if (trimmed.length < 8) return;
  registered.add(trimmed);
}

/** Drops every registered literal. Test-only: production registers once and never clears. */
export function clearRegisteredSecrets(): void {
  registered.clear();
}

/** Replaces every known and every key-shaped secret in `input` with {@link REDACTED}. */
export function redact(input: string): string {
  if (!input) return input;
  let out = input;
  for (const secret of registered) {
    if (secret && out.includes(secret)) out = splitJoin(out, secret, REDACTED);
  }
  out = out.replace(KEY_PATTERN, REDACTED);
  out = out.replace(BEARER_PATTERN, (_match, prefix: string) => `${prefix}${REDACTED}`);
  return out;
}

/**
 * Redacts anything, not just strings. Objects and arrays are walked so a
 * serialized request body or a header map can be logged safely. Header keys
 * that carry credentials are blanked whole, because a truncated Authorization
 * value is still a value.
 */
export function redactValue(value: unknown): unknown {
  if (typeof value === 'string') return redact(value);
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(redactValue);

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEYS.has(key.toLowerCase()) ? REDACTED : redactValue(item);
  }
  return out;
}

/** Object keys whose value is a credential regardless of its shape. */
const SECRET_KEYS = new Set(['authorization', 'apikey', 'api_key', 'x-api-key', 'token', 'secret']);

/**
 * `String.replaceAll` with no regex compilation and no `$&` expansion, so a
 * secret containing `$` cannot corrupt the replacement.
 */
function splitJoin(haystack: string, needle: string, replacement: string): string {
  return haystack.split(needle).join(replacement);
}
