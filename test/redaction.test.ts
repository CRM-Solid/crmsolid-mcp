import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuthenticationError, ScopeError, describeFailure } from '../src/core/errors.js';
import { createLogger } from '../src/core/log.js';
import { REDACTED, clearRegisteredSecrets, redact, redactValue, registerSecret } from '../src/core/redact.js';
import { httpErrorFor } from '../src/upstream/client.js';
import { SOCIAL_TOOLS, TEST_KEY, connectBridge, toolsRoute, type ConnectedBridge } from './helpers.js';

const LIVE_KEY = 'csk_live_ab12cd34ef56ZYXWVU9876543210zyxwvu98';

let session: ConnectedBridge | null = null;

beforeEach(() => {
  clearRegisteredSecrets();
});

afterEach(async () => {
  await session?.close();
  session = null;
  clearRegisteredSecrets();
});

describe('redact', () => {
  it('scrubs a key by shape, even one this process was never given', () => {
    const text = `The tool failed for key ${LIVE_KEY} on attempt 2.`;
    expect(redact(text)).toBe(`The tool failed for key ${REDACTED} on attempt 2.`);
    expect(redact(text)).not.toContain('ab12cd34ef56');
  });

  it('scrubs every environment label, not just live', () => {
    expect(redact(`a ${TEST_KEY} b`)).not.toContain('abcdef123456');
    expect(redact('csk_staging_0123456789abZZZZZZZZZZZZZZZZZZZZZZ')).toBe(REDACTED);
  });

  it('scrubs a registered literal that does not match the shape', () => {
    // A future key format, or an operator-issued token. The shape rule cannot
    // catch it, so the exact value is remembered instead.
    registerSecret('opaque-operator-token-value');
    expect(redact('using opaque-operator-token-value now')).toBe(`using ${REDACTED} now`);
  });

  it('refuses to register a value short enough to blank unrelated text', () => {
    registerSecret('abc');
    expect(redact('abc def')).toBe('abc def');
  });

  it('scrubs a bearer header value', () => {
    expect(redact('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig')).toBe(
      `Authorization: Bearer ${REDACTED}`,
    );
  });

  it('survives a secret containing regex-special characters', () => {
    registerSecret('secret$&value.with*chars');
    expect(redact('x secret$&value.with*chars y')).toBe(`x ${REDACTED} y`);
  });

  it('walks objects and blanks credential-bearing keys whole', () => {
    const scrubbed = redactValue({
      url: `https://api.crmsolid.com/mcp?token=${LIVE_KEY}`,
      headers: { Authorization: `Bearer ${LIVE_KEY}`, 'user-agent': 'crmsolid-mcp/0.1.0' },
      nested: [{ apiKey: LIVE_KEY }, `plain ${LIVE_KEY}`],
    });

    expect(JSON.stringify(scrubbed)).not.toContain('ab12cd34ef56');
    expect(scrubbed).toEqual({
      url: `https://api.crmsolid.com/mcp?token=${REDACTED}`,
      headers: { Authorization: REDACTED, 'user-agent': 'crmsolid-mcp/0.1.0' },
      nested: [{ apiKey: REDACTED }, `plain ${REDACTED}`],
    });
  });
});

describe('errors never carry the key', () => {
  it('redacts at construction, so no call site can forget', () => {
    registerSecret(LIVE_KEY);
    const error = new AuthenticationError(`Key ${LIVE_KEY} was rejected`);
    expect(error.message).toBe(`Key ${REDACTED} was rejected`);
  });

  it('redacts an upstream body that echoed the key back', async () => {
    const body = JSON.stringify({ Success: false, Error: `Unknown API key ${LIVE_KEY}` });
    const error = await httpErrorFor(new Response(body, { status: 400, statusText: 'Bad Request' }));
    expect(error.message).not.toContain('ab12cd34ef56');
    expect(error.message).toContain(REDACTED);
  });

  it('redacts in describeFailure, including for foreign errors', () => {
    expect(describeFailure(new Error(`boom ${LIVE_KEY}`))).toBe(`Unexpected failure: boom ${REDACTED}`);
    expect(describeFailure(`raw string ${LIVE_KEY}`)).toContain(REDACTED);
  });

  it('leaves a scope error fully readable while redacting the key', () => {
    const error = new ScopeError({
      requiredScope: 'social:write',
      grantedScopes: ['social:read'],
      subject: `The tool called with ${LIVE_KEY}`,
    });
    expect(error.message).toContain("needs the 'social:write' scope");
    expect(error.message).not.toContain('ab12cd34ef56');
  });
});

describe('logging never carries the key', () => {
  it('scrubs the message and the detail payload', () => {
    const lines: string[] = [];
    registerSecret(LIVE_KEY);
    const logger = createLogger(true, (line) => lines.push(line));

    logger.debug(`sending with ${LIVE_KEY}`, { headers: { authorization: `Bearer ${LIVE_KEY}` } });
    logger.error('failed', { key: LIVE_KEY });

    expect(lines.join('\n')).not.toContain('ab12cd34ef56');
    expect(lines[0]).toContain(REDACTED);
    expect(lines[1]).toContain(REDACTED);
  });

  it('keeps debug lines out of the log unless debug is on', () => {
    const lines: string[] = [];
    const logger = createLogger(false, (line) => lines.push(line));
    logger.debug('quiet');
    logger.info('quiet');
    logger.warn('loud');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('loud');
  });

  it('does not throw on a circular detail object', () => {
    const lines: string[] = [];
    const logger = createLogger(true, (line) => lines.push(line));
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    expect(() => logger.debug('circular', circular)).not.toThrow();
    expect(lines).toHaveLength(1);
  });
});

describe('the key never reaches the client', () => {
  it('keeps it out of a tool error the model will read', async () => {
    session = await connectBridge(
      {
        routes: {
          'tools/list': toolsRoute(SOCIAL_TOOLS),
          'tools/call': {
            error: { code: -32603, message: `Internal error while using ${LIVE_KEY}` },
          },
        },
      },
      { apiKey: LIVE_KEY },
    );

    const result = await session.client.callTool({ name: 'crm_social_inbox_summary', arguments: {} });
    const text = JSON.stringify(result);

    expect(result.isError).toBe(true);
    expect(text).not.toContain('ab12cd34ef56');
    expect(text).toContain(REDACTED);
  });

  it('keeps it out of a protocol error on a list call', async () => {
    session = await connectBridge(
      { routes: { 'tools/list': { status: 400, raw: JSON.stringify({ Error: `bad key ${LIVE_KEY}` }) } } },
      { apiKey: LIVE_KEY },
    );

    const failure = await session.client.listTools().catch((error: unknown) => error as Error);
    expect((failure as Error).message).not.toContain('ab12cd34ef56');
  });

  it('still sends the real key upstream', async () => {
    // Redaction is a display concern. The wire has to carry the real value or
    // nothing works.
    session = await connectBridge({ routes: { 'tools/list': toolsRoute([]) } }, { apiKey: LIVE_KEY });
    await session.client.listTools();
    expect(session.upstream.requests[0]?.headers['authorization']).toBe(`Bearer ${LIVE_KEY}`);
  });
});
