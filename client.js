/**
 * dsh-mcp-panel — 浏览器半体。
 *
 * 两个座位：
 *   - `sidebar.panellist`：侧边栏里的一行（id 与面板 id 相同）；
 *   - `main`（keyed，key = 面板 id）：中央面板本体。
 *
 * 纯 DOM/React 渲染，无构建步骤；数据全部来自宿主路由 `/api/dsh-mcp-panel/*`，
 * 面板只负责把「有哪些服务器、各自连上没有、配置是什么」讲清楚，并把开关/测试动作转给宿主。
 * 样式只用 `--dsw-alias-*` 主题令牌，随宿主明暗主题切换。
 */
window.__ModuleLoader__.load({
  id: 'dsh-mcp-panel',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useMemo, useRef, useState } = React;

    const NS = 'dsh-mcp-panel';
    const PANEL_ID = 'mcp';
    const PANEL_ORDER = 40;
    const API = '/api/dsh-mcp-panel';
    const POLL_MS = 4000;

    /* ------------------------------------------------------------------ *
     * 文案
     * ------------------------------------------------------------------ */

    const ZH = {
      'panel.title': 'MCP 服务器',
      'panel.refresh': '刷新',
      'panel.empty': '还没有配置任何 MCP 服务器',
      'panel.emptyHint': '在 设置 → 插件 → MCP 服务器配置 里添加，或把 mcp-client 行写进 profile 补丁。',
      'state.connected': '已连接',
      'state.connecting': '连接中',
      'state.idle': '未连接',
      'state.failed': '加载失败',
      'state.disabled': '已停用',
      'state.unknown': '未知',
      'unit.tools': '工具',
      'summary.connected': '{n} 已连接',
      'summary.failed': '{n} 异常',
      'summary.disabled': '{n} 已停用',
      'action.toggleOn': '启用并连接',
      'action.toggleOff': '停用',
      'action.test': '测试连接',
      'action.testing': '测试中…',
      'action.retry': '重试',
      'action.retrying': '重试中…',
      'action.showConfig': '配置',
      'action.hideConfig': '收起',
      'field.transport': '传输',
      'field.command': '命令',
      'field.url': '地址',
      'field.env': '环境变量',
      'field.headers': '请求头',
      'field.source': '来源',
      'field.entry': '条目',
      'field.reconnect': '重连策略',
      'field.timeout': '调用超时',
      'hint.notToggleable': '该服务器由插件包提供，不能在面板里开关',
      'hint.idle': 'MCP 客户端已加载，但没有注册任何工具——通常意味着连接失败。点「测试连接」看原因。',
      'hint.failed': '这一行加载失败，展开可看错误信息；「重试」会重新挂载它。',
      'hint.disabled': '已停用：不会连接，也不占工具表。',
      'hint.pending': 'MCP 客户端正在启动，稍等片刻会自动刷新。',
      'badge.bundled': '内置',
      'error.load': '读取 MCP 状态失败',
      'error.action': '操作失败',
      'toggle.settled': '已连接',
      'toggle.timeout': '还在连接中，稍后会自动刷新',
      'toggle.disabled': '已停用',
      'test.ok': '连接成功：{n} 个工具，耗时 {ms} ms',
      'test.fail': '连接失败',
    };

    const EN = {
      'panel.title': 'MCP Servers',
      'panel.refresh': 'Refresh',
      'panel.empty': 'No MCP server configured yet',
      'panel.emptyHint': 'Add one under Settings → Plugins → MCP server configuration, or write an mcp-client row into the profile patch.',
      'state.connected': 'Connected',
      'state.connecting': 'Connecting',
      'state.idle': 'Not connected',
      'state.failed': 'Failed',
      'state.disabled': 'Disabled',
      'state.unknown': 'Unknown',
      'unit.tools': 'tools',
      'summary.connected': '{n} connected',
      'summary.failed': '{n} failing',
      'summary.disabled': '{n} disabled',
      'action.toggleOn': 'Enable and connect',
      'action.toggleOff': 'Disable',
      'action.test': 'Test connection',
      'action.testing': 'Testing…',
      'action.retry': 'Reconnect',
      'action.retrying': 'Reconnecting…',
      'action.showConfig': 'Config',
      'action.hideConfig': 'Hide',
      'field.transport': 'Transport',
      'field.command': 'Command',
      'field.url': 'URL',
      'field.env': 'Environment',
      'field.headers': 'Headers',
      'field.source': 'Source',
      'field.entry': 'Entry',
      'field.reconnect': 'Reconnect policy',
      'field.timeout': 'Call timeout',
      'hint.notToggleable': 'Provided by a plugin package; it cannot be switched here',
      'hint.idle': 'The MCP client is loaded but registered no tools — usually a failed connection. Test it to see why.',
      'hint.failed': 'This row failed to load. Expand it for the error; Reconnect remounts it.',
      'hint.disabled': 'Disabled: no connection is attempted and no tools are registered.',
      'hint.pending': 'The MCP client is starting; this list refreshes automatically.',
      'badge.bundled': 'built-in',
      'error.load': 'Could not read MCP state',
      'error.action': 'Action failed',
      'toggle.settled': 'Connected',
      'toggle.disabled': 'Disabled',
      'toggle.timeout': 'Still connecting; the list refreshes automatically',
      'test.ok': 'Connected: {n} tools in {ms} ms',
      'test.fail': 'Connection failed',
    };

    /* ------------------------------------------------------------------ *
     * 样式（只用主题令牌；类名带 mcpPanel- 前缀，避免与宿主/其它插件冲突）
     * ------------------------------------------------------------------ */

    const CSS = `
.mcpPanel-root{height:100%;min-height:0;overflow-y:auto;box-sizing:border-box;padding:22px 28px 44px;display:flex;flex-direction:column;gap:14px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:inherit}
.mcpPanel-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.mcpPanel-headMain{display:flex;flex-direction:column;gap:2px;min-width:0}
.mcpPanel-title{font-size:17px;font-weight:600;line-height:24px}
.mcpPanel-sub{font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.mcpPanel-headActions{margin-left:auto;display:flex;align-items:center;gap:8px}
.mcpPanel-chip{display:inline-flex;align-items:center;gap:5px;border:.5px solid var(--dsw-alias-border-l1);border-radius:999px;padding:2px 9px;font-size:11.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.mcpPanel-chip i{width:7px;height:7px;border-radius:50%;flex:none;background:var(--dsw-alias-state-idle-primary)}
.mcpPanel-chip[data-tone=ok] i{background:var(--dsw-alias-state-success-primary)}
.mcpPanel-chip[data-tone=bad] i{background:var(--dsw-alias-state-error-primary)}
.mcpPanel-iconBtn{appearance:none;border:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);border-radius:7px;width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;padding:0;transition:border-color .15s,color .15s}
.mcpPanel-iconBtn:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}
.mcpPanel-iconBtn:disabled{opacity:.5;cursor:default}
.mcpPanel-iconBtn svg{display:block}
.mcpPanel-spin{animation:mcpPanel-spin 1s linear infinite}
@keyframes mcpPanel-spin{to{transform:rotate(360deg)}}
.mcpPanel-banner{border:.5px solid var(--dsw-alias-state-error-primary);background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent);color:var(--dsw-alias-state-error-primary);border-radius:8px;padding:8px 12px;font-size:12px;line-height:1.5}
.mcpPanel-list{display:flex;flex-direction:column;gap:8px}
.mcpPanel-card{border:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:10px;overflow:hidden;transition:border-color .15s}
.mcpPanel-card:hover{border-color:var(--dsw-alias-border-l2)}
.mcpPanel-row{display:flex;align-items:center;gap:10px;padding:11px 13px;min-width:0}
.mcpPanel-dot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--dsw-alias-state-idle-primary)}
.mcpPanel-dot[data-state=connected]{background:var(--dsw-alias-state-success-primary)}
.mcpPanel-dot[data-state=idle]{background:var(--dsw-alias-state-error-primary)}
.mcpPanel-dot[data-state=failed]{background:var(--dsw-alias-state-error-primary)}
.mcpPanel-dot[data-state=connecting]{background:var(--dsw-alias-state-warn-primary);animation:mcpPanel-pulse 1.2s ease-in-out infinite}
@keyframes mcpPanel-pulse{0%,100%{opacity:1}50%{opacity:.35}}
.mcpPanel-id{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}
.mcpPanel-nameLine{display:flex;align-items:baseline;gap:8px;min-width:0}
.mcpPanel-name{font-size:13.5px;font-weight:600;line-height:20px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mcpPanel-state{font-size:11.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.mcpPanel-state[data-state=connected]{color:var(--dsw-alias-state-success-primary)}
.mcpPanel-state[data-state=idle],.mcpPanel-state[data-state=failed]{color:var(--dsw-alias-state-error-primary)}
.mcpPanel-target{font-size:11.5px;line-height:16px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:var(--dsw-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace)}
.mcpPanel-tools{font-size:11px;color:var(--dsw-alias-label-secondary);border:.5px solid var(--dsw-alias-border-l1);border-radius:6px;padding:1px 6px;white-space:nowrap;font-variant-numeric:tabular-nums}
.mcpPanel-link{appearance:none;border:0;background:0 0;padding:0 2px;font:inherit;font-size:11.5px;color:var(--dsw-alias-brand-primary);cursor:pointer;white-space:nowrap}
.mcpPanel-link:hover:not(:disabled){text-decoration:underline}
.mcpPanel-link:disabled{color:var(--dsw-alias-label-secondary);cursor:default}
.mcpPanel-switch{appearance:none;border:0;padding:0;width:34px;height:20px;border-radius:999px;background:color-mix(in srgb, var(--dsw-alias-label-secondary) 32%, transparent);position:relative;cursor:pointer;flex:none;transition:background .15s}
.mcpPanel-switch[data-on=true]{background:var(--dsw-alias-brand-primary)}
.mcpPanel-switch:disabled{opacity:.45;cursor:default}
.mcpPanel-switch span{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;transition:transform .15s;box-shadow:0 1px 2px rgba(0,0,0,.25)}
.mcpPanel-switch[data-on=true] span{transform:translateX(14px)}
.mcpPanel-switch:focus-visible,.mcpPanel-link:focus-visible,.mcpPanel-iconBtn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.mcpPanel-detail{border-top:.5px solid var(--dsw-alias-border-l1);padding:9px 13px 11px;display:grid;grid-template-columns:auto minmax(0,1fr);gap:4px 14px;font-size:11.5px;line-height:18px}
.mcpPanel-key{color:var(--dsw-alias-label-secondary);white-space:nowrap}
.mcpPanel-val{min-width:0;overflow-wrap:anywhere;font-family:var(--dsw-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);color:var(--dsw-alias-label-primary)}
.mcpPanel-note{grid-column:1 / -1;color:var(--dsw-alias-label-secondary);font-family:inherit;line-height:1.6;margin-top:2px}
.mcpPanel-note[data-tone=bad]{color:var(--dsw-alias-state-error-primary)}
.mcpPanel-note[data-tone=ok]{color:var(--dsw-alias-state-success-primary)}
.mcpPanel-empty{border:.5px dashed var(--dsw-alias-border-l2);border-radius:10px;padding:26px 20px;text-align:center;display:flex;flex-direction:column;gap:6px;color:var(--dsw-alias-label-secondary);font-size:12.5px}
.mcpPanel-emptyTitle{color:var(--dsw-alias-label-primary);font-size:13.5px;font-weight:600}
`;

    /* ------------------------------------------------------------------ *
     * 小工具
     * ------------------------------------------------------------------ */

    function formatDuration(ms) {
      return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`;
    }

    function stateLabel(t, state) {
      return t(`state.${state}`);
    }

    function transportLabel(transport) {
      if (transport === 'stdio') return 'stdio';
      if (transport === 'streamable-http') return 'http';
      return '';
    }

    async function requestJson(path, init) {
      const response = await fetch(`${API}${path}`, {
        credentials: 'same-origin',
        ...init,
        headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
      });
      let payload;
      try {
        payload = await response.json();
      } catch {
        payload = undefined;
      }
      if (!response.ok || payload?.ok === false) {
        throw new Error(payload?.error ?? `HTTP ${response.status}`);
      }
      return payload;
    }

    /* ------------------------------------------------------------------ *
     * 图标
     * ------------------------------------------------------------------ */

    function Glyph({ size = 18 }) {
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          style: { display: 'block' },
        },
        h('circle', { cx: 5.5, cy: 12, r: 2.3 }),
        h('circle', { cx: 18.5, cy: 5.8, r: 2.3 }),
        h('circle', { cx: 18.5, cy: 18.2, r: 2.3 }),
        h('path', { d: 'M7.5 11.1 16.5 6.7' }),
        h('path', { d: 'M7.5 12.9 16.5 17.3' }),
      );
    }

    function RefreshIcon({ spinning }) {
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: 14,
          height: 14,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          className: spinning ? 'mcpPanel-spin' : undefined,
          'aria-hidden': true,
        },
        h('path', { d: 'M20 11a8 8 0 1 0-2.6 5.9' }),
        h('path', { d: 'M20 5v6h-6' }),
      );
    }

    /* ------------------------------------------------------------------ *
     * 行
     * ------------------------------------------------------------------ */

    function Switch({ on, disabled, label, onToggle }) {
      return h(
        'button',
        {
          type: 'button',
          role: 'switch',
          'aria-checked': on,
          'aria-label': label,
          title: label,
          className: 'mcpPanel-switch',
          'data-on': on ? 'true' : 'false',
          disabled,
          onClick: onToggle,
        },
        h('span', null),
      );
    }

    /** 一行配置：左键右值，作为两个网格单元给出。 */
    function detailCell(label, value, index) {
      return [
        h('span', { key: `k${index}`, className: 'mcpPanel-key' }, label),
        h('span', { key: `v${index}`, className: 'mcpPanel-val' }, value),
      ];
    }

    function ServerCard({ server, t, busy, onToggle, onTest, onRetry, expanded, onExpand }) {
      const state = server.state;
      const toggleable = server.writableFile === true;
      const tools = server.toolCount;
      const toggleBusy = busy?.kind === 'toggle';
      const testBusy = busy?.kind === 'test';
      const retryBusy = busy?.kind === 'retry';
      const testResult = busy?.result;

      const hint = state === 'idle' ? t('hint.idle')
        : state === 'failed' ? t('hint.failed')
        : state === 'disabled' ? t('hint.disabled')
        : state === 'connecting' ? t('hint.pending')
        : null;

      const fields = [
        [t('field.transport'), transportLabel(server.transport) || '—'],
      ];
      if (server.transport === 'stdio') {
        fields.push([t('field.command'), server.detail.command ?? '—']);
        if (server.detail.args?.length) fields.push(['args', server.detail.args.join(' ')]);
        if (server.detail.cwd) fields.push(['cwd', server.detail.cwd]);
        if (server.detail.envKeys?.length) fields.push([t('field.env'), server.detail.envKeys.join(', ')]);
      } else {
        fields.push([t('field.url'), server.detail.url ?? '—']);
        if (server.detail.headerKeys?.length) fields.push([t('field.headers'), server.detail.headerKeys.join(', ')]);
      }
      if (server.reconnect) {
        const { enabled = false, maxAttempts, initialDelayMs, maxDelayMs } = server.reconnect;
        fields.push([
          t('field.reconnect'),
          enabled ? `on · ${initialDelayMs ?? '?'}–${maxDelayMs ?? '?'} ms · ≤${maxAttempts ?? '?'}` : 'off',
        ]);
      }
      if (server.toolCallTimeoutMs) fields.push([t('field.timeout'), formatDuration(server.toolCallTimeoutMs)]);
      if (server.source) fields.push([t('field.source'), `${server.source}${server.patchFile ? ` · ${server.patchFile}` : ''}`]);
      fields.push([t('field.entry'), server.id]);
      const detail = fields.map(([label, value], index) => detailCell(label, value, index));

      const notes = [];
      if (hint) notes.push(h('div', { key: 'hint', className: 'mcpPanel-note' }, hint));
      if (server.error) notes.push(h('div', { key: 'error', className: 'mcpPanel-note', 'data-tone': 'bad' }, server.error));
      if (testResult) {
        notes.push(h('div', {
          key: 'test',
          className: 'mcpPanel-note',
          'data-tone': testResult.ok ? 'ok' : 'bad',
        }, testResult.ok
          ? t('test.ok', { n: testResult.toolsCount ?? 0, ms: testResult.durationMs ?? 0 })
          : `${t('test.fail')}：${testResult.error ?? ''}${testResult.durationMs !== undefined ? ` (${testResult.durationMs} ms)` : ''}`));
      }
      if (busy?.message) {
        notes.push(h('div', {
          key: 'busy',
          className: 'mcpPanel-note',
          'data-tone': busy.tone === 'bad' || busy.tone === 'ok' ? busy.tone : undefined,
        }, busy.message));
      }

      return h(
        'div',
        { className: 'mcpPanel-card' },
        h(
          'div',
          { className: 'mcpPanel-row' },
          h('span', { className: 'mcpPanel-dot', 'data-state': state, 'aria-hidden': true }),
          h(
            'div',
            { className: 'mcpPanel-id' },
            h(
              'div',
              { className: 'mcpPanel-nameLine' },
              h('span', { className: 'mcpPanel-name', title: server.serverName }, server.serverName),
              h('span', { className: 'mcpPanel-state', 'data-state': state }, stateLabel(t, state)),
              state === 'connected' || state === 'idle'
                ? h(
                  'span',
                  { className: 'mcpPanel-tools' },
                  tools === null ? `${t('unit.tools')} ?` : `${tools} ${t('unit.tools')}`,
                )
                : null,
            ),
            server.target
              ? h('div', { className: 'mcpPanel-target', title: server.target }, server.target)
              : null,
          ),
          state === 'connected' || server.disabled
            ? null
            : h(
              'button',
              {
                type: 'button',
                className: 'mcpPanel-link',
                disabled: retryBusy || testBusy || !toggleable,
                onClick: onRetry,
              },
              retryBusy ? t('action.retrying') : t('action.retry'),
            ),
          h(
            'button',
            { type: 'button', className: 'mcpPanel-link', disabled: testBusy, onClick: onTest },
            testBusy ? t('action.testing') : t('action.test'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'mcpPanel-link',
              onClick: onExpand,
              'aria-expanded': expanded,
            },
            expanded ? t('action.hideConfig') : t('action.showConfig'),
          ),
          toggleable
            ? h(Switch, {
              on: !server.disabled,
              disabled: toggleBusy || retryBusy,
              label: server.disabled ? t('action.toggleOn') : t('action.toggleOff'),
              onToggle: onToggle,
            })
            : h('span', { className: 'mcpPanel-tools', title: t('hint.notToggleable') }, t('badge.bundled')),
        ),
        expanded
          ? h(
            'div',
            { className: 'mcpPanel-detail' },
            ...detail.flat(),
            ...notes,
          )
          : null,
      );
    }

    /* ------------------------------------------------------------------ *
     * 面板
     * ------------------------------------------------------------------ */

    function Panel({ t = (key) => key }) {
      const [snapshot, setSnapshot] = useState({ loading: true, servers: [], error: null });
      const [busy, setBusy] = useState({});
      const [expanded, setExpanded] = useState({});
      const [refreshing, setRefreshing] = useState(false);
      const mounted = useRef(true);

      const load = useCallback(async () => {
        try {
          const payload = await requestJson('/servers', { method: 'GET' });
          if (!mounted.current) return;
          setSnapshot({ loading: false, servers: payload.servers ?? [], error: null, checkedAt: payload.checkedAt });
        } catch (error) {
          if (!mounted.current) return;
          setSnapshot((previous) => ({ ...previous, loading: false, error: error?.message ?? String(error) }));
        }
      }, []);

      useEffect(() => {
        mounted.current = true;
        load();
        const timer = setInterval(() => {
          if (document.visibilityState === 'visible') load();
        }, POLL_MS);
        return () => {
          mounted.current = false;
          clearInterval(timer);
        };
      }, [load]);

      const setBusyFor = useCallback((id, value) => {
        setBusy((previous) => {
          const next = { ...previous };
          if (value === undefined) delete next[id];
          else next[id] = { ...(previous[id] ?? {}), ...value };
          return next;
        });
      }, []);

      const toggle = useCallback(async (server) => {
        const id = server.id;
        const enabled = server.disabled;
        setExpanded((previous) => ({ ...previous, [id]: true }));
        setBusyFor(id, { kind: 'toggle', message: undefined, result: undefined });
        try {
          const payload = await requestJson('/toggle', {
            method: 'POST',
            body: JSON.stringify({ id, enabled }),
          });
          setBusyFor(id, {
            message: payload.settled
              ? (enabled ? t('toggle.settled') : t('toggle.disabled'))
              : t('toggle.timeout'),
            tone: payload.settled ? 'ok' : undefined,
          });
        } catch (error) {
          setBusyFor(id, { message: `${t('error.action')}：${error?.message ?? error}`, tone: 'bad' });
        } finally {
          setBusy((previous) => {
            const next = { ...previous };
            if (next[id]) next[id] = { ...next[id], kind: undefined };
            return next;
          });
          load();
        }
      }, [load, setBusyFor, t]);

      const test = useCallback(async (server) => {
        const id = server.id;
        setExpanded((previous) => ({ ...previous, [id]: true }));
        setBusyFor(id, { kind: 'test', message: undefined, result: undefined });
        try {
          const payload = await requestJson('/test', { method: 'POST', body: JSON.stringify({ id }) });
          setBusyFor(id, { result: payload.result });
        } catch (error) {
          setBusyFor(id, { result: { ok: false, error: error?.message ?? String(error) } });
        } finally {
          setBusy((previous) => {
            const next = { ...previous };
            if (next[id]) next[id] = { ...next[id], kind: undefined };
            return next;
          });
        }
      }, [setBusyFor]);

      const retry = useCallback(async (server) => {
        const id = server.id;
        setBusyFor(id, { kind: 'retry', message: undefined });
        try {
          const payload = await requestJson('/retry', { method: 'POST', body: JSON.stringify({ id }) });
          setBusyFor(id, {
            message: payload.settled ? t('toggle.settled') : t('toggle.timeout'),
            tone: payload.settled ? 'ok' : undefined,
          });
        } catch (error) {
          setBusyFor(id, { message: `${t('error.action')}：${error?.message ?? error}`, tone: 'bad' });
        } finally {
          setBusy((previous) => {
            const next = { ...previous };
            if (next[id]) next[id] = { ...next[id], kind: undefined };
            return next;
          });
          load();
        }
      }, [load, setBusyFor, t]);

      const counts = useMemo(() => {
        const result = { connected: 0, failed: 0, disabled: 0 };
        for (const server of snapshot.servers) {
          if (server.state === 'connected') result.connected += 1;
          else if (server.state === 'disabled') result.disabled += 1;
          else result.failed += 1;
        }
        return result;
      }, [snapshot.servers]);

      const refresh = useCallback(async () => {
        setRefreshing(true);
        await load();
        if (mounted.current) setRefreshing(false);
      }, [load]);

      const header = h(
        'div',
        { className: 'mcpPanel-head' },
        h('span', { style: { color: 'var(--dsw-alias-label-secondary)', display: 'flex' } }, h(Glyph, { size: 18 })),
        h(
          'div',
          { className: 'mcpPanel-headMain' },
          h('div', { className: 'mcpPanel-title' }, t('panel.title')),
          h('div', { className: 'mcpPanel-sub' }, snapshot.loading ? '…' : `${snapshot.servers.length} MCP`),
        ),
        h(
          'div',
          { className: 'mcpPanel-headActions' },
          counts.connected > 0 ? h('span', { className: 'mcpPanel-chip', 'data-tone': 'ok' }, h('i'), t('summary.connected', { n: counts.connected })) : null,
          counts.failed > 0 ? h('span', { className: 'mcpPanel-chip', 'data-tone': 'bad' }, h('i'), t('summary.failed', { n: counts.failed })) : null,
          counts.disabled > 0 ? h('span', { className: 'mcpPanel-chip' }, h('i'), t('summary.disabled', { n: counts.disabled })) : null,
          h(
            'button',
            {
              type: 'button',
              className: 'mcpPanel-iconBtn',
              title: t('panel.refresh'),
              'aria-label': t('panel.refresh'),
              onClick: refresh,
              disabled: refreshing,
            },
            h(RefreshIcon, { spinning: refreshing }),
          ),
        ),
      );

      const body = snapshot.error
        ? h('div', { className: 'mcpPanel-banner' }, `${t('error.load')}：${snapshot.error}`)
        : snapshot.loading && snapshot.servers.length === 0
          ? null
          : snapshot.servers.length === 0
            ? h(
              'div',
              { className: 'mcpPanel-empty' },
              h('div', { className: 'mcpPanel-emptyTitle' }, t('panel.empty')),
              h('div', null, t('panel.emptyHint')),
            )
            : h(
              'div',
              { className: 'mcpPanel-list' },
              ...snapshot.servers.map((server) => h(ServerCard, {
                key: server.id,
                server,
                t,
                busy: busy[server.id],
                expanded: Boolean(expanded[server.id]),
                onToggle: () => toggle(server),
                onTest: () => test(server),
                onRetry: () => retry(server),
                onExpand: () => setExpanded((previous) => ({ ...previous, [server.id]: !previous[server.id] })),
              })),
            );

      return h(
        'div',
        { className: 'mcpPanel-root' },
        h('style', { 'data-dsh-plugin': NS }, CSS),
        header,
        body,
      );
    }

    /* ------------------------------------------------------------------ *
     * 插件本体
     * ------------------------------------------------------------------ */

    return {
      name: NS,
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'dsh-mcp-panel: dictionaries');
        const t = ctx.locale.bind(NS);

        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: PANEL_ORDER,
          label: () => t('panel.title'),
          locale: NS,
        }, ({ size = 18 }) => h(Glyph, { size })));

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          locale: NS,
          inject: () => ({ t }),
        }, (props) => h(Panel, { t: props?.t ?? t })));
      },
    };
  },
});
