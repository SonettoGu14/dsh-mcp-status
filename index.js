/**
 * dsh-mcp-status — 宿主半体。
 *
 * 四件事：
 *   1. 列出**当前真正加载的** MCP 服务器：遍历 loader 里所有 `@deepseek-ai/dsh-mcp-client`
 *      行（profile 补丁、home 补丁、插件包插入的行都算），所以「有哪些 server」的答案与宿主
 *      实际运行的东西一致。
 *   2. 推导存活状态并留下依据：loader fiber 的 state、工具注册表里 `mcp__<server>__*` 的条数、
 *      streamable-http 行的 TCP 探活、最近一次「测试连接」的结论。判定逻辑在 `lib/status.js`
 *      （纯函数、可单测），这里只负责采集与缓存。
 *   3. 把同一份状态喂给三个消费方：面板（HTTP 路由）、模型（system prompt 摘要）、
 *      工具调用闸门（不可用服务器的工具在派发前被拒）。
 *   4. 提供开关与连接测试：开关只改补丁文件里那一行的 `disabled`，热重载即重连。
 *
 * 设计参考 opencode 的 MCP 状态所有权（一份状态服务多个消费方）；差别是 DSH 的
 * `dsh-mcp-client` 不暴露连接状态，所以我们的状态是推导的，每条结论都必须带 evidence。
 *
 * @module dsh-mcp-status
 */

import { constants as fsConstants } from 'node:fs';
import { access, readFile, rename, stat, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  buildHealthText,
  decideGuard,
  FIBER_ACTIVE,
  FIBER_FAILED,
  normalizeConfig,
  resolveStatus,
  sectionOrder,
  serverNameFromTool,
} from './lib/status.js';
import { probeServer } from './lib/probe.js';

/** 浏览器半体与宿主共用的包名（客户端模块 id 与 locale 命名空间）。 */
const PLUGIN_ID = 'dsh-mcp-status';
/** 承载一台 MCP 服务器的那一行插件。 */
const MCP_CLIENT_NAME = '@deepseek-ai/dsh-mcp-client';
/** 等待超时后主动重排的轮数（每轮仍受 startupWaitMs 约束）。 */
const RETRY_ROUNDS = 1;
const ROUTE_BASE = '/api/dsh-mcp-status';
/** TCP 探活的缓存时长：轮询 4 s 一次，2 s 内复用同一个结果，避免 300 ms 档的等待期把它打成风暴。 */
const REACHABILITY_TTL_MS = 2000;
/** 「测试连接」结果的保质期：过期后回落到工具注册表推断，免得一次旧失败永久污名化一行。 */
const PROBE_TTL_MS = 10 * 60 * 1000;
/** system prompt 摘要的 section 名。 */
const HEALTH_SECTION = 'mcp-status:health';

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
 * 采集：行 + 工具数 + 端口探活 + 测试结论
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

/* ------------------------------------------------------------------ *
 * 存活旁证：HTTP 端口探活 + 「测试连接」结果
 * ------------------------------------------------------------------ */

/** {@link reachableOf} 的结果缓存，key 是 `host:port`。 */
const reachCache = new Map();

/** TCP 连一下 host:port：连上即可达；拒绝/超时/错误返回原因，供 guard 与 prompt 引用。 */
function tcpReachable(host, port, timeoutMs = 700) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let settled = false;
    const finish = (ok, detail) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ ok, detail });
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true, 'ok'));
    socket.once('timeout', () => finish(false, 'timeout'));
    socket.once('error', (error) => finish(false, error?.code === 'ECONNREFUSED' ? 'refused' : 'error'));
  });
}

/**
 * 只对 streamable-http 有意义：解析 url 取 host/port 再探活。
 * @returns {{ok: boolean, detail: string, at: number}|null} url 不合法时返回 null（不下结论）
 */
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
  if (cached !== undefined && now - cached.at < REACHABILITY_TTL_MS) return cached;
  const { ok, detail } = await tcpReachable(host, port);
  const value = { ok, detail, at: Date.now() };
  reachCache.set(key, value);
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
 * 采一份完整快照。
 *
 * 状态由 {@link resolveStatus} 判定；DTO 里把 `pending` 映射回界面既有的 `connecting`
 * 取值（面板不需要为一个内部状态名改 CSS），并附带 reason + evidence 让界面能解释结论。
 */
async function collect(ctx, settings, { withSources = true } = {}) {
  const loader = ctx.get('loader');
  const rows = loader === undefined || typeof loader.entries !== 'function'
    ? []
    : [...loader.entries()].filter((entry) => entry?.options?.name === MCP_CLIENT_NAME);

  const configs = rows.map((entry) => configOf(entry));
  const serverNames = configs
    .map((config) => (typeof config.serverName === 'string' ? config.serverName : ''))
    .filter((name) => name !== '');
  const counts = toolCounts(ctx, serverNames);
  const now = Date.now();

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
    const reach = reachable[index];
    const probe = storedProbe(entry.options.id);
    const status = resolveStatus({
      disabled: Boolean(entry.disabled),
      fiberState: entry.fiber?.state ?? null,
      toolCount: count === undefined ? null : count,
      reachable: reach === null ? null : reach.ok,
      reachableAt: reach === null ? null : reach.at,
      reachDetail: reach === null ? null : reach.detail,
      probe,
      now,
      probeAssertMs: settings.probeAssertMs,
    });
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
      state: status.state === 'pending' ? 'connecting' : status.state,
      reason: status.reason,
      evidence: status.evidence,
      disabled: Boolean(entry.disabled),
      fiberState: entry.fiber?.state ?? null,
      toolCount: count === undefined ? null : count,
      reachable: reach === null ? null : reach.ok,
      reachDetail: reach === null ? null : reach.detail,
      checkedAt: now,
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
    checkedAt: now,
  };
}

function errorOf(entry) {
  if (entry.fiber?.state !== FIBER_FAILED) return undefined;
  const error = entry.fiber?.error;
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return message === '' ? 'MCP 客户端加载失败' : message;
}

/**
 * 状态缓存：后台按 refreshMs 刷新，给 system prompt 与 guard 用；
 * 面板请求 `refresh(true)` 时当场重采，保持它原有的新鲜度。
 */
function createTracker(ctx, config) {
  let cache = { servers: [], patchFiles: [], checkedAt: 0 };
  let inflight;
  const listeners = new Set();

  async function refresh(force = false) {
    if (!force && Date.now() - cache.checkedAt < config.refreshMs) return cache;
    if (inflight !== undefined) return inflight;
    inflight = collect(ctx, config)
      .then((next) => {
        cache = next;
        for (const listener of listeners) {
          try {
            listener(cache);
          } catch {
            /* 通知失败不影响刷新 */
          }
        }
        return cache;
      })
      .catch(() => cache)
      .finally(() => {
        inflight = undefined;
      });
    return inflight;
  }

  return {
    refresh,
    peek: () => cache,
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/* ------------------------------------------------------------------ *
 * 动作
 * ------------------------------------------------------------------ */

async function waitForState(ctx, config, tracker, id, accept, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() <= deadline) {
    const snapshot = await tracker.refresh(true);
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
    ctx.logger?.warn?.(`[mcp-status] ${id}: 重新挂载失败 — ${error?.message ?? error}`);
    return false;
  }
}

async function setEnabled(ctx, config, tracker, id, enabled) {
  const before = await tracker.refresh(true);
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
  let current = await waitForState(ctx, config, tracker, id, accept, config.startupWaitMs);
  while (current !== undefined && !accept(current) && enabled && attempts < RETRY_ROUNDS) {
    attempts += 1;
    const reloaded = await forceReload(ctx, id);
    if (!reloaded) break;
    current = await waitForState(ctx, config, tracker, id, accept, config.startupWaitMs);
  }
  return {
    state: current?.state ?? 'unknown',
    settled: current !== undefined && accept(current),
    attempts,
    server: current ?? null,
  };
}

async function reconnect(ctx, config, tracker, id) {
  const before = await tracker.refresh(true);
  const row = before.servers.find((server) => server.id === id);
  if (row === undefined) throw new Error(`未找到 MCP 服务器条目：${id}`);
  probeResults.delete(id);
  reachCache.clear();
  let attempts = 1;
  await forceReload(ctx, id);
  let current = await waitForState(ctx, config, tracker, id, (server) => server.state === 'connected', config.startupWaitMs);
  while (current !== undefined && current.state !== 'connected' && attempts <= RETRY_ROUNDS) {
    attempts += 1;
    await forceReload(ctx, id);
    current = await waitForState(ctx, config, tracker, id, (server) => server.state === 'connected', config.startupWaitMs);
  }
  return {
    state: current?.state ?? 'unknown',
    settled: current?.state === 'connected',
    attempts,
    server: current ?? null,
  };
}

/** 用与宿主真正连接同一份配置做一次 JSON-RPC 握手，拿回可读的失败原因。 */
async function testServer(ctx, config, id) {
  const before = await collect(ctx, config);
  const row = before.servers.find((server) => server.id === id);
  if (row === undefined) throw new Error(`未找到 MCP 服务器条目：${id}`);
  const loader = ctx.get('loader');
  const entry = [...loader.entries()].find((item) => item?.options?.id === id);
  const serverConfig = entry === undefined ? {} : configOf(entry);
  const probeConfig = { transport: serverConfig.transport, serverName: row.serverName };
  if (serverConfig.transport === 'stdio') {
    probeConfig.command = serverConfig.command;
    probeConfig.args = Array.isArray(serverConfig.args)
      ? serverConfig.args.filter((arg) => typeof arg === 'string')
      : [];
    probeConfig.env = Object.fromEntries(
      Object.entries(serverConfig.env ?? {}).filter(([, value]) => typeof value === 'string'),
    );
    if (typeof serverConfig.cwd === 'string' && serverConfig.cwd !== '') probeConfig.cwd = serverConfig.cwd;
  } else {
    probeConfig.url = serverConfig.url;
    probeConfig.headers = Object.fromEntries(
      Object.entries(serverConfig.headers ?? {}).filter(([, value]) => typeof value === 'string'),
    );
  }
  return probeServer(probeConfig, { timeoutMs: config.probeTimeoutMs });
}

/* ------------------------------------------------------------------ *
 * 模型可见性：不可用摘要（system prompt）+ 调用闸门（tools.guard）
 * ------------------------------------------------------------------ */

/**
 * 只在「有不可用服务器」时注册 section，恢复后注销。
 * 这样健康时 prompt 里连一个空行都不会多——空 section 会不会产生空行属于未验证行为，
 * 动态注册让这个不确定性消失。
 */
function attachHealthSection(ctx, config, tracker) {
  if (!config.promptHealth) return;
  ctx.inject(['systemPrompt'], (inner) => {
    let dispose;
    const sync = () => {
      const text = buildHealthText(tracker.peek(), { now: Date.now() });
      if (text !== '' && dispose === undefined) {
        dispose = inner.systemPrompt.section({
          name: HEALTH_SECTION,
          order: sectionOrder(inner.systemPrompt),
          interpolate: false,
          text: () => buildHealthText(tracker.peek(), { now: Date.now() }),
        });
      } else if (text === '' && dispose !== undefined) {
        dispose();
        dispose = undefined;
      }
    };
    inner.effect(() => {
      sync();
      const stop = tracker.onChange(sync);
      return () => {
        stop();
        if (dispose !== undefined) dispose();
        dispose = undefined;
      };
    }, 'dsh-mcp-status: health section');
  });
}

/**
 * 调用闸门：不可用服务器的 `mcp__<server>__*` 调用在派发前被拒，理由可读。
 * guard 是同步的，所以只读缓存快照，绝不在这里探活。
 */
function attachGuard(ctx, config, tracker) {
  if (!config.guardUnreachable) return;
  ctx.inject(['tools'], (inner) => {
    inner.effect(() => inner.tools.guard((execution) => {
      const serverName = serverNameFromTool(execution?.name);
      if (serverName === undefined) return undefined;
      const snapshot = tracker.peek();
      const row = snapshot.servers.find((server) => server.serverName === serverName);
      if (row === undefined) return undefined;
      return decideGuard({
        toolName: execution.name,
        row,
        snapshotAt: snapshot.checkedAt,
        now: Date.now(),
        config,
      });
    }), 'dsh-mcp-status: unreachable guard');
  });
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
 * 注册路由、后台刷新、prompt 摘要与调用闸门。
 * @param ctx - 插件上下文（webServer 已就绪）。
 * @param rawConfig - 行配置（patch 里 `config:` 下的对象）；未声明 Config schema，这里手工归一化。
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig);
  const tracker = createTracker(ctx, config);
  // 冷启动先采一次，别让 prompt/guard 在第一个 refreshMs 窗口里读到空快照。
  tracker.refresh(true);

  ctx.effect(() => {
    const timer = setInterval(() => {
      tracker.refresh();
    }, config.refreshMs);
    if (typeof timer.unref === 'function') timer.unref();
    return () => clearInterval(timer);
  }, 'dsh-mcp-status: refresh loop');

  attachHealthSection(ctx, config, tracker);
  attachGuard(ctx, config, tracker);

  ctx.effect(() => {
    const routes = [
      ctx.webServer.register({
        kind: 'exact',
        path: `${ROUTE_BASE}/servers`,
        handler: async (request, response) => {
          const rejection = gate(request, { method: 'GET', write: false });
          if (rejection !== undefined) return sendJson(response, rejection.status, { ok: false, error: rejection.error });
          try {
            // 面板每次拉取都当场重采：探活有 2 s 缓存、其它全是内存读取，成本可忽略。
            const snapshot = await tracker.refresh(true);
            return sendJson(response, 200, { ok: true, ...snapshot });
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
            const result = await setEnabled(ctx, config, tracker, body.id, Boolean(body.enabled));
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
            const result = await reconnect(ctx, config, tracker, body.id);
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
            const result = await testServer(ctx, config, body.id);
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
