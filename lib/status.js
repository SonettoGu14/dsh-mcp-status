/**
 * dsh-mcp-status — 状态判定与两个消费方（模型可见性 / 调用闸门）的纯逻辑。
 *
 * 这个文件不碰 loader、不碰 fs、不发请求：输入是已经采到的观测值，输出是状态 + 依据，
 * 因此可以直接单测。宿主半体负责采集（fiber、工具注册表、TCP 探活、测试连接结果），
 * 这里只负责「这些观测值说明什么」。
 *
 * 设计参考 opencode 的 MCP 状态机（`packages/schema/src/mcp.ts` 的 Status 联合类型）：
 *   状态是一个有穷集合 + 一句 reason，而不是散落在界面里的临时判断；
 *   不可用状态会同时喂给界面、system prompt 和工具调用闸门。
 * 差别在于 DSH 的 `dsh-mcp-client` 不暴露连接状态，所以我们的状态是**推导**出来的，
 * 每条结论都必须带着「凭什么」（evidence），不能只给一个颜色。
 *
 * @module dsh-mcp-status/lib/status
 */

/** cordis FiberState：2 = 运行中，3 = 失败（与宿主一致）。 */
export const FIBER_ACTIVE = 2;
export const FIBER_FAILED = 3;

/** 插件配置默认值；宿主半体用 {@link normalizeConfig} 钳制。 */
export const DEFAULT_CONFIG = {
  /** 状态缓存的后台刷新周期（毫秒）。 */
  refreshMs: 10000,
  /** 开关/重试后等待连接就绪的上限（毫秒）。 */
  startupWaitMs: 8000,
  /** 「测试连接」失败后，结论压过实时探活的窗口（毫秒）。 */
  probeAssertMs: 60000,
  /** 「测试连接」的整次超时（毫秒）。 */
  probeTimeoutMs: 15000,
  /** 是否把不可用服务器写进 system prompt。 */
  promptHealth: true,
  /** 是否拦截发往不可用服务器的工具调用。 */
  guardUnreachable: true,
};

const MIN_REFRESH_MS = 2000;
const MIN_TIMEOUT_MS = 1000;
const NUMBER_KEYS = ['refreshMs', 'startupWaitMs', 'probeAssertMs', 'probeTimeoutMs'];
const BOOLEAN_KEYS = ['promptHealth', 'guardUnreachable'];

/** 把行配置合并到默认值上，钳制非法/越界数字；未知键忽略。 */
export function normalizeConfig(raw) {
  const config = { ...DEFAULT_CONFIG };
  if (raw === undefined || raw === null || typeof raw !== 'object') return config;
  for (const key of NUMBER_KEYS) {
    const value = raw[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    const floor = key === 'refreshMs' ? MIN_REFRESH_MS : MIN_TIMEOUT_MS;
    config[key] = Math.max(floor, Math.round(value));
  }
  for (const key of BOOLEAN_KEYS) {
    if (typeof raw[key] === 'boolean') config[key] = raw[key];
  }
  return config;
}

/**
 * 判定一行 MCP 服务器的状态。
 *
 * 优先级（顺序即权威程度）：
 *   1. 停用 → disabled（用户的意愿，不是故障）
 *   2. fiber 失败 → failed
 *   3. fiber 未就绪 → pending
 *   4. 「测试连接」失败且（端口不通 或 结论够新）→ unreachable
 *   5. HTTP 端口拒绝连接 → unreachable
 *   6. 「测试连接」成功 → connected
 *   7. 工具表读不到 → connected（不下结论，宁可说连上也不误判故障）
 *   8. 有工具 → connected；没有工具 → idle
 *
 * `idle` 刻意与 `unreachable` 区分：工具数为 0 有可能只是这行挂在 per-agent 作用域
 * （全局注册表看不到），把它当断线会误拦、误报。
 *
 * @param {object} input 观测值
 * @returns {{state: string, reason: string, evidence: Array<object>}}
 */
export function resolveStatus(input) {
  const {
    disabled = false,
    fiberState = null,
    toolCount, // number | null | undefined（undefined/null = 读不到注册表）
    reachable = null, // boolean | null（stdio 行恒为 null）
    reachableAt = null,
    reachDetail = null, // 'refused' | 'timeout' | 'error' | null
    probe, // { ok, at, error } | undefined
    now = Date.now(),
    probeAssertMs = DEFAULT_CONFIG.probeAssertMs,
  } = input;

  const evidence = [];
  const fiberValue = fiberState === FIBER_ACTIVE
    ? 'active'
    : fiberState === FIBER_FAILED ? 'failed' : 'pending';
  evidence.push({ signal: 'fiber', value: fiberValue, at: null });
  evidence.push({ signal: 'tools', value: toolCount === undefined || toolCount === null ? null : toolCount, at: null });
  if (reachable !== null) {
    evidence.push({ signal: 'tcp', value: reachDetail ?? (reachable ? 'ok' : 'refused'), at: reachableAt });
  }
  if (probe !== undefined) {
    evidence.push({ signal: 'probe', value: probe.ok ? 'ok' : 'failed', at: probe.at, detail: probe.error ?? null });
  }

  if (disabled) return { state: 'disabled', reason: 'disabled', evidence };
  if (fiberState === FIBER_FAILED) return { state: 'failed', reason: 'fiber-failed', evidence };
  if (fiberState !== FIBER_ACTIVE) return { state: 'pending', reason: 'pending', evidence };

  const probeFailed = probe !== undefined && probe.ok === false;
  const probeAsserted = probeFailed && (reachable !== true || now - (probe.at ?? 0) < probeAssertMs);
  if (probeAsserted) return { state: 'unreachable', reason: 'probe-failed', evidence };
  if (reachable === false) return { state: 'unreachable', reason: 'tcp-refused', evidence };
  if (probe !== undefined && probe.ok === true) return { state: 'connected', reason: 'connected', evidence };
  if (toolCount === undefined || toolCount === null) return { state: 'connected', reason: 'unknown-tools', evidence };
  if (toolCount > 0) return { state: 'connected', reason: 'connected', evidence };
  return { state: 'idle', reason: 'no-tools', evidence };
}

/** `mcp__<server>__<tool>` 里取出 serverName；不是 MCP 工具名时返回 undefined。 */
export function serverNameFromTool(toolName) {
  if (typeof toolName !== 'string' || !toolName.startsWith('mcp__')) return undefined;
  const rest = toolName.slice('mcp__'.length);
  const index = rest.indexOf('__');
  if (index <= 0) return undefined;
  return rest.slice(0, index);
}

/**
 * 调用闸门的判定：返回字符串即拒绝（DSH `tools.guard` 的契约），返回 undefined 放行。
 *
 * 只有**证据够新**才拒绝：快照本身超过 `2 × refreshMs` 视为过期（后台刷新卡住、
 * 插件刚启动等），此时让真实调用自己去失败，比误拦一个能用的服务器强。
 *
 * @param {object} input
 * @param {string} input.toolName 请求的工具名
 * @param {object|undefined} input.row 快照里对应的行
 * @param {number} input.snapshotAt 快照采集时间
 * @param {number} input.now
 * @param {object} input.config 归一化后的配置
 * @returns {string|undefined} 拒绝原因
 */
export function decideGuard({ toolName, row, snapshotAt, now = Date.now(), config = DEFAULT_CONFIG }) {
  if (config.guardUnreachable === false) return undefined;
  if (row === undefined || row === null) return undefined;
  // 只拦「有证据的不可用」：pending/connecting 只是还没起来，可能下一秒就连上。
  if (row.state !== 'unreachable' && row.state !== 'failed') return undefined;
  if (now - snapshotAt > config.refreshMs * 2) return undefined;

  const detail = row.probe?.error
    ?? (row.reachDetail === 'timeout' ? `TCP connect to ${row.target} timed out` : null)
    ?? (row.reachDetail === 'refused' ? `TCP connect to ${row.target} refused` : null)
    ?? (row.state === 'failed' ? 'the MCP client failed to load' : 'not connected');
  return `MCP server "${row.serverName}" is not connected: ${detail}. `
    + 'Its tools are refused until it reconnects; fix it from the MCP panel (sidebar → MCP 服务器) and retry.';
}

/** 给 system prompt 用的紧凑摘要；没有不可用服务器时返回空串。 */
export function buildHealthText(snapshot, { now = Date.now(), maxRows = 6, maxChars = 800 } = {}) {
  const rows = (snapshot?.servers ?? []).filter(
    (row) => row.state === 'unreachable' || row.state === 'failed',
  );
  if (rows.length === 0) return '';

  const lines = rows.slice(0, maxRows).map((row) => {
    const age = row.checkedAt === undefined || row.checkedAt === null
      ? ''
      : `, checked ${Math.max(0, Math.round((now - row.checkedAt) / 1000))}s ago`;
    const detail = row.probe?.error
      ?? (row.reachDetail === 'refused' ? 'TCP connect refused' : row.reachDetail === 'timeout' ? 'TCP connect timed out' : row.state);
    return `- ${row.serverName} (${row.target || 'unknown target'}): ${row.state} — ${detail}${age}.`;
  });
  if (rows.length > maxRows) lines.push(`- …and ${rows.length - maxRows} more unavailable MCP server(s).`);

  const header = '## MCP servers currently unavailable\n'
    + 'Calling tools of these servers is refused before execution. Tell the user instead of retrying;\n'
    + 'they can reconnect from the MCP panel (sidebar → MCP 服务器).\n';
  const text = `${header}${lines.join('\n')}`;
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

/** 设置 section 顺序：优先问注册表，问不到就用一个稳的常量（不因为版本差异抛错）。 */
export function sectionOrder(registry, name = 'MCP_SERVERS', fallback = 50) {
  try {
    const order = registry?.getSectionOrder?.(name);
    return typeof order === 'number' && Number.isFinite(order) ? order : fallback;
  } catch {
    return fallback;
  }
}
