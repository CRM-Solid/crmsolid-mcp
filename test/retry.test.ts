import { describe, expect, it } from 'vitest';

import { RateLimitError, UpstreamConnectionError, UpstreamServerError } from '../src/core/errors.js';
import { UpstreamClient, retryAfterMs, retryAfterSeconds } from '../src/upstream/client.js';
import { SOCIAL_TOOLS, TEST_KEY, connectBridge, stubUpstream, toolsRoute } from './helpers.js';

interface Waits {
  ms: number[];
}

/** A client wired to a stub, with sleeps recorded rather than slept. */
function testClient(
  stub: ReturnType<typeof stubUpstream>,
  overrides: Partial<ConstructorParameters<typeof UpstreamClient>[0]> = {},
): { client: UpstreamClient; waits: Waits } {
  const waits: Waits = { ms: [] };
  const client = new UpstreamClient({
    url: 'https://api.example.test/mcp',
    apiKey: TEST_KEY,
    timeoutMs: 5_000,
    maxRetries: 3,
    initialRetryDelayMs: 500,
    maxRetryDelayMs: 8_000,
    userAgent: 'crmsolid-mcp/test',
    fetch: stub.fetch,
    sleep: async (ms: number) => {
      waits.ms.push(ms);
    },
    // Pinned so an exponential assertion is not a coin flip. Full jitter maps
    // 0.5 onto 75 percent of the computed delay.
    random: () => 0.5,
    ...overrides,
  });
  return { client, waits };
}

describe('retry policy', () => {
  it('retries an idempotent call on 503 and succeeds', async () => {
    const stub = stubUpstream({
      routes: {
        'tools/list': [{ status: 503, raw: 'boom' }, { status: 503, raw: 'boom' }, toolsRoute(SOCIAL_TOOLS)],
      },
    });
    const { client, waits } = testClient(stub);

    const result = await client.send<{ tools: unknown[] }>('tools/list', {}, { idempotent: true });

    expect(result.tools).toHaveLength(SOCIAL_TOOLS.length);
    expect(stub.received('tools/list')).toHaveLength(3);
    expect(waits.ms).toHaveLength(2);
  });

  it('retries a transport failure on an idempotent call', async () => {
    const stub = stubUpstream({
      routes: {
        'tools/list': [{ throws: new TypeError('fetch failed') }, toolsRoute(SOCIAL_TOOLS)],
      },
    });
    const { client } = testClient(stub);

    await client.send('tools/list', {}, { idempotent: true });
    expect(stub.received('tools/list')).toHaveLength(2);
  });

  it('gives up after maxRetries and surfaces the classified error', async () => {
    const stub = stubUpstream({ routes: { 'tools/list': { status: 503, raw: 'boom' } } });
    const { client, waits } = testClient(stub, { maxRetries: 2 });

    const failure = await client.send('tools/list', {}, { idempotent: true }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(UpstreamServerError);
    expect(stub.received('tools/list')).toHaveLength(3);
    expect(waits.ms).toHaveLength(2);
  });

  it('never retries a tools/call', async () => {
    // A retried send is a second Instagram DM to a real person. No backoff
    // policy is worth that, so this one is not negotiable.
    const stub = stubUpstream({
      routes: { 'tools/call': [{ status: 503, raw: 'boom' }, { result: { content: [] } }] },
    });
    const { client, waits } = testClient(stub);

    const failure = await client
      .send('tools/call', { name: 'crm_send_social_message' }, { idempotent: false })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(UpstreamServerError);
    expect(stub.received('tools/call')).toHaveLength(1);
    expect(waits.ms).toHaveLength(0);
  });

  it('does not retry a status outside the retryable set', async () => {
    const stub = stubUpstream({ routes: { 'tools/list': { status: 400, raw: 'bad' } } });
    const { client } = testClient(stub);

    await client.send('tools/list', {}, { idempotent: true }).catch(() => undefined);
    expect(stub.received('tools/list')).toHaveLength(1);
  });

  it('honours Retry-After over its own backoff', async () => {
    const stub = stubUpstream({
      routes: {
        'tools/list': [{ status: 429, headers: { 'retry-after': '2' }, raw: '' }, toolsRoute([])],
      },
    });
    const { client, waits } = testClient(stub);

    await client.send('tools/list', {}, { idempotent: true });
    expect(waits.ms).toEqual([2_000]);
  });

  it('caps a Retry-After that would stall the process', async () => {
    const stub = stubUpstream({
      routes: {
        'tools/list': [{ status: 429, headers: { 'retry-after': '3600' }, raw: '' }, toolsRoute([])],
      },
    });
    const { client, waits } = testClient(stub);

    await client.send('tools/list', {}, { idempotent: true });
    expect(waits.ms).toEqual([8_000]);
  });

  it('floors a zero Retry-After so the loop cannot re-hammer instantly', async () => {
    const stub = stubUpstream({
      routes: { 'tools/list': [{ status: 429, headers: { 'retry-after': '0' }, raw: '' }, toolsRoute([])] },
    });
    const { client, waits } = testClient(stub);

    await client.send('tools/list', {}, { idempotent: true });
    expect(waits.ms).toEqual([500]);
  });

  it('reports 429 with the wait when the retries run out', async () => {
    const stub = stubUpstream({
      routes: { 'tools/list': { status: 429, headers: { 'retry-after': '11' }, raw: '' } },
    });
    const { client } = testClient(stub, { maxRetries: 1 });

    const failure = await client.send('tools/list', {}, { idempotent: true }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RateLimitError);
    expect((failure as RateLimitError).retryAfterSeconds).toBe(11);
  });
});

describe('backoff', () => {
  it('grows exponentially and applies jitter', () => {
    const { client } = testClient(stubUpstream());
    // 500 * 2^n, times the pinned jitter factor of 0.75.
    expect(client.backoff(0, null)).toBe(375);
    expect(client.backoff(1, null)).toBe(750);
    expect(client.backoff(2, null)).toBe(1_500);
    expect(client.backoff(3, null)).toBe(3_000);
  });

  it('caps the computed delay', () => {
    const { client } = testClient(stubUpstream());
    expect(client.backoff(10, null)).toBe(6_000);
    expect(client.backoff(20, null)).toBe(6_000);
  });

  it('spreads a herd across the window rather than aligning it', () => {
    // Full jitter: every value lands between half the computed delay and all of
    // it, so a thousand clients limited at the same instant do not return at the
    // same instant.
    const lowest = testClient(stubUpstream(), { random: () => 0 }).client;
    const highest = testClient(stubUpstream(), { random: () => 0.999999 }).client;
    expect(lowest.backoff(2, null)).toBe(1_000);
    expect(highest.backoff(2, null)).toBe(2_000);
  });
});

describe('retry-after parsing', () => {
  it('reads delta-seconds', () => {
    expect(retryAfterMs(new Headers({ 'retry-after': '5' }))).toBe(5_000);
    expect(retryAfterSeconds(new Headers({ 'retry-after': '5' }))).toBe(5);
  });

  it('reads an HTTP-date', () => {
    const future = new Date(Date.now() + 10_000).toUTCString();
    const parsed = retryAfterMs(new Headers({ 'retry-after': future }));
    expect(parsed).toBeGreaterThan(8_000);
    expect(parsed).toBeLessThanOrEqual(10_000);
  });

  it('falls back to X-RateLimit-Reset', () => {
    const reset = Math.ceil(Date.now() / 1000) + 20;
    const parsed = retryAfterMs(new Headers({ 'x-ratelimit-reset': String(reset) }));
    expect(parsed).toBeGreaterThan(18_000);
  });

  it('returns null when the server said nothing', () => {
    expect(retryAfterMs(new Headers())).toBeNull();
    expect(retryAfterSeconds(new Headers())).toBeNull();
  });

  it('never returns a negative wait for a date already in the past', () => {
    const past = new Date(Date.now() - 60_000).toUTCString();
    expect(retryAfterMs(new Headers({ 'retry-after': past }))).toBe(0);
  });
});

describe('retry through the bridge', () => {
  it('recovers a tools/list that failed twice, transparently to the client', async () => {
    const connected = await connectBridge({
      routes: {
        'tools/list': [{ status: 500, raw: 'x' }, { status: 502, raw: 'x' }, toolsRoute(SOCIAL_TOOLS)],
      },
    });

    const listed = await connected.client.listTools();
    expect(listed.tools).toHaveLength(SOCIAL_TOOLS.length);
    expect(connected.upstream.received('tools/list')).toHaveLength(3);

    await connected.close();
  });

  it('does not retry a failed tool call', async () => {
    const connected = await connectBridge({
      routes: {
        'tools/list': toolsRoute(SOCIAL_TOOLS),
        'tools/call': { status: 500, raw: 'x' },
      },
    });

    const result = await connected.client.callTool({
      name: 'crm_send_social_message',
      arguments: { conversationId: 1, text: 'hi' },
    });

    expect(result.isError).toBe(true);
    expect(connected.upstream.received('tools/call')).toHaveLength(1);

    await connected.close();
  });

  it('surfaces a transport failure that outlasts the retries', async () => {
    const connected = await connectBridge(
      { routes: { 'tools/list': { throws: new TypeError('socket hang up') } } },
      { maxRetries: 2 },
    );

    const failure = await connected.client.listTools().catch((error: unknown) => error as Error);
    expect((failure as Error).message).toContain('Could not reach CRM Solid');
    expect(connected.upstream.received('tools/list')).toHaveLength(3);

    await connected.close();
  });

  it('classifies a timeout separately from an unreachable host', async () => {
    const stub = stubUpstream({
      routes: {
        'tools/list': {
          // A fetch that never settles: the client's own timeout has to fire.
          throws: Object.assign(new Error('aborted'), { name: 'AbortError' }),
        },
      },
    });
    const { client } = testClient(stub, { maxRetries: 0 });

    const failure = await client.send('tools/list', {}, { idempotent: true }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(UpstreamConnectionError);
  });
});
