import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createDesktopLiveConnector } from '../src/telemetry/desktop-live.js';
import { createLiveTelemetry } from '../src/telemetry/live-telemetry.js';

const THREAD = '123e4567-e89b-42d3-a456-426614170001';
const OTHER = '123e4567-e89b-42d3-a456-426614170002';
const CLIENT = 'status-reader';
const OWNER = 'desktop-owner';
const NOW = Date.parse('2026-10-18T04:00:00.000Z');
const PRIVATE = 'PRIVATE_BODY_AND_CREDENTIAL_MARKER';
const MODEL = 'example-provider/gpt-6.1-sol';
const USAGE = { inputTokens: 100, outputTokens: 20, totalTokens: 120 };
const timerContexts = new WeakSet();

function frame(value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}

class FakeSocket extends EventEmitter {
  writable = true;
  destroyed = false;
  messages = [];
  frames = [];
  destroys = 0;

  write(bytes) {
    assert.equal(bytes.readUInt32LE(0), bytes.length - 4);
    this.frames.push(Buffer.from(bytes));
    this.messages.push(JSON.parse(bytes.subarray(4).toString('utf8')));
    return true;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroys++;
    this.destroyed = true;
    this.writable = false;
    this.emit('close');
  }

  receive(value) { this.emit('data', frame(value)); }
}

function setup(t, options = {}, { telemetry = false } = {}) {
  if (!timerContexts.has(t)) {
    t.mock.timers.enable({ apis: ['setInterval'] });
    timerContexts.add(t);
  }
  let mono = 0, wall = NOW;
  const sockets = [], paths = [], statuses = [], events = [];
  const factory = createDesktopLiveConnector({
    now: () => mono, wallClock: () => wall,
    refreshMs: 1_000_000, reconnectMs: 10, discoverySettleMs: 0,
    connect(path) {
      paths.push(path);
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    ...options,
  });
  let connector, live = null;
  function connect(callbacks = {}) {
    connector = factory({
      status(value) { statuses.push(structuredClone(value)); callbacks.status?.(value); },
      observe(value) { events.push(structuredClone(value)); callbacks.observe?.(value); },
    });
    return connector;
  }
  if (telemetry) {
    live = createLiveTelemetry({ connector: connect, wallClock: () => wall, monotonicClock: () => mono });
    live.ensureStarted();
    t.after(() => live.stop());
  } else {
    connect().start();
    t.after(() => connector.stop());
  }

  const s = {
    connector, live, sockets, paths, statuses, events,
    get peer() { return sockets.at(-1); },
    get conversations() { return events.filter((event) => event.type === 'conversation'); },
    advance(ms) { mono += ms; wall += ms; },
    flush() { t.mock.timers.tick(1_000); },
    request(method, id) {
      return s.peer.messages.findLast((message) => message.type === 'request' && message.method === method
        && (id === undefined || message.params.conversationId === id));
    },
    reply(request, result, extra = {}) {
      assert.ok(request, 'expected an outgoing request');
      s.peer.receive({ type: 'response', requestId: request.requestId, method: request.method,
        resultType: 'success', handledByClientId: OWNER, result, ...extra });
    },
    ready(taskId = null) {
      connector.select(taskId);
      s.peer.emit('connect');
      s.reply(s.request('initialize'), { clientId: CLIENT });
      s.flush();
      return s.peer;
    },
    owner(id = THREAD, owner = OWNER) {
      s.reply(s.request('thread-owner-discovery', id), { supportsUntrustedAppInput: true }, { handledByClientId: owner });
      s.flush();
    },
    interest(id = THREAD, following = true, sourceClientId = 'ui-window') {
      s.peer.receive({ type: 'broadcast', method: 'thread-stream-following-changed', version: 1,
        sourceClientId, params: { conversationId: id, hostId: 'local', following } });
    },
    state(change, { id = THREAD, owner = OWNER, hostId = 'local', version = 11, ...extra } = {}) {
      s.peer.receive({ type: 'broadcast', method: 'thread-stream-state-changed', version,
        sourceClientId: owner, targetClientIds: [CLIENT], params: { conversationId: id, hostId, change }, ...extra });
    },
    snapshot(revision = 1, value = {}, envelope = {}) {
      const id = envelope.id ?? THREAD;
      s.state({ type: 'snapshot', revision, conversationState: {
        id, source: 'cli', threadRuntimeStatus: { type: 'active', activeFlags: [] },
        latestTokenUsageInfo: { total: USAGE, last: { inputTokens: 5, outputTokens: 3, totalTokens: 8 }, modelContextWindow: 200_000 },
        ...value,
      } }, envelope);
      s.flush();
    },
    follows(id = THREAD) {
      return s.peer.messages.filter((message) => message.method === 'thread-stream-following-changed'
        && message.params.conversationId === id);
    },
    subscribe(id = THREAD) { s.ready(id); s.owner(id); s.snapshot(1, {}, { id }); },
  };
  return s;
}

test('desktop IPC frames initialize on the existing pipe and decline command ownership', (t) => {
  const s = setup(t);
  s.connector.start();
  assert.equal(s.sockets.length, 0);
  s.connector.select(null);
  assert.deepEqual(s.paths, ['\\\\.\\pipe\\codex-ipc']);
  assert.equal(s.peer.messages.length, 0);
  s.peer.emit('connect');
  const initialize = s.request('initialize');
  assert.match(initialize.requestId, /^[0-9a-f-]{36}$/);
  assert.deepEqual({ ...initialize, requestId: 'id' }, {
    type: 'request', requestId: 'id', sourceClientId: 'initializing-client', version: 0,
    method: 'initialize', params: { clientType: 'desktop' }, timeoutMs: 5_000,
  });

  const responses = Buffer.concat([
    frame({ type: 'response', requestId: initialize.requestId, resultType: 'success', method: 'initialize', result: { clientId: CLIENT } }),
    frame({ type: 'client-discovery-request', requestId: 'discovery-\u4e2d\u6587', params: { input: PRIVATE } }),
  ]);
  for (const chunk of [responses.subarray(0, 2), responses.subarray(2, 9), responses.subarray(9)]) s.peer.emit('data', chunk);
  s.flush();
  assert.deepEqual(s.statuses, [{ connected: true, source: 'codex_app_server' }]);
  assert.deepEqual(s.peer.messages.at(-1), {
    type: 'client-discovery-response', requestId: 'discovery-\u4e2d\u6587', response: { canHandle: false },
  });
  assert.equal(s.peer.messages.some((message) => message.method === 'thread-owner-discovery'), false);
  assert.equal(JSON.stringify(s.peer.messages).includes(PRIVATE), false);
});

test('exact pins discover an owner and accept only its matching thread, host and nonstale revision', (t) => {
  const s = setup(t);
  s.ready(THREAD);
  s.interest(OTHER);
  const discovery = s.request('thread-owner-discovery', THREAD);
  assert.deepEqual(discovery.params, { conversationId: THREAD, hostId: 'local' });
  assert.equal(discovery.version, 1);
  assert.equal(discovery.sourceClientId, CLIENT);
  assert.equal(s.request('thread-owner-discovery', OTHER), undefined);
  s.snapshot();
  assert.equal(s.conversations.length, 0);
  s.owner();
  assert.deepEqual(s.follows()[0], {
    type: 'broadcast', method: 'thread-stream-following-changed', version: 1,
    sourceClientId: CLIENT, targetClientIds: [OWNER],
    params: { conversationId: THREAD, hostId: 'local', following: true },
  });
  s.snapshot(1, {}, { owner: 'unrelated-owner' });
  s.snapshot(1, {}, { id: OTHER });
  s.snapshot(1, {}, { hostId: 'remote' });
  assert.equal(s.conversations.length, 0);
  s.snapshot(5);
  assert.equal(s.conversations.length, 1);
  assert.equal(s.conversations[0].threadId, THREAD);
  assert.equal(s.conversations[0].primary, true);
  assert.deepEqual(s.conversations[0].usage, USAGE);
  s.snapshot(4, { latestTokenUsageInfo: { total: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } } });
  assert.equal(s.conversations.length, 1);
});

test('automatic UI interests stay bounded and distinguish primary, subagent and unknown ancestry', (t) => {
  const s = setup(t, { maxCandidates: 8 });
  s.ready();
  s.interest(OTHER, true, CLIENT);
  assert.equal(s.request('thread-owner-discovery', OTHER), undefined);
  const variants = [
    [{ source: 'cli' }, true],
    [{ source: { subAgent: { thread_spawn: { parent_thread_id: THREAD }, prompt: PRIVATE } } }, false],
    [{ source: { subAgent: 'review' } }, false],
    [{ parentThreadId: THREAD }, false],
    [{ ephemeral: true }, false],
    [{ sideConversation: true }, false],
    [{ threadSource: 'ambient_suggestions' }, false],
    [{ source: undefined }, null],
  ];
  for (let index = 0; index < variants.length; index++) {
    const id = `123e4567-e89b-42d3-a456-4266141701${String(index).padStart(2, '0')}`;
    s.interest(id);
    s.owner(id);
    s.snapshot(1, variants[index][0], { id });
    assert.equal(s.conversations.at(-1).primary, variants[index][1]);
  }
  assert.equal(s.peer.messages.filter((message) => message.method === 'thread-owner-discovery').length, 8);
  const first = s.conversations[0].threadId;
  s.interest(first, true, 'second-ui-window');
  s.interest(first, false);
  assert.equal(s.follows(first).at(-1).params.following, true);
  s.interest(first, false, 'second-ui-window');
  assert.equal(s.follows(first).at(-1).params.following, false);
  assert.deepEqual(s.events.at(-1), { type: 'removed', threadId: first });
  s.interest(OTHER);
  s.owner(OTHER); s.snapshot(1, {}, { id: OTHER });
  s.interest(first);
  assert.equal(s.peer.messages.filter((message) => message.method === 'thread-owner-discovery').length, 9);
  assert.equal(s.peer.destroyed, true);
  assert.deepEqual(s.statuses.at(-1), { connected: false, source: 'codex_app_server', reason: 'capacity_exceeded' });
  const followed = s.peer.messages.filter((message) => message.method === 'thread-stream-following-changed');
  for (const id of new Set(followed.map((message) => message.params.conversationId))) {
    assert.equal(s.follows(id).at(-1).params.following, false);
  }
  assert.equal(JSON.stringify(s.events).includes(PRIVATE), false);
});

test('automatic discovery waits for every staggered snapshot and invalidates ready for new candidates', (t) => {
  const s = setup(t, { discoverySettleMs: 500 });
  s.ready();
  s.interest(THREAD); s.interest(OTHER);
  s.owner(THREAD); s.owner(OTHER);
  s.state({ type: 'snapshot', revision: 1, conversationState: {
    id: THREAD, source: 'cli', threadRuntimeStatus: { type: 'active', activeFlags: [] }, latestTokenUsageInfo: { total: USAGE },
  } });
  s.advance(501); s.flush();
  assert.equal(s.statuses.some((status) => status.connected), false);
  assert.equal(s.conversations.length, 0);
  s.snapshot(1, {}, { id: OTHER });
  assert.deepEqual(s.statuses.at(-1), { connected: true, source: 'codex_app_server' });
  assert.deepEqual(s.conversations.map((event) => event.threadId), [THREAD, OTHER]);

  const third = '123e4567-e89b-42d3-a456-426614170003';
  const count = s.conversations.length;
  s.interest(third);
  assert.deepEqual(s.statuses.at(-1), { connected: false, source: 'codex_app_server', reason: 'connecting' });
  s.owner(third);
  s.snapshot(2);
  assert.equal(s.conversations.length, count);
  assert.equal(s.statuses.at(-1).connected, false);
  s.snapshot(1, { source: { subAgent: 'review' } }, { id: third });
  assert.equal(s.statuses.at(-1).connected, true);
  assert.deepEqual(s.conversations.slice(count).map((event) => [event.threadId, event.primary]), [
    [THREAD, true], [OTHER, true], [third, false],
  ]);
});

test('failed or unresolved candidates disconnect without promoting the remaining candidate to unique', (t) => {
  for (const mode of ['failure', 'owner-timeout', 'snapshot-timeout']) {
    const s = setup(t, { leaseMs: 20_000 });
    s.ready();
    s.interest(THREAD); s.interest(OTHER);
    s.owner(THREAD); s.snapshot();
    assert.equal(s.statuses.at(-1).connected, false);
    assert.equal(s.conversations.length, 0);
    if (mode === 'failure') {
      s.reply(s.request('thread-owner-discovery', OTHER), { error: PRIVATE }, { resultType: 'no-client-found' });
    } else {
      if (mode === 'snapshot-timeout') s.owner(OTHER);
      s.advance(5_001); s.flush();
    }
    assert.equal(s.peer.destroyed, true);
    assert.equal(s.follows(THREAD).at(-1).params.following, false);
    assert.equal(s.statuses.at(-1).reason, mode === 'snapshot-timeout' ? 'source_unavailable' : 'identity_unverified');
    assert.equal(s.conversations.length, 0);
    assert.equal(JSON.stringify({ events: s.events, statuses: s.statuses }).includes(PRIVATE), false);
  }
});

test('full desktop snapshots project only metadata and use thread totals without inventing a turn', (t) => {
  const s = setup(t);
  s.ready(THREAD); s.owner();
  s.snapshot(1, {
    title: PRIVATE, input: PRIVATE, items: [{ text: PRIVATE }], turns: [], latestModel: MODEL,
    latestReasoningEffort: 'ultra', latestThreadSettings: { model: PRIVATE },
    turnHistory: { kind: 'canonical', history: {
      entitiesByKey: { key: { turnId: OTHER, status: 'inProgress', params: { input: PRIVATE }, items: [{ text: PRIVATE }] } },
      islands: [{ entries: [{ value: 'key' }] }],
    } },
    latestTokenUsageInfo: { total: { ...USAGE, cachedInputTokens: 90, reasoningOutputTokens: 10, secret: PRIVATE },
      last: { inputTokens: 5, outputTokens: 3, totalTokens: 8 }, modelContextWindow: 200_000, secret: PRIVATE },
  });
  assert.deepEqual(s.conversations, [{
    type: 'conversation', threadId: THREAD, primary: true, state: 'active', usage: USAGE,
    model: MODEL, reasoningEffort: 'ultra', observedAt: new Date(NOW).toISOString(),
  }]);
  assert.equal(JSON.stringify({ events: s.events, statuses: s.statuses, outgoing: s.peer.messages }).includes(PRIVATE), false);
});

test('metadata patches update counters and revision gaps resync once before a fresh snapshot', (t) => {
  const s = setup(t);
  s.subscribe();
  const patches = [
    { op: 'replace', path: ['latestTokenUsageInfo', 'total', 'inputTokens'], value: 150 },
    { op: 'replace', path: ['latestTokenUsageInfo', 'total', 'outputTokens'], value: 30 },
    { op: 'replace', path: ['latestTokenUsageInfo', 'total', 'totalTokens'], value: 180 },
    { op: 'add', path: ['turnHistory', 'history', 'entitiesByKey', 'key'], value: { items: [{ text: PRIVATE }] } },
  ];
  s.state({ type: 'patches', baseRevision: 1, revision: 2, patches });
  assert.deepEqual(s.conversations.at(-1).usage, { inputTokens: 150, outputTokens: 30, totalTokens: 180 });
  const count = s.conversations.length;
  s.state({ type: 'patches', baseRevision: 1, revision: 2, patches });
  assert.equal(s.conversations.length, count);
  s.state({ type: 'patches', baseRevision: 4, revision: 5, patches });
  assert.deepEqual(s.statuses.at(-1), { connected: false, source: 'codex_app_server', reason: 'connecting' });
  assert.equal(s.conversations.length, count);
  assert.equal(s.follows().filter((message) => message.params.following).length, 2);
  s.state({ type: 'patches', baseRevision: 5, revision: 6, patches });
  assert.equal(s.follows().filter((message) => message.params.following).length, 2);
  s.snapshot(6);
  assert.deepEqual(s.conversations.at(-1).usage, USAGE);
  s.state({ type: 'patches', baseRevision: 6, revision: 7,
    patches: [{ op: 'replace', path: ['source', 'subAgent'], value: PRIVATE }] });
  assert.deepEqual(s.statuses.at(-1), { connected: false, source: 'codex_app_server', reason: 'connecting' });
  assert.equal(s.follows().filter((message) => message.params.following).length, 3);
  s.snapshot(7, { source: { subAgent: 'review' } });
  assert.equal(s.conversations.at(-1).primary, false);
  assert.equal(JSON.stringify(s.events).includes(PRIVATE), false);
});

test('patch gaps and ancestry resync never promote the other active conversation to unique live usage', (t) => {
  for (const mode of ['gap', 'ancestry']) {
    const s = setup(t, {}, { telemetry: true });
    s.ready();
    s.interest(THREAD); s.interest(OTHER);
    s.owner(THREAD); s.owner(OTHER);
    s.snapshot(); s.snapshot(1, {}, { id: OTHER });
    assert.equal(s.live.snapshot().state, 'ambiguous');

    const change = mode === 'gap'
      ? { type: 'patches', baseRevision: 4, revision: 5, patches: [] }
      : { type: 'patches', baseRevision: 1, revision: 2,
        patches: [{ op: 'replace', path: ['source', 'subAgent'], value: PRIVATE }] };
    s.state(change);
    assert.deepEqual(s.statuses.at(-1), { connected: false, source: 'codex_app_server', reason: 'connecting' });
    const blocked = s.live.snapshot();
    assert.equal(blocked.state, 'disconnected');
    assert.equal(blocked.reason, 'connecting');
    assert.equal(blocked.session, null);
    assert.equal(blocked.usage, null);

    const published = s.conversations.length;
    s.snapshot(2, {}, { id: OTHER });
    assert.equal(s.conversations.length, published);
    assert.equal(s.live.snapshot().state, 'disconnected');
    assert.equal(s.live.snapshot().usage, null);
    assert.equal(s.follows().filter((message) => message.params.following).length, 2);

    s.snapshot(change.revision);
    const restored = s.live.snapshot();
    assert.equal(restored.state, 'ambiguous');
    assert.equal(restored.reason, 'multiple_active_threads');
    assert.equal(restored.session, null);
    assert.equal(restored.usage, null);
    assert.deepEqual(s.conversations.slice(published).map((event) => event.threadId), [THREAD, OTHER]);
    assert.equal(JSON.stringify({ events: s.events, statuses: s.statuses }).includes(PRIVATE), false);
    s.connector.stop();
  }
});

test('switching pins cancels old owner discovery so late failures and timeouts cannot disconnect the new pin', (t) => {
  for (const mode of ['late-failure', 'timeout']) {
    const s = setup(t, {}, { telemetry: true });
    s.ready(THREAD);
    const previous = s.request('thread-owner-discovery', THREAD);
    s.connector.select(OTHER);
    s.owner(OTHER); s.snapshot(1, {}, { id: OTHER });
    const available = s.live.snapshot({ taskId: OTHER });
    assert.equal(available.state, 'available');
    assert.equal(available.session.id, OTHER);
    assert.equal(available.usage.totalTokens, USAGE.totalTokens);

    if (mode === 'late-failure') s.reply(previous, { error: PRIVATE }, { resultType: 'no-client-found' });
    s.advance(5_001); s.flush();
    const retained = s.live.snapshot({ taskId: OTHER });
    assert.equal(retained.state, 'available');
    assert.equal(retained.session.id, OTHER);
    assert.equal(retained.usage.totalTokens, USAGE.totalTokens);
    assert.equal(s.peer.destroyed, false);
    assert.equal(s.statuses.at(-1).connected, true);
    assert.equal(s.request('thread-owner-discovery', THREAD), previous);
    s.connector.stop();
  }
});

test('selection changes unsubscribe the old thread and ignore late snapshots', (t) => {
  const s = setup(t);
  s.subscribe();
  s.connector.select('invalid-thread');
  assert.equal(s.follows().length, 1);
  s.connector.select(OTHER);
  assert.equal(s.follows(THREAD).at(-1).params.following, false);
  assert.deepEqual(s.events.at(-1), { type: 'removed', threadId: THREAD });
  assert.ok(s.request('thread-owner-discovery', OTHER));
  const count = s.conversations.length;
  s.snapshot(2);
  assert.equal(s.conversations.length, count);
  s.owner(OTHER, 'other-owner');
  s.snapshot(1, {}, { id: OTHER, owner: 'other-owner' });
  assert.equal(s.conversations.at(-1).threadId, OTHER);
  s.connector.select(OTHER);
  assert.equal(s.follows(OTHER).length, 1);
  s.connector.select(null);
  assert.equal(s.follows(OTHER).at(-1).params.following, false);
  assert.equal(s.peer.destroyed, true);
  assert.equal(s.statuses.at(-1).connected, false);
});

test('disconnect and stop release subscriptions, reject old sockets and stop reconnecting', (t) => {
  const s = setup(t, { leaseMs: 20_000 });
  s.subscribe();
  const old = s.peer;
  old.emit('error', new Error(PRIVATE));
  assert.equal(old.destroyed, true);
  assert.equal(old.messages.at(-1).params.following, false);
  assert.deepEqual(s.statuses.at(-1), { connected: false, source: 'codex_app_server', reason: 'source_unavailable' });
  s.advance(1_000); t.mock.timers.tick(1_000);
  assert.equal(s.sockets.length, 2);
  const count = s.conversations.length;
  old.receive({ type: 'client-discovery-request', requestId: PRIVATE });
  assert.equal(s.conversations.length, count);
  assert.equal(s.peer.messages.length, 0);
  s.peer.emit('connect'); s.reply(s.request('initialize'), { clientId: CLIENT }); s.owner(); s.snapshot();
  s.connector.stop();
  assert.equal(s.follows().at(-1).params.following, false);
  assert.equal(s.peer.destroys, 1);
  const stoppedCounts = [s.sockets.length, s.peer.messages.length, s.events.length, s.statuses.length];
  s.connector.stop(); s.connector.start(); s.connector.select(OTHER);
  s.advance(1_000); t.mock.timers.tick(1_000);
  assert.deepEqual([s.sockets.length, s.peer.messages.length, s.events.length, s.statuses.length], stoppedCounts);
  assert.equal(JSON.stringify({ events: s.events, statuses: s.statuses }).includes(PRIVATE), false);
});

test('oversize, empty and invalid frames fail closed and source errors never disclose payloads', (t) => {
  for (const [bytes, reason] of [
    [Buffer.alloc(4), 'capacity_exceeded'],
    [Buffer.from([1, 1, 0, 0]), 'capacity_exceeded'],
    [Buffer.concat([Buffer.from([1, 0, 0, 0]), Buffer.from('{')]), 'source_invalid'],
  ]) {
    const s = setup(t, { maxFrameBytes: 256 });
    s.ready();
    s.peer.emit('data', bytes);
    assert.equal(s.peer.destroyed, true);
    assert.equal(s.statuses.at(-1).reason, reason);
    assert.equal(s.conversations.length, 0);
  }
  const s = setup(t, { connect() { throw new Error(PRIVATE); } });
  s.connector.select(THREAD);
  assert.deepEqual(s.statuses.at(-1), { connected: false, source: 'codex_app_server', reason: 'source_unavailable' });
  assert.equal(JSON.stringify({ statuses: s.statuses, events: s.events }).includes(PRIVATE), false);
});

test('invalid identity and protocol are unavailable while malformed counters never become usage', (t) => {
  for (const [value, envelope, reason] of [
    [{ id: OTHER }, {}, 'identity_unverified'],
    [{}, { version: 10 }, 'source_invalid'],
  ]) {
    const s = setup(t);
    s.ready(THREAD); s.owner(); s.snapshot(1, value, envelope);
    assert.equal(s.conversations.length, 0);
    assert.equal(s.peer.destroyed, true);
    assert.equal(s.statuses.at(-1).reason, reason);
  }
  const s = setup(t);
  s.ready(THREAD); s.owner();
  for (const total of [null, { inputTokens: -1, outputTokens: 1, totalTokens: 0 },
    { inputTokens: 1, outputTokens: 1, totalTokens: 3 }, { inputTokens: 0.5, outputTokens: 1, totalTokens: 1.5 }]) {
    s.snapshot(s.conversations.length + 1, { latestTokenUsageInfo: { total } });
    assert.equal(s.conversations.at(-1).usage, null);
  }
  s.snapshot(5, { latestTokenUsageInfo: { total: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } },
    threadRuntimeStatus: { type: 'idle', activeFlags: [] } });
  assert.equal(s.conversations.at(-1).state, 'idle');
  assert.deepEqual(s.conversations.at(-1).usage, { inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  s.snapshot(6, { threadRuntimeStatus: { type: 'systemError', activeFlags: [] } });
  assert.equal(s.conversations.at(-1).state, 'failed');
  s.snapshot(7, { threadRuntimeStatus: { type: 'notLoaded', activeFlags: [] } });
  assert.deepEqual(s.events.findLast((event) => event.type !== 'heartbeat'), { type: 'removed', threadId: THREAD });
});

test('expired HTTP leases and unanswered handshakes release sources using injected time', (t) => {
  const s = setup(t, { leaseMs: 50 });
  s.subscribe();
  s.advance(51); t.mock.timers.tick(1_000);
  assert.equal(s.follows().at(-1).params.following, false);
  assert.equal(s.peer.destroyed, true);
  assert.equal(s.statuses.at(-1).reason, 'source_unavailable');
  s.advance(1_000); t.mock.timers.tick(1_000);
  assert.equal(s.sockets.length, 1);

  const pending = setup(t, { leaseMs: 20_000 });
  pending.connector.select(null); pending.peer.emit('connect');
  pending.advance(5_001); t.mock.timers.tick(1_000);
  assert.equal(pending.peer.destroyed, true);
  assert.equal(pending.statuses.at(-1).reason, 'source_unavailable');
  assert.equal(pending.conversations.length, 0);
});

test('desktop observed speed survives confirmed updates slower than the old thirty-second reconnect', (t) => {
  const s = setup(t, { refreshMs: undefined }, { telemetry: true });
  s.ready(THREAD); s.owner(); s.snapshot();
  assert.equal(s.live.snapshot({ taskId: THREAD }).speed, null);
  s.advance(35_000);
  s.live.snapshot({ taskId: THREAD }); s.flush();
  assert.equal(s.peer.destroyed, false);
  s.state({ type: 'patches', baseRevision: 1, revision: 2, patches: [
    { op: 'replace', path: ['latestTokenUsageInfo', 'total'], value: { inputTokens: 200, outputTokens: 90, totalTokens: 290 } },
  ] });
  const speed = s.live.snapshot({ taskId: THREAD }).speed;
  assert.equal(speed.source, 'observed_window');
  assert.equal(speed.outputTokens, 70);
  assert.equal(speed.elapsedSeconds, 35);
  assert.equal(speed.outputTokensPerSecond, 2);
  s.advance(85_001);
  s.live.snapshot({ taskId: THREAD }); s.flush();
  assert.equal(s.peer.destroyed, true, 'bounded refresh still re-verifies source identity');
  assert.equal(s.live.snapshot({ taskId: THREAD }).speed, null);
});
