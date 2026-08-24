import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';

import { Bridge } from '../src/bridge.js';
import type { FetchLike } from '../src/upstream/client.js';
import { openEventStream } from '../src/upstream/sse.js';
import type { JsonRpcNotification } from '../src/upstream/types.js';
import { SOCIAL_TOOLS, initializeResponse, testConfig, toolsRoute, type StubRoutes } from './helpers.js';

/** A Response whose body is fed by the returned `push` / `end` pair. */
function streamingResponse(): { response: Response; push: (chunk: string) => void; end: () => void } {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    response: new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    push: (chunk: string) => controller.enqueue(encoder.encode(chunk)),
    end: () => controller.close(),
  };
}

/** Yields to the event loop so a queued transport message or stream chunk lands. */
function tick(times = 3): Promise<void> {
  let chain = Promise.resolve();
  for (let i = 0; i < times; i++) chain = chain.then(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  return chain;
}

describe('event stream parsing', () => {
  it('reads data frames and ignores the heartbeat comments', async () => {
    const received: JsonRpcNotification[] = [];
    const feed = streamingResponse();
    const stream = openEventStream({
      url: 'https://api.example.test/mcp',
      headers: new Headers(),
      fetch: async () => feed.response,
      onNotification: (notification) => received.push(notification),
      maxConsecutiveFailures: 1,
      sleep: async () => undefined,
    });

    feed.push(': connected\n\n');
    feed.push(': ping\n\n');
    feed.push(`data: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })}\n\n`);
    feed.push(
      `data: ${JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/progress',
        params: { progressToken: 'abc', progress: 1, total: 1 },
      })}\n\n`,
    );
    await tick();

    expect(received.map((entry) => entry.method)).toEqual([
      'notifications/tools/list_changed',
      'notifications/progress',
    ]);
    expect(received[1]?.params).toEqual({ progressToken: 'abc', progress: 1, total: 1 });

    stream.stop();
    feed.end();
  });

  it('reassembles a frame split across chunks', async () => {
    const received: JsonRpcNotification[] = [];
    const feed = streamingResponse();
    const stream = openEventStream({
      url: 'https://api.example.test/mcp',
      headers: new Headers(),
      fetch: async () => feed.response,
      onNotification: (notification) => received.push(notification),
      maxConsecutiveFailures: 1,
      sleep: async () => undefined,
    });

    feed.push('data: {"jsonrpc":"2.0","method":"notif');
    await tick(1);
    expect(received).toHaveLength(0);
    feed.push('ications/message","params":{"level":"info"}}\n\n');
    await tick();

    expect(received).toHaveLength(1);
    expect(received[0]?.method).toBe('notifications/message');

    stream.stop();
    feed.end();
  });

  it('discards a frame that is a response rather than a notification', async () => {
    const received: JsonRpcNotification[] = [];
    const feed = streamingResponse();
    const stream = openEventStream({
      url: 'https://api.example.test/mcp',
      headers: new Headers(),
      fetch: async () => feed.response,
      onNotification: (notification) => received.push(notification),
      maxConsecutiveFailures: 1,
      sleep: async () => undefined,
    });

    feed.push(`data: ${JSON.stringify({ jsonrpc: '2.0', id: 7, result: {} })}\n\n`);
    feed.push('data: not json at all\n\n');
    feed.push(`data: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message' })}\n\n`);
    await tick();

    expect(received.map((entry) => entry.method)).toEqual(['notifications/message']);

    stream.stop();
    feed.end();
  });

  it('gives up after the configured number of consecutive failures', async () => {
    let attempts = 0;
    const stream = openEventStream({
      url: 'https://api.example.test/mcp',
      headers: new Headers(),
      fetch: async () => {
        attempts++;
        return new Response('nope', { status: 500 });
      },
      onNotification: () => undefined,
      maxConsecutiveFailures: 3,
      sleep: async () => undefined,
    });

    await stream.done;
    expect(attempts).toBe(3);
  });

  it('sends the session header and asks for an event stream', async () => {
    let seen: Record<string, string> = {};
    const feed = streamingResponse();
    const headers = new Headers({ Authorization: 'Bearer x', 'Mcp-Session-Id': 'session-1' });
    const stream = openEventStream({
      url: 'https://api.example.test/mcp',
      headers,
      fetch: async (_url, init) => {
        new Headers(init.headers).forEach((value, key) => {
          seen[key.toLowerCase()] = value;
        });
        return feed.response;
      },
      onNotification: () => undefined,
      maxConsecutiveFailures: 1,
      sleep: async () => undefined,
    });

    await tick(1);
    expect(seen['accept']).toBe('text/event-stream');
    expect(seen['mcp-session-id']).toBe('session-1');

    stream.stop();
    feed.end();
  });
});

describe('forwarding to the local client', () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    await cleanup?.();
    cleanup = null;
  });

  /**
   * A bridge with the upstream stream live, driven through a raw transport so a
   * test can assert on the exact frames sent to the client. The SDK's own Client
   * routes progress notifications by token and would swallow one that has no
   * in-flight request behind it.
   */
  async function connectRaw(routes: StubRoutes = {}) {
    const feed = streamingResponse();
    const sent: JSONRPCMessage[] = [];

    const fetchImpl: FetchLike = async (_url, init) => {
      if ((init.method ?? 'GET') === 'GET') return feed.response;

      const body = typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
      const method = String(body['method'] ?? '');
      const preset = routes[method];
      const spec = Array.isArray(preset) ? preset[0] : preset;

      if (method === 'initialize') {
        const initResponse = initializeResponse('session-1');
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: body['id'], result: initResponse.result }), {
          status: 200,
          headers: { 'content-type': 'application/json', 'mcp-session-id': 'session-1' },
        });
      }
      if (method === 'notifications/initialized') return new Response('', { status: 202 });

      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body['id'], result: spec?.result ?? {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const bridge = new Bridge({ config: testConfig({ sse: true }), fetch: fetchImpl, sleep: async () => undefined });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    clientTransport.onmessage = (message) => sent.push(message);

    await bridge.start(serverTransport);
    await clientTransport.start();

    cleanup = async () => {
      feed.end();
      await bridge.stop();
      await clientTransport.close();
    };

    return { bridge, clientTransport, sent, feed };
  }

  /** Completes the local handshake the way a real client does. */
  async function localHandshake(transport: InMemoryTransport): Promise<void> {
    await transport.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '0' } },
    });
    await tick();
    await transport.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    await tick();
  }

  it('relays notifications/progress once both sides have initialized', async () => {
    const { clientTransport, sent, feed } = await connectRaw({ 'tools/list': toolsRoute(SOCIAL_TOOLS) });
    await localHandshake(clientTransport);

    // The upstream handshake, and with it the stream, only happens on the first
    // real request.
    await clientTransport.send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    await tick(5);

    feed.push(
      `data: ${JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/progress',
        params: { progressToken: 'token-9', progress: 0.5, total: 1 },
      })}\n\n`,
    );
    await tick(5);

    const forwarded = sent.filter((message) => 'method' in message && message.method === 'notifications/progress');
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]).toMatchObject({
      jsonrpc: '2.0',
      method: 'notifications/progress',
      params: { progressToken: 'token-9', progress: 0.5, total: 1 },
    });
  });

  it('relays an upstream log notification', async () => {
    const { clientTransport, sent, feed } = await connectRaw({ 'tools/list': toolsRoute([]) });
    await localHandshake(clientTransport);
    await clientTransport.send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    await tick(5);

    feed.push(
      `data: ${JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/message',
        params: { level: 'warning', logger: 'crm', data: { message: 'quota is nearly spent' } },
      })}\n\n`,
    );
    await tick(5);

    const forwarded = sent.filter((message) => 'method' in message && message.method === 'notifications/message');
    expect(forwarded).toHaveLength(1);
  });

  it('drops a notification method it never advertised', async () => {
    const { clientTransport, sent, feed } = await connectRaw({ 'tools/list': toolsRoute([]) });
    await localHandshake(clientTransport);
    await clientTransport.send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    await tick(5);

    feed.push(`data: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/something/invented' })}\n\n`);
    await tick(5);

    const forwarded = sent.filter(
      (message) => 'method' in message && String(message.method).startsWith('notifications/something'),
    );
    expect(forwarded).toHaveLength(0);
  });

  it('refetches the tool list after a list_changed notification', async () => {
    let listCalls = 0;
    const feed = streamingResponse();

    const fetchImpl: FetchLike = async (_url, init) => {
      if ((init.method ?? 'GET') === 'GET') return feed.response;
      const body = typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
      const method = String(body['method'] ?? '');

      if (method === 'initialize') {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: body['id'], result: {} }), {
          status: 200,
          headers: { 'content-type': 'application/json', 'mcp-session-id': 'session-1' },
        });
      }
      if (method === 'notifications/initialized') return new Response('', { status: 202 });
      if (method === 'tools/list') {
        listCalls++;
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: body['id'], result: { tools: SOCIAL_TOOLS } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id: body['id'], result: { content: [{ type: 'text', text: 'ok' }] } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };

    const bridge = new Bridge({ config: testConfig({ sse: true }), fetch: fetchImpl, sleep: async () => undefined });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    clientTransport.onmessage = () => undefined;
    await bridge.start(serverTransport);
    await clientTransport.start();
    cleanup = async () => {
      feed.end();
      await bridge.stop();
      await clientTransport.close();
    };

    await localHandshake(clientTransport);
    await clientTransport.send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    await tick(5);
    expect(listCalls).toBe(1);

    // A second call reuses the cached index rather than asking again.
    await clientTransport.send({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'crm_social_inbox_summary', arguments: {} },
    });
    await tick(5);
    expect(listCalls).toBe(1);

    feed.push(`data: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })}\n\n`);
    await tick(5);

    // The cached annotations are stale now, so the next call has to refetch:
    // a tool that used to be read-only may not be any more.
    await clientTransport.send({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'crm_social_inbox_summary', arguments: {} },
    });
    await tick(5);
    expect(listCalls).toBe(2);
  });
});
