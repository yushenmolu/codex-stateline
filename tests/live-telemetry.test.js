import test from 'node:test';
import assert from 'node:assert/strict';
import { createLiveTelemetry, publicLiveSnapshot, unavailableLiveSnapshot } from '../src/telemetry/live-telemetry.js';

const THREAD = '123e4567-e89b-12d3-a456-426614170001';
const OTHER = '123e4567-e89b-12d3-a456-426614170002';
const TURN = '123e4567-e89b-12d3-a456-426614170003';
const NOW = Date.parse('2026-10-18T04:00:00.000Z');
const USAGE = { inputTokens: 100, outputTokens: 20, totalTokens: 120 };

function setup(options = {}) {
  let hooks, starts = 0, stops = 0, mono = 0, now = NOW;
  const live = createLiveTelemetry({
    wallClock: () => now, monotonicClock: () => mono,
    connector: (callbacks) => {
      hooks = callbacks;
      return { start() { starts++; }, stop() { stops++; } };
    }, ...options,
  });
  live.ensureStarted();
  const emit = (event) => hooks.observe({ observedAt: new Date(now).toISOString(), ...event });
  const thread = (id = THREAD, primary = true, state = 'active') => emit({ type: 'thread', threadId: id, primary, state });
  const turn = (id = THREAD) => emit({ type: 'turn_started', threadId: id, turnId: TURN, startedAt: new Date(now).toISOString() });
  const usage = (data = USAGE, id = THREAD) => emit({ type: 'usage', threadId: id, turnId: TURN, usage: data });
  return {
    live, emit, thread, turn, usage,
    connect: () => hooks.status({ connected: true, source: 'codex_app_server' }),
    disconnect: () => hooks.status({ connected: false, source: 'codex_app_server', reason: 'source_disconnected' }),
    advance(ms) { now += ms; mono += ms; },
    get counts() { return { starts, stops }; },
  };
}

test('live starts once, waits for a source, and never consults session logs', async () => {
  const s = setup();
  s.live.ensureStarted();
  assert.deepEqual(s.counts, { starts: 1, stops: 0 });
  assert.equal(s.live.snapshot().state, 'unavailable');
  assert.equal(s.live.snapshot().reason, 'connecting');
  await s.live.stop(); await s.live.stop();
  assert.deepEqual(s.counts, { starts: 1, stops: 1 });
  s.connect(); s.thread(); s.turn(); s.usage();
  assert.equal(s.live.snapshot().state, 'unavailable');
  assert.equal(s.live.snapshot().usage, null);
});

test('live separates active state from confirmed counters and labels the actual scope', () => {
  const s = setup(); s.connect(); s.thread(); s.turn();
  const waiting = s.live.snapshot();
  assert.equal(waiting.state, 'waiting');
  assert.equal(waiting.usage, null);
  assert.equal(waiting.lifecycle.state, 'running');
  s.usage();
  assert.deepEqual(s.live.snapshot().usage, { scope: 'conversation', includesSubagents: false, ...USAGE });
  assert.equal(s.live.snapshot().state, 'available');
  assert.equal(s.live.snapshot().model, null);
  assert.equal(s.live.snapshot().reasoningEffort, null);
  assert.equal(s.live.snapshot().speed, null);
});

test('live requires exact thread and turn identity and never guesses from an unknown usage event', () => {
  const s = setup(); s.connect(); s.usage();
  assert.equal(s.live.snapshot().session, null);
  s.thread(); s.turn();
  s.emit({ type: 'usage', threadId: THREAD, turnId: OTHER, usage: USAGE });
  assert.equal(s.live.snapshot().usage, null);
  s.usage(USAGE, OTHER);
  assert.equal(s.live.snapshot({ taskId: OTHER }).session, null);
  s.usage();
  assert.equal(s.live.snapshot({ taskId: OTHER }).reason, 'thread_not_observed');
  assert.equal(s.live.snapshot({ taskId: THREAD }).usage.totalTokens, 120);
});

test('live follow uses one active primary thread and reports ambiguity instead of choosing the latest log', () => {
  const s = setup(); s.connect(); s.thread(); s.turn(); s.usage();
  s.thread(OTHER, false);
  assert.equal(s.live.snapshot().session.id, THREAD);
  s.thread(OTHER, true);
  assert.equal(s.live.snapshot().state, 'ambiguous');
  assert.equal(s.live.snapshot().usage, null);
  assert.equal(s.live.snapshot({ taskId: THREAD }).usage.totalTokens, 120);
  s.thread(OTHER, true, 'idle');
  assert.equal(s.live.snapshot().session.id, THREAD);
});

test('live sampling time cannot advance the event timestamp or revive a disconnected source', () => {
  const s = setup(); s.connect(); s.thread(); s.turn(); s.usage();
  const first = s.live.snapshot(); s.advance(1_000);
  const second = s.live.snapshot();
  assert.equal(second.observedAt, first.observedAt);
  assert.notEqual(second.sampledAt, first.sampledAt);
  s.disconnect();
  assert.equal(s.live.snapshot().state, 'disconnected');
  assert.equal(s.live.snapshot().usage, null);
  s.connect();
  assert.equal(s.live.snapshot().session, null);
});

test('live liveness expires using monotonic time and heartbeats do not invent new usage', () => {
  const s = setup({ staleMs: 100 }); s.connect(); s.thread(); s.turn(); s.usage();
  const first = s.live.snapshot(); s.advance(101);
  assert.equal(s.live.snapshot().reason, 'source_stale');
  s.emit({ type: 'heartbeat' });
  assert.equal(s.live.snapshot().usage.totalTokens, 120);
  assert.equal(s.live.snapshot().observedAt, first.observedAt);
});

test('live rejects malformed, future and out-of-order counters but accepts a confirmed zero', () => {
  const s = setup(); s.connect(); s.thread(); s.turn();
  for (const invalid of [null, { inputTokens: 1, outputTokens: 1, totalTokens: 3 }, { inputTokens: -1, outputTokens: 1, totalTokens: 0 }, { inputTokens: 1.5, outputTokens: 1, totalTokens: 2.5 }]) s.usage(invalid);
  assert.equal(s.live.snapshot().usage, null);
  s.emit({ type: 'usage', threadId: THREAD, turnId: TURN, usage: USAGE, observedAt: new Date(NOW + 6_000).toISOString() });
  assert.equal(s.live.snapshot().usage, null);
  s.usage({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  assert.equal(s.live.snapshot().usage.totalTokens, 0);
  s.emit({ type: 'usage', threadId: THREAD, turnId: TURN, usage: USAGE, observedAt: new Date(NOW - 1).toISOString() });
  assert.equal(s.live.snapshot().usage.totalTokens, 0);
});

test('live completed state keeps confirmed conversation usage only when explicitly pinned', () => {
  const s = setup(); s.connect(); s.thread(); s.turn(); s.usage(); s.advance(10_000);
  s.emit({ type: 'turn_completed', threadId: THREAD, turnId: TURN, state: 'completed', startedAt: new Date(NOW).toISOString(), completedAt: new Date(NOW + 10_000).toISOString(), elapsedSeconds: 10 });
  assert.equal(s.live.snapshot().reason, 'no_active_thread');
  const pinned = s.live.snapshot({ taskId: THREAD });
  assert.equal(pinned.lifecycle.state, 'completed');
  assert.equal(pinned.lifecycle.elapsedSeconds, 10);
  assert.equal(pinned.usage.totalTokens, 120);
  s.emit({ type: 'removed', threadId: THREAD });
  assert.equal(s.live.snapshot({ taskId: THREAD }).usage, null);
});

test('live caps retained thread metadata and connector failures stay bounded', async () => {
  const s = setup({ maxThreads: 1 }); s.connect(); s.thread(); s.thread(OTHER);
  assert.equal(s.live.snapshot({ taskId: OTHER }).usage, null);
  const failing = createLiveTelemetry({ connector() { throw Error('private config secret'); }, wallClock: () => NOW });
  failing.ensureStarted();
  assert.equal(failing.snapshot().reason, 'source_unavailable');
  assert.equal(JSON.stringify(failing.snapshot()).includes('private'), false);
  await failing.stop();
});

test('live HTTP projection allowlists every layer and enforces requested conversation identity', () => {
  const value = {
    sampledAt: new Date(NOW).toISOString(), state: 'available', source: 'codex_app_server', reason: null,
    observedAt: new Date(NOW).toISOString(), session: { id: THREAD, preview: 'private-text' },
    usage: { scope: 'conversation', includesSubagents: false, ...USAGE, secret: 'private-text' },
    model: 'example-provider/gpt-6.1-sol', reasoningEffort: 'ultra',
    lifecycle: { state: 'running', startedAt: new Date(NOW).toISOString(), completedAt: null, elapsedSeconds: null, text: 'private-text' },
    speed: { source: 'confirmed_request', outputTokensPerSecond: 3, observedAt: new Date(NOW).toISOString(), headers: 'private-text' },
    raw: 'private-text',
  };
  const out = publicLiveSnapshot(value, { taskId: THREAD, now: NOW });
  assert.equal(JSON.stringify(out).includes('private-text'), false);
  assert.deepEqual(Object.keys(out), ['sampledAt', 'state', 'source', 'reason', 'observedAt', 'session', 'usage', 'model', 'reasoningEffort', 'lifecycle', 'speed']);
  assert.deepEqual(out.session, { id: THREAD });
  assert.equal(out.usage.totalTokens, 120);
  assert.equal(publicLiveSnapshot(value, { taskId: OTHER, now: NOW }).usage, null);
  assert.deepEqual(publicLiveSnapshot({ state: 'available', source: 'log' }, { now: NOW }), unavailableLiveSnapshot('source_invalid', NOW));
  assert.equal(publicLiveSnapshot({ ...value, state: 'disconnected' }, { now: NOW }).usage, null);
});

test('desktop conversation counters need no fabricated turn identity and null usage clears independently', () => {
  const s = setup(); s.connect();
  s.emit({ type: 'conversation', threadId: THREAD, primary: true, state: 'active', usage: USAGE });
  assert.equal(s.live.snapshot().usage.totalTokens, 120);
  assert.equal(s.live.snapshot().lifecycle.state, 'running');
  assert.equal(s.live.snapshot().lifecycle.startedAt, null);
  s.emit({ type: 'conversation', threadId: THREAD, primary: true, state: 'active', usage: null });
  assert.equal(s.live.snapshot().usage, null);
  s.emit({ type: 'conversation', threadId: THREAD, primary: true, state: 'idle', usage: USAGE });
  assert.equal(s.live.snapshot().usage, null);
  assert.equal(s.live.snapshot({ taskId: THREAD }).usage.totalTokens, 120);
});

test('unverified ancestry cannot silently become the unique active primary', () => {
  const s = setup(); s.connect();
  s.emit({ type: 'conversation', threadId: THREAD, primary: null, state: 'active', usage: USAGE });
  assert.equal(s.live.snapshot().reason, 'identity_unverified');
  assert.equal(s.live.snapshot({ taskId: THREAD }).usage.totalTokens, 120);
  s.emit({ type: 'conversation', threadId: OTHER, primary: true, state: 'active', usage: USAGE });
  assert.equal(s.live.snapshot().state, 'ambiguous');
  s.emit({ type: 'conversation', threadId: THREAD, primary: false, state: 'active', usage: USAGE });
  assert.equal(s.live.snapshot().session.id, OTHER);
});

test('live estimates observed output from same-conversation usage updates with a verifiable denominator', () => {
  const s = setup(); s.connect();
  const conversation = (usage) => s.emit({ type: 'conversation', threadId: THREAD, primary: true, state: 'active', usage });
  conversation(USAGE);
  assert.equal(s.live.snapshot().speed, null);
  s.advance(20_000);
  conversation({ inputTokens: 200, outputTokens: 80, totalTokens: 280 });
  const speed = s.live.snapshot().speed;
  assert.deepEqual(speed, {
    source: 'observed_window', outputTokensPerSecond: 3, outputTokens: 60, elapsedSeconds: 20,
    startedAt: new Date(NOW).toISOString(), observedAt: new Date(NOW + 20_000).toISOString(), includesToolsAndWait: true,
  });
  s.advance(10_000);
  conversation({ inputTokens: 200, outputTokens: 80, totalTokens: 280 });
  assert.deepEqual(s.live.snapshot().speed, speed, 'unrelated IPC patches cannot advance the speed timestamp');
  s.advance(50_001); s.emit({ type: 'heartbeat' });
  assert.equal(s.live.snapshot().speed, null, 'old rate expires even while connection heartbeats continue');
});

test('live speed clears on invalid usage, regressions, source reset, inactivity, and identity changes', () => {
  for (const mode of ['invalid', 'regression', 'disconnect', 'idle', 'long-gap', 'out-of-order', 'switch']) {
    const s = setup(); s.connect();
    const conversation = (usage, rest = {}) => s.emit({ type: 'conversation', threadId: THREAD, primary: true, state: 'active', usage, ...rest });
    conversation(USAGE); s.advance(10_000);
    const higher = { inputTokens: 200, outputTokens: 50, totalTokens: 250 };
    conversation(higher);
    assert.ok(s.live.snapshot().speed, mode);
    if (mode === 'invalid') conversation(null);
    if (mode === 'regression') conversation(USAGE);
    if (mode === 'disconnect') { s.disconnect(); s.connect(); conversation(higher); }
    if (mode === 'idle') { conversation(higher, { state: 'idle' }); conversation(higher); }
    if (mode === 'long-gap') { s.advance(60_001); conversation({ inputTokens: 300, outputTokens: 70, totalTokens: 370 }); }
    if (mode === 'out-of-order') conversation({ inputTokens: 300, outputTokens: 70, totalTokens: 370 }, { observedAt: new Date(NOW + 9_000).toISOString() });
    if (mode === 'switch') {
      s.emit({ type: 'removed', threadId: THREAD });
      conversation(higher, { threadId: OTHER });
    }
    // Out-of-order data is ignored; it must not produce a new estimate.
    if (mode === 'out-of-order') assert.equal(s.live.snapshot().speed.outputTokens, 30);
    else assert.equal(s.live.snapshot().speed, null, mode);
  }
});

test('a newer invalid turn usage event revokes prior counters and speed without letting older usage revive them', () => {
  const s = setup(); s.connect(); s.thread(); s.turn(); s.usage(); s.advance(10_000);
  s.usage({ inputTokens: 200, outputTokens: 50, totalTokens: 250 });
  assert.ok(s.live.snapshot().speed);
  s.advance(1_000);
  s.usage({ inputTokens: 200, outputTokens: 50, totalTokens: 999 });
  assert.equal(s.live.snapshot().usage, null);
  assert.equal(s.live.snapshot().speed, null);
  s.emit({ type: 'usage', threadId: THREAD, turnId: TURN, usage: USAGE, observedAt: new Date(NOW).toISOString() });
  assert.equal(s.live.snapshot().usage, null);
  s.advance(1_000); s.usage({ inputTokens: 200, outputTokens: 50, totalTokens: 250 });
  assert.equal(s.live.snapshot().usage.totalTokens, 250);
  assert.equal(s.live.snapshot().speed, null, 'recovery starts a fresh speed baseline');
});

test('observed speed projection rejects inconsistent, stale and unrelated values without hiding confirmed usage', () => {
  const value = {
    sampledAt: new Date(NOW).toISOString(), state: 'available', source: 'codex_app_server', reason: null,
    observedAt: new Date(NOW).toISOString(), session: { id: THREAD },
    usage: { scope: 'conversation', includesSubagents: false, ...USAGE },
    speed: { source: 'observed_window', outputTokensPerSecond: 2, outputTokens: 20, elapsedSeconds: 10,
      startedAt: new Date(NOW - 10_000).toISOString(), observedAt: new Date(NOW).toISOString(), includesToolsAndWait: true, private: 'hidden' },
  };
  assert.equal(publicLiveSnapshot(value, { now: NOW }).speed.outputTokensPerSecond, 2);
  assert.equal(JSON.stringify(publicLiveSnapshot(value, { now: NOW })).includes('hidden'), false);
  for (const scope of ['turn', 'request']) {
    const result = publicLiveSnapshot({ ...value, usage: { ...value.usage, scope } }, { now: NOW });
    assert.equal(result.speed, null);
    assert.equal(result.usage.totalTokens, 120);
  }
  for (const change of [
    { outputTokensPerSecond: 999 }, { outputTokens: 21 }, { elapsedSeconds: 0 }, { elapsedSeconds: 121 },
    { outputTokens: Number.MAX_SAFE_INTEGER + 1 }, { includesToolsAndWait: false }, { startedAt: 'invalid' },
    { observedAt: new Date(NOW + 1).toISOString() },
    { startedAt: new Date(NOW - 70_001).toISOString(), observedAt: new Date(NOW - 60_001).toISOString() },
  ]) {
    const result = publicLiveSnapshot({ ...value, speed: { ...value.speed, ...change } }, { now: NOW });
    assert.equal(result.speed, null, JSON.stringify(change));
    assert.equal(result.usage.totalTokens, 120);
  }
});
