/**
 * Self-contained test suite for lib/status.js (status resolution, tool-name parsing,
 * call guard, system-prompt health text, config clamping, section order).
 *
 * Run from the plugin directory: node test/status.test.mjs
 * No test framework: one PASS/FAIL line per case, a final "N/M cases passed",
 * and a non-zero exit code when any case fails.
 */

import assert from 'node:assert/strict';

import {
  DEFAULT_CONFIG,
  FIBER_ACTIVE,
  FIBER_FAILED,
  buildHealthText,
  decideGuard,
  normalizeConfig,
  resolveStatus,
  sectionOrder,
  serverNameFromTool,
  summarizeServers,
} from '../lib/status.js';

const NOW = 1_700_000_000_000;
const PROBE_ASSERT_MS = DEFAULT_CONFIG.probeAssertMs;

const signalsOf = (result) => result.evidence.map((entry) => entry.signal);

const cases = [
  // ---------------------------------------------------------------- resolveStatus

  ['resolveStatus: disabled row wins over active fiber and tools', () => {
    const result = resolveStatus({
      disabled: true,
      fiberState: FIBER_ACTIVE,
      toolCount: 5,
      reachable: false,
      reachDetail: 'refused',
      reachableAt: NOW,
      probe: { ok: false, at: NOW, error: 'boom' },
      now: NOW,
    });
    assert.equal(result.state, 'disabled');
    assert.equal(result.reason, 'disabled');
  }],

  ['resolveStatus: fiber FAILED → failed/fiber-failed', () => {
    const result = resolveStatus({
      fiberState: FIBER_FAILED,
      toolCount: 3,
      reachable: false,
      reachDetail: 'refused',
      probe: { ok: false, at: NOW, error: 'boom' },
      now: NOW,
    });
    assert.equal(result.state, 'failed');
    assert.equal(result.reason, 'fiber-failed');
  }],

  ['resolveStatus: fiber null/0/1 → pending/pending', () => {
    for (const fiberState of [null, 0, 1, undefined]) {
      const result = resolveStatus({
        fiberState,
        toolCount: 0,
        reachable: false,
        reachDetail: 'refused',
        now: NOW,
      });
      assert.equal(result.state, 'pending', `fiberState=${String(fiberState)}`);
      assert.equal(result.reason, 'pending', `fiberState=${String(fiberState)}`);
    }
  }],

  ['resolveStatus: probe failed + TCP refused → unreachable/probe-failed', () => {
    const result = resolveStatus({
      fiberState: FIBER_ACTIVE,
      toolCount: 3,
      reachable: false,
      reachDetail: 'refused',
      reachableAt: NOW,
      probe: { ok: false, at: NOW, error: 'connect ECONNREFUSED' },
      now: NOW,
    });
    assert.equal(result.state, 'unreachable');
    assert.equal(result.reason, 'probe-failed');
  }],

  ['resolveStatus: probe failed + TCP ok + fresh probe → unreachable/probe-failed', () => {
    const result = resolveStatus({
      fiberState: FIBER_ACTIVE,
      toolCount: 3,
      reachable: true,
      reachableAt: NOW,
      probe: { ok: false, at: NOW - 1000, error: 'handshake failed' },
      now: NOW,
      probeAssertMs: PROBE_ASSERT_MS,
    });
    assert.ok(NOW - (NOW - 1000) < PROBE_ASSERT_MS, 'probe must be inside the assertion window');
    assert.equal(result.state, 'unreachable');
    assert.equal(result.reason, 'probe-failed');
  }],

  ['resolveStatus: probe failed + TCP ok + stale probe → connected (not unreachable)', () => {
    const result = resolveStatus({
      fiberState: FIBER_ACTIVE,
      toolCount: 3,
      reachable: true,
      reachableAt: NOW,
      probe: { ok: false, at: NOW - PROBE_ASSERT_MS - 1, error: 'handshake failed' },
      now: NOW,
      probeAssertMs: PROBE_ASSERT_MS,
    });
    assert.notEqual(result.state, 'unreachable');
    assert.equal(result.state, 'connected');
    assert.equal(result.reason, 'connected');
  }],

  ['resolveStatus: TCP refused without probe → unreachable/tcp-refused', () => {
    const result = resolveStatus({
      fiberState: FIBER_ACTIVE,
      toolCount: 3,
      reachable: false,
      reachDetail: 'refused',
      reachableAt: NOW,
      now: NOW,
    });
    assert.equal(result.state, 'unreachable');
    assert.equal(result.reason, 'tcp-refused');
  }],

  ['resolveStatus: TCP ok + 0 tools → idle/no-tools (not unreachable)', () => {
    const result = resolveStatus({
      fiberState: FIBER_ACTIVE,
      toolCount: 0,
      reachable: true,
      reachDetail: 'ok',
      reachableAt: NOW,
      now: NOW,
    });
    assert.equal(result.state, 'idle');
    assert.equal(result.reason, 'no-tools');
    assert.notEqual(result.state, 'unreachable');
  }],

  ['resolveStatus: TCP ok + 49 tools → connected', () => {
    const result = resolveStatus({
      fiberState: FIBER_ACTIVE,
      toolCount: 49,
      reachable: true,
      reachDetail: 'ok',
      reachableAt: NOW,
      now: NOW,
    });
    assert.equal(result.state, 'connected');
    assert.equal(result.reason, 'connected');
  }],

  ['resolveStatus: unreadable tool registry → connected/unknown-tools', () => {
    for (const toolCount of [null, undefined]) {
      const result = resolveStatus({
        fiberState: FIBER_ACTIVE,
        toolCount,
        now: NOW,
      });
      assert.equal(result.state, 'connected', `toolCount=${String(toolCount)}`);
      assert.equal(result.reason, 'unknown-tools', `toolCount=${String(toolCount)}`);
    }
  }],

  ['resolveStatus: evidence carries fiber/tools/tcp (+probe only when supplied)', () => {
    const reachableAt = NOW - 1234;
    const base = {
      fiberState: FIBER_ACTIVE,
      toolCount: 7,
      reachable: false,
      reachDetail: 'refused',
      reachableAt,
      now: NOW,
    };

    const withoutProbe = resolveStatus(base);
    assert.deepEqual(signalsOf(withoutProbe), ['fiber', 'tools', 'tcp']);
    assert.deepEqual(withoutProbe.evidence[0], { signal: 'fiber', value: 'active', at: null });
    assert.deepEqual(withoutProbe.evidence[1], { signal: 'tools', value: 7, at: null });
    assert.deepEqual(withoutProbe.evidence[2], { signal: 'tcp', value: 'refused', at: reachableAt });
    assert.equal(withoutProbe.evidence.find((entry) => entry.signal === 'probe'), undefined);

    const withProbe = resolveStatus({
      ...base,
      probe: { ok: false, at: NOW - 500, error: 'connect ECONNREFUSED' },
    });
    assert.deepEqual(signalsOf(withProbe), ['fiber', 'tools', 'tcp', 'probe']);
    assert.deepEqual(withProbe.evidence[3], {
      signal: 'probe',
      value: 'failed',
      at: NOW - 500,
      detail: 'connect ECONNREFUSED',
    });
  }],

  // ------------------------------------------------- host connection status

  ['resolveStatus: host connecting → pending/client-connecting', () => {
    const result = resolveStatus({
      fiberState: FIBER_ACTIVE,
      connection: { state: 'connecting' },
      toolCount: 0,
      now: NOW,
    });
    assert.equal(result.state, 'pending');
    assert.equal(result.reason, 'client-connecting');
  }],

  ['resolveStatus: host reconnecting → reconnecting + attempt in evidence', () => {
    const result = resolveStatus({
      fiberState: FIBER_ACTIVE,
      connection: { state: 'reconnecting', attempt: 3, maxAttempts: 10 },
      toolCount: 0,
      now: NOW,
    });
    assert.equal(result.state, 'reconnecting');
    assert.equal(result.reason, 'client-reconnecting');
    assert.deepEqual(result.evidence.at(-1), {
      signal: 'client',
      value: 'reconnecting',
      at: null,
      detail: '3/10',
    });
  }],

  ['resolveStatus: host gave up wins over a successful probe (no more fake green)', () => {
    const result = resolveStatus({
      fiberState: FIBER_ACTIVE,
      connection: { state: 'failed', reason: 'gave-up', maxAttempts: 10, lastError: 'connect ECONNREFUSED' },
      toolCount: 0,
      reachable: true,
      reachableAt: NOW,
      probe: { ok: true, at: NOW, toolsCount: 49 },
      now: NOW,
    });
    assert.equal(result.state, 'failed');
    assert.equal(result.reason, 'gave-up');
  }],

  ['resolveStatus: host failed (other reasons) → failed/client-failed', () => {
    for (const reason of ['unclosed-generation', 'reconnect-disabled', undefined]) {
      const result = resolveStatus({
        fiberState: FIBER_ACTIVE,
        connection: reason === undefined ? { state: 'failed' } : { state: 'failed', reason },
        toolCount: 2,
        now: NOW,
      });
      assert.equal(result.state, 'failed', `reason=${String(reason)}`);
      assert.equal(result.reason, 'client-failed', `reason=${String(reason)}`);
    }
  }],

  ['resolveStatus: host closed / waiting-credentials → failed', () => {
    const closed = resolveStatus({
      fiberState: FIBER_ACTIVE, connection: { state: 'closed' }, toolCount: 0, now: NOW,
    });
    assert.equal(closed.state, 'failed');
    assert.equal(closed.reason, 'client-closed');

    const waiting = resolveStatus({
      fiberState: FIBER_ACTIVE, connection: { state: 'waiting-credentials' }, toolCount: 0, now: NOW,
    });
    assert.equal(waiting.state, 'failed');
    assert.equal(waiting.reason, 'waiting-credentials');
  }],

  ['resolveStatus: host connected + tools → connected, client evidence present', () => {
    const result = resolveStatus({
      fiberState: FIBER_ACTIVE,
      connection: { state: 'connected' },
      toolCount: 49,
      reachable: true,
      reachDetail: 'ok',
      reachableAt: NOW,
      now: NOW,
    });
    assert.equal(result.state, 'connected');
    assert.equal(result.reason, 'connected');
    assert.equal(result.evidence.at(-1).signal, 'client');
  }],

  ['resolveStatus: host connected but a fresh failed probe still means unreachable', () => {
    const result = resolveStatus({
      fiberState: FIBER_ACTIVE,
      connection: { state: 'connected' },
      toolCount: 3,
      reachable: true,
      reachDetail: 'ok',
      reachableAt: NOW,
      probe: { ok: false, at: NOW, error: 'handshake failed' },
      now: NOW,
      probeAssertMs: PROBE_ASSERT_MS,
    });
    assert.equal(result.state, 'unreachable');
    assert.equal(result.reason, 'probe-failed');
  }],

  ['resolveStatus: host connected + 0 tools → idle/no-tools', () => {
    const result = resolveStatus({
      fiberState: FIBER_ACTIVE,
      connection: { state: 'connected' },
      toolCount: 0,
      now: NOW,
    });
    assert.equal(result.state, 'idle');
    assert.equal(result.reason, 'no-tools');
  }],

  ['resolveStatus: unknown host state falls back to observational derivation', () => {
    const result = resolveStatus({
      fiberState: FIBER_ACTIVE,
      connection: { state: 'some-future-state' },
      toolCount: 4,
      reachable: true,
      reachDetail: 'ok',
      reachableAt: NOW,
      now: NOW,
    });
    assert.equal(result.state, 'connected');
    assert.equal(result.reason, 'connected');
  }],

  // ---------------------------------------------------------- serverNameFromTool

  ['serverNameFromTool: extracts the server segment of an MCP tool name', () => {
    assert.equal(serverNameFromTool('mcp__unityMCP__manage_scene'), 'unityMCP');
    assert.equal(serverNameFromTool('mcp__a_b__x'), 'a_b');
    assert.equal(serverNameFromTool('bash'), undefined);
    assert.equal(serverNameFromTool('mcp____x'), undefined);
    assert.equal(serverNameFromTool('mcp__lonely'), undefined);
  }],

  // ----------------------------------------------------------------- decideGuard

  ['decideGuard: unreachable row with fresh snapshot is refused with server + probe error', () => {
    const message = decideGuard({
      toolName: 'mcp__unityMCP__manage_scene',
      row: {
        serverName: 'unityMCP',
        target: 'http://127.0.0.1:9/mcp',
        state: 'unreachable',
        probe: { ok: false, error: 'connect ECONNREFUSED 127.0.0.1:9' },
      },
      snapshotAt: NOW - 1000,
      now: NOW,
      config: DEFAULT_CONFIG,
    });
    assert.equal(typeof message, 'string');
    assert.ok(message.length > 0);
    assert.ok(message.includes('unityMCP'), message);
    assert.ok(message.includes('connect ECONNREFUSED 127.0.0.1:9'), message);
  }],

  ['decideGuard: snapshot older than 2 × refreshMs is stale → undefined', () => {
    const message = decideGuard({
      toolName: 'mcp__unityMCP__manage_scene',
      row: {
        serverName: 'unityMCP',
        target: 'http://127.0.0.1:9/mcp',
        state: 'unreachable',
        probe: { ok: false, error: 'connect ECONNREFUSED' },
      },
      snapshotAt: NOW - DEFAULT_CONFIG.refreshMs * 2 - 1,
      now: NOW,
      config: DEFAULT_CONFIG,
    });
    assert.equal(message, undefined);
  }],

  ['decideGuard: idle/connected/absent rows are never refused', () => {
    const config = DEFAULT_CONFIG;
    const common = { toolName: 'mcp__unityMCP__manage_scene', snapshotAt: NOW - 1000, now: NOW, config };
    assert.equal(decideGuard({ ...common, row: { serverName: 'x', state: 'idle', target: 't' } }), undefined);
    assert.equal(decideGuard({ ...common, row: { serverName: 'x', state: 'connected', target: 't' } }), undefined);
    assert.equal(decideGuard({ ...common, row: undefined }), undefined);
    assert.equal(decideGuard({ ...common, row: null }), undefined);
  }],

  ['decideGuard: guardUnreachable:false disarms the guard', () => {
    const message = decideGuard({
      toolName: 'mcp__unityMCP__manage_scene',
      row: { serverName: 'unityMCP', target: 'http://127.0.0.1:9/mcp', state: 'unreachable' },
      snapshotAt: NOW - 1000,
      now: NOW,
      config: normalizeConfig({ guardUnreachable: false }),
    });
    assert.equal(message, undefined);
  }],

  ['decideGuard: failed row without probe yields a one-line message naming the server', () => {
    const message = decideGuard({
      toolName: 'mcp__broken__do_thing',
      row: { serverName: 'broken', target: 'stdio:node server.mjs', state: 'failed' },
      snapshotAt: NOW - 1000,
      now: NOW,
      config: DEFAULT_CONFIG,
    });
    assert.equal(typeof message, 'string');
    assert.ok(message.includes('broken'), message);
    assert.ok(!message.includes('\n'), 'guard message must stay one line');
  }],

  ['decideGuard: reconnecting row is refused with the attempt count', () => {
    const message = decideGuard({
      toolName: 'mcp__unityMCP__manage_scene',
      row: {
        serverName: 'unityMCP',
        target: 'http://127.0.0.1:9/mcp',
        state: 'reconnecting',
        connection: { state: 'reconnecting', attempt: 4, maxAttempts: 10 },
      },
      snapshotAt: NOW - 1000,
      now: NOW,
      config: DEFAULT_CONFIG,
    });
    assert.equal(typeof message, 'string');
    assert.ok(message.includes('reconnecting'), message);
    assert.ok(message.includes('4 of 10'), message);
  }],

  ['decideGuard: gave-up row explains the attempt limit', () => {
    const message = decideGuard({
      toolName: 'mcp__unityMCP__manage_scene',
      row: {
        serverName: 'unityMCP',
        target: 'http://127.0.0.1:9/mcp',
        state: 'failed',
        reason: 'gave-up',
        connection: { state: 'failed', reason: 'gave-up', maxAttempts: 10 },
      },
      snapshotAt: NOW - 1000,
      now: NOW,
      config: DEFAULT_CONFIG,
    });
    assert.equal(typeof message, 'string');
    assert.ok(message.includes('gave up after 10'), message);
  }],

  // ------------------------------------------------------------ buildHealthText

  ['buildHealthText: no unhealthy rows → empty string', () => {
    assert.equal(buildHealthText({ servers: [] }, { now: NOW }), '');
    assert.equal(buildHealthText({ servers: [{ state: 'connected' }, { state: 'idle' }] }, { now: NOW }), '');
    assert.equal(buildHealthText(undefined, { now: NOW }), '');
  }],

  ['buildHealthText: one unreachable row → header, server, target and age', () => {
    const text = buildHealthText({
      servers: [{
        serverName: 'unityMCP',
        target: 'http://127.0.0.1:9/mcp',
        state: 'unreachable',
        reachDetail: 'refused',
        checkedAt: NOW - 5000,
      }],
    }, { now: NOW });
    assert.ok(text.includes('## MCP servers currently unavailable'), text);
    assert.ok(text.includes('unityMCP'), text);
    assert.ok(text.includes('http://127.0.0.1:9/mcp'), text);
    assert.ok(text.includes('checked 5s ago'), text);
    assert.ok(text.length <= 800, text);
  }],

  ['buildHealthText: 9 unhealthy rows → 6 bullets + "…and 3 more"', () => {
    const servers = Array.from({ length: 9 }, (_, index) => ({
      serverName: `s${index + 1}`,
      target: `t${index + 1}`,
      state: 'unreachable',
    }));
    const text = buildHealthText({ servers }, { now: NOW });
    const bullets = text.split('\n').filter((line) => line.startsWith('- '));
    const overflow = bullets.filter((line) => line.includes('…and 3 more'));
    assert.equal(overflow.length, 1, text);
    assert.equal(bullets.length - overflow.length, 6, text);
    assert.ok(text.includes('s6'), text);
    assert.ok(!text.includes('s7'), text);
    assert.ok(text.length <= 800, text);
  }],

  ['buildHealthText: respects explicit maxChars and marks truncation with …', () => {
    const servers = Array.from({ length: 15 }, (_, index) => ({
      serverName: `server-${index + 1}-${'x'.repeat(40)}`,
      target: `http://127.0.0.1:${9000 + index}/${'y'.repeat(120)}`,
      state: 'unreachable',
      reachDetail: 'timeout',
      checkedAt: NOW - index * 1000,
    }));
    const text = buildHealthText({ servers }, { now: NOW, maxChars: 120 });
    assert.ok(text.length <= 120, `length=${text.length}`);
    assert.equal(text.length, 120);
    assert.ok(text.endsWith('…'), text);
  }],

  ['buildHealthText: gave-up row says the client stopped reconnecting', () => {
    const text = buildHealthText({
      servers: [{
        serverName: 'unityMCP',
        target: 'http://127.0.0.1:8080/mcp',
        state: 'failed',
        reason: 'gave-up',
        toolCount: 0,
        checkedAt: NOW,
      }],
    }, { now: NOW });
    assert.ok(text.includes('reconnect gave up'), text);
    assert.ok(text.includes('unityMCP'), text);
  }],

  // ------------------------------------------------------------- normalizeConfig

  ['normalizeConfig: defaults, floors, type guards and unknown keys', () => {
    // defaults for missing / garbage input
    assert.deepEqual(normalizeConfig(undefined), DEFAULT_CONFIG);
    assert.deepEqual(normalizeConfig(null), DEFAULT_CONFIG);
    assert.deepEqual(normalizeConfig('garbage'), DEFAULT_CONFIG);
    assert.deepEqual(normalizeConfig(42), DEFAULT_CONFIG);
    assert.deepEqual(normalizeConfig([]), DEFAULT_CONFIG);

    // refreshMs floor is 2000ms; other timeouts floor at 1000ms
    assert.equal(normalizeConfig({ refreshMs: 10 }).refreshMs, 2000);
    assert.equal(normalizeConfig({ startupWaitMs: 10 }).startupWaitMs, 1000);
    assert.equal(normalizeConfig({ probeAssertMs: 10.6 }).probeAssertMs, 1000);

    // non-numeric values are ignored, not coerced
    assert.deepEqual(
      normalizeConfig({
        refreshMs: '5000',
        startupWaitMs: Number.NaN,
        probeAssertMs: Number.POSITIVE_INFINITY,
      }),
      DEFAULT_CONFIG,
    );

    // booleans only accepted when actually boolean
    assert.equal(normalizeConfig({ promptHealth: 'false' }).promptHealth, true);
    assert.equal(normalizeConfig({ guardUnreachable: 0 }).guardUnreachable, true);
    assert.equal(normalizeConfig({ guardUnreachable: false }).guardUnreachable, false);

    // unknown keys dropped, known ones merged onto defaults
    const config = normalizeConfig({ refreshMs: 5000, promptHealth: false, nope: 'x' });
    assert.deepEqual(config, { ...DEFAULT_CONFIG, refreshMs: 5000, promptHealth: false });
  }],

  // --------------------------------------------------------------- sectionOrder

  ['sectionOrder: registry answer, throwing registry, missing method', () => {
    assert.equal(sectionOrder({ getSectionOrder: () => 7 }), 7);
    assert.equal(sectionOrder({ getSectionOrder: () => 7 }, 'MCP_SERVERS', 3), 7);

    const throwing = { getSectionOrder: () => { throw new Error('registry exploded'); } };
    assert.equal(sectionOrder(throwing), 50);
    assert.equal(sectionOrder(throwing, 'MCP_SERVERS', 7), 7);

    assert.equal(sectionOrder({}), 50);
    assert.equal(sectionOrder(undefined), 50);
    assert.equal(sectionOrder({ getSectionOrder: () => '7' }, 'MCP_SERVERS', 50), 50);
  }],

  // ------------------------------------------------------------ summarizeServers
  //
  // 这是侧栏角标唯一的输入。它只做聚合，所以用例守的是「哪些状态配点亮侧栏」这条边界，
  // 尤其是 A3：idle（没有工具）不是断线，绝不能让侧栏变红。

  ['summarizeServers: all connected → ok, no attention', () => {
    const summary = summarizeServers([
      { id: 'a', serverName: 'alpha', state: 'connected', reason: 'connected' },
      { id: 'b', serverName: 'beta', state: 'connected', reason: 'connected' },
    ]);
    assert.equal(summary.worst, 'ok');
    assert.equal(summary.counts.total, 2);
    assert.equal(summary.counts.connected, 2);
    assert.deepEqual(summary.names, []);
    assert.equal(summary.attention.length, 0);
  }],

  ['summarizeServers: failed → bad, with name and reason', () => {
    const summary = summarizeServers([
      { id: 'u', serverName: 'unityMCP', state: 'failed', reason: 'gave-up' },
      { id: 'a', serverName: 'alpha', state: 'connected', reason: 'connected' },
    ]);
    assert.equal(summary.worst, 'bad');
    assert.equal(summary.counts.unhealthy, 1);
    assert.deepEqual(summary.names, ['unityMCP']);
    assert.equal(summary.attention[0].reason, 'gave-up');
  }],

  ['summarizeServers: reconnecting alone → warn, failed outranks it', () => {
    const warn = summarizeServers([{ id: 'a', serverName: 'alpha', state: 'reconnecting', reason: 'client-reconnecting' }]);
    assert.equal(warn.worst, 'warn');
    assert.equal(warn.counts.reconnecting, 1);

    const bad = summarizeServers([
      { id: 'a', serverName: 'alpha', state: 'reconnecting', reason: 'client-reconnecting' },
      { id: 'b', serverName: 'beta', state: 'unreachable', reason: 'tcp-refused' },
    ]);
    assert.equal(bad.worst, 'bad');
    // 先出现的 warn 不能让后面更糟的 bad 被吞掉
    assert.equal(bad.attention.length, 2);
  }],

  ['summarizeServers: idle/pending are not errors (A3)', () => {
    const idle = summarizeServers([{ id: 'a', serverName: 'alpha', state: 'idle', reason: 'no-tools' }]);
    assert.equal(idle.worst, 'idle');
    assert.equal(idle.counts.unhealthy, 0);
    assert.equal(idle.counts.reconnecting, 0);
    assert.deepEqual(idle.names, []);

    const pending = summarizeServers([{ id: 'a', serverName: 'alpha', state: 'pending', reason: 'pending' }]);
    assert.equal(pending.worst, 'idle');
    assert.deepEqual(pending.names, []);

    // 和闸门对齐：同一行 decideGuard 放行，角标就不该亮。
    const row = { state: 'idle', reason: 'no-tools', serverName: 'alpha', connection: undefined };
    assert.equal(decideGuard({ toolName: 'mcp__alpha__ping', row, snapshotAt: NOW, now: NOW }), undefined);
    assert.notEqual(idle.worst, 'bad');
  }],

  ['summarizeServers: disabled excluded, empty and unknown stay quiet', () => {
    const disabled = summarizeServers([{ id: 'a', serverName: 'alpha', state: 'disabled', reason: 'disabled' }]);
    assert.equal(disabled.worst, 'disabled');
    assert.equal(disabled.counts.disabled, 1);
    assert.deepEqual(disabled.names, []);

    const empty = summarizeServers([]);
    assert.equal(empty.worst, 'empty');
    assert.equal(empty.counts.total, 0);

    // 宿主给了没见过的新状态：不猜、不报警，只记个数。
    const unknown = summarizeServers([{ id: 'a', serverName: 'alpha', state: 'brand-new-state' }]);
    assert.equal(unknown.counts.unknown, 1);
    assert.deepEqual(unknown.names, []);
    assert.equal(unknown.worst, 'empty');
  }],

  ['summarizeServers: names are capped, the rest become a count', () => {
    const rows = Array.from({ length: 5 }, (_, index) => ({
      id: `s${index}`, serverName: `srv${index}`, state: 'failed', reason: 'client-failed',
    }));
    const summary = summarizeServers(rows, { maxNames: 2 });
    assert.deepEqual(summary.names, ['srv0', 'srv1']);
    assert.equal(summary.more, 3);
    assert.equal(summary.attention.length, 2);
  }],

  ['summarizeServers: signature tracks state and reason changes', () => {
    const rows = [{ id: 'a', serverName: 'alpha', state: 'connected', reason: 'connected' }];
    const before = summarizeServers(rows).signature;
    const after = summarizeServers([
      { id: 'a', serverName: 'alpha', state: 'failed', reason: 'client-failed' },
    ]).signature;
    assert.notEqual(before, after);
    assert.equal(summarizeServers(rows).signature, before);
  }],
];


let failed = 0;
for (const [name, body] of cases) {
  try {
    body();
    console.log(`PASS  ${name}`);
  } catch (err) {
    failed += 1;
    const detail = String(err?.message ?? err).split('\n')[0];
    console.log(`FAIL  ${name}\n      ${detail}`);
  }
}

console.log(`${cases.length - failed}/${cases.length} cases passed`);
process.exit(failed === 0 ? 0 : 1);
