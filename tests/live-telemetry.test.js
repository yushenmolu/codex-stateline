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
    status: (reason) => hooks.status({ connected: false, source: 'codex_app_server', reason }),
    advance(ms) { now += ms; mono += ms; },
    adjustWall(ms) { now += ms; },
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

test('live carries optional cache counters and drops an out-of-range cache count without voiding usage', () => {
  const s = setup(); s.connect(); s.thread(); s.turn();
  const cached = { ...USAGE, cachedInputTokens: 90, reasoningOutputTokens: 10 };
  s.usage(cached);
  assert.deepEqual(s.live.snapshot().usage, { scope: 'conversation', includesSubagents: false, ...cached });
  const projected = s.live.snapshot();
  assert.equal(projected.usage.cachedInputTokens, 90);
  assert.equal(projected.usage.reasoningOutputTokens, 10);
  // Out-of-range or malformed cache counters mean "unknown", not "discard this usage".
  for (const extra of [{ cachedInputTokens: 101 }, { cachedInputTokens: -1 }, { cachedInputTokens: '90' },
    { reasoningOutputTokens: 1.5 }, { cachedInputTokens: USAGE.inputTokens + 1, reasoningOutputTokens: -1 }]) {
    s.usage({ ...USAGE, ...extra });
    assert.deepEqual(s.live.snapshot().usage, { scope: 'conversation', includesSubagents: false, ...USAGE }, JSON.stringify(extra));
  }
  s.usage({ ...USAGE, cachedInputTokens: USAGE.inputTokens, reasoningOutputTokens: 0 });
  assert.deepEqual(s.live.snapshot().usage, { scope: 'conversation', includesSubagents: false, ...USAGE, cachedInputTokens: 100, reasoningOutputTokens: 0 });
  s.usage(USAGE);
  assert.deepEqual(s.live.snapshot().usage, { scope: 'conversation', includesSubagents: false, ...USAGE });
});

test('live keeps the last confirmed conversation data after the turn completes instead of blanking out', () => {
  const s = setup(); s.connect(); s.thread(); s.turn(); s.usage(); s.advance(10_000);
  s.emit({ type: 'turn_completed', threadId: THREAD, turnId: TURN, state: 'completed', startedAt: new Date(NOW).toISOString(), completedAt: new Date(NOW + 10_000).toISOString(), elapsedSeconds: 10 });
  const idle = s.live.snapshot();
  assert.equal(idle.state, 'available');
  assert.equal(idle.session.id, THREAD);
  assert.equal(idle.usage.totalTokens, 120);
  assert.deepEqual(idle.lifecycle, {
    state: 'completed', startedAt: new Date(NOW).toISOString(),
    completedAt: new Date(NOW + 10_000).toISOString(), elapsedSeconds: 10,
  });
  const pinned = s.live.snapshot({ taskId: THREAD });
  assert.equal(pinned.lifecycle.state, 'completed');
  assert.equal(pinned.lifecycle.elapsedSeconds, 10);
  assert.equal(pinned.usage.totalTokens, 120);
  // Past the retention window the panel reports no active thread again.
  s.advance(300_001);
  s.emit({ type: 'heartbeat' });
  assert.equal(s.live.snapshot().reason, 'no_active_thread');
  assert.equal(s.live.snapshot().usage, null);
  s.emit({ type: 'removed', threadId: THREAD });
  assert.equal(s.live.snapshot({ taskId: THREAD }).usage, null);
});

test('live falls back to the freshest idle conversation inside the retention window', () => {
  const s = setup(); s.connect();
  s.emit({ type: 'conversation', threadId: THREAD, primary: true, state: 'idle', usage: USAGE });
  assert.equal(s.live.snapshot().state, 'available');
  assert.equal(s.live.snapshot().session.id, THREAD);
  // A newer idle conversation wins over an older one.
  s.advance(1_000);
  s.emit({ type: 'conversation', threadId: OTHER, primary: true, state: 'idle', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } });
  assert.equal(s.live.snapshot().session.id, OTHER);
  assert.equal(s.live.snapshot().usage.totalTokens, 15);
  // An active conversation always outranks the idle fallback.
  s.emit({ type: 'conversation', threadId: THREAD, primary: true, state: 'active', usage: USAGE });
  assert.equal(s.live.snapshot().session.id, THREAD);
  assert.equal(s.live.snapshot().lifecycle.state, 'running');
  // Subagent threads never become the fallback on their own.
  s.emit({ type: 'removed', threadId: OTHER });
  s.emit({ type: 'conversation', threadId: THREAD, primary: false, state: 'idle', usage: USAGE });
  s.emit({ type: 'heartbeat' });
  assert.equal(s.live.snapshot().reason, 'no_active_thread');
});

test('an unpinned card still reports a conversation whose last turn failed', () => {
  const s = setup(); s.connect();
  s.emit({ type: 'conversation', threadId: THREAD, primary: true, state: 'failed', usage: USAGE, model: 'other-provider/kimi-k3', reasoningEffort: 'high' });
  // The runtime reports `systemError` for a session that merely ended badly, so the
  // conversation the reader just received a full snapshot of must still be the one
  // an unpinned card describes. Reporting "no active thread" here blanked the card
  // while the socket was healthy.
  const failed = s.live.snapshot();
  assert.equal(failed.state, 'available');
  assert.equal(failed.reason, null);
  assert.equal(failed.session.id, THREAD);
  assert.deepEqual(failed.usage, { scope: 'conversation', includesSubagents: false, ...USAGE });
  assert.equal(failed.model, 'other-provider/kimi-k3');
  assert.equal(failed.reasoningEffort, 'high');
  assert.equal(s.live.snapshot({ taskId: THREAD }).usage.totalTokens, 120);
  // An active conversation still outranks a failed one.
  s.emit({ type: 'conversation', threadId: OTHER, primary: true, state: 'active', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } });
  assert.equal(s.live.snapshot().session.id, OTHER);
  // Past the retention window the failed conversation stops standing in.
  s.emit({ type: 'removed', threadId: OTHER });
  s.advance(300_001);
  s.emit({ type: 'heartbeat' });
  assert.equal(s.live.snapshot().reason, 'no_active_thread');
});

test('live keeps the most recent request counters and degrades a dirty request group to unknown', () => {
  const s = setup(); s.connect(); s.thread(); s.turn();
  const last = { inputTokens: 40, outputTokens: 8, totalTokens: 48, cachedInputTokens: 30, reasoningOutputTokens: 2 };
  s.usage({ ...USAGE, last });
  assert.deepEqual(s.live.snapshot().usage, { scope: 'conversation', includesSubagents: false, ...USAGE, last });
  assert.deepEqual(publicLiveSnapshot(s.live.snapshot(), { taskId: THREAD, now: NOW }).usage.last, last);
  // A request group that contradicts itself is unknown, not a reason to void the totals.
  for (const broken of [{ ...last, totalTokens: 49 }, { inputTokens: 40, outputTokens: 8 }, null]) {
    s.usage({ ...USAGE, last: broken });
    assert.deepEqual(s.live.snapshot().usage, { scope: 'conversation', includesSubagents: false, ...USAGE }, JSON.stringify(broken));
  }
  // An out-of-range cache counter inside the request group drops only that field.
  s.usage({ ...USAGE, last: { ...last, cachedInputTokens: last.inputTokens + 1 } });
  assert.deepEqual(s.live.snapshot().usage.last, { inputTokens: 40, outputTokens: 8, totalTokens: 48, reasoningOutputTokens: 2 });
  s.usage(USAGE);
  assert.deepEqual(s.live.snapshot().usage, { scope: 'conversation', includesSubagents: false, ...USAGE });
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
    usage: { scope: 'conversation', includesSubagents: false, ...USAGE, cachedInputTokens: 40, reasoningOutputTokens: 5, secret: 'private-text' },
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
  assert.equal(out.usage.cachedInputTokens, 40);
  assert.equal(out.usage.reasoningOutputTokens, 5);
  // An out-of-range cache count is dropped from the projection; the usage itself still confirms.
  const outOfRange = publicLiveSnapshot({ ...value, usage: { ...value.usage, cachedInputTokens: 101 } }, { taskId: THREAD, now: NOW });
  assert.deepEqual(outOfRange.usage, { scope: 'conversation', includesSubagents: false, ...USAGE, reasoningOutputTokens: 5 });
  assert.equal(outOfRange.state, 'available');
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
  assert.equal(s.live.snapshot().usage.totalTokens, 120);
  assert.equal(s.live.snapshot().lifecycle.state, 'completed');
  assert.equal(s.live.snapshot({ taskId: THREAD }).usage.totalTokens, 120);
});

test('the runtime model survives a turn start and unvalidated values never fill the slot', () => {
  const s = setup(); s.connect();
  s.emit({ type: 'conversation', threadId: THREAD, primary: true, state: 'active', usage: USAGE, model: 'example-provider/gpt-6.1-sol', reasoningEffort: 'ultra' });
  assert.equal(s.live.snapshot().model, 'example-provider/gpt-6.1-sol');
  assert.equal(s.live.snapshot().reasoningEffort, 'ultra');
  s.emit({ type: 'turn_started', threadId: THREAD, turnId: TURN, startedAt: new Date(NOW).toISOString() });
  assert.equal(s.live.snapshot().model, 'example-provider/gpt-6.1-sol');
  assert.equal(s.live.snapshot().reasoningEffort, 'ultra');
  // An unusable report says nothing about what is running, so the confirmed pair
  // stays: a provider switch must not blank a level that was already observed.
  s.emit({ type: 'conversation', threadId: THREAD, primary: true, state: 'active', usage: USAGE, model: 'configured', reasoningEffort: 'bad level!' });
  assert.equal(s.live.snapshot().model, 'example-provider/gpt-6.1-sol');
  assert.equal(s.live.snapshot().reasoningEffort, 'ultra');
  // A level this build has never seen is still a level Codex chose.
  s.emit({ type: 'conversation', threadId: THREAD, primary: true, state: 'active', usage: USAGE, model: 'example-provider/gpt-6.1-sol', reasoningEffort: 'turbo' });
  assert.equal(s.live.snapshot().model, 'example-provider/gpt-6.1-sol');
  assert.equal(s.live.snapshot().reasoningEffort, 'turbo');
  // Absent is not the same as invalid: a report without the keys keeps both.
  s.emit({ type: 'conversation', threadId: THREAD, primary: true, state: 'active', usage: USAGE });
  assert.equal(s.live.snapshot().model, 'example-provider/gpt-6.1-sol');
  assert.equal(s.live.snapshot().reasoningEffort, 'turbo');
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

test('live reconciles the exact conversation with Magpie and refreshes both sources', async () => {
  const calls = { starts: 0, refreshes: [], stops: 0, snapshots: [] };
  let gateway = {
    state: 'available', reason: null, observedAt: new Date(NOW + 1000).toISOString(),
    matchedRequests: 4, countedRequests: 3,
    usage: { inputTokens: 500, outputTokens: 70, totalTokens: 570, cachedInputTokens: 350, reasoningOutputTokens: 30 },
  };
  const usageSource = {
    start() { calls.starts++; },
    async refresh(options) { calls.refreshes.push(options); },
    snapshot(options) { calls.snapshots.push(options); return gateway; },
    async stop() { calls.stops++; },
  };
  const s = setup({ usageSource });
  s.connect(); s.thread(); s.turn(); s.usage({ ...USAGE, last: { inputTokens: 80, outputTokens: 10, totalTokens: 90, cachedInputTokens: 60 } });
  const snapshot = s.live.snapshot();
  assert.equal(snapshot.source, 'magpie_gateway');
  assert.equal(snapshot.observedAt, gateway.observedAt);
  assert.deepEqual(snapshot.usage, {
    scope: 'conversation', includesSubagents: false,
    inputTokens: 500, outputTokens: 70, totalTokens: 570, cachedInputTokens: 350, reasoningOutputTokens: 30,
    last: { inputTokens: 80, outputTokens: 10, totalTokens: 90, cachedInputTokens: 60 },
  });
  assert.deepEqual(snapshot.gateway, { state: 'available', observedAt: gateway.observedAt, matchedRequests: 4, countedRequests: 3 });
  assert.deepEqual(calls.snapshots, [{ taskId: THREAD }]);
  await s.live.refresh({ taskId: THREAD });
  assert.deepEqual(calls.refreshes, [{ force: true }]);
  gateway = { ...gateway, state: 'unavailable', usage: null };
  assert.equal(s.live.snapshot().source, 'codex_app_server');
  assert.equal(s.live.snapshot().usage.totalTokens, 120);
  await s.live.stop();
  assert.equal(calls.starts, 1);
  assert.equal(calls.stops, 1);
});

test('Magpie speed uses fresh local observations instead of stale log timestamps', () => {
  let gateway = {
    state: 'available', reason: null, observedAt: new Date(NOW + 1000).toISOString(),
    matchedRequests: 4, countedRequests: 4,
    usage: { inputTokens: 500, outputTokens: 70, totalTokens: 570, cachedInputTokens: 350 },
  };
  const s = setup({ usageSource: { start() {}, snapshot: () => gateway } });
  s.connect(); s.thread(); s.turn(); s.usage();
  assert.equal(s.live.snapshot().speed, null);
  s.advance(2_000);
  // The log timestamp deliberately stays behind. TPS must still advance from
  // the new output total and the local two-second observation interval.
  gateway = { ...gateway, matchedRequests: 5, countedRequests: 5,
    usage: { inputTokens: 500, outputTokens: 170, totalTokens: 670, cachedInputTokens: 350 } };
  const snapshot = s.live.snapshot();
  assert.equal(snapshot.observedAt, gateway.observedAt);
  assert.deepEqual(snapshot.speed, {
    source: 'observed_window', outputTokensPerSecond: 50, outputTokens: 100, elapsedSeconds: 2,
    startedAt: new Date(NOW).toISOString(), observedAt: new Date(NOW + 2_000).toISOString(), includesToolsAndWait: true,
  });
});

test('live retains the verified Magpie conversation briefly across Codex disconnects', () => {
  let gateway = {
    state: 'available', reason: null, observedAt: new Date(NOW + 1000).toISOString(),
    matchedRequests: 4, countedRequests: 4,
    usage: { inputTokens: 500, outputTokens: 70, totalTokens: 570, cachedInputTokens: 350 },
  };
  const s = setup({ usageSource: { start() {}, snapshot: () => gateway } });
  s.connect(); s.thread(); s.turn(); s.usage({ ...USAGE, last: { inputTokens: 80, outputTokens: 10, totalTokens: 90 } });
  assert.equal(s.live.snapshot().source, 'magpie_gateway');
  s.disconnect();
  gateway = { ...gateway, observedAt: new Date(NOW + 2000).toISOString(), matchedRequests: 5, countedRequests: 5,
    usage: { inputTokens: 600, outputTokens: 80, totalTokens: 680, cachedInputTokens: 400 } };
  const retained = s.live.snapshot();
  assert.equal(retained.state, 'available');
  assert.equal(retained.source, 'magpie_gateway');
  assert.equal(retained.reason, 'source_disconnected');
  assert.equal(retained.session.id, THREAD);
  assert.equal(retained.usage.totalTokens, 680);
  assert.equal(retained.usage.cachedInputTokens, 400);
  assert.deepEqual(retained.usage.last, { inputTokens: 80, outputTokens: 10, totalTokens: 90 });
  assert.equal(retained.lifecycle, null);
  assert.equal(retained.speed, null);
  assert.equal(retained.gateway.matchedRequests, 5);
  assert.equal(s.live.snapshot({ taskId: OTHER }).session, null);
  s.advance(300_001);
  assert.equal(s.live.snapshot().state, 'disconnected');
  assert.equal(s.live.snapshot().usage, null);
});

test('gateway-confirmed counters do not depend on Codex already reporting its own counters', () => {
  for (const state of ['available', 'partial']) {
    const gateway = { state, observedAt: new Date(NOW).toISOString(), matchedRequests: 2, countedRequests: 1, usage: USAGE };
    const s = setup({ usageSource: { snapshot: () => gateway } });
    s.connect();
    s.emit({ type: 'conversation', threadId: THREAD, primary: true, state: 'active', usage: null });
    const value = s.live.snapshot();
    assert.equal(value.state, 'available', state);
    assert.equal(value.reason, null);
    assert.equal(value.source, 'magpie_gateway');
    assert.deepEqual(value.usage, { scope: 'conversation', includesSubagents: false, ...USAGE });
  }
});

test('gateway totals never inherit optional counters from a different source or hide valid Codex data', () => {
  let gateway = { state: 'available', observedAt: new Date(NOW).toISOString(), matchedRequests: 1, countedRequests: 1, usage: USAGE };
  const s = setup({ usageSource: { snapshot: () => gateway } });
  s.connect(); s.thread(); s.turn(); s.usage({ ...USAGE, cachedInputTokens: 80, reasoningOutputTokens: 15 });
  assert.deepEqual(s.live.snapshot().usage, { scope: 'conversation', includesSubagents: false, ...USAGE });
  gateway = { ...gateway, observedAt: new Date(NOW + 5_001).toISOString() };
  const fallback = s.live.snapshot();
  assert.equal(fallback.state, 'available');
  assert.equal(fallback.source, 'codex_app_server');
  assert.equal(fallback.usage.cachedInputTokens, 80);
});

test('retained gateway identity is revoked by removal, changed selection, ambiguity, or untrusted source state', () => {
  for (const mode of ['removed', 'new-active', 'new-idle', 'subagent', 'unknown-ancestry', 'different-pin',
    'connecting', 'identity_unverified', 'source_invalid', 'capacity_exceeded']) {
    const gateway = { state: 'available', observedAt: new Date(NOW).toISOString(), matchedRequests: 1, countedRequests: 1, usage: USAGE };
    const s = setup({ usageSource: { snapshot: () => gateway } });
    s.connect();
    s.emit({ type: 'conversation', threadId: THREAD, primary: true, state: mode === 'new-idle' ? 'idle' : 'active', usage: USAGE });
    assert.equal(s.live.snapshot().session.id, THREAD, mode);
    if (mode === 'removed') s.emit({ type: 'removed', threadId: THREAD });
    else if (mode === 'new-active' || mode === 'new-idle') {
      s.advance(1);
      s.emit({ type: 'conversation', threadId: OTHER, primary: true, state: mode === 'new-idle' ? 'idle' : 'active', usage: USAGE });
    } else if (mode === 'subagent' || mode === 'unknown-ancestry') {
      s.emit({ type: 'conversation', threadId: THREAD, primary: mode === 'subagent' ? false : null, state: 'active', usage: USAGE });
    } else if (mode === 'different-pin') s.live.snapshot({ taskId: OTHER });
    else s.status(mode);
    s.disconnect();
    assert.equal(s.live.snapshot().usage, null, mode);
  }
});

test('empty reconnect handshakes and wall-clock changes cannot extend retained identity indefinitely', () => {
  for (const mode of ['empty-handshake', 'wall-clock-backward']) {
    const gateway = { state: 'available', observedAt: new Date(NOW).toISOString(), matchedRequests: 1, countedRequests: 1, usage: USAGE };
    const s = setup({ usageSource: { snapshot: () => gateway } });
    s.connect(); s.thread(); s.turn(); s.usage(); s.live.snapshot(); s.disconnect();
    s.advance(290_000);
    if (mode === 'empty-handshake') { s.connect(); s.disconnect(); }
    else s.adjustWall(-280_000);
    s.advance(10_001);
    assert.equal(s.live.snapshot().usage, null, mode);
  }
});

test('a disconnected gateway cannot manufacture a live speed or carry an old baseline into recovery', () => {
  let gateway = { state: 'available', observedAt: new Date(NOW).toISOString(), matchedRequests: 1, countedRequests: 1, usage: USAGE };
  const s = setup({ usageSource: { snapshot: () => gateway } });
  s.connect(); s.thread(); s.turn(); s.usage(); s.live.snapshot();
  s.advance(2_000);
  gateway = { ...gateway, usage: { inputTokens: 100, outputTokens: 40, totalTokens: 140 } };
  assert.ok(s.live.snapshot().speed);
  s.disconnect(); s.advance(2_000);
  gateway = { ...gateway, usage: { inputTokens: 100, outputTokens: 60, totalTokens: 160 } };
  assert.equal(s.live.snapshot().speed, null);
  s.connect(); s.thread(); s.turn(); s.usage();
  assert.equal(s.live.snapshot().speed, null);
});
