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

  // ----------------------------------------------------------- serverNameFromTool

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
