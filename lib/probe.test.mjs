/**
 * Self-contained test suite for the MCP probe.
 * Run with: node lib/probe.test.mjs
 * No test framework; exits non-zero on failure and prints one line per case.
 */

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { probeServer } from './probe.js';

// A fake stdio MCP server speaking newline-delimited JSON-RPC.
// String.raw keeps the fixture's own "\n" escapes intact.
const STDIO_FIXTURE = String.raw`
let buffer = '';
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (message.method === 'initialize') {
      send({ jsonrpc: '2.0', id: message.id, result: {
        protocolVersion: '2025-06-18',
        serverInfo: { name: 'fake-stdio', version: '9.9.9' },
        capabilities: { tools: {} },
      } });
    } else if (message.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: message.id, result: { tools: [
        { name: 'alpha', description: 'Alpha tool' },
        { name: 'beta', description: 'Beta tool' },
        { name: 'gamma' },
      ] } });
    } else if (message.id !== undefined && message.id !== null) {
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });
    }
  }
});
process.stdin.resume();
`;

// A fake stdio MCP server that reads requests but never answers.
const NEVER_ANSWER_FIXTURE = String.raw`
process.stdin.resume();
setInterval(() => {}, 1000);
`;

async function startHttpServer(handler) {
  const server = createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => handler(raw, res));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: () => new Promise((resolve) => {
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

function assertShape(result, transport) {
  assert.equal(typeof result.ok, 'boolean');
  assert.equal(result.transport, transport);
  assert.equal(typeof result.durationMs, 'number');
  assert.ok(result.durationMs >= 0);
  assert.equal(typeof result.toolsCount, 'number');
  assert.ok(Array.isArray(result.tools));
  if (result.error !== undefined) {
    assert.equal(typeof result.error, 'string');
    assert.ok(!result.error.includes('\n'), 'error must be one line');
  }
}

const tmpDir = await mkdtemp(path.join(tmpdir(), 'dsh-mcp-probe-'));
const stdioFixturePath = path.join(tmpDir, 'fake-stdio.mjs');
const neverAnswerPath = path.join(tmpDir, 'never-answer.mjs');
await writeFile(stdioFixturePath, STDIO_FIXTURE, 'utf8');
await writeFile(neverAnswerPath, NEVER_ANSWER_FIXTURE, 'utf8');

const cases = [
  ['stdio success (fake server: initialize + tools/list)', async () => {
    const result = await probeServer({
      transport: 'stdio',
      serverName: 'fake-stdio',
      command: process.execPath,
      args: [stdioFixturePath],
    });
    assertShape(result, 'stdio');
    assert.equal(result.ok, true, result.error);
    assert.equal(result.error, undefined);
    assert.equal(result.protocolVersion, '2025-06-18');
    assert.deepEqual(result.serverInfo, { name: 'fake-stdio', version: '9.9.9' });
    assert.equal(result.toolsCount, 3);
    assert.equal(result.tools.length, 3);
    assert.deepEqual(result.tools.map((tool) => tool.name), ['alpha', 'beta', 'gamma']);
    assert.equal(result.tools[0].description, 'Alpha tool');
  }],

  ['http success (JSON initialize + SSE tools/list)', async () => {
    const server = await startHttpServer((raw, res) => {
      let message;
      try { message = JSON.parse(raw); } catch { res.writeHead(400); res.end(); return; }
      if (message.method === 'notifications/initialized') {
        res.writeHead(202);
        res.end();
        return;
      }
      const result = message.method === 'initialize'
        ? {
          protocolVersion: '2025-06-18',
          serverInfo: { name: 'fake-http', version: '1.2.3' },
          capabilities: { tools: {} },
        }
        : {
          tools: [
            { name: 'sse-one', description: 'First SSE tool' },
            { name: 'sse-two' },
          ],
        };
      if (message.method === 'tools/list') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n\n`);
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    });
    try {
      const result = await probeServer({
        transport: 'streamable-http',
        serverName: 'fake-http',
        url: server.url,
      });
      assertShape(result, 'streamable-http');
      assert.equal(result.ok, true, result.error);
      assert.equal(result.error, undefined);
      assert.equal(result.protocolVersion, '2025-06-18');
      assert.deepEqual(result.serverInfo, { name: 'fake-http', version: '1.2.3' });
      assert.equal(result.toolsCount, 2);
      assert.deepEqual(result.tools.map((tool) => tool.name), ['sse-one', 'sse-two']);
      assert.equal(result.tools[0].description, 'First SSE tool');
    } finally {
      await server.close();
    }
  }],

  ['stdio failure: command not found', async () => {
    const result = await probeServer({
      transport: 'stdio',
      serverName: 'missing',
      command: 'dsh-probe-definitely-not-a-real-command',
    });
    assertShape(result, 'stdio');
    assert.equal(result.ok, false);
    assert.equal(result.toolsCount, 0);
    assert.ok(result.error.includes('无法启动命令: dsh-probe-definitely-not-a-real-command'), result.error);
  }],

  ['stdio failure: server never answers (timeout)', async () => {
    const result = await probeServer(
      { transport: 'stdio', serverName: 'slow', command: process.execPath, args: [neverAnswerPath] },
      { timeoutMs: 800 },
    );
    assertShape(result, 'stdio');
    assert.equal(result.ok, false);
    assert.equal(result.toolsCount, 0);
    assert.equal(result.error, '连接超时（800ms）');
  }],

  ['http failure: 401 response', async () => {
    const server = await startHttpServer((raw, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
    });
    try {
      const result = await probeServer({
        transport: 'streamable-http',
        serverName: 'auth',
        url: server.url,
      });
      assertShape(result, 'streamable-http');
      assert.equal(result.ok, false);
      assert.equal(result.toolsCount, 0);
      assert.ok(result.error.startsWith('认证失败(HTTP 401)'), result.error);
    } finally {
      await server.close();
    }
  }],
];

let failed = 0;
for (const [name, body] of cases) {
  try {
    await body();
    console.log(`PASS  ${name}`);
  } catch (err) {
    failed += 1;
    const detail = String(err?.message ?? err).split('\n')[0];
    console.log(`FAIL  ${name}\n      ${detail}`);
  }
}

await rm(tmpDir, { recursive: true, force: true });
console.log(`${cases.length - failed}/${cases.length} cases passed`);
process.exit(failed === 0 ? 0 : 1);
