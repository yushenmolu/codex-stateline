import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, appendFile, readFile, rm, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createMagpieUsage } from '../src/telemetry/magpie-usage.js';

const encode = (records) => records.map((record) => JSON.stringify(record)).join('\n') + '\n';
const record = (session, overrides = {}) => ({
  t: '2026-10-29T06:00:00.000Z', agent: 'codex', provider: 'openai', model: 'gpt-test',
  req: 'same-request', in: 10, out: 5, cache_read: 2, cache_write: 0, reasoning: 1,
  status: 200, rid: 'same-rid', response_id: 'same-response', session,
  native_session: 'native-session', ...overrides,
});

async function fixture(t, initial = '', options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'magpie-usage-'));
  const filePath = join(directory, 'usage.jsonl');
  if (initial !== null) await writeFile(filePath, initial);
  const reader = createMagpieUsage({ filePath, ...options });
  t.after(async () => {
    await reader.stop();
    await rm(directory, { recursive: true, force: true });
  });
  return { reader, filePath };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await delay(10);
  }
  assert.fail('timed out waiting for background refresh');
}

test('accumulates a session with cached input included exactly once', async (t) => {
  const { reader } = await fixture(t, encode([
    record('a', { in: 100, out: 20, cache_read: 30, reasoning: 7 }),
    record('a', {
      t: '2026-10-29T06:01:00.000+00:00', in: 50, out: 10, cache_read: 5, reasoning: 2,
    }),
  ]));
  await reader.refresh();
  assert.deepEqual(reader.snapshot({ taskId: 'a' }), {
    state: 'available', reason: null, observedAt: '2026-10-29T06:01:00.000Z',
    matchedRequests: 2, countedRequests: 2,
    usage: {
      inputTokens: 185, outputTokens: 30, totalTokens: 215,
      cachedInputTokens: 35, reasoningOutputTokens: 9,
    },
  });
});

test('isolates sessions, including invalid records in another session', async (t) => {
  const { reader } = await fixture(t, encode([
    record('a', { in: 1, out: 2, cache_read: 3 }),
    record('b', { in: 20, out: 10, cache_read: 5 }),
    record('b', { in: -1 }),
  ]));
  await reader.refresh();
  const a = reader.snapshot({ taskId: 'a' });
  assert.equal(a.state, 'available');
  assert.equal(a.matchedRequests, 1);
  assert.deepEqual(a.usage, {
    inputTokens: 4, outputTokens: 2, totalTokens: 6,
    cachedInputTokens: 3, reasoningOutputTokens: 1,
  });
  const b = reader.snapshot({ taskId: 'b' });
  assert.equal(b.state, 'partial');
  assert.equal(b.reason, 'invalid_record');
  assert.equal(b.matchedRequests, 2);
  assert.equal(b.countedRequests, 1);
  assert.equal(b.usage.inputTokens, 25);
});

test('legacy rows without session attribution do not poison identified sessions', async (t) => {
  const legacy = record('ignored');
  delete legacy.session;
  const { reader } = await fixture(t, encode([legacy, record('a')]));
  await reader.refresh();
  const snapshot = reader.snapshot({ taskId: 'a' });
  assert.equal(snapshot.state, 'available');
  assert.equal(snapshot.matchedRequests, 1);
  assert.equal(snapshot.countedRequests, 1);
  assert.equal(snapshot.usage.totalTokens, 17);
  assert.equal(reader.snapshot({ taskId: 'ignored' }).state, 'waiting');
});

test('counts 499 usage and repeated ids, while zero-usage statuses change no totals', async (t) => {
  const zero = { in: 0, out: 0, cache_read: 0, reasoning: 0 };
  const { reader } = await fixture(t, encode([
    record('a'),
    record('a', { status: 499, in: 20, out: 7, cache_read: 3, reasoning: 2 }),
    record('a', { status: 499, ...zero }),
    record('a', zero),
  ]));
  await reader.refresh();
  const snapshot = reader.snapshot({ taskId: 'a' });
  assert.equal(snapshot.state, 'available');
  assert.equal(snapshot.matchedRequests, 4);
  assert.equal(snapshot.countedRequests, 2);
  assert.deepEqual(snapshot.usage, {
    inputTokens: 35, outputTokens: 12, totalTokens: 47,
    cachedInputTokens: 5, reasoningOutputTokens: 3,
  });
});

test('missing files are unavailable rather than zero and can recover', async (t) => {
  const { reader, filePath } = await fixture(t, null);
  await reader.refresh();
  assert.deepEqual(reader.snapshot({ taskId: 'a' }), {
    state: 'unavailable', reason: 'read_failed', observedAt: null,
    matchedRequests: 0, countedRequests: 0, usage: null,
  });
  await writeFile(filePath, encode([record('a')]));
  await reader.refresh();
  assert.equal(reader.snapshot({ taskId: 'a' }).state, 'available');
});

test('a later read failure preserves the last usage but reports read_failed', async (t) => {
  const { reader, filePath } = await fixture(t, encode([record('a')]));
  await reader.refresh();
  const before = reader.snapshot({ taskId: 'a' });
  await rm(filePath);
  await reader.refresh();
  const after = reader.snapshot({ taskId: 'a' });
  assert.equal(after.state, 'unavailable');
  assert.equal(after.reason, 'read_failed');
  assert.deepEqual(after.usage, before.usage);
  assert.equal(after.observedAt, before.observedAt);
});

test('skips malformed and invalid matching records and marks the result partial', async (t) => {
  const lines = [
    JSON.stringify(record('a')),
    '{not json',
    JSON.stringify(record('a', { in: -1 })),
    JSON.stringify(record('a', { in: Number.MAX_SAFE_INTEGER, cache_read: 1 })),
    JSON.stringify(record('a', { in: 4, out: 2, cache_read: 1 })),
  ].join('\n') + '\n';
  const { reader } = await fixture(t, lines);
  await reader.refresh();
  const snapshot = reader.snapshot({ taskId: 'a' });
  assert.equal(snapshot.state, 'partial');
  assert.equal(snapshot.reason, 'invalid_record');
  assert.equal(snapshot.matchedRequests, 4);
  assert.equal(snapshot.countedRequests, 2);
  assert.deepEqual(snapshot.usage, {
    inputTokens: 17, outputTokens: 7, totalTokens: 24,
    cachedInputTokens: 3, reasoningOutputTokens: 2,
  });
});

test('append refresh retains prior rows and completes a split final line', async (t) => {
  const { reader, filePath } = await fixture(t, encode([record('a')]));
  await reader.refresh();
  const addition = encode([record('a', { in: 20, out: 10, cache_read: 5 })]);
  const split = Math.floor(addition.length / 2);
  await appendFile(filePath, addition.slice(0, split));
  await reader.refresh();
  assert.equal(reader.snapshot({ taskId: 'a' }).countedRequests, 1);
  await appendFile(filePath, addition.slice(split));
  await reader.refresh();
  const snapshot = reader.snapshot({ taskId: 'a' });
  assert.equal(snapshot.countedRequests, 2);
  assert.equal(snapshot.usage.inputTokens, 37);
  assert.equal(snapshot.usage.totalTokens, 52);
});

test('force rereads a same-size replacement even when its mtime is restored', async (t) => {
  const first = encode([record('a', { in: 1, out: 1, cache_read: 1, reasoning: 1 })]);
  const second = encode([record('a', { in: 9, out: 9, cache_read: 9, reasoning: 9 })]);
  assert.equal(first.length, second.length);
  const { reader, filePath } = await fixture(t, first);
  await reader.refresh();
  const original = await stat(filePath);
  await writeFile(filePath, second);
  await utimes(filePath, original.atime, original.mtime);
  await reader.refresh({ force: true });
  const snapshot = reader.snapshot({ taskId: 'a' });
  assert.equal(snapshot.countedRequests, 1);
  assert.equal(snapshot.usage.inputTokens, 18);
  assert.equal(snapshot.usage.totalTokens, 27);
});

test('truncation rebuilds state instead of retaining stale records', async (t) => {
  const { reader, filePath } = await fixture(t, encode([
    record('a', { in: 100 }), record('a', { in: 200 }),
  ]));
  await reader.refresh();
  await writeFile(filePath, encode([record('a', { in: 3, out: 2, cache_read: 1 })]));
  await reader.refresh();
  let snapshot = reader.snapshot({ taskId: 'a' });
  assert.equal(snapshot.matchedRequests, 1);
  assert.equal(snapshot.countedRequests, 1);
  assert.equal(snapshot.usage.totalTokens, 6);
  await writeFile(filePath, '');
  await reader.refresh();
  snapshot = reader.snapshot({ taskId: 'a' });
  assert.equal(snapshot.state, 'waiting');
  assert.equal(snapshot.reason, 'no_records');
  assert.equal(snapshot.usage, null);
});

test('reasoningOutputTokens is omitted when any counted row omits reasoning', async (t) => {
  const withoutReasoning = record('a', { in: 2 });
  delete withoutReasoning.reasoning;
  const { reader } = await fixture(t, encode([record('a'), withoutReasoning]));
  await reader.refresh();
  const snapshot = reader.snapshot({ taskId: 'a' });
  assert.equal(snapshot.state, 'available');
  assert.equal('reasoningOutputTokens' in snapshot.usage, false);
});

test('cross-record arithmetic overflow fails closed as partial', async (t) => {
  const { reader } = await fixture(t, encode([
    record('a', { in: Number.MAX_SAFE_INTEGER, out: 0, cache_read: 0, reasoning: 0 }),
    record('a', { in: 1, out: 0, cache_read: 0, reasoning: 0 }),
  ]));
  await reader.refresh();
  const snapshot = reader.snapshot({ taskId: 'a' });
  assert.equal(snapshot.state, 'partial');
  assert.equal(snapshot.reason, 'invalid_record');
  assert.equal(snapshot.countedRequests, 1);
});

test('start refreshes in the background and stop is final and idempotent', async (t) => {
  const { reader, filePath } = await fixture(t, encode([record('a')]), { refreshMs: 5 });
  reader.start();
  await waitFor(() => reader.snapshot({ taskId: 'a' }).state === 'available');
  await reader.stop();
  await appendFile(filePath, encode([record('a', { in: 20 })]));
  await reader.refresh({ force: true });
  reader.start();
  await delay(30);
  assert.equal(reader.snapshot({ taskId: 'a' }).countedRequests, 1);
  await reader.stop();
});

test('oversized lines are bounded and do not hide later valid records', async (t) => {
  const valid = JSON.stringify({ session: 'a', in: 1, out: 2, cache_read: 3, reasoning: 4 });
  const { reader } = await fixture(t, `${'x'.repeat(200)}\n${valid}\n`, { maxLineBytes: 96 });
  await reader.refresh();
  const snapshot = reader.snapshot({ taskId: 'a' });
  assert.equal(snapshot.state, 'partial');
  assert.equal(snapshot.countedRequests, 1);
  assert.equal(snapshot.usage.totalTokens, 6);
});
