#!/usr/bin/env node
/**
 * End-to-end smoke test for the built binary.
 *
 * Everything else in this repository tests modules. This one tests the artifact
 * people actually run: `node dist/cli.js`, spawned as a child process, speaking
 * newline-delimited JSON-RPC over real pipes to a real HTTP server on a real
 * socket. It is the only check that would catch a broken shebang, a bad bundle,
 * a missing dependency in `dist`, or stdout being polluted by a stray log line,
 * because none of those reproduce in-process.
 *
 * Run it with `npm run smoke`, which builds first.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'dist', 'cli.js');
const API_KEY = 'csk_test_smoke1234567890abcdefghijklmnopqrst';
const SESSION_ID = 'smoke-session-0001';

const SOCIAL_TOOLS = [
  readOnlyTool('crm_list_social_conversations'),
  readOnlyTool('crm_social_inbox_summary'),
  writeTool('crm_send_social_message'),
  readOnlyTool('crm_list_social_posts'),
  writeTool('crm_schedule_social_post'),
  readOnlyTool('crm_search_contacts'),
  writeTool('crm_create_deal'),
];

const failures = [];

function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` (${detail})`}`);
    failures.push(label);
  }
}

function readOnlyTool(name) {
  return {
    name,
    description: `${name} description`,
    inputSchema: { type: 'object', properties: {} },
    annotations: {
      title: name,
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  };
}

function writeTool(name) {
  return {
    name,
    description: `${name} description`,
    inputSchema: { type: 'object', properties: {} },
    annotations: {
      title: name,
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  };
}

/** Stands in for `POST https://api.crmsolid.com/mcp` plus its SSE channel. */
function startStubUpstream() {
  const received = [];
  const openStreams = new Set();

  const server = createServer((request, response) => {
    if (request.method === 'GET') {
      openStreams.add(response);
      response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      response.write(': connected\n\n');
      request.on('close', () => openStreams.delete(response));
      return;
    }

    if (request.method === 'DELETE') {
      received.push({ method: 'DELETE', headers: request.headers });
      response.writeHead(204).end();
      return;
    }

    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      let frame = {};
      try {
        frame = JSON.parse(body);
      } catch {
        // Leave it empty: the assertions below will notice.
      }
      received.push({ method: frame.method, headers: request.headers, body: frame });

      if (frame.method === 'initialize') {
        return respond(response, frame.id, {
          protocolVersion: '2025-06-18',
          capabilities: {
            tools: { listChanged: true },
            resources: { listChanged: true, subscribe: false },
            prompts: { listChanged: true },
            logging: {},
          },
          serverInfo: { name: 'crmsolid', title: 'CRM Solid', version: '1.0.0' },
        }, { 'Mcp-Session-Id': SESSION_ID });
      }

      if (frame.method === 'notifications/initialized') {
        return response.writeHead(202).end();
      }

      if (frame.method === 'tools/list') {
        return respond(response, frame.id, { tools: SOCIAL_TOOLS });
      }

      if (frame.method === 'resources/list') {
        return respond(response, frame.id, {
          resources: [
            {
              uri: 'crm://social/inbox',
              name: 'Social inbox',
              description: 'Unread social conversations',
              mimeType: 'application/json',
            },
          ],
        });
      }

      if (frame.method === 'prompts/list') {
        return respond(response, frame.id, {
          prompts: [{ name: 'social-inbox-triage', description: 'Triage the social inbox', arguments: [] }],
        });
      }

      if (frame.method === 'tools/call') {
        return respond(response, frame.id, {
          content: [{ type: 'text', text: `called ${frame.params?.name}` }],
          isError: false,
        });
      }

      return respond(response, frame.id, {});
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        received,
        async close() {
          for (const stream of openStreams) stream.destroy();
          server.close();
          server.closeAllConnections?.();
          await once(server, 'close').catch(() => undefined);
        },
      });
    });
  });
}

function respond(response, id, result, extraHeaders = {}) {
  const payload = JSON.stringify({ jsonrpc: '2.0', id: id ?? null, result });
  response.writeHead(200, { 'Content-Type': 'application/json', ...extraHeaders }).end(payload);
}

/** Spawns the built CLI and exposes a request/response helper over its pipes. */
function startBridge(baseUrl, args) {
  const child = spawn(process.execPath, [CLI, ...args], {
    env: { ...process.env, CRMSOLID_API_KEY: API_KEY, CRMSOLID_BASE_URL: baseUrl },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  const pending = new Map();
  const notifications = [];

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    let newline = stdout.indexOf('\n');
    while (newline >= 0) {
      const line = stdout.slice(0, newline).trim();
      stdout = stdout.slice(newline + 1);
      newline = stdout.indexOf('\n');
      if (!line) continue;

      let message;
      try {
        message = JSON.parse(line);
      } catch {
        throw new Error(`the server wrote a non-JSON line to stdout: ${line}`);
      }
      if (message.id !== undefined && message.id !== null && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      } else {
        notifications.push(message);
      }
    }
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  let nextId = 0;

  return {
    child,
    notifications,
    get stderr() {
      return stderr;
    },
    request(method, params) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for '${method}'`)), 15_000);
        pending.set(id, (message) => {
          clearTimeout(timer);
          resolve(message);
        });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    },
    notify(method, params) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
    },
    async stop() {
      child.stdin.end();
      child.kill();
      await once(child, 'exit').catch(() => undefined);
    },
  };
}

async function main() {
  if (!existsSync(CLI)) {
    console.error(`smoke: ${CLI} does not exist. Run "npm run build" first.`);
    process.exit(1);
  }

  const upstream = await startStubUpstream();
  console.log(`smoke: stub upstream on ${upstream.url}`);

  // Both filters on, so the run covers the full startup surface at once.
  const bridge = startBridge(upstream.url, ['--tools', 'social,posts', '--read-only', '--debug']);

  try {
    console.log('\nhandshake');
    const initialize = await bridge.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'smoke', version: '0.0.0' },
    });
    bridge.notify('notifications/initialized');

    check('initialize returns a result', Boolean(initialize.result), JSON.stringify(initialize));
    check('protocol revision is 2025-06-18', initialize.result?.protocolVersion === '2025-06-18');
    check('server identifies as crmsolid', initialize.result?.serverInfo?.name === 'crmsolid');
    check('server reports a version', typeof initialize.result?.serverInfo?.version === 'string');
    check('tools capability is advertised', Boolean(initialize.result?.capabilities?.tools));
    check('resources capability is advertised', Boolean(initialize.result?.capabilities?.resources));
    check('prompts capability is advertised', Boolean(initialize.result?.capabilities?.prompts));
    check(
      'the local handshake did not need the network',
      upstream.received.length === 0,
      `${upstream.received.length} upstream calls`,
    );

    console.log('\nupstream handshake');
    const tools = await bridge.request('tools/list', {});
    const upstreamInit = upstream.received.find((entry) => entry.method === 'initialize');
    check('the bridge initialized upstream', Boolean(upstreamInit));
    check('the bearer key was sent', upstreamInit?.headers?.authorization === `Bearer ${API_KEY}`);
    check(
      'the negotiated protocol revision was sent',
      upstreamInit?.body?.params?.protocolVersion === '2025-06-18',
    );
    check(
      'notifications/initialized completed the handshake',
      upstream.received.some((entry) => entry.method === 'notifications/initialized'),
    );
    check(
      'the minted session id is echoed on later calls',
      upstream.received.filter((entry) => entry.method === 'tools/list').every(
        (entry) => entry.headers['mcp-session-id'] === SESSION_ID,
      ),
    );

    console.log('\nfilters');
    const names = (tools.result?.tools ?? []).map((entry) => entry.name);
    check('read-only tools survive', names.includes('crm_list_social_conversations'));
    check('post reads survive', names.includes('crm_list_social_posts'));
    check('--read-only hides a write', !names.includes('crm_send_social_message'), names.join(','));
    check('--read-only hides a scheduling write', !names.includes('crm_schedule_social_post'));
    check('--tools hides another group', !names.includes('crm_search_contacts'), names.join(','));

    const refused = await bridge.request('tools/call', { name: 'crm_send_social_message', arguments: {} });
    check('a hidden write is refused when called anyway', refused.result?.isError === true);
    check(
      'the refusal explains itself',
      String(refused.result?.content?.[0]?.text ?? '').includes('--read-only'),
      JSON.stringify(refused.result),
    );
    check(
      'the refusal never reached the API',
      !upstream.received.some((entry) => entry.method === 'tools/call'),
    );

    const allowed = await bridge.request('tools/call', { name: 'crm_social_inbox_summary', arguments: {} });
    check('an allowed read goes through', allowed.result?.isError === false);
    check('the tool output is returned verbatim', allowed.result?.content?.[0]?.text === 'called crm_social_inbox_summary');

    console.log('\nresources and prompts');
    const resources = await bridge.request('resources/list', {});
    check('resources are mirrored', resources.result?.resources?.[0]?.uri === 'crm://social/inbox');
    const prompts = await bridge.request('prompts/list', {});
    check('prompts are mirrored', prompts.result?.prompts?.[0]?.name === 'social-inbox-triage');

    console.log('\nsecrets');
    check('the key never appears on stderr', !bridge.stderr.includes(API_KEY));
    check('debug output was produced', bridge.stderr.includes('[crmsolid-mcp]'), bridge.stderr.slice(0, 200));
  } finally {
    await bridge.stop();
    await upstream.close();
  }

  console.log('');
  if (failures.length > 0) {
    console.error(`smoke: ${failures.length} check(s) failed:`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log('smoke: all checks passed');
}

main().catch((error) => {
  console.error(`smoke: ${error?.stack ?? error}`);
  process.exit(1);
});
