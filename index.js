/**
 * dsh-mcp-status — 宿主半体。
 *
 * 只做三件事，其它都交给已有的组件：
 *   1. 列出**当前真正加载的** MCP 服务器：遍历 loader 里所有
 *      `@deepseek-ai/dsh-mcp-client` 行（无论它来自 profile 补丁、home 补丁还是某个
 *      插件包插入的），所以「有哪些 server」的答案与宿主实际运行的东西一致。
 *   2. 读存活状态：loader fiber 的 state 决定「已停用 / 加载失败 / 连接中 / 已注册」，
 *      工具注册表里 `mcp__<server>__*` 的条数决定「真的连上了没有」——mcp-client 在连不上时
 *      不会抛错（`failOnStartupError` 默认 false），fiber 照样 active，只有工具面是空的。
 *   3. 提供三条同源 HTTP 路由给浏览器半体：读快照、开关、连接测试。
 *
 * 开关的持久化方式与 @hyzyn/dsh-mcp 一致：只改补丁文件里那一行的 `disabled`（行级文本编辑，
 * 不动文件其余部分），随后由 DSH 的补丁监听热重载该行——重载即重新连接，这就是「切开关自动
 * 重连」。监听没生效时退回到 `hmr.reconcileProfile([id])` 主动重排。
 *
 * @module dsh-mcp-status
 */

import { constants as fsConstants } from 'node:fs';
import { access, readFile, rename, stat, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { probeServer } from './lib/probe.js';

/** 浏览器半体与宿主共用的包名（客户端模块 id 与 locale 命名空间）。 */
const PLUGIN_ID = 'dsh-mcp-status';
/** 承载一台 MCP 服务器的那一行插件。 */
const MCP_CLIENT_NAME = '@deepseek-ai/dsh-mcp-client';
/** cordis FiberState：2 = 运行中，3 = 失败。 */
const FIBER_ACTIVE = 2;
const FIBER_FAILED = 3;
/**
 * 开关后的等待上限（毫秒）。只等「热重载 + 一次连接」：mcp-client 自己还有
 * `reconnect` 策略在后台退避重连，面板不必替它把 10 次重试都等完——等超时就把
 * 「还在连接中」交回给界面，下一次轮询会自然刷新。
 */
const SETTLE_TIMEOUT_MS = 8000;
/** 等待超时后主动重排的轮数（每轮仍受 SETTLE_TIMEOUT_MS 约束）。 */
const RETRY_ROUNDS = 1;
const ROUTE_BASE = '/api/dsh-mcp-status';
/** TCP 探活的缓存时长：轮询 4 s 一次，2 s 内复用同一个结果，避免 300 ms 档的等待期把它打成风暴。 */
const REACHABILITY_TTL_MS = 2000;
/** 「测试连接」结果的保质期：过期后回落到工具注册表推断，免得一次旧失败永久污名化一行。 */
const PROBE_TTL_MS = 10 * 60 * 1000;
/** 测试失败后，徽标跟着这条错误走的窗口：端口通着时也以它为优先（用户刚点过，界面必须一致）。 */
const PROBE_ASSERT_MS = 60 * 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ *
 * 补丁文件：定位 + 行级编辑 disabled
 * ------------------------------------------------------------------ */

/** 可能持有 mcp-client 行的补丁文件，后应用的层优先。 */
function candidatePatchFiles(ctx) {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  const profile = ctx.get('profileContext');
  const profilePatch = profile?.patchPath
    ?? (process.env.DSH_PROFILE ? join(home, 'profiles', process.env.DSH_PROFILE, 'cordis.patch.yml') : undefined);
  const files = [];
  if (profilePatch) files.push({ path: profilePatch, layer: 'profile' });
  files.push({ path: join(home, 'cordis.patch.yml'), layer: 'home' });
  return files;
}

/**
 * 在 YAML 行数组里找到 `- id: <id>` 那一块（含后续缩进更深的行）。
 * 只做缩进判定，不解析 YAML：注释、`!!js` 表达式与其它行的排版都原样保留。
 */
function findRowBlock(lines, id) {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rowRe = new RegExp(`^(\\s*)-\\s*id:\\s*['"]?${escaped}['"]?\\s*$`);
  for (let index = 0; index < lines.length; index += 1) {
    const match = rowRe.exec(lines[index]);
    if (match === null) continue;
    const dashIndent = match[1].length;
    let end = index + 1;
    let disabledIndex;
    while (end < lines.length) {
      const line = lines[end];
      if (line.trim() === '') {
        end += 1;
        continue;
      }
      const indent = line.length - line.trimStart().length;
      if (indent <= dashIndent) break;
      if (disabledIndex === undefined && /^\s*disabled\s*:/.test(line) && indent >= dashIndent + 1) {
        disabledIndex = end;
      }
      end += 1;
    }
    return { start: index, end, keyIndent: dashIndent + 2, disabledIndex };
  }
  return undefined;
}

/** 原子写：同目录临时文件 + rename，保留原文件权限位。 */
async function writeAtomic(file, content) {
  let mode;
  try {
    mode = (await stat(file)).mode;
  } catch {
    mode = undefined;
  }
  const temporary = `${file}.dsh-mcp-status.tmp`;
  await writeFile(temporary, content, mode === undefined ? undefined : { mode });
  await rename(temporary, file);
}

/**
 * 把补丁文件里某一行设为 `disabled: true/false`。
 * @returns 文件里确实有这一行时返回 true（目标状态已存在也算成功）。
 */
async function setRowDisabled(file, id, disabled) {
  const text = await readFile(file, 'utf8');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const block = findRowBlock(lines, id);
  if (block === undefined) return false;
  const pad = ' '.repeat(block.keyIndent);
  if (disabled) {
    if (block.disabledIndex === undefined) lines.splice(block.start + 1, 0, `${pad}disabled: true`);
    else lines[block.disabledIndex] = `${pad}disabled: true`;
  } else if (block.disabledIndex !== undefined) {
    lines.splice(block.disabledIndex, 1);
  } else {
    return true;
  }
  await writeAtomic(file, lines.join(eol));
  return true;
}

/* ------------------------------------------------------------------ *
 * 快照：行 + 存活状态 + 工具数
 * ------------------------------------------------------------------ */

function configOf(entry) {
  // fiber.config 是解析后的配置（!!js 表达式已求值）；options.config 是原始形态。
  const resolved = entry.fiber?.config;
  if (resolved !== undefined && resolved !== null) return resolved;
  return entry.options.config ?? {};
}

function summarize(config) {
  if (config.transport === 'stdio') {
    const args = Array.isArray(config.args) ? config.args.map(String) : [];
    return {
      transport: 'stdio',
      target: [config.command, ...args].filter((part) => part !== undefined && part !== '').join(' '),
      detail: {
        command: config.command ?? null,
        args,
        cwd: config.cwd || null,
        envKeys: Object.keys(config.env ?? {}),
      },
    };
  }
  if (config.transport === 'streamable-http') {
    return {
      transport: 'streamable-http',
      target: String(config.url ?? ''),
      detail: { url: config.url ?? null, headerKeys: Object.keys(config.headers ?? {}) },
    };
  }
  return { transport: null, target: '', detail: {} };
}

/** 每个 serverName 当前注册了几个 `mcp__<server>__*` 工具；读不到注册表时返回 undefined。 */
function toolCounts(ctx, serverNames) {
  const tools = ctx.get('tools');
  if (tools === undefined || typeof tools.schemas !== 'function') return undefined;
  let schemas;
  try {
    schemas = tools.schemas();
  } catch {
    return undefined;
  }
  if (!Array.isArray(schemas)) return undefined;
  const names = schemas
    .map((schema) => (typeof schema?.name === 'string' ? schema.name : ''))
    .filter((name) => name.startsWith('mcp__'));
  const counts = new Map();
  for (const serverName of serverNames) {
    const prefix = `mcp__${serverName}__`;
    counts.set(serverName, names.reduce((total, name) => (name.startsWith(prefix) ? total + 1 : total), 0));
  }
  return counts;
}

/**
 * 存活判据（顺序即优先级）：
 *   1. 行被停用 → disabled（不连接、不占工具表）
 *   2. loader fiber 失败 → failed
 *   3. fiber 还没起来 → connecting
 *   4. 最近一次「测试连接」失败 → unreachable（用户刚点过，界面必须与那条错误一致）
 *   5. streamable-http 的端口连不上 → unreachable
 *   6. 工具注册表里有 `mcp__<server>__*` → connected
 *   7. 没有工具 → idle（客户端加载了但没连上）
 *
 * 为什么第 5 条必须存在：`toolCount > 0` 只证明「这个进程曾经连接成功并注册过工具」。
 * 服务器后来死掉时 mcp-client 不会注销这些工具，于是 fiber 仍 active、工具仍在注册表里——
 * 只按工具数判就会出现「端口已经 ECONNREFUSED，面板还是绿的」（实测踩过：unityMCP 49 个残留工具）。
 * stdio 没有可连的端口，只能靠用户点「测试连接」留下的第 4 条判据。
 */
function stateOf(entry, count, { reachable, probe } = {}) {
  if (entry.disabled) return 'disabled';
  const state = entry.fiber?.state;
  if (state === FIBER_FAILED) return 'failed';
  if (state !== FIBER_ACTIVE) return 'connecting';
  if (probe !== undefined && probe.ok === false) return 'unreachable';
  if (reachable === false) return 'unreachable';
  if (probe !== undefined && probe.ok === true) return 'connected';
  if (count === undefined) return 'connected';
  return count > 0 ? 'connected' : 'idle';
}

/* ------------------------------------------------------------------ *
 * 存活旁证：HTTP 端口探活 + 「测试连接」结果
 * ------------------------------------------------------------------ */

/** {@link reachableOf} 的结果缓存，key 是 `host:port`。 */
const reachCache = new Map();

/** TCP 连一下 host:port：连上即可达，refused/timeout 即不可达。 */
function tcpReachable(host, port, timeoutMs = 700) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

/** 只对 streamable-http 有意义：解析 url 取 host/port 再探活；url 不合法返回 null（不下结论）。 */
async function reachableOf(url) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    return null;
  }
  const host = parsed.hostname.startsWith('[') ? parsed.hostname.slice(1, -1) : parsed.hostname;
  const port = parsed.port === ''
    ? (parsed.protocol === 'https:' ? 443 : 80)
    : Number(parsed.port);
  if (host === '' || !Number.isFinite(port) || port <= 0) return null;
  const key = `${host}:${port}`;
  const now = Date.now();
  const cached = reachCache.get(key);
  if (cached !== undefined && now - cached.at < REACHABILITY_TTL_MS) return cached.value;
  const value = await tcpReachable(host, port);
  reachCache.set(key, { value, at: Date.now() });
  return value;
}

/** 每个行的「测试连接」结果，/test 写入，toggle/retry 清掉。 */
const probeResults = new Map();

function storedProbe(id) {
  const hit = probeResults.get(id);
  if (hit === undefined) return undefined;
  if (Date.now() - hit.at > PROBE_TTL_MS) {
    probeResults.delete(id);
    return undefined;
  }
  return hit;
}

/**
 * 决定「这次的测试结论还作数吗」。
 *
 * - 测试成功 → 直接算数（连接是可直接验证的正面证据）。
 * - 测试失败 + 端口也不通 → 算数（两条证据一致）。
 * - 测试失败 + 端口通着 → 只在刚测完 {@link PROBE_ASSERT_MS} 内算数：用户刚点过，
 *   徽标必须与那条错误一致；过了这个窗口就让每次轮询的 TCP 结果说话，否则服务器恢复后
 *   徽标会一直红着等用户再点一次。
 * - stdio 没有端口证据（reach 为 null），失败结论按 {@link PROBE_TTL_MS} 保留。
 */
function probeVerdict(probe, reach) {
  if (probe === undefined) return undefined;
  if (probe.ok === true) return probe;
  if (reach === false) return probe;
  if (reach === true && Date.now() - probe.at < PROBE_ASSERT_MS) return probe;
  return undefined;
}

function errorOf(entry) {
  if (entry.fiber?.state !== FIBER_FAILED) return undefined;
  const error = entry.fiber?.error;
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return message === '' ? 'MCP 客户端加载失败' : message;
}

async function collect(ctx, { withSources = true } = {}) {
  const loader = ctx.get('loader');
  const rows = loader === undefined || typeof loader.entries !== 'function'
    ? []
    : [...loader.entries()].filter((entry) => entry?.options?.name === MCP_CLIENT_NAME);

  const configs = rows.map((entry) => configOf(entry));
  const serverNames = configs
    .map((config) => (typeof config.serverName === 'string' ? config.serverName : ''))
    .filter((name) => name !== '');
  const counts = toolCounts(ctx, serverNames);

  // 只有 streamable-http 能便宜地探活（TCP）；stdio 的存活只能靠工具注册表 + 用户点测试。
  const reachable = await Promise.all(configs.map((config) => (
    config.transport === 'streamable-http' ? reachableOf(config.url) : Promise.resolve(null)
  )));

  const sourceText = new Map();
  if (withSources) {
    for (const file of candidatePatchFiles(ctx)) {
      try {
        sourceText.set(file.path, await readFile(file.path, 'utf8'));
      } catch {
        /* 文件不存在 = 这一层没有行 */
      }
    }
  }

  const servers = rows.map((entry, index) => {
    const config = configs[index];
    const serverName = typeof config.serverName === 'string' ? config.serverName : '(未命名)';
    const count = counts?.get(serverName);
    const summary = summarize(config);
    const reach = reachable[index] ?? null;
    const probe = probeVerdict(storedProbe(entry.options.id), reach);
    let patchFile;
    let layer;
    for (const [path, text] of sourceText) {
      if (findRowBlock(text.split(/\r?\n/), entry.options.id) !== undefined) {
        patchFile = path;
        layer = candidatePatchFiles(ctx).find((file) => file.path === path)?.layer;
        break;
      }
    }
    return {
      id: entry.options.id,
      entryPath: entry.id,
      serverName,
      state: stateOf(entry, count, { reachable: reach, probe }),
      disabled: Boolean(entry.disabled),
      fiberState: entry.fiber?.state ?? null,
      toolCount: count === undefined ? null : count,
      reachable: reach,
      probe: probe === undefined
        ? null
        : {
          ok: probe.ok,
          at: probe.at,
          durationMs: probe.durationMs ?? null,
          toolsCount: probe.toolsCount ?? null,
          error: probe.error ?? null,
        },
      error: errorOf(entry),
      transport: summary.transport,
      target: summary.target,
      detail: summary.detail,
      reconnect: config.reconnect ?? null,
      toolCallTimeoutMs: config.toolCallTimeoutMs ?? null,
      source: withSources ? layer ?? 'bundle' : undefined,
      patchFile: withSources ? patchFile ?? null : undefined,
      writableFile: withSources ? Boolean(patchFile) : undefined,
    };
  });

  servers.sort((a, b) => a.serverName.localeCompare(b.serverName));
  return {
    servers,
    patchFiles: candidatePatchFiles(ctx).map((file) => ({ path: file.path, layer: file.layer })),
    checkedAt: Date.now(),
  };
}

async function waitForState(ctx, id, accept, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() <= deadline) {
    const snapshot = await collect(ctx, { withSources: false });
    last = snapshot.servers.find((server) => server.id === id);
    if (last !== undefined && accept(last)) return last;
    await sleep(300);
  }
  return last;
}

/** 主动重排一次：补丁监听没接上时用它把行重新挂载（= 重新连接）。 */
async function forceReload(ctx, id) {
  const hmr = ctx.get('hmr');
  if (hmr === undefined || typeof hmr.reconcileProfile !== 'function') return false;
  const run = () => hmr.reconcileProfile([id]);
  try {
    if (typeof hmr.runExclusive === 'function') await hmr.runExclusive(run);
    else await run();
    return true;
  } catch (error) {
    ctx.logger?.warn?.(`[mcp-panel] ${id}: 重新挂载失败 — ${error?.message ?? error}`);
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * 动作
 * ------------------------------------------------------------------ */

async function setEnabled(ctx, id, enabled) {
  const before = await collect(ctx);
  const row = before.servers.find((server) => server.id === id);
  if (row === undefined) throw new Error(`未找到 MCP 服务器条目：${id}`);
  if (row.patchFile === null) throw new Error('这一行由插件包提供，不在可编辑的补丁文件里');

  await access(row.patchFile, fsConstants.W_OK).catch(() => {
    throw new Error(`补丁文件不可写：${row.patchFile}`);
  });
  const written = await setRowDisabled(row.patchFile, id, !enabled);
  if (!written) throw new Error('补丁文件里找不到这一行（可能刚被其它工具改写，请刷新后重试）');
  // 重新挂载就是一次新连接：旧的测试结论不再适用。
  probeResults.delete(id);
  reachCache.clear();

  const accept = enabled
    ? (server) => server.state === 'connected'
    : (server) => server.state === 'disabled';

  let attempts = 0;
  let current = await waitForState(ctx, id, accept, SETTLE_TIMEOUT_MS);
  while (current !== undefined && !accept(current) && enabled && attempts < RETRY_ROUNDS) {
    attempts += 1;
    const reloaded = await forceReload(ctx, id);
    if (!reloaded) break;
    current = await waitForState(ctx, id, accept, SETTLE_TIMEOUT_MS);
  }
  return {
    state: current?.state ?? 'unknown',
    settled: current !== undefined && accept(current),
    attempts,
    server: current ?? null,
  };
}

async function reconnect(ctx, id) {
  const before = await collect(ctx);
  const row = before.servers.find((server) => server.id === id);
  if (row === undefined) throw new Error(`未找到 MCP 服务器条目：${id}`);
  probeResults.delete(id);
  reachCache.clear();
  let attempts = 1;
  await forceReload(ctx, id);
  let current = await waitForState(ctx, id, (server) => server.state === 'connected', SETTLE_TIMEOUT_MS);
  while (current !== undefined && current.state !== 'connected' && attempts <= RETRY_ROUNDS) {
    attempts += 1;
    await forceReload(ctx, id);
    current = await waitForState(ctx, id, (server) => server.state === 'connected', SETTLE_TIMEOUT_MS);
  }
  return {
    state: current?.state ?? 'unknown',
    settled: current?.state === 'connected',
    attempts,
    server: current ?? null,
  };
}

/** 用与宿主真正连接同一份配置做一次 JSON-RPC 握手，拿回可读的失败原因。 */
async function testServer(ctx, id) {
  const snapshot = await collect(ctx);
  const row = snapshot.servers.find((server) => server.id === id);
  if (row === undefined) throw new Error(`未找到 MCP 服务器条目：${id}`);
  const loader = ctx.get('loader');
  const entry = [...loader.entries()].find((item) => item?.options?.id === id);
  const config = entry === undefined ? {} : configOf(entry);
  const probeConfig = { transport: config.transport, serverName: row.serverName };
  if (config.transport === 'stdio') {
    probeConfig.command = config.command;
    probeConfig.args = Array.isArray(config.args) ? config.args.filter((arg) => typeof arg === 'string') : [];
    probeConfig.env = Object.fromEntries(
      Object.entries(config.env ?? {}).filter(([, value]) => typeof value === 'string'),
    );
    if (typeof config.cwd === 'string' && config.cwd !== '') probeConfig.cwd = config.cwd;
  } else {
    probeConfig.url = config.url;
    probeConfig.headers = Object.fromEntries(
      Object.entries(config.headers ?? {}).filter(([, value]) => typeof value === 'string'),
    );
  }
  return probeServer(probeConfig, { timeoutMs: 15000 });
}

/* ------------------------------------------------------------------ *
 * HTTP 路由
 * ------------------------------------------------------------------ */

function isLoopback(request) {
  const address = request.socket?.remoteAddress ?? '';
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function isSameOrigin(request) {
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

function sendJson(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  });
  response.end(payload);
}

async function readJsonBody(request, limitBytes = 65536) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > limitBytes) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  if (total === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/**
 * 路由闸门：只接受回环来源；写操作还要求同源证明（浏览器跨站请求带 Origin，和 Host 对不上）。
 */
function gate(request, { method, write }) {
  if (!isLoopback(request)) return { status: 403, error: '只接受本机请求' };
  if (request.method !== method) return { status: 405, error: `只支持 ${method}` };
  if (write && !isSameOrigin(request)) return { status: 403, error: '跨站写请求被拒绝' };
  return undefined;
}

export const name = PLUGIN_ID;
export const inject = ['webServer'];

/**
 * 注册三条路由。整块都在一个 effect 里，插件卸载时路由一起消失。
 * @param ctx - 插件上下文（webServer 已就绪）。
 */
export function apply(ctx) {
  ctx.effect(() => {
    const routes = [
      ctx.webServer.register({
        kind: 'exact',
        path: `${ROUTE_BASE}/servers`,
        handler: async (request, response) => {
          const rejection = gate(request, { method: 'GET', write: false });
          if (rejection !== undefined) return sendJson(response, rejection.status, { ok: false, error: rejection.error });
          try {
            return sendJson(response, 200, { ok: true, ...(await collect(ctx)) });
          } catch (error) {
            return sendJson(response, 500, { ok: false, error: error?.message ?? String(error) });
          }
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: `${ROUTE_BASE}/toggle`,
        handler: async (request, response) => {
          const rejection = gate(request, { method: 'POST', write: true });
          if (rejection !== undefined) return sendJson(response, rejection.status, { ok: false, error: rejection.error });
          try {
            const body = await readJsonBody(request);
            if (typeof body.id !== 'string' || body.id === '') throw new Error('缺少 id');
            const result = await setEnabled(ctx, body.id, Boolean(body.enabled));
            return sendJson(response, 200, { ok: true, ...result });
          } catch (error) {
            return sendJson(response, 400, { ok: false, error: error?.message ?? String(error) });
          }
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: `${ROUTE_BASE}/retry`,
        handler: async (request, response) => {
          const rejection = gate(request, { method: 'POST', write: true });
          if (rejection !== undefined) return sendJson(response, rejection.status, { ok: false, error: rejection.error });
          try {
            const body = await readJsonBody(request);
            if (typeof body.id !== 'string' || body.id === '') throw new Error('缺少 id');
            const result = await reconnect(ctx, body.id);
            return sendJson(response, 200, { ok: true, ...result });
          } catch (error) {
            return sendJson(response, 400, { ok: false, error: error?.message ?? String(error) });
          }
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: `${ROUTE_BASE}/test`,
        handler: async (request, response) => {
          const rejection = gate(request, { method: 'POST', write: true });
          if (rejection !== undefined) return sendJson(response, rejection.status, { ok: false, error: rejection.error });
          try {
            const body = await readJsonBody(request);
            if (typeof body.id !== 'string' || body.id === '') throw new Error('缺少 id');
            const result = await testServer(ctx, body.id);
            // 结果既返回给这次调用，也记下来让下一次快照（以及轮询）把徽标改成同一条结论。
            probeResults.set(body.id, {
              ok: result.ok === true,
              at: Date.now(),
              durationMs: result.durationMs,
              toolsCount: result.toolsCount,
              error: result.error,
            });
            return sendJson(response, 200, { ok: true, result });
          } catch (error) {
            return sendJson(response, 400, { ok: false, error: error?.message ?? String(error) });
          }
        },
      }),
    ];
    return () => {
      for (const dispose of routes) dispose();
    };
  }, 'dsh-mcp-status: routes');
}
