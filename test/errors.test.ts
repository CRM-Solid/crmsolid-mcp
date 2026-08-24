import { afterEach, describe, expect, it } from 'vitest';

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
} from '../src/core/errors.js';
import { connectionErrorFor, httpErrorFor, rpcErrorFor } from '../src/upstream/client.js';
import { RpcErrorCode } from '../src/upstream/types.js';
import { SOCIAL_TOOLS, connectBridge, toolsRoute, type ConnectedBridge } from './helpers.js';

let session: ConnectedBridge | null = null;

afterEach(async () => {
  await session?.close();
  session = null;
});

describe('scope errors', () => {
  it('names the missing scope and what the key already has', () => {
    const error = rpcErrorFor(
      {
        code: RpcErrorCode.Forbidden,
        message: "Tool 'crm_send_social_message' requires scope 'social:write'",
        data: { requiredScope: 'social:write', granted: ['social:read', 'posts:read'] },
      },
      "The tool 'crm_send_social_message'",
    );

    expect(error).toBeInstanceOf(ScopeError);
    const scopeError = error as ScopeError;
    expect(scopeError.requiredScope).toBe('social:write');
    expect(scopeError.grantedScopes).toEqual(['social:read', 'posts:read']);
    expect(scopeError.message).toContain("needs the 'social:write' scope");
    expect(scopeError.message).toContain('social:read, posts:read');
    expect(scopeError.message).toContain('https://app.crmsolid.com/settings/developers');
    // Not a JSON-RPC dump.
    expect(scopeError.message).not.toContain('-32002');
    expect(scopeError.message).not.toContain('jsonrpc');
  });

  it('recovers the scope from the message when the data member is missing', () => {
    const error = rpcErrorFor(
      { code: RpcErrorCode.Forbidden, message: "Prompt 'weekly-content-plan' requires scope 'posts:read'" },
      'The prompt',
    );
    expect(error).toBeInstanceOf(ScopeError);
    expect((error as ScopeError).requiredScope).toBe('posts:read');
    expect((error as ScopeError).message).toContain('The key carries no matching scope.');
  });

  it('falls back to an access error when no scope can be identified', () => {
    const error = rpcErrorFor({ code: RpcErrorCode.Forbidden, message: 'Refused' }, 'The call');
    expect(error).toBeInstanceOf(AccessError);
    expect(error).not.toBeInstanceOf(ScopeError);
  });

  it('surfaces the scope through tools/call as a readable tool error', async () => {
    session = await connectBridge({
      routes: {
        'tools/list': toolsRoute(SOCIAL_TOOLS),
        'tools/call': {
          error: {
            code: RpcErrorCode.Forbidden,
            message: "Tool 'crm_send_social_message' requires scope 'social:write'",
            data: { requiredScope: 'social:write', granted: ['social:read'] },
          },
        },
      },
    });

    const result = await session.client.callTool({
      name: 'crm_send_social_message',
      arguments: { conversationId: 1, text: 'hi' },
    });

    expect(result.isError).toBe(true);
    const text = String((result.content as Array<{ text?: string }>)[0]?.text);
    expect(text).toContain("needs the 'social:write' scope");
    expect(text).toContain('Add ');
  });

  it('surfaces the scope through prompts/get as a JSON-RPC error with a readable message', async () => {
    session = await connectBridge({
      routes: {
        'prompts/get': {
          error: {
            code: RpcErrorCode.Forbidden,
            message: "Prompt 'weekly-content-plan' requires scope 'posts:read'",
            data: { requiredScope: 'posts:read', granted: [] },
          },
        },
      },
    });

    const failure = await session.client
      .getPrompt({ name: 'weekly-content-plan' })
      .catch((error: unknown) => error as Error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("needs the 'posts:read' scope");
  });
});

describe('authentication errors', () => {
  it('explains a rejected key on HTTP 401', async () => {
    const error = await httpErrorFor(new Response('', { status: 401 }));
    expect(error).toBeInstanceOf(AuthenticationError);
    expect(error.message).toContain('rejected the API key');
    expect(error.message).toContain('revoked or expired');
    expect(error.message).toContain('CRMSOLID_API_KEY');
  });

  it('explains a rejected key on JSON-RPC -32001', () => {
    const error = rpcErrorFor({ code: RpcErrorCode.Unauthorized, message: 'Invalid principal' }, 'The call');
    expect(error).toBeInstanceOf(AuthenticationError);
    expect(error.message).toContain('did not accept the API key');
    expect(error.message).toContain('Invalid principal');
  });

  it('reaches the client as a distinct message, not a status code', async () => {
    session = await connectBridge({ fallback: { status: 401, raw: '' } });

    const failure = await session.client.listTools().catch((error: unknown) => error as Error);
    expect((failure as Error).message).toContain('rejected the API key');
    expect((failure as Error).message).not.toContain('-32603');
  });
});

describe('plan errors', () => {
  it('reads the feature key out of the 402 body', async () => {
    const body = JSON.stringify({
      Success: false,
      Error: "This feature isn't included in your current plan. Upgrade to unlock it.",
      Data: { FeatureKey: 'dev_mcp_server', UpgradeRequired: true },
    });
    const error = await httpErrorFor(new Response(body, { status: 402 }));

    expect(error).toBeInstanceOf(PlanError);
    expect((error as PlanError).featureKey).toBe('dev_mcp_server');
    expect(error.message).toContain("plan does not include this (feature 'dev_mcp_server')");
    expect(error.message).toContain('https://app.crmsolid.com/billing');
  });

  it('still explains itself when the body has no feature key', async () => {
    const error = await httpErrorFor(new Response('', { status: 402 }));
    expect(error).toBeInstanceOf(PlanError);
    expect((error as PlanError).featureKey).toBeNull();
    expect(error.message).toContain('Upgrade at');
  });

  it('is distinguishable from an authentication failure at the client', async () => {
    session = await connectBridge({
      fallback: {
        status: 402,
        raw: JSON.stringify({ Success: false, Error: 'nope', Data: { FeatureKey: 'dev_mcp_server' } }),
      },
    });

    const failure = await session.client.listTools().catch((error: unknown) => error as Error);
    expect((failure as Error).message).toContain('plan does not include this');
    expect((failure as Error).message).not.toContain('API key');
  });
});

describe('network errors', () => {
  it('explains an unreachable host and names what to check', () => {
    const error = connectionErrorFor(
      new TypeError('fetch failed'),
      'https://api.crmsolid.com/mcp',
      60_000,
    );
    expect(error).toBeInstanceOf(UpstreamConnectionError);
    expect(error.message).toContain('Could not reach CRM Solid at https://api.crmsolid.com/mcp');
    expect(error.message).toContain('fetch failed');
    expect(error.message).toContain('proxy or firewall');
  });

  it('reaches the client as its own message', async () => {
    session = await connectBridge({ fallback: { throws: new TypeError('fetch failed') } }, { maxRetries: 0 });

    const failure = await session.client.listTools().catch((error: unknown) => error as Error);
    expect((failure as Error).message).toContain('Could not reach CRM Solid');
  });

  it('reports a body that is not JSON as an interception rather than a parse error', async () => {
    session = await connectBridge({ fallback: { raw: '<html>captive portal</html>' } });

    const failure = await session.client.listTools().catch((error: unknown) => error as Error);
    expect((failure as Error).message).toContain('not JSON');
    expect((failure as Error).message).toContain('proxy');
  });
});

describe('other upstream failures', () => {
  it('classifies 403 as an access problem, not a scope problem', async () => {
    const error = await httpErrorFor(new Response('', { status: 403 }));
    expect(error).toBeInstanceOf(AccessError);
    expect(error.message).toContain('IP allow list');
  });

  it('classifies 429 and repeats the wait the server asked for', async () => {
    const error = await httpErrorFor(new Response('', { status: 429, headers: { 'retry-after': '30' } }));
    expect(error).toBeInstanceOf(RateLimitError);
    expect((error as RateLimitError).retryAfterSeconds).toBe(30);
    expect(error.message).toContain('about 30 seconds');
  });

  it('classifies 5xx as a server fault nobody can configure away', async () => {
    const error = await httpErrorFor(new Response('boom', { status: 503, statusText: 'Service Unavailable' }));
    expect(error).toBeInstanceOf(UpstreamServerError);
    expect(error.message).toContain('server error (HTTP 503)');
    expect(error.message).toContain('not something your configuration can fix');
  });

  it('turns a 404 into base-url guidance', async () => {
    const error = await httpErrorFor(new Response('', { status: 404 }));
    expect(error).toBeInstanceOf(UpstreamHttpError);
    expect(error.message).toContain('CRMSOLID_BASE_URL');
    expect(error.message).toContain('no /mcp suffix');
  });

  it('keeps an unclassified JSON-RPC error readable', () => {
    const error = rpcErrorFor({ code: -32601, message: "Unknown method 'nope'" }, 'The call');
    expect(error).toBeInstanceOf(UpstreamRpcError);
    expect((error as UpstreamRpcError).code).toBe(-32601);
    expect(error.message).toContain("Unknown method 'nope'");
  });

  it('reports an empty response body as a protocol problem', async () => {
    session = await connectBridge({ routes: { 'tools/list': { status: 200, raw: '' } } });
    const failure = await session.client.listTools().catch((error: unknown) => error as Error);
    expect((failure as Error).message).toContain('empty body');
  });

  it('is exported so an embedding host can branch on the class', () => {
    expect(new UpstreamProtocolError('x')).toBeInstanceOf(Error);
    expect(new UpstreamProtocolError('x').name).toBe('UpstreamProtocolError');
  });
});
