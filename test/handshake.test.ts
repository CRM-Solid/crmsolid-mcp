import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';

import { PROTOCOL_VERSION, SESSION_HEADER } from '../src/upstream/client.js';
import { VERSION } from '../src/version.js';
import {
  CRM_TOOLS,
  SOCIAL_TOOLS,
  TEST_KEY,
  connectBridge,
  initializeResponse,
  toolsRoute,
  type ConnectedBridge,
} from './helpers.js';

let session: ConnectedBridge | null = null;

afterEach(async () => {
  await session?.close();
  session = null;
});

describe('handshake', () => {
  it('serves the local initialize without touching the network', async () => {
    session = await connectBridge();

    // The local handshake already happened inside connectBridge. Nothing should
    // have gone upstream for it: a client that opens a connection and asks
    // nothing must not burn an API call, and must not fail on a bad key until
    // it actually asks for something.
    expect(session.upstream.callCount).toBe(0);

    const info = session.client.getServerVersion();
    expect(info).toMatchObject({ name: 'crmsolid', version: VERSION });
    expect(session.client.getServerCapabilities()).toMatchObject({
      tools: { listChanged: true },
      resources: { listChanged: true, subscribe: false },
      prompts: { listChanged: true },
      logging: {},
    });
  });

  it('initializes upstream once and reuses the session id', async () => {
    session = await connectBridge({
      routes: {
        initialize: initializeResponse('session-xyz'),
        'tools/list': toolsRoute(SOCIAL_TOOLS),
        'resources/list': { result: { resources: [] } },
        'prompts/list': { result: { prompts: [] } },
      },
    });

    await session.client.listTools();
    await session.client.listResources();
    await session.client.listPrompts();

    expect(session.upstream.received('initialize')).toHaveLength(1);

    const handshake = session.upstream.received('initialize')[0]!;
    expect(handshake.method).toBe('POST');
    expect(handshake.url).toBe('https://api.example.test/mcp');
    expect(handshake.headers['authorization']).toBe(`Bearer ${TEST_KEY}`);
    expect(handshake.headers['user-agent']).toContain('crmsolid-mcp/');
    expect(handshake.body).toMatchObject({
      jsonrpc: '2.0',
      method: 'initialize',
      params: { protocolVersion: PROTOCOL_VERSION },
    });
    // The bridge identifies itself, not the client it is bridging for.
    expect(handshake.body?.['params']).toMatchObject({ clientInfo: { name: 'crmsolid-mcp-bridge' } });

    // The session id is minted on the initialize response header and echoed on
    // everything after it.
    expect(handshake.headers[SESSION_HEADER.toLowerCase()]).toBeUndefined();
    for (const later of session.upstream.requests.slice(1)) {
      expect(later.headers[SESSION_HEADER.toLowerCase()]).toBe('session-xyz');
    }
  });

  it('completes the handshake with notifications/initialized', async () => {
    session = await connectBridge({ routes: { 'tools/list': toolsRoute([]) } });
    await session.client.listTools();

    expect(session.upstream.methods().slice(0, 2)).toEqual(['initialize', 'notifications/initialized']);
    const ack = session.upstream.received('notifications/initialized')[0]!;
    expect(ack.body?.['id']).toBeUndefined();
  });

  it('forwards every mirrored method to the upstream endpoint', async () => {
    session = await connectBridge({
      routes: {
        'tools/list': toolsRoute(CRM_TOOLS),
        'tools/call': { result: { content: [{ type: 'text', text: 'ok' }], isError: false } },
        'resources/list': { result: { resources: [{ uri: 'crm://social/inbox', name: 'Inbox', description: 'd', mimeType: 'application/json' }] } },
        'resources/read': { result: { contents: [{ uri: 'crm://social/inbox', mimeType: 'application/json', text: '{}' }] } },
        'prompts/list': { result: { prompts: [{ name: 'dm-reply-draft', description: 'd', arguments: [] }] } },
        'prompts/get': { result: { description: 'd', messages: [{ role: 'user', content: { type: 'text', text: 'hi' } }] } },
        ping: { result: {} },
        'logging/setLevel': { result: {} },
      },
    });

    await session.client.listTools();
    await session.client.callTool({ name: 'crm_search_contacts', arguments: { query: 'acme' } });
    await session.client.listResources();
    await session.client.readResource({ uri: 'crm://social/inbox' });
    await session.client.listPrompts();
    await session.client.getPrompt({ name: 'dm-reply-draft', arguments: { conversationId: '7' } });
    await session.client.ping();
    await session.client.setLoggingLevel('debug');

    expect(session.upstream.methods()).toEqual([
      'initialize',
      'notifications/initialized',
      'tools/list',
      'tools/call',
      'resources/list',
      'resources/read',
      'prompts/list',
      'prompts/get',
      'ping',
      'logging/setLevel',
    ]);

    expect(session.upstream.received('tools/call')[0]?.body?.['params']).toEqual({
      name: 'crm_search_contacts',
      arguments: { query: 'acme' },
    });
    expect(session.upstream.received('resources/read')[0]?.body?.['params']).toEqual({
      uri: 'crm://social/inbox',
    });
    expect(session.upstream.received('prompts/get')[0]?.body?.['params']).toEqual({
      name: 'dm-reply-draft',
      arguments: { conversationId: '7' },
    });
    expect(session.upstream.received('logging/setLevel')[0]?.body?.['params']).toEqual({ level: 'debug' });
  });

  it('still answers ping when the API is unreachable', async () => {
    // A client's ping is a transport keepalive. Failing it would make the client
    // drop a working stdio session over a transient network problem.
    session = await connectBridge(
      { fallback: { throws: new TypeError('fetch failed') } },
      { maxRetries: 0 },
    );

    await expect(session.client.ping()).resolves.toEqual({});
  });

  it('passes a progress token through to the backend', async () => {
    session = await connectBridge({
      routes: {
        'tools/list': toolsRoute(SOCIAL_TOOLS),
        'tools/call': { result: { content: [], isError: false } },
      },
    });

    // Sent as a raw request rather than through `callTool`, because the SDK
    // client mints its own token when a caller passes `onprogress` and the point
    // here is that whatever token arrives is the token forwarded.
    await session.client.request(
      {
        method: 'tools/call',
        params: { name: 'crm_social_post_stats', arguments: {}, _meta: { progressToken: 'token-1' } },
      },
      CallToolResultSchema,
    );

    expect(session.upstream.received('tools/call')[0]?.body?.['params']).toMatchObject({
      _meta: { progressToken: 'token-1' },
    });
  });

  it('omits _meta entirely when the caller did not ask for progress', async () => {
    session = await connectBridge({
      routes: {
        'tools/list': toolsRoute(SOCIAL_TOOLS),
        'tools/call': { result: { content: [], isError: false } },
      },
    });

    await session.client.callTool({ name: 'crm_social_post_stats', arguments: {} });

    const params = session.upstream.received('tools/call')[0]?.body?.['params'] as Record<string, unknown>;
    expect(params).toEqual({ name: 'crm_social_post_stats', arguments: {} });
  });

  it('leaves the payload camelCase in both directions', async () => {
    // The MCP surface is the one part of the backend that is camelCase natively:
    // every field carries an explicit [JsonPropertyName]. Renaming anything here
    // would corrupt it.
    session = await connectBridge({
      routes: {
        'tools/list': toolsRoute(SOCIAL_TOOLS),
        'tools/call': {
          result: {
            content: [{ type: 'text', text: 'Scheduled' }],
            isError: false,
            structuredContent: { postId: 42, scheduledAt: '2026-09-01T09:00:00Z' },
          },
        },
      },
    });

    const result = await session.client.callTool({
      name: 'crm_schedule_social_post',
      arguments: { content: 'hello', platforms: ['instagram'], scheduledAt: '2026-09-01T09:00:00Z' },
    });

    expect(session.upstream.received('tools/call')[0]?.body?.['params']).toMatchObject({
      arguments: { content: 'hello', platforms: ['instagram'], scheduledAt: '2026-09-01T09:00:00Z' },
    });
    expect(result.structuredContent).toEqual({ postId: 42, scheduledAt: '2026-09-01T09:00:00Z' });
  });

  it('tears the upstream session down on stop', async () => {
    const connected = await connectBridge({ routes: { 'tools/list': toolsRoute([]) } });
    session = connected;
    await connected.client.listTools();

    await connected.bridge.stop();
    const teardown = connected.upstream.requests.at(-1)!;
    expect(teardown.method).toBe('DELETE');
    expect(teardown.headers[SESSION_HEADER.toLowerCase()]).toBe('session-abc123');

    session = null;
    await connected.client.close();
  });
});
