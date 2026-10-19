import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTaskSummary } from '../src/telemetry/task-summary.js';
import { taskUsageEmpty, usageAllowlist } from '../src/telemetry/usage.js';

const iso = '2026-10-11T00:00:00.000Z';
const now = Date.parse(iso);

function idFor(number) {
  return '123e4567-e89b-12d3-a456-42661417' + number.toString(16).padStart(4, '0');
}

function filename(sessionId) {
  return 'rollout-2026-10-11T00-00-00-' + sessionId + '.jsonl';
}

function at(offset) {
  return new Date(now + offset).toISOString();
}

function line(type, payload, offset = 0, raw = type) {
  return JSON.stringify({ timestamp: at(offset), type: raw, payload });
}

function meta(id, sessionId, extra = {}, offset = -3000) {
  return line('session_meta', { id, session_id: sessionId, ...extra }, offset);
}

function started(turn, root, offset) {
  return line('task_started', { type: 'task_started', turn_id: turn, root_turn_id: root, started_at: 1 }, offset, 'event_msg');
}

function context(turn, root, model, effort, offset) {
  return line('turn_context', { turn_id: turn, root_turn_id: root, model, effort }, offset);
}

function usage(turn, root, counts, offset, threadId = null, sessionId = null) {
  return line('token_usage_record', {
    thread_id: threadId, turn_id: turn, session_id: sessionId, root_turn_id: root,
    response_id: 'response-' + turn, turn_token_usage: counts,
  }, offset);
}

function completed(turn, offset) {
  return line('task_complete', { type: 'task_complete', turn_id: turn, last_agent_message: 'PRIVATE-TRANSCRIPT' }, offset, 'event_msg');
}

function aborted(turn, offset) {
  return line('turn_aborted', { type: 'turn_aborted', turn_id: turn, root_turn_id: turn }, offset, 'event_msg');
}

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'codex-task-summary-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = idFor(1);
  const active = idFor(2);
  const old = idFor(3);
  const counts = { input_tokens: 100, cached_input_tokens: 40, output_tokens: 20, reasoning_output_tokens: 5, total_tokens: 120 };
  await writeFile(join(dir, filename(root)), [
    meta(root, root, { thread_source: 'user', agent_role: null }),
    started('turn-root', 'turn-root', -2500),
    context('turn-root', 'turn-root', 'example-provider/gpt-6.1-sol', 'ultra', -2400),
    usage('turn-root', 'turn-root', counts, -1200, root, root),
  ].join('\n') + '\n');
  await writeFile(join(dir, filename(active)), [
    meta(active, root, { parent_thread_id: root, agent_role: 'agency-backend' }),
    started('turn-active', 'turn-root', -2000),
    context('turn-active', 'turn-root', 'example-provider/deepseek-v4.1-flash', 'max', -1900),
    usage('turn-active', 'turn-root', counts, -1000, active, root),
  ].join('\n') + '\n');
  await writeFile(join(dir, filename(old)), [
    meta(old, root, { parent_thread_id: active, agent_role: 'default' }),
    started('turn-old', 'turn-old', -80_000),
    context('turn-old', 'turn-old', 'example-provider/gpt-6-astra', 'high', -79_000),
    usage('turn-old', 'turn-old', counts, -78_000, old, root),
    completed('turn-old', -77_000),
  ].join('\n') + '\n');
  for (const id of [root, active, old]) await utimes(join(dir, filename(id)), now / 1000, now / 1000);
  return { dir, root, active, old };
}

test('task summary lists roots and projects three distinct agent models', async (t) => {
  const { dir, root, active, old } = await fixture(t);
  const summary = createTaskSummary({ sessionsDir: dir, codexHome: join(dir, 'missing'), wallClock: () => now });
  await summary.refresh();

  const listed = summary.list();
  assert.deepEqual(listed.tasks.map((task) => task.id), [root]);
  assert.equal(listed.sampledAt, iso);
  assert.equal(listed.stale, false);
  assert.equal(listed.truncated, false);

  const detail = summary.detail(root, 'pinned');
  assert.equal(detail.task.id, root);
  assert.equal(detail.task.selection, 'pinned');
  assert.equal(detail.task.rootTurnId, 'turn-root');
  assert.equal(detail.task.updatedAt, at(-1000));
  assert.equal(detail.task.stale, false);
  assert.equal(detail.currentTurn.id, 'turn-root');
  assert.deepEqual(detail.currentTurn.usage, {
    inputTokens: 100, cachedInputTokens: 40, outputTokens: 20, reasoningOutputTokens: 5, totalTokens: 120,
  });
  assert.deepEqual(detail.agents.map((agent) => agent.id).sort(), [root, active, old].sort());
  assert.deepEqual(new Set(detail.agents.map((agent) => agent.model)), new Set(['example-provider/gpt-6.1-sol', 'example-provider/gpt-6-astra', 'example-provider/deepseek-v4.1-flash']));
  const byId = Object.fromEntries(detail.agents.map((agent) => [agent.id, agent]));
  assert.equal(byId[root].association, 'current_turn');
  assert.equal(byId[root].state, 'in_progress');
  assert.equal(byId[active].association, 'current_turn');
  assert.equal(byId[active].role, 'agency-backend');
  assert.equal(byId[active].effort, 'max');
  assert.equal(byId[old].association, 'other_turn');
  assert.equal(byId[old].state, 'completed');
  assert.equal(byId[old].parentId, active);
  assert.equal(JSON.stringify(detail).includes('PRIVATE-TRANSCRIPT'), false);
  assert.equal(JSON.stringify(listed).includes('PRIVATE-TRANSCRIPT'), false);
});

test('task counter allowlist preserves unknown fields and rejects inconsistent complete snapshots', () => {
  for (const counts of [
    { input_tokens: 2, output_tokens: 1, total_tokens: 99 },
    { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 1, total_tokens: Number.MAX_SAFE_INTEGER },
    { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 1, total_tokens: Number.MAX_SAFE_INTEGER + 1 },
    { input_tokens: -1, output_tokens: 2, total_tokens: 1 },
  ]) assert.deepEqual(usageAllowlist(counts), taskUsageEmpty());
  assert.deepEqual(usageAllowlist({ input_tokens: 7, output_tokens: null, total_tokens: 10, cached_input_tokens: 0 }), {
    inputTokens: 7, cachedInputTokens: 0, outputTokens: null, reasoningOutputTokens: null, totalTokens: 10,
  });
  assert.deepEqual(usageAllowlist({ input_tokens: 0, output_tokens: 0, total_tokens: 0 }), {
    inputTokens: 0, cachedInputTokens: null, outputTokens: 0, reasoningOutputTokens: null, totalTokens: 0,
  });
});

test('newer invalid task totals revoke prior usage without replaying older counters and recover at zero', async (t) => {
  const invalid = [
    ['inconsistent total', { input_tokens: 2, output_tokens: 1, total_tokens: 99 }],
    ['unsafe sum', { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 1, total_tokens: Number.MAX_SAFE_INTEGER }],
    ['unsafe total', { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 1, total_tokens: Number.MAX_SAFE_INTEGER + 1 }],
  ];
  for (const [name, counts] of invalid) {
    await t.test(name, async (t) => {
      const dir = await mkdtemp(join(tmpdir(), 'codex-task-summary-'));
      t.after(() => rm(dir, { recursive: true, force: true }));
      const root = idFor(0x42);
      const path = join(dir, filename(root));
      const valid = { input_tokens: 7, output_tokens: 3, total_tokens: 10 };
      await writeFile(path, [meta(root, root), started('turn-root', 'turn-root', -2500),
        usage('turn-root', 'turn-root', valid, -2000, root, root)].join('\n') + '\n');
      const summary = createTaskSummary({ sessionsDir: dir, codexHome: join(dir, 'missing'), wallClock: () => now });
      await summary.refresh();
      assert.equal(summary.detail(root).currentTurn.usage.totalTokens, 10);
      await appendFile(path, [usage('turn-root', 'turn-root', counts, -1000, root, root),
        usage('turn-root', 'turn-root', valid, -1500, root, root)].join('\n') + '\n');
      await summary.refresh({ force: true });
      const rejected = summary.detail(root);
      assert.deepEqual(rejected.currentTurn.usage, taskUsageEmpty());
      assert.equal(rejected.currentTurn.usageUpdatedAt, null);
      assert.deepEqual(rejected.agents[0].usage, taskUsageEmpty());
      assert.equal(rejected.agents[0].usageUpdatedAt, null);
      const zero = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
      await appendFile(path, usage('turn-root', 'turn-root', zero, -500, root, root) + '\n');
      await summary.refresh({ force: true });
      const recovered = summary.detail(root);
      assert.equal(recovered.currentTurn.usage.totalTokens, 0);
      assert.equal(recovered.agents[0].usage.totalTokens, 0);
      assert.equal(recovered.currentTurn.usageUpdatedAt, at(-500));
    });
  }
});

test('task summary keeps an idle pinned root without treating it as active', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-task-summary-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = idFor(7);
  const counts = { input_tokens: 1, output_tokens: 2, total_tokens: 3 };
  await writeFile(join(dir, filename(root)), [
    meta(root, root, { thread_source: 'user' }, -400_000),
    started('turn-idle', 'turn-idle', -395_000),
    context('turn-idle', 'turn-idle', 'example-provider/gpt-6.1-sol', 'ultra', -394_000),
    usage('turn-idle', 'turn-idle', counts, -393_000, root, root),
    completed('turn-idle', -392_000),
  ].join('\n') + '\n');
  await utimes(join(dir, filename(root)), now / 1000, now / 1000);
  const summary = createTaskSummary({ sessionsDir: dir, codexHome: join(dir, 'missing'), wallClock: () => now });
  await summary.refresh({ pinnedId: root });

  const detail = summary.detail(root);
  assert.equal(detail.task.id, root);
  assert.equal(detail.task.rootTurnId, null);
  assert.equal(detail.task.stale, true);
  assert.equal(detail.currentTurn, null);
  assert.equal(detail.agents.length, 1);
  assert.equal(detail.agents[0].state, 'completed');
  assert.equal(detail.agents[0].association, 'unknown');
});

test('task summary reports unavailable detail when the sessions root is unsafe', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-task-summary-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const summary = createTaskSummary({ sessionsDir: join(dir, 'absent'), codexHome: dir, wallClock: () => now });
  const snapshot = await summary.refresh();
  assert.equal(snapshot.error, 'read_failed');
  assert.equal(summary.list().stale, true);
  // A library that could not be read cannot prove absence: the caller gets an
  // explicit unavailable marker, never a false not-found.
  assert.deepEqual(summary.detail(idFor(1)), { unavailable: true, reason: 'read_failed' });
  assert.deepEqual(summary.list().tasks, []);
  assert.equal(summary.list().truncated, true);
});

// Bounded discovery must advance across samples. The walk is limited to a few
// directories per refresh, so a pin that lives behind many earlier date
// directories is only reachable if the queue survives instead of resetting.
test('task summary advances bounded discovery across samples to reach a pinned root', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-task-summary-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const pinned = idFor(0x90);
  const counts = { input_tokens: 5, output_tokens: 5, total_tokens: 10 };
  const writes = [];
  // The pinned file sits in the oldest day directory while 30 newer days exist,
  // so it is only reachable after the resumable walk has made progress.
  for (let i = 0; i < 31; i++) {
    const day = String(i + 1).padStart(2, '0');
    const sub = join(dir, '2026', '01', day);
    await mkdir(sub, { recursive: true });
    const id = i === 0 ? pinned : idFor(0x100 + i);
    writes.push([join(sub, filename(id)), id]);
  }
  for (const [path, id] of writes) {
    await writeFile(path, [
      meta(id, id, { thread_source: 'user' }, -3000),
      started('turn-' + id, 'turn-' + id, -2500),
      context('turn-' + id, 'turn-' + id, 'example-provider/gpt-6.1-sol', 'max', -2400),
      usage('turn-' + id, 'turn-' + id, counts, -1000, id, id),
    ].join('\n') + '\n');
    await utimes(path, now / 1000, now / 1000);
  }
  const summary = createTaskSummary({ sessionsDir: dir, codexHome: join(dir, 'missing'), wallClock: () => now });
  let found = null;
  const rounds = [];
  for (let round = 0; round < 8 && !found; round++) {
    await summary.refresh({ pinnedId: pinned, force: true });
    rounds.push(summary.list().truncated);
    const detail = summary.detail(pinned);
    if (detail && !detail.unavailable) found = detail;
  }
  assert.ok(found, 'bounded discovery never reached the pinned root across samples');
  assert.equal(found.task.id, pinned);
  assert.equal(found.task.selection, 'pinned');
  assert.equal(found.currentTurn.id, 'turn-' + pinned);
  assert.deepEqual(found.agents.map((agent) => agent.id), [pinned]);
  // Incomplete coverage must be reported as truncated, never as a complete view.
  assert.equal(rounds[0], true);
});

test('task summary keeps a pinned idle root and reports no fabricated turn association', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-task-summary-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = idFor(0x21);
  const child = idFor(0x22);
  const counts = { input_tokens: 7, output_tokens: 3, total_tokens: 10 };
  await writeFile(join(dir, filename(root)), [
    meta(root, root, { thread_source: 'user' }, -3000),
    started('turn-root', 'turn-root', -2500),
    context('turn-root', 'turn-root', 'example-provider/gpt-6.1-sol', 'ultra', -2400),
    usage('turn-root', 'turn-root', counts, -1200, root, root),
  ].join('\n') + '\n');
  await writeFile(join(dir, filename(child)), [
    meta(child, root, { parent_thread_id: root, agent_role: 'backend' }, -3000),
    started('turn-child', 'turn-root', -2000),
    context('turn-child', 'turn-root', 'example-provider/deepseek-v4.1-flash', 'max', -1900),
    usage('turn-child', 'turn-root', counts, -1000, child, root),
  ].join('\n') + '\n');
  await utimes(join(dir, filename(root)), now / 1000, now / 1000);
  await utimes(join(dir, filename(child)), now / 1000, now / 1000);
  const summary = createTaskSummary({ sessionsDir: dir, codexHome: join(dir, 'missing'), wallClock: () => now });
  await summary.refresh({ pinnedId: root });
  await summary.refresh({ pinnedId: root });

  const detail = summary.detail(root);
  assert.equal(detail.currentTurn.id, 'turn-root');
  assert.equal(detail.task.rootTurnId, 'turn-root');
  assert.equal(detail.agents.length, 2);
  assert.deepEqual(detail.agents.map((agent) => agent.association).sort(), ['current_turn', 'current_turn']);

  // Completing the root turn clears the association key instead of pinning the
  // stale turn id forever, while the child keeps its own evidence.
  await writeFile(join(dir, filename(root)), [
    meta(root, root, { thread_source: 'user' }, -3000),
    started('turn-root', 'turn-root', -2500),
    context('turn-root', 'turn-root', 'example-provider/gpt-6.1-sol', 'ultra', -2400),
    usage('turn-root', 'turn-root', counts, -1200, root, root),
    completed('turn-root', -1100),
  ].join('\n') + '\n');
  await utimes(join(dir, filename(root)), now / 1000, now / 1000);
  await summary.refresh({ pinnedId: root, force: true });
  const idle = summary.detail(root);
  assert.equal(idle.currentTurn, null);
  assert.equal(idle.task.rootTurnId, null);
  assert.equal(idle.task.stale, false);
  assert.equal(Object.fromEntries(idle.agents.map((agent) => [agent.id, agent.association]))[child], 'unknown');

  // An unfinished turn stays in_progress no matter how old it is: age is
  // reported through staleness, never as an end that was not observed.
  await writeFile(join(dir, filename(root)), [
    meta(root, root, { thread_source: 'user' }, -400_000),
    started('turn-long', 'turn-long', -120_000),
    context('turn-long', 'turn-long', 'example-provider/gpt-6.1-sol', 'max', -119_000),
    usage('turn-long', 'turn-long', counts, -118_000, root, root),
  ].join('\n') + '\n');
  await utimes(join(dir, filename(root)), now / 1000, now / 1000);
  await summary.refresh({ pinnedId: root, force: true });
  const longRunning = summary.detail(root);
  assert.equal(longRunning.currentTurn.id, 'turn-long');
  assert.equal(longRunning.task.rootTurnId, 'turn-long');
  assert.equal(longRunning.task.stale, true);
  assert.equal(longRunning.agents[0].state, 'in_progress');
});

test('task summary never groups a file whose usage identity contradicts it', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-task-summary-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = idFor(0x31);
  const foreign = idFor(0x32);
  const counts = { input_tokens: 9, output_tokens: 1, total_tokens: 10 };
  await writeFile(join(dir, filename(root)), [
    meta(root, root, { thread_source: 'user' }, -3000),
    started('turn-conflict', 'turn-conflict', -2500),
    context('turn-conflict', 'turn-conflict', 'example-provider/gpt-6.1-sol', 'max', -2400),
    usage('turn-conflict', 'turn-conflict', counts, -1000, foreign, foreign),
  ].join('\n') + '\n');
  await utimes(join(dir, filename(root)), now / 1000, now / 1000);
  const summary = createTaskSummary({ sessionsDir: dir, codexHome: join(dir, 'missing'), wallClock: () => now });
  await summary.refresh();

  assert.deepEqual(summary.list().tasks, []);
  assert.equal(summary.list().truncated, true);
  assert.equal(summary.detail(root), null);
});

test('task summary serves the last trusted snapshot when a later sample fails', async (t) => {
  const { dir, root } = await fixture(t);
  const summary = createTaskSummary({ sessionsDir: dir, codexHome: join(dir, 'missing'), wallClock: () => now });
  await summary.refresh();
  const trustedAt = summary.list().sampledAt;
  assert.equal(trustedAt, iso);

  // Remove the readable root: the next sample fails closed but must not erase
  // the previously verified view or its sample time.
  await rm(dir, { recursive: true, force: true });
  await summary.refresh({ pinnedId: root, force: true });

  const list = summary.list();
  assert.equal(list.tasks.length, 1);
  assert.equal(list.tasks[0].id, root);
  assert.equal(list.sampledAt, trustedAt);
  assert.equal(list.stale, true);
  assert.equal(list.truncated, true);
  const detail = summary.detail(root);
  assert.equal(detail.task.stale, true);
  assert.equal(detail.task.truncated, true);
  assert.ok(detail.agents.length >= 1);
});

// A long-running UI polls continuously. The discovery TTL must not be pushed
// forward by those samples: a child rollout that lands after the first walk is
// only ever visible if the listing is re-checked once the TTL really elapses.
test('task summary re-discovers a child created after the discovery TTL while polling', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-task-summary-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = idFor(0x41);
  const child = idFor(0x42);
  const counts = { input_tokens: 4, output_tokens: 6, total_tokens: 10 };
  await writeFile(join(dir, filename(root)), [
    meta(root, root, { thread_source: 'user' }, -3000),
    started('turn-root', 'turn-root', -2500),
    context('turn-root', 'turn-root', 'example-provider/gpt-6.1-sol', 'max', -2400),
    usage('turn-root', 'turn-root', counts, -1000, root, root),
  ].join('\n') + '\n');
  await utimes(join(dir, filename(root)), now / 1000, now / 1000);

  let clock = 0;
  const summary = createTaskSummary({ sessionsDir: dir, codexHome: join(dir, 'missing'),
    wallClock: () => now, monotonicClock: () => clock });
  await summary.refresh({ pinnedId: root, force: true });
  assert.equal(summary.detail(root).agents.length, 1);

  // The child appears well after the first listing was completed.
  await writeFile(join(dir, filename(child)), [
    meta(child, root, { parent_thread_id: root, agent_role: 'agency-backend' }, -2000),
    started('turn-child', 'turn-root', -1900),
    context('turn-child', 'turn-root', 'example-provider/deepseek-v4.1-flash', 'max', -1800),
    usage('turn-child', 'turn-root', counts, -1000, child, root),
  ].join('\n') + '\n');
  await utimes(join(dir, filename(child)), now / 1000, now / 1000);

  // Continuous polling inside the TTL must not postpone re-discovery.
  for (const tick of [500, 1000, 1500, 2000]) {
    clock = tick;
    await summary.refresh({ pinnedId: root, force: true });
  }
  assert.equal(summary.detail(root).agents.length, 1, 'child found before the TTL elapsed');

  clock = 31_000;
  await summary.refresh({ pinnedId: root, force: true });
  const detail = summary.detail(root);
  assert.deepEqual(detail.agents.map((agent) => agent.id).sort(), [root, child].sort());
  const byId = Object.fromEntries(detail.agents.map((agent) => [agent.id, agent]));
  assert.equal(byId[child].role, 'agency-backend');
  assert.equal(byId[child].state, 'in_progress');
});

// Fair bounded progress: a pinned log far larger than the round budget must not
// starve the other sessions. Repeated rounds are capped in bytes but the child
// must still be reached and ingested for real.
test('task summary keeps bounded rounds fair between the pinned log and its children', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-task-summary-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = idFor(0x51);
  const child = idFor(0x52);
  const counts = { input_tokens: 2, output_tokens: 3, total_tokens: 5 };
  // The pinned log is much larger than one round budget.
  const filler = '{"timestamp":"' + at(-2000) + '","type":"noop","payload":{"pad":"' + 'x'.repeat(1024) + '"}}';
  const rootLines = [meta(root, root, { thread_source: 'user' }, -3000)];
  while (rootLines.length < 2600) rootLines.push(filler);
  rootLines.push(started('turn-root', 'turn-root', -2500));
  rootLines.push(context('turn-root', 'turn-root', 'example-provider/gpt-6.1-sol', 'max', -2400));
  rootLines.push(usage('turn-root', 'turn-root', counts, -1000, root, root));
  await writeFile(join(dir, filename(root)), rootLines.join('\n') + '\n');
  await writeFile(join(dir, filename(child)), [
    meta(child, root, { parent_thread_id: root, agent_role: 'agency-frontend' }, -2000),
    started('turn-child', 'turn-root', -1900),
    context('turn-child', 'turn-root', 'example-provider/deepseek-v4.1-flash', 'max', -1800),
    usage('turn-child', 'turn-root', counts, -1000, child, root),
  ].join('\n') + '\n');
  for (const id of [root, child]) await utimes(join(dir, filename(id)), now / 1000, now / 1000);

  // A deliberately small round budget proves the lanes actually bound spending.
  const summary = createTaskSummary({ sessionsDir: dir, codexHome: join(dir, 'missing'),
    wallClock: () => now, budgetBytes: 512 * 1024 });
  let found = null;
  for (let round = 0; round < 12 && !found; round++) {
    await summary.refresh({ pinnedId: root, force: true });
    const detail = summary.detail(root);
    if (detail && !detail.unavailable && detail.agents.length > 1) found = detail;
  }
  assert.ok(found, 'the child was starved out of the cache by the pinned bootstrap');
  const byId = Object.fromEntries(found.agents.map((agent) => [agent.id, agent]));
  assert.equal(byId[child].role, 'agency-frontend');
  assert.equal(byId[child].model, 'example-provider/deepseek-v4.1-flash');
});

// A single appended record in a large log must be observed even when the append
// starts exactly at the previous read boundary.
test('task summary observes a single line-aligned append in a large log', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-task-summary-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = idFor(0x61);
  const padding = line('noop', { pad: 'x'.repeat(1000) }, 0, 'noop');
  const rows = [meta(root, root, { thread_source: 'user' }, -3000),
    started('turn-root', 'turn-root', -2500)];
  while (rows.length < 650) rows.push(padding);
  rows.push(usage('turn-root', 'turn-root', { input_tokens: 100, output_tokens: 11, total_tokens: 111 }, -1000, root, root));
  await writeFile(join(dir, filename(root)), rows.join('\n') + '\n');
  await utimes(join(dir, filename(root)), now / 1000, now / 1000);

  const summary = createTaskSummary({ sessionsDir: dir, codexHome: join(dir, 'missing'),
    wallClock: () => now, refreshIntervalMs: 0 });
  for (let round = 0; round < 4; round++) await summary.refresh({ pinnedId: root, force: true });
  assert.equal(summary.detail(root).currentTurn.usage.outputTokens, 11);

  // Append exactly one complete record at the previous end of file.
  await writeFile(join(dir, filename(root)), rows.join('\n') + '\n'
    + usage('turn-root', 'turn-root', { input_tokens: 100, output_tokens: 99, total_tokens: 199 }, -500, root, root) + '\n');
  await summary.refresh({ pinnedId: root, force: true });
  const after = summary.detail(root).currentTurn.usage;
  assert.equal(after.outputTokens, 99, 'a line-aligned append must not be swallowed');
  assert.equal(after.totalTokens, 199);
});

// A record split across two writes is only published once its newline lands,
// and the recovery must parse the whole line instead of skipping it.
test('task summary recovers a partially written trailing line', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-task-summary-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = idFor(0x71);
  const head = [meta(root, root, { thread_source: 'user' }, -3000),
    started('turn-root', 'turn-root', -2500),
    usage('turn-root', 'turn-root', { input_tokens: 10, output_tokens: 1, total_tokens: 11 }, -2000, root, root)];
  const partial = usage('turn-root', 'turn-root', { input_tokens: 20, output_tokens: 42, total_tokens: 62 }, -1000, root, root);
  const cut = Math.floor(partial.length / 2);
  await writeFile(join(dir, filename(root)), head.join('\n') + '\n' + partial.slice(0, cut));
  await utimes(join(dir, filename(root)), now / 1000, now / 1000);

  const summary = createTaskSummary({ sessionsDir: dir, codexHome: join(dir, 'missing'),
    wallClock: () => now, refreshIntervalMs: 0 });
  await summary.refresh({ pinnedId: root, force: true });
  assert.equal(summary.detail(root).currentTurn.usage.outputTokens, 1, 'an incomplete line must not be published');

  // The rest of the record arrives: the whole line becomes observable.
  await writeFile(join(dir, filename(root)), head.join('\n') + '\n' + partial + '\n');
  await summary.refresh({ pinnedId: root, force: true });
  assert.equal(summary.detail(root).currentTurn.usage.outputTokens, 42);
  assert.equal(summary.detail(root).currentTurn.usage.totalTokens, 62);
});

// Coverage is a property of what was actually parsed, not of how far any single
// read reached. A head+tail sample of a large log leaves a real middle gap, so
// the view stays truncated until the bounded bootstrap really closes it.
test('task summary reports a middle gap as truncated until it is really covered', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-task-summary-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = idFor(0x81);
  const counts = { input_tokens: 6, output_tokens: 4, total_tokens: 10 };
  const filler = line('noop', { pad: 'x'.repeat(1024) }, 0, 'noop');
  const rows = [meta(root, root, { thread_source: 'user' }, -3000)];
  const sizeOf = (list) => Buffer.byteLength(list.join('\n') + '\n', 'utf8');
  const target = 2 * 1024 * 1024 + 128 * 1024;
  while (sizeOf(rows) < target - 4 * 1024) rows.push(filler);
  rows.push(started('turn-root', 'turn-root', -2500),
    context('turn-root', 'turn-root', 'example-provider/gpt-6.1-sol', 'max', -2400),
    usage('turn-root', 'turn-root', counts, -1000, root, root));
  const size = sizeOf(rows);
  assert.ok(size > 2 * 1024 * 1024 && size < 2 * 1024 * 1024 + 256 * 1024, 'fixture must fit the tail window: ' + size);
  const path = join(dir, filename(root));
  const full = rows.join('\n') + '\n';
  await writeFile(path, full);
  await utimes(path, now / 1000, now / 1000);

  const summary = createTaskSummary({ sessionsDir: dir, codexHome: join(dir, 'missing'), wallClock: () => now });
  await summary.refresh({ pinnedId: root, force: true });
  const first = summary.detail(root);
  assert.equal(first.currentTurn.id, 'turn-root');
  assert.equal(first.task.truncated, true, 'a head+tail sample with an unread middle is not a complete view');

  let complete = false;
  for (let round = 0; round < 16 && !complete; round++) {
    await summary.refresh({ pinnedId: root, force: true });
    complete = summary.detail(root).task.truncated === false;
  }
  assert.equal(complete, true, 'the bounded bootstrap never closed the middle gap');

  // A cut trailing line is not complete coverage either, and it becomes
  // complete again once the newline lands.
  const extra = usage('turn-root', 'turn-root', { input_tokens: 6, output_tokens: 5, total_tokens: 11 }, -500, root, root);
  await writeFile(path, full + extra.slice(0, 12));
  await summary.refresh({ pinnedId: root, force: true });
  assert.equal(summary.detail(root).task.truncated, true, 'a cut trailing line is not a complete view');
  await writeFile(path, full + extra + '\n');
  await summary.refresh({ pinnedId: root, force: true });
  assert.equal(summary.detail(root).task.truncated, false);
  assert.equal(summary.detail(root).currentTurn.usage.outputTokens, 5);
});

// Beyond head + tail + bootstrap the middle can never be re-read, so the gap is
// permanent and the view must keep saying so instead of claiming completeness.
test('task summary keeps a gap beyond the bootstrap cap truncated across rounds', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-task-summary-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = idFor(0x82);
  const counts = { input_tokens: 8, output_tokens: 2, total_tokens: 10 };
  const filler = line('noop', { pad: 'x'.repeat(1024) }, 0, 'noop');
  const rows = [meta(root, root, { thread_source: 'user' }, -3000)];
  const sizeOf = (list) => Buffer.byteLength(list.join('\n') + '\n', 'utf8');
  const target = 3 * 1024 * 1024;
  while (sizeOf(rows) < target - 8 * 1024) rows.push(filler);
  rows.push(started('turn-root', 'turn-root', -2500),
    context('turn-root', 'turn-root', 'example-provider/gpt-6.1-sol', 'max', -2400),
    usage('turn-root', 'turn-root', counts, -1000, root, root));
  const size = sizeOf(rows);
  assert.ok(size > 2 * 1024 * 1024 + 256 * 1024, 'fixture must exceed the bootstrap cap: ' + size);
  const path = join(dir, filename(root));
  await writeFile(path, rows.join('\n') + '\n');
  await utimes(path, now / 1000, now / 1000);

  const summary = createTaskSummary({ sessionsDir: dir, codexHome: join(dir, 'missing'), wallClock: () => now });
  let last = null;
  for (let round = 0; round < 12; round++) {
    await summary.refresh({ pinnedId: root, force: true });
    last = summary.detail(root);
  }
  // The tail is still ingested for real even though the middle stays unread.
  assert.equal(last.currentTurn.id, 'turn-root');
  assert.equal(last.currentTurn.usage.outputTokens, 2);
  assert.equal(last.agents[0].model, 'example-provider/gpt-6.1-sol');
  assert.equal(last.task.truncated, true, 'a permanent middle gap must stay truncated');
});

// Lifecycle state and usage accounting are separate signals: a usage record may
// refresh counters and activity time, but it must not undo an observed end.
test('task summary does not let a later usage record resurrect a completed turn', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-task-summary-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = idFor(0xa1);
  const early = { input_tokens: 10, output_tokens: 1, total_tokens: 11 };
  const late = { input_tokens: 20, output_tokens: 92, total_tokens: 112 };
  await writeFile(join(dir, filename(root)), [
    meta(root, root, { thread_source: 'user' }, -3000),
    started('turn-root', 'turn-root', -2500),
    context('turn-root', 'turn-root', 'example-provider/gpt-6.1-sol', 'max', -2400),
    usage('turn-root', 'turn-root', early, -2000, root, root),
    completed('turn-root', -1500),
    usage('turn-root', 'turn-root', late, -1000, root, root),
  ].join('\n') + '\n');
  await utimes(join(dir, filename(root)), now / 1000, now / 1000);

  const summary = createTaskSummary({ sessionsDir: dir, codexHome: join(dir, 'missing'), wallClock: () => now });
  await summary.refresh({ pinnedId: root, force: true });
  const detail = summary.detail(root);
  assert.equal(detail.currentTurn, null, 'usage after a completed turn must not reopen it');
  assert.equal(detail.task.rootTurnId, null);
  assert.equal(detail.agents[0].state, 'completed');
  // Counters and usage time still advance independently of the lifecycle.
  assert.equal(detail.agents[0].usage.outputTokens, 92);
  assert.equal(detail.agents[0].usage.totalTokens, 112);
  assert.equal(detail.agents[0].usageUpdatedAt, at(-1000));
});

test('task summary does not let a later usage record resurrect an aborted turn', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-task-summary-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = idFor(0xa2);
  const early = { input_tokens: 3, output_tokens: 3, total_tokens: 6 };
  const late = { input_tokens: 40, output_tokens: 77, total_tokens: 117 };
  await writeFile(join(dir, filename(root)), [
    meta(root, root, { thread_source: 'user' }, -3000),
    started('turn-root', 'turn-root', -2500),
    context('turn-root', 'turn-root', 'example-provider/gpt-6.1-sol', 'max', -2400),
    usage('turn-root', 'turn-root', early, -2000, root, root),
    aborted('turn-root', -1500),
    usage('turn-root', 'turn-root', late, -1000, root, root),
  ].join('\n') + '\n');
  await utimes(join(dir, filename(root)), now / 1000, now / 1000);

  const summary = createTaskSummary({ sessionsDir: dir, codexHome: join(dir, 'missing'), wallClock: () => now });
  await summary.refresh({ pinnedId: root, force: true });
  const detail = summary.detail(root);
  assert.equal(detail.currentTurn, null, 'usage after an aborted turn must not reopen it');
  assert.equal(detail.task.rootTurnId, null);
  assert.equal(detail.agents[0].state, 'aborted');
  assert.equal(detail.agents[0].usage.outputTokens, 77);
  assert.equal(detail.agents[0].usageUpdatedAt, at(-1000));
});

// Same-timestamp evidence must resolve the same way regardless of replay order:
// the terminal event outranks usage and a start, while a strictly newer start is
// still allowed to open the next turn.
test('task summary keeps a terminal state stable for same-stamp events in either order', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-task-summary-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const first = idFor(0xb1);
  const second = idFor(0xb2);
  const head = (id) => [meta(id, id, { thread_source: 'user' }, -3000),
    context('turn-' + id, 'turn-' + id, 'example-provider/gpt-6.1-sol', 'max', -2400)];
  const pathOf = (id) => join(dir, filename(id));
  await writeFile(pathOf(first), [
    ...head(first),
    started('turn-' + first, 'turn-' + first, -1000),
    completed('turn-' + first, -1000),
  ].join('\n') + '\n');
  // The reverse file order must produce the same terminal state.
  await writeFile(pathOf(second), [
    ...head(second),
    completed('turn-' + second, -1000),
    usage('turn-' + second, 'turn-' + second, { input_tokens: 1, output_tokens: 2, total_tokens: 3 }, -1000, second, second),
    started('turn-' + second, 'turn-' + second, -1000),
  ].join('\n') + '\n');
  for (const id of [first, second]) await utimes(pathOf(id), now / 1000, now / 1000);

  const summary = createTaskSummary({ sessionsDir: dir, codexHome: join(dir, 'missing'), wallClock: () => now });
  await summary.refresh({ pinnedId: first, force: true });
  for (const id of [first, second]) {
    const detail = summary.detail(id);
    assert.equal(detail.agents[0].state, 'completed', 'same-stamp start/usage must not reopen ' + id);
    assert.equal(detail.currentTurn, null);
  }
  assert.equal(summary.detail(second).agents[0].usage.outputTokens, 2);

  // Only an explicitly newer start opens the next turn.
  await writeFile(pathOf(second), [
    ...head(second),
    completed('turn-' + second, -1000),
    started('turn-' + second, 'turn-' + second, -900),
  ].join('\n') + '\n');
  await summary.refresh({ pinnedId: second, force: true });
  const reopened = summary.detail(second);
  assert.equal(reopened.currentTurn.id, 'turn-' + second);
  assert.equal(reopened.agents[0].state, 'in_progress');
});
