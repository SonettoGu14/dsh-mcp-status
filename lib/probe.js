/**
 * Host-side MCP probe: initialize + tools/list over stdio or streamable HTTP.
 * Resolves `{ ok: false, error }` for server-side failures (never rejects),
 * is bounded by `timeoutMs`, always cleans up, and uses only node: builtins.
 */

import { spawn } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 15_000;
const PROTOCOL_VERSION = '2025-06-18';
const CLIENT_INFO = { name: 'dsh-mcp-status', version: '1.0.0' };
const INIT_PARAMS = { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO };
const MAX_TOOLS = 200;
const STDERR_TAIL_CHARS = 300;
const MAX_ERROR_CHARS = 400;
const ANSI_PATTERN = /\u001b\[[0-9;]*[A-Za-z]/g;

/** Skeleton result shared by every path (success, failure, timeout). */
function emptyResult(transport) {
  return {
    ok: false, transport, durationMs: 0, protocolVersion: undefined,
    serverInfo: undefined, tools: [], toolsCount: 0, error: undefined,
  };
}

/** Collapse any text to a single line and strip ANSI escapes. */
function oneLine(value) {
  return String(value ?? '').replace(ANSI_PATTERN, '').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

function errorText(err) {
  const text = oneLine(err?.message ?? err) || '未知错误';
  return text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS - 3)}...` : text;
}

/** Convert a JSON-RPC `error` object into an Error. */
function rpcError(method, message) {
  const text = oneLine(message.error?.message ?? '未知错误');
  const code = message.error?.code !== undefined ? ` (code ${message.error.code})` : '';
  return new Error(`${method} 失败: ${text}${code}`);
}

/** Validate a JSON-RPC response and return its `result` object. */
function requireResult(method, message) {
  if (!message || typeof message !== 'object') throw new Error(`${method} 未返回响应`);
  if (message.error) throw rpcError(method, message);
  const result = message.result;
  if (!result || typeof result !== 'object') throw new Error(`${method} 返回格式无效`);
  return result;
}

function applyInitialize(result, initResult) {
  if (typeof initResult.protocolVersion === 'string') result.protocolVersion = initResult.protocolVersion;
  const info = initResult.serverInfo;
  if (info && typeof info === 'object') {
    result.serverInfo = {};
    if (typeof info.name === 'string') result.serverInfo.name = info.name;
    if (typeof info.version === 'string') result.serverInfo.version = info.version;
  }
}

function applyTools(result, toolsResult) {
  if (!Array.isArray(toolsResult.tools)) throw new Error('tools/list 返回缺少 tools 数组');
  result.toolsCount = toolsResult.tools.length;
  result.tools = toolsResult.tools.slice(0, MAX_TOOLS).map((tool) => {
    const entry = { name: typeof tool?.name === 'string' ? tool.name : String(tool?.name ?? '') };
    if (typeof tool?.description === 'string' && tool.description) entry.description = tool.description;
    return entry;
  });
}

/** Newline-delimited JSON-RPC session over a child process. */
function createStdioSession(config, signal) {
  const command = config.command;
  const child = spawn(command, Array.isArray(config.args) ? config.args.map(String) : [], {
    cwd: typeof config.cwd === 'string' ? config.cwd : undefined,
    env: { ...process.env, ...(config.env && typeof config.env === 'object' ? config.env : {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const pending = new Map();
  let buffer = '';
  let stderrTail = '';
  let failure = null;
  let closed = false;
  let nextId = 1;

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdin?.on('error', () => {});

  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message?.id != null && pending.has(message.id)) {
        const entry = pending.get(message.id);
        pending.delete(message.id);
        entry.resolve(message);
      }
    }
  });

  child.stderr.on('data', (chunk) => { stderrTail = (stderrTail + chunk).slice(-4000); });

  const withStderr = (text) => {
    const tail = oneLine(stderrTail.slice(-STDERR_TAIL_CHARS));
    return tail ? `${text}: ${tail}` : text;
  };

  const failPending = (err) => {
    failure = err;
    for (const entry of pending.values()) entry.reject(err);
    pending.clear();
  };

  child.on('error', (err) => {
    const code = err?.code ? String(err.code) : '';
    failPending(new Error(code === 'ENOENT'
      ? `无法启动命令: ${command}`
      : withStderr(`无法启动命令: ${command}${code ? ` (${code})` : ''}`)));
  });

  child.on('exit', (code, exitSignal) => {
    if (closed) return;
    const detail = exitSignal ? `signal ${exitSignal}` : `code ${code}`;
    failPending(new Error(withStderr(`MCP 服务提前退出 (${detail})`)));
  });

  signal.addEventListener('abort', () => failPending(new Error('已取消')), { once: true });

  const send = (payload) => child.stdin.write(`${JSON.stringify(payload)}\n`);

  function request(method, params) {
    if (failure) return Promise.reject(failure);
    return new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      try { send({ jsonrpc: '2.0', id, method, params }); }
      catch (err) { pending.delete(id); reject(new Error(`写入失败: ${oneLine(err?.message ?? err)}`)); }
    });
  }

  function notify(method) {
    if (failure) return;
    try { send({ jsonrpc: '2.0', method }); } catch { /* child gone; next request reports it */ }
  }

  function close() {
    if (closed) return;
    closed = true;
    failPending(new Error('已关闭'));
    try { child.kill('SIGTERM'); } catch { /* already dead */ }
    const killTimer = setTimeout(() => {
      try {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      } catch { /* already dead */ }
    }, 500);
    killTimer.unref?.();
  }

  return { request, notify, close };
}

async function probeStdio(config, result, session) {
  applyInitialize(result, requireResult('initialize', await session.request('initialize', INIT_PARAMS)));
  session.notify('notifications/initialized');
  applyTools(result, requireResult('tools/list', await session.request('tools/list', {})));
}

/** Parse one SSE event block, returning the JSON carried by its data lines. */
function parseSseBlock(block) {
  const data = block.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
  if (!data) return null;
  try { return JSON.parse(data); } catch { return null; }
}

/** Read an SSE body until the JSON-RPC message with `expectedId` arrives. */
async function readSseMessage(response, expectedId) {
  if (!response.body) throw new Error('响应体为空');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      for (let sep = buffer.indexOf('\n\n'); sep >= 0; sep = buffer.indexOf('\n\n')) {
        const message = parseSseBlock(buffer.slice(0, sep));
        buffer = buffer.slice(sep + 2);
        if (message && message.id === expectedId) return message;
      }
    }
    const tail = parseSseBlock(buffer);
    if (tail && tail.id === expectedId) return tail;
  } finally {
    reader.cancel().catch(() => {});
  }
  throw new Error('SSE 响应未包含结果');
}

async function discardBody(response) {
  try { if (response.body) await response.body.cancel(); } catch { /* ignore */ }
}

async function probeHttp(config, result, signal) {
  if (typeof config.url !== 'string' || !config.url) throw new Error('streamable-http 配置缺少 url');
  const configured = config.headers && typeof config.headers === 'object' ? config.headers : {};
  const baseHeaders = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...configured,
  };
  let sessionId;

  async function post(payload, expectedId, method) {
    const headers = { ...baseHeaders };
    if (sessionId) headers['mcp-session-id'] = sessionId;

    let response;
    try {
      response = await fetch(config.url, { method: 'POST', headers, body: JSON.stringify(payload), signal });
    } catch (err) {
      if (signal.aborted) throw new Error('已取消');
      throw new Error(`请求失败: ${oneLine(err?.cause?.message ?? err?.message ?? err)}`);
    }
    sessionId = response.headers.get('mcp-session-id') || sessionId;

    if (response.status === 401 || response.status === 403) {
      await discardBody(response);
      throw new Error(`认证失败(HTTP ${response.status})`);
    }
    if (!response.ok) {
      const statusText = oneLine(response.statusText);
      await discardBody(response);
      throw new Error(`HTTP ${response.status}${statusText ? ` ${statusText}` : ''}`);
    }
    if (expectedId === null) {
      await discardBody(response);
      return null;
    }

    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    if (contentType.includes('text/event-stream')) return readSseMessage(response, expectedId);

    const text = await response.text();
    if (!text.trim()) throw new Error(`${method} 响应体为空`);
    try { return JSON.parse(text); } catch { throw new Error(`${method} 响应不是有效 JSON`); }
  }

  const initMessage = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: INIT_PARAMS }, 1, 'initialize');
  applyInitialize(result, requireResult('initialize', initMessage));

  await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, null, 'notifications/initialized');

  const toolsMessage = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, 2, 'tools/list');
  applyTools(result, requireResult('tools/list', toolsMessage));
}

function normalizeTimeout(value) {
  const ms = Number(value);
  return Number.isFinite(ms) && ms > 0 ? Math.floor(ms) : DEFAULT_TIMEOUT_MS;
}

/** Probe one configured MCP server; always resolves a structured result. */
export async function probeServer(config, options = {}) {
  const startedAt = Date.now();
  const timeoutMs = normalizeTimeout(options?.timeoutMs);
  const transport = config?.transport === 'streamable-http' ? 'streamable-http' : 'stdio';
  const result = emptyResult(transport);
  const controller = new AbortController();
  const cleanups = [];
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
    for (const cleanup of cleanups) cleanup();
  }, timeoutMs);
  timer.unref?.();

  try {
    if (!config || typeof config !== 'object') throw new Error('无效的 MCP 服务器配置');
    if (config.transport === 'stdio') {
      if (typeof config.command !== 'string' || !config.command) throw new Error('stdio 配置缺少 command');
      const session = createStdioSession(config, controller.signal);
      cleanups.push(() => session.close());
      await probeStdio(config, result, session);
    } else if (config.transport === 'streamable-http') {
      await probeHttp(config, result, controller.signal);
    } else {
      throw new Error(`不支持的传输类型: ${oneLine(config.transport ?? '') || '未指定'}`);
    }
    result.ok = true;
  } catch (err) {
    result.ok = false;
    result.tools = [];
    result.toolsCount = 0;
    result.error = timedOut ? `连接超时（${timeoutMs}ms）` : errorText(err);
  } finally {
    clearTimeout(timer);
    for (const cleanup of cleanups) {
      try { cleanup(); } catch { /* ignore cleanup errors */ }
    }
    result.durationMs = Date.now() - startedAt;
  }

  if (!result.ok && !result.error) result.error = '未知错误';
  return result;
}
