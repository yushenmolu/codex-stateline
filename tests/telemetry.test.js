import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseUsageLine, publicUsage, sessionIdFromFilename, sessionFilenameIdentity } from '../src/telemetry/usage.js';
import { readActiveSession } from '../src/telemetry/session-reader.js';
import { createSpeedTracker } from '../src/telemetry/speed.js';
import { createTelemetryWorker } from '../src/telemetry/speed-worker.js';

const id = '123e4567-e89b-12d3-a456-426614174000';
const iso = '2026-10-11T00:00:00.000Z';
const now = Date.parse(iso);
const underscoreRollout = 'rollout-2026-10-11T21-07-12-01a125f5-8300-71a2-bf15-b2817aef108b_01a12b13-126d-74b2-801d-fc4fbf0bc28c.jsonl';
const underscoreSessionId = '01a125f5-8300-71a2-bf15-b2817aef108b';

test('dual UUID filenames accept underscore and hyphen with strict UUID validation', () => {
  for (const name of [underscoreRollout, underscoreRollout.replace('_', '-')]) {
    assert.equal(sessionIdFromFilename(name), underscoreSessionId);
    assert.deepEqual(sessionFilenameIdentity(name), { id: underscoreSessionId, dual: true });
  }
  for (const name of [
    underscoreRollout.replace('_', '__'),
    underscoreRollout.replace('_', '.'),
    underscoreRollout.replace('71a2', '01a2'),
    underscoreRollout.replace('74b2', '04b2'),
    underscoreRollout.replace('bf15', '7f15'),
    underscoreRollout.replace('801d', '701d'),
    underscoreRollout.replace('fc4fbf0bc28c', 'fc4fbf0bc28g'),
    underscoreRollout.replace('.jsonl', '_extra.jsonl'),
  ]) {
    assert.equal(sessionIdFromFilename(name), null, name);
    assert.equal(sessionFilenameIdentity(name), null, name);
  }
});

function idFor(number) {
  return '123e4567-e89b-12d3-a456-42661417' + number.toString(16).padStart(4, '0');
}

function filename(sessionId) {
  return 'rollout-2026-10-11T00-00-00-' + sessionId + '.jsonl';
}

function metaLine(sessionId, timestamp = iso) {
  return JSON.stringify({ timestamp, type: 'session_meta', payload: { id: sessionId } });
}

function tokenLine(usage, timestamp = iso, extra = {}) {
  return JSON.stringify({
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: { total_token_usage: usage },
      ...extra,
    },
    message: 'private transcript must not escape the parser',
  });
}

async function tempDirectory(t, prefix = 'codex-telemetry-') {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  return dir;
}

async function writeSession(dir, sessionId, {
  timestamp = iso,
  usage = { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  lines,
  mtime = now,
  finalNewline = true,
} = {}) {
  const rows = lines ?? [metaLine(sessionId, timestamp), tokenLine(usage, timestamp)];
  const path = join(dir, filename(sessionId));
  await writeFile(path, rows.join('\n') + (finalNewline ? '\n' : ''));
  await utimes(path, mtime / 1000, mtime / 1000);
  return path;
}

function virtualSessions(t, { directories = [], files = [], entries, changeReads = 0, missingOpen = false, escape = false } = {}) {
  const root = join(tmpdir(), 'virtual-telemetry');
  const dirs = new Map([[root, []]]);
  const records = new Map();
  const counters = { reads: 0, bytes: 0, metadata: 0, directories: 0, entries: 0, closes: 0 };
  const entry = (name, directory) => ({ name, isSymbolicLink: () => false, isDirectory: () => directory, isFile: () => !directory });
  for (const parts of directories) {
    const path = join(root, ...parts);
    dirs.set(path, []);
    dirs.get(join(root, ...parts.slice(0, -1))).push(entry(parts.at(-1), true));
  }
  for (const file of files) {
    const parts = file.parts ?? [filename(file.id)];
    const path = join(root, ...parts);
    records.set(path, file);
    dirs.get(join(root, ...parts.slice(0, -1))).push(entry(parts.at(-1), false));
  }
  if (entries) dirs.set(root, Array.from({ length: entries }, (_, i) => entry('ignored-' + i, false)));
  const stat = (path) => {
    const file = records.get(path);
    return { ino: 1, dev: 1, size: file?.size ?? 0, mtimeMs: file?.mtime ?? now, isSymbolicLink: () => file?.link ?? false, isDirectory: () => dirs.has(path), isFile: () => records.has(path) };
  };
  t.mock.method(fs, 'lstat', async (path) => { counters.metadata++; return stat(path); });
  t.mock.method(fs, 'realpath', async (path) => { counters.metadata++; return escape && records.has(path) ? join(tmpdir(), 'outside', 'private') : path; });
  t.mock.method(fs, 'opendir', async (path) => {
    counters.metadata++; counters.directories++;
    let index = 0;
    return { read: async () => { const item = dirs.get(path)[index++]; if (item) counters.entries++; return item ?? null; }, close: async () => { counters.closes++; } };
  });
  t.mock.method(fs, 'open', async (path) => {
    counters.metadata++;
    if (missingOpen) throw Object.assign(Error('gone'), { code: 'ENOENT' });
    let version = 0;
    return {
      stat: async () => { counters.metadata++; return { ...stat(path), mtimeMs: now + version }; },
      read: async (buffer, offset, length, position) => {
        counters.reads++; counters.bytes += length;
        if (counters.reads <= changeReads) version++;
        const file = records.get(path);
        const prefix = Buffer.from(metaLine(file.id) + '\n');
        const size = file.size ?? prefix.length;
        const n = Math.min(length, Math.max(0, size - position));
        const unit = Buffer.from('{"type":"other"}\n');
        for (let i = 0; i < n; i++) buffer[offset + i] = position + i < prefix.length ? prefix[position + i] : unit[(position + i - prefix.length) % unit.length];
        return { bytesRead: n };
      },
      close: async () => {},
    };
  });
  return { root, counters };
}

test('nested date discovery preserves privacy and ignores other depths and directory names', async (t) => {
  const root = await tempDirectory(t);
  const date = join(root, '2026', '10', '11');
  await mkdir(date, { recursive: true });
  await writeSession(date, id);
  for (const parts of [['misc'], ['2026', '13', '11'], ['2026', '10'], ['2026', '10', '11', 'deeper']]) {
    const dir = join(root, ...parts);
    await mkdir(dir, { recursive: true });
    await writeSession(dir, idFor(parts.length));
  }
  const result = await readActiveSession({ sessionsDir: root, wallClock: () => now });
  assert.deepEqual({ state: result.state, session: result.session, usage: result.usage, eventTimestamp: result.eventTimestamp }, { state: 'ok', session: { id, updatedAt: iso }, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, eventTimestamp: now });
  assert.equal(JSON.stringify(result).includes('private'), false);
  assert.equal(JSON.stringify(result).includes(root), false);
});

test('directory junctions and linked roots are skipped', async (t) => {
  const root = await tempDirectory(t);
  const outside = await tempDirectory(t);
  const date = join(outside, '10', '11');
  await mkdir(date, { recursive: true });
  await writeSession(date, id);
  await symlink(outside, join(root, '2026'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await readActiveSession({ sessionsDir: root, wallClock: () => now })).state, 'empty');
  assert.equal((await readActiveSession({ sessionsDir: join(root, '2026'), wallClock: () => now })).state, 'unavailable');
});

test('linked files are skipped even when their target is inside the root', async (t) => {
  const root = await tempDirectory(t);
  const target = await writeSession(root, id);
  try { await symlink(target, join(root, filename(idFor(1))), 'file'); }
  catch (error) { if (error.code === 'EPERM') { t.skip('Windows file symlink privilege unavailable; junction test still runs'); return; } throw error; }
  assert.equal((await readActiveSession({ sessionsDir: root, wallClock: () => now })).session.id, id);
});

test('discovery stops at 512 opened directories and closes them on exhaustion', async (t) => {
  const directories = Array.from({ length: 512 }, (_, i) => [String(2000 + i)]);
  const { root, counters } = virtualSessions(t, { directories });
  assert.equal((await readActiveSession({ sessionsDir: root, wallClock: () => now })).state, 'unavailable');
  assert.equal(counters.directories, 512);
  assert.equal(counters.closes, 512);
  assert.equal(counters.reads, 0);
});

test('discovery rejects excess entries without reading candidate data', async (t) => {
  const { root, counters } = virtualSessions(t, { entries: 10_001 });
  assert.equal((await readActiveSession({ sessionsDir: root, wallClock: () => now })).state, 'unavailable');
  assert.equal(counters.entries, 10_001);
  assert.equal(counters.reads, 0);
  assert.equal(counters.closes, 1);
});

test('nested stale candidates cannot exceed the 20000 metadata operation budget', async (t) => {
  const parts = ['2026', '10', '11'];
  const files = Array.from({ length: 2500 }, (_, i) => ({ id: idFor(i), parts: [...parts, filename(idFor(i))], mtime: now - 600_001 }));
  const { root, counters } = virtualSessions(t, { directories: [parts.slice(0, 1), parts.slice(0, 2), parts], files });
  assert.equal((await readActiveSession({ sessionsDir: root, wallClock: () => now })).state, 'unavailable');
  assert.equal(counters.metadata, 20_000);
  assert.equal(counters.reads, 0);
  assert.equal(counters.closes, 4);
});

test('realpath escape is skipped and ENOENT during open is a harmless race', async (t) => {
  const { root, counters } = virtualSessions(t, { files: [{ id, size: 1024 }], escape: true });
  assert.equal((await readActiveSession({ sessionsDir: root, wallClock: () => now })).state, 'empty');
  assert.equal(counters.reads, 0);
  t.mock.restoreAll();
  virtualSessions(t, { files: [{ id, size: 1024 }], missingOpen: true });
  assert.equal((await readActiveSession({ sessionsDir: root, wallClock: () => now })).state, 'empty');
});

test('retry reads consume the 8MiB budget before reading and each read is capped at 2MiB', async (t) => {
  const size = 2 * 1024 * 1024;
  const files = Array.from({ length: 4 }, (_, i) => ({ id: idFor(i), size }));
  const { root, counters } = virtualSessions(t, { files, changeReads: 1 });
  assert.equal((await readActiveSession({ sessionsDir: root, wallClock: () => now })).state, 'unavailable');
  assert.equal(counters.reads, 4);
  assert.equal(counters.bytes, 8 * 1024 * 1024);
});

test('changed files retry once then fail closed if still changing', async (t) => {
  const { root, counters } = virtualSessions(t, { files: [{ id, size: 1024 }], changeReads: 2 });
  assert.equal((await readActiveSession({ sessionsDir: root, wallClock: () => now })).state, 'unavailable');
  assert.equal(counters.reads, 2);
  assert.equal(counters.bytes, 2048);
});

test('file links are rejected by lstat even when directory entries report regular files', async (t) => {
  const { root, counters } = virtualSessions(t, { files: [{ id, size: 1024, link: true }] });
  assert.equal((await readActiveSession({ sessionsDir: root, wallClock: () => now })).state, 'empty');
  assert.equal(counters.reads, 0);
});

test('a file that stabilizes on retry can be selected without exposing its contents', async (t) => {
  const { root, counters } = virtualSessions(t, { files: [{ id, size: 1024 }], changeReads: 1 });
  const result = await readActiveSession({ sessionsDir: root, wallClock: () => now });
  assert.equal(result.state, 'ok');
  assert.deepEqual(result.session, { id, updatedAt: iso });
  assert.equal(counters.reads, 2);
  assert.equal(counters.bytes, 2048);
});

test('large files scan from zero and isolate oversized unknown records', async (t) => {
  const root = await tempDirectory(t);
  const path = join(root, filename(id));
  await writeFile(path, 'x'.repeat(3 * 1024 * 1024) + '\n' + metaLine(id) + '\n' + tokenLine({ input_tokens: 4, output_tokens: 6, total_tokens: 10 }) + '\n');
  await utimes(path, now / 1000, now / 1000);
  const result = await readActiveSession({ sessionsDir: root, wallClock: () => now });
  assert.equal(result.state, 'ok');
  assert.deepEqual(result.usage, { inputTokens: 4, outputTokens: 6, totalTokens: 10 });
  assert.equal(result.lastCompletedTurn.reason, 'read_gap');
});

test('large file recovery keeps per-read and per-poll byte bounds and parser state', async (t) => {
  const { root, counters } = virtualSessions(t, { files: [{ id, size: 100 * 1024 * 1024 }] });
  const cache = new Map();
  const first = await readActiveSession({ sessionsDir: root, wallClock: () => now, cache });
  assert.equal(first.state, 'unavailable');
  assert.equal(first.lastCompletedTurn.reason, 'bootstrap_in_progress');
  assert.equal(counters.reads, 5);
  assert.equal(counters.bytes, 8 * 1024 * 1024);
  assert.equal(cache.size, 1);
  const offset = [...cache.values()][0].offset;
  await readActiveSession({ sessionsDir: root, wallClock: () => now, cache });
  assert.equal([...cache.values()][0].offset, offset + 8 * 1024 * 1024);
});

test('session filename parser only accepts the fixed UUID suffix', () => {
  assert.equal(sessionIdFromFilename(filename(id)), id);
  assert.equal(sessionIdFromFilename('rollout-x-' + id + '-reverted.jsonl'), null);
  assert.equal(sessionIdFromFilename('rollout-x-' + id.toUpperCase() + '.jsonl'), null);
  assert.equal(sessionIdFromFilename('rollout-x-' + id + '.json'), null);
});

test('W1 dual UUID discovery and always-present unavailable contracts', () => {
  assert.equal(sessionIdFromFilename(filename(id).replace('.jsonl', '-' + idFor(1) + '.jsonl')), id);
  const value = publicUsage('empty', null, null, null);
  assert.equal(value.conversationContext.reason, 'no_session');
  assert.equal(value.lastCompletedTurn.outputTokens, null);
  assert.equal(value.turnAverageSpeed.includesToolsAndWait, true);
});

test('usage parser keeps only the allowlisted counters', () => {
  const line = JSON.stringify({
    timestamp: iso,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: { total_token_usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20, prompt: 'secret' } },
      response: 'secret',
    },
    message: 'secret',
  });
  assert.deepEqual(parseUsageLine(line, id, now), {
    type: 'token_count', timestamp: now, sessionId: id,
    usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
  });
  const unknown = JSON.stringify({ timestamp: iso, type: 'other_event', payload: { content: 'secret' } });
  assert.equal(parseUsageLine(unknown, id, now), null);
});

test('usage parser rejects malformed, future, mismatched and invalid counter records', () => {
  assert.throws(() => parseUsageLine('{', id, now), /malformed_line/);
  assert.throws(() => parseUsageLine('[]', id, now), /invalid_event/);
  assert.throws(() => parseUsageLine(JSON.stringify({ timestamp: iso, type: 'session_meta', payload: { id: idFor(1) } }), id, now), /session_mismatch/);
  assert.throws(() => parseUsageLine(JSON.stringify({ timestamp: '2099-01-01T00:00:00Z', type: 'session_meta', payload: { id } }), id, now), /invalid_timestamp/);
  assert.throws(() => parseUsageLine(JSON.stringify({ timestamp: iso, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: -1, output_tokens: 2, total_tokens: 1 } } } }), id, now), /invalid_usage/);
  assert.throws(() => parseUsageLine(JSON.stringify({ timestamp: iso, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1, output_tokens: null, total_tokens: 1 } } } }), id, now), /invalid_usage/);
  assert.deepEqual(parseUsageLine(tokenLine({ input_tokens: null, output_tokens: null, total_tokens: null }), id, now).usage, null);
});

test('usage counters reject inconsistent or unsafe totals before session publication and preserve zero', async (t) => {
  const invalid = [
    ['inconsistent total', { input_tokens: 2, output_tokens: 1, total_tokens: 99 }],
    ['unsafe sum', { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 1, total_tokens: Number.MAX_SAFE_INTEGER }],
    ['unsafe total', { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 1, total_tokens: Number.MAX_SAFE_INTEGER + 1 }],
  ];
  for (const [name, usage] of invalid) {
    await t.test(name, async (t) => {
      assert.throws(() => parseUsageLine(tokenLine(usage), id, now), /invalid_usage/);
      const dir = await tempDirectory(t);
      await writeSession(dir, id, { lines: [metaLine(id), tokenLine({ input_tokens: 1, output_tokens: 1, total_tokens: 2 }), tokenLine(usage)] });
      const result = await readActiveSession({ sessionsDir: dir, wallClock: () => now });
      assert.equal(result.state, 'unavailable');
      assert.deepEqual(result.usage, { inputTokens: null, outputTokens: null, totalTokens: null });
    });
  }
  for (const usage of [
    { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    { input_tokens: Number.MAX_SAFE_INTEGER - 1, output_tokens: 1, total_tokens: Number.MAX_SAFE_INTEGER },
  ]) {
    assert.deepEqual(parseUsageLine(tokenLine(usage), id, now).usage,
      { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens, totalTokens: usage.total_tokens });
  }
});

test('forks ignore inherited VS Code metadata without treating it as current-session activity', async (t) => {
  const parent = idFor(1);
  const inherited = { timestamp: iso, type: 'session_meta', payload: {
    id: parent, session_id: parent, source: 'vscode', timestamp: iso,
  } };
  const line = JSON.stringify(inherited);
  assert.equal(parseUsageLine(line, id, now), null);
  const root = await tempDirectory(t);
  await writeSession(root, id, { lines: [metaLine(id), line, tokenLine({ input_tokens: 3, output_tokens: 2, total_tokens: 5 })] });
  const result = await readActiveSession({ sessionsDir: root, wallClock: () => now });
  assert.equal(result.state, 'ok');
  assert.equal(result.session.id, id);
  assert.equal(result.usage.totalTokens, 5);
  const inheritedOnly = await tempDirectory(t);
  await writeSession(inheritedOnly, id, { lines: [line] });
  assert.equal((await readActiveSession({ sessionsDir: inheritedOnly, wallClock: () => now })).state, 'empty');
  for (const patch of [
    { id: 'invalid', session_id: 'invalid' }, { session_id: id },
    { session_id: undefined }, { source: 'cli' }, { timestamp: 'invalid' },
    { timestamp: '2099-01-01T00:00:00Z' },
  ]) {
    assert.throws(() => parseUsageLine(JSON.stringify({ ...inherited, payload: { ...inherited.payload, ...patch } }), id, now), /session_mismatch/);
  }
  assert.throws(() => parseUsageLine(line, 'invalid', now), /session_mismatch/);
});

test('public telemetry schema contains no parser internals or transcript fields', () => {
  const value = publicUsage('ok', { id, updatedAt: iso, eventTimestamp: now }, { inputTokens: 1, outputTokens: 2, totalTokens: 3, prompt: 'secret' }, { state: 'available', outputTokensPerSecond: 2 });
  assert.deepEqual(Object.keys(value).sort(), ['conversationContext', 'lastCompletedTurn', 'session', 'speed', 'state', 'turnAverageSpeed', 'usage']);
  assert.deepEqual(Object.keys(value.session).sort(), ['id', 'updatedAt']);
  assert.deepEqual(Object.keys(value.usage).sort(), ['inputTokens', 'outputTokens', 'totalTokens']);
  assert.deepEqual(value.speed, { outputTokensPerSecond: 2, state: 'available' });
  assert.equal(JSON.stringify(value).includes('secret'), false);
  assert.equal(JSON.stringify(value).includes('eventTimestamp'), false);
});

test('active session reader selects a deterministic active file and handles empty or stale data', async (t) => {
  const dir = await tempDirectory(t);
  await writeSession(dir, id);
  const selected = await readActiveSession({ sessionsDir: dir, wallClock: () => now });
  assert.equal(selected.state, 'ok');
  assert.equal(selected.session.id, id);
  assert.deepEqual(selected.usage, { inputTokens: 10, outputTokens: 5, totalTokens: 15 });

  const staleDir = await tempDirectory(t);
  await writeSession(staleDir, idFor(1), { timestamp: '2026-10-10T23:00:00.000Z', mtime: now });
  assert.equal((await readActiveSession({ sessionsDir: staleDir, wallClock: () => now })).state, 'empty');
  const oldMtimeDir = await tempDirectory(t);
  await writeSession(oldMtimeDir, idFor(2), { mtime: now - 600_001 });
  assert.equal((await readActiveSession({ sessionsDir: oldMtimeDir, wallClock: () => now })).session.id, idFor(2));
  assert.equal((await readActiveSession({ sessionsDir: join(dir, 'missing'), wallClock: () => now })).state, 'unavailable');
});

test('active session reader ignores an unterminated tail but rejects malformed complete records', async (t) => {
  const validDir = await tempDirectory(t);
  await writeSession(validDir, id, {
    lines: [metaLine(id), tokenLine({ input_tokens: 10, output_tokens: 5, total_tokens: 15 }), '{"unterminated":'],
    finalNewline: false,
  });
  assert.equal((await readActiveSession({ sessionsDir: validDir, wallClock: () => now })).state, 'ok');
  const malformedDir = await tempDirectory(t);
  await writeSession(malformedDir, idFor(1), { lines: [metaLine(idFor(1)), '{'] });
  assert.equal((await readActiveSession({ sessionsDir: malformedDir, wallClock: () => now })).state, 'unavailable');
  const mismatchDir = await tempDirectory(t);
  await writeSession(mismatchDir, idFor(2), { lines: [metaLine(id), tokenLine({ input_tokens: 1, output_tokens: 1, total_tokens: 2 })] });
  assert.equal((await readActiveSession({ sessionsDir: mismatchDir, wallClock: () => now })).state, 'unavailable');
  const futureDir = await tempDirectory(t);
  await writeSession(futureDir, idFor(3), { timestamp: '2026-10-11T00:10:00.000Z' });
  assert.equal((await readActiveSession({ sessionsDir: futureDir, wallClock: () => now })).state, 'unavailable');
});

test('active session reader reports close candidates as ambiguous and otherwise picks newest event', async (t) => {
  const dir = await tempDirectory(t);
  await writeSession(dir, idFor(1));
  await writeSession(dir, idFor(2));
  const ambiguous = await readActiveSession({ sessionsDir: dir, wallClock: () => now });
  assert.equal(ambiguous.state, 'ambiguous');
  assert.equal(ambiguous.session, null);
  const newer = '2026-10-11T00:00:02.000Z';
  await writeSession(dir, idFor(2), { timestamp: newer });
  const selected = await readActiveSession({ sessionsDir: dir, wallClock: () => now });
  assert.equal(selected.state, 'ok');
  assert.equal(selected.session.id, idFor(2));
  assert.equal(selected.session.updatedAt, newer);
});

test('active session reader enforces candidate and line bounds', async (t) => {
  const manyDir = await tempDirectory(t, 'codex-telemetry-many-');
  await Promise.all(Array.from({ length: 101 }, (_, index) => writeSession(manyDir, idFor(index), { usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } })));
  assert.equal((await readActiveSession({ sessionsDir: manyDir, wallClock: () => now })).state, 'unavailable');
  const lineDir = await tempDirectory(t, 'codex-telemetry-line-');
  const huge = 'x'.repeat(256 * 1024);
  await writeSession(lineDir, id, { lines: [metaLine(id), JSON.stringify({ timestamp: iso, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }, unknown: huge })] });
  const oversized = await readActiveSession({ sessionsDir: lineDir, wallClock: () => now });
  assert.equal(oversized.state, 'unavailable');
  assert.equal(oversized.lastCompletedTurn.reason, 'budget_exceeded');
  assert.equal(oversized.usage.totalTokens, null);
});

test('speed tracker handles valid samples, invalid intervals, resets and retention', () => {
  const tracker = createSpeedTracker();
  const usage = (output, input = 10) => ({ inputTokens: input, outputTokens: output, totalTokens: input + output });
  assert.equal(tracker.observe(id, usage(10), 0).state, 'unavailable');
  assert.equal(tracker.observe(id, usage(30), 1000).outputTokensPerSecond, 20);
  assert.equal(tracker.observe(id, usage(30), 3000).outputTokensPerSecond, 20);
  assert.equal(tracker.observe(id, usage(30), 6001).state, 'unavailable');
  assert.equal(tracker.observe(id, usage(40), 6100).state, 'unavailable');
  assert.equal(tracker.observe(id, usage(60), 12100).state, 'unavailable');
  assert.equal(tracker.observe(id, usage(70), 12600).outputTokensPerSecond, 20);
  assert.equal(tracker.observe(idFor(1), usage(80), 13600).state, 'unavailable');
  assert.equal(tracker.observe(idFor(1), usage(1), 14600).state, 'unavailable');
  assert.equal(tracker.observe(idFor(1), null, 15600).state, 'unavailable');
});

test('telemetry worker refreshes with injected clocks and drops stale or rolled-back samples', async (t) => {
  const dir = await tempDirectory(t, 'codex-telemetry-worker-');
  let wall = now;
  let monotonic = 0;
  let intervalCallback;
  let cleared = false;
  const scheduler = {
    setInterval(callback) { intervalCallback = callback; return 1; },
    clearInterval() { cleared = true; },
  };
  const worker = createTelemetryWorker({ sessionsDir: dir, wallClock: () => wall, monotonicClock: () => monotonic, scheduler });
  await writeSession(dir, id, { usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } });
  const first = await worker.start();
  assert.equal(first.state, 'ok');
  assert.equal(first.speed.state, 'unavailable');
  assert.equal(typeof intervalCallback, 'function');
  await fs.appendFile(join(dir, filename(id)), tokenLine({ input_tokens: 10, output_tokens: 30, total_tokens: 40 }) + '\n');
  monotonic = 1000;
  await worker.refresh();
  assert.equal(worker.snapshot().lastCompletedTurn.reason, 'turn_start_missing');
  assert.deepEqual(worker.snapshot().speed, { outputTokensPerSecond: null, state: 'unavailable' });
  monotonic = 3000;
  assert.deepEqual(worker.snapshot().speed, { outputTokensPerSecond: null, state: 'unavailable' });
  monotonic = 6001;
  assert.equal(worker.snapshot().speed.state, 'unavailable');
  wall = now - 1000;
  monotonic = 7000;
  await worker.refresh();
  assert.equal(worker.snapshot().speed.state, 'unavailable');
  monotonic = 10001;
  assert.equal(worker.snapshot().state, 'unavailable');
  await worker.stop();
  assert.equal(cleared, true);
});
import { parseConfigDefaults, readConfigDefaults, createConfigDefaultsReader } from '../src/telemetry/config-defaults.js';
import { createTurnState, isolateTurnState, observeTelemetry, parseTelemetryLine, projectTelemetry, unavailableTelemetry, validModel } from '../src/telemetry/usage.js';
import { createSessionReader } from '../src/telemetry/session-reader.js';

function eventLine(type, payload, offset = 0) {
  return JSON.stringify({ type: ['task_started', 'task_complete'].includes(type) ? 'event_msg' : type, timestamp: new Date(now + offset).toISOString(), payload: { ...(type.startsWith('task_') ? { type } : {}), ...payload } });
}
const turnCounts = { input_tokens: 100, output_tokens: 9310, total_tokens: 9410 };
function turnRows() {
  return [eventLine('session_meta', { id, session_id: id }),
    eventLine('task_started', { turn_id: 'turn-1', root_turn_id: 'turn-1' }, -1520559),
    eventLine('turn_context', { turn_id: 'turn-1', root_turn_id: 'turn-1', model: 'gpt-6.1-sol', effort: 'ultra' }, -1520558),
    eventLine('token_usage_record', { thread_id: id, session_id: id, turn_id: 'turn-1', root_turn_id: 'turn-1', response_id: 'response-1', turn_token_usage: turnCounts, thread_token_usage: turnCounts }, -1),
    eventLine('task_complete', { turn_id: 'turn-1' })];
}

test('stale mtime cold discovery preserves real completed-turn evidence', async (t) => {
  const dir = await tempDirectory(t);
  await writeSession(dir, id, { lines: turnRows(), mtime: now - 1_088_000 });
  const value = await readActiveSession({ sessionsDir: dir, wallClock: () => now });
  assert.equal(value.state, 'ok');
  assert.equal(value.session?.id, id);
  assert.equal(value.eventTimestamp, now);
  const expected = projectRows(turnRows(), false);
  assert.deepEqual(value.conversationContext, expected.conversationContext);
  assert.deepEqual(value.lastCompletedTurn, expected.lastCompletedTurn);
  assert.deepEqual(value.turnAverageSpeed, expected.turnAverageSpeed);
});

test('stale mtime warm discovery reads append with unchanged old mtime', async (t) => {
  const dir = await tempDirectory(t);
  const rows = turnRows();
  const oldMtime = now - 1_088_000;
  const path = await writeSession(dir, id, { lines: rows.slice(0, 3), mtime: oldMtime });
  const reader = createSessionReader({ sessionsDir: dir, wallClock: () => now });
  assert.equal((await reader.read()).conversationContext.model, 'gpt-6.1-sol');
  assert.equal((await reader.read()).session?.id, id);
  await fs.appendFile(path, rows.slice(3).join('\n') + '\n');
  await utimes(path, oldMtime / 1000, oldMtime / 1000);
  assert.equal((await reader.read()).lastCompletedTurn.outputTokens, 9310);
  assert.equal((await reader.read()).lastCompletedTurn.outputTokens, 9310);
});

test('stale mtime cold large main recovers across bounded polls', async (t) => {
  const dir = await tempDirectory(t);
  const rows = turnRows();
  const ignored = JSON.stringify({ type: 'response_item', payload: { text: 'x'.repeat(20000) } });
  await writeSession(dir, id, { lines: [...rows.slice(0, 3), ...Array(700).fill(ignored), ...rows.slice(3)], mtime: now - 1_088_000 });
  const originalOpen = fs.open;
  let bytes = 0, maximum = 0;
  t.mock.method(fs, 'open', async (...args) => {
    const file = await originalOpen(...args);
    const read = file.read.bind(file);
    file.read = (...params) => { bytes += params[2]; maximum = Math.max(maximum, params[2]); return read(...params); };
    return file;
  });
  const reader = createSessionReader({ sessionsDir: dir, wallClock: () => now });
  let value;
  let polls = 0;
  for (let poll = 0; poll < 6; poll++) {
    polls++;
    bytes = 0;
    value = await reader.read();
    assert.ok(bytes <= 8 * 1024 * 1024, String(bytes));
    if (value.lastCompletedTurn.state === 'available') break;
    assert.equal(value.lastCompletedTurn.outputTokens, null);
    assert.equal(value.lastCompletedTurn.reason, 'bootstrap_in_progress');
  }
  assert.ok(maximum <= 2 * 1024 * 1024);
  assert.equal(polls, 2);
  assert.equal(value.lastCompletedTurn.outputTokens, 9310);
  assert.equal(value.session?.id, id);
});

test('stale mtime does not revive genuinely expired main or select an active subagent', async (t) => {
  const dir = await tempDirectory(t);
  const oldRows = turnRows().map((line) => {
    const row = JSON.parse(line);
    row.timestamp = new Date(Date.parse(row.timestamp) - 700_000).toISOString();
    return JSON.stringify(row);
  });
  await writeSession(dir, id, { lines: oldRows, mtime: now - 1_088_000 });
  await writeSession(dir, idFor(1), { lines: [eventLine('session_meta', { id: idFor(1), session_id: idFor(2), source: 'subagent' })] });
  const reader = createSessionReader({ sessionsDir: dir, wallClock: () => now });
  for (let poll = 0; poll < 3; poll++) {
    const value = await reader.read();
    assert.equal(value.state, 'empty');
    assert.equal(value.session, null);
    assert.equal(value.lastCompletedTurn.outputTokens, null);
    assert.equal(value.conversationContext.model, null);
  }
});

test('stale mtime fresh evidence still fails closed on corrupt main bytes', async (t) => {
  const dir = await tempDirectory(t);
  await writeSession(dir, id, { lines: ['{', ...turnRows()], mtime: now - 1_088_000 });
  const value = await readActiveSession({ sessionsDir: dir, wallClock: () => now });
  assert.equal(value.state, 'unavailable');
  assert.equal(value.lastCompletedTurn.reason, 'read_failed');
  assert.equal(value.lastCompletedTurn.outputTokens, null);
  assert.equal(value.conversationContext.model, null);
});

test('stale mtime fallback rotates more than 100 historical files and then switches main', async (t) => {
  const dir = await tempDirectory(t);
  const old = new Date(now - 700_000).toISOString();
  const oldMtime = now - 1_088_000;
  await Promise.all(Array.from({ length: 130 }, (_, index) => writeSession(dir, idFor(index + 1), { timestamp: old, mtime: oldMtime })));
  await writeSession(dir, id, { lines: turnRows(), mtime: oldMtime });
  const reader = createSessionReader({ sessionsDir: dir, wallClock: () => now + 5000 });
  const first = await reader.read();
  assert.equal(first.lastCompletedTurn.reason, 'bootstrap_in_progress');
  const recovered = await reader.read();
  assert.equal(recovered.session?.id, id);
  assert.equal(recovered.lastCompletedTurn.outputTokens, 9310);
  const next = idFor(500);
  await writeSession(dir, next, { timestamp: new Date(now + 5000).toISOString(), mtime: oldMtime });
  const switched = await reader.read();
  assert.equal(switched.session?.id, next);
  assert.equal(switched.lastCompletedTurn.outputTokens, null);
  assert.equal(switched.conversationContext.model, null);
  await writeSession(dir, idFor(501), { lines: [eventLine('session_meta', { id: idFor(501), session_id: idFor(502), source: 'subagent' }, 6000)], mtime: oldMtime });
  assert.equal((await reader.read()).session?.id, next);
});

test('stale mtime unknown giant history cannot starve a checked current main', async (t) => {
  const dir = await tempDirectory(t);
  const old = new Date(now - 700_000).toISOString();
  const ignored = JSON.stringify({ type: 'response_item', payload: { text: 'x'.repeat(20000) } });
  const giant = [metaLine(idFor(1), old), ...Array(500).fill(ignored)].join('\n') + '\n';
  const historical = await writeSession(dir, idFor(1), { lines: [], mtime: now - 1_088_000 });
  await writeFile(historical, giant);
  await utimes(historical, (now - 1_088_000) / 1000, (now - 1_088_000) / 1000);
  await writeSession(dir, id, { lines: turnRows() });
  const originalOpen = fs.open;
  let historicalBytes = 0, totalBytes = 0;
  t.mock.method(fs, 'open', async (...args) => {
    const file = await originalOpen(...args);
    const read = file.read.bind(file);
    file.read = (...params) => {
      totalBytes += params[2];
      if (args[0] === historical) historicalBytes += params[2];
      return read(...params);
    };
    return file;
  });
  const reader = createSessionReader({ sessionsDir: dir, wallClock: () => now });
  for (let poll = 0; poll < 3; poll++) {
    historicalBytes = 0; totalBytes = 0;
    const value = await reader.read();
    assert.equal(value.session?.id, id);
    assert.equal(value.lastCompletedTurn.outputTokens, 9310);
    assert.ok(historicalBytes <= 2 * 1024 * 1024);
    assert.ok(totalBytes <= 8 * 1024 * 1024);
  }
  assert.equal(historicalBytes, 2 * 256 * 1024);
});

test('stale mtime independent probe budget is capped at 2MiB and resumes fairly', async (t) => {
  const dir = await tempDirectory(t);
  const oldMtime = now - 1_088_000;
  const ignored = JSON.stringify({ type: 'response_item', payload: { text: 'x'.repeat(20000) } });
  const histories = new Set();
  for (let index = 0; index < 5; index++) histories.add(await writeSession(dir, idFor(index + 1), { lines: Array(60).fill(ignored), mtime: oldMtime }));
  await writeSession(dir, id, { lines: turnRows(), mtime: oldMtime });
  const originalOpen = fs.open;
  let bytes = 0, historicalBytes = 0, maximum = 0;
  t.mock.method(fs, 'open', async (...args) => {
    const file = await originalOpen(...args);
    const read = file.read.bind(file);
    file.read = (...params) => {
      bytes += params[2]; maximum = Math.max(maximum, params[2]);
      if (histories.has(args[0])) historicalBytes += params[2];
      return read(...params);
    };
    return file;
  });
  const reader = createSessionReader({ sessionsDir: dir, wallClock: () => now });
  const first = await reader.read();
  assert.equal(first.lastCompletedTurn.reason, 'bootstrap_in_progress');
  assert.equal(historicalBytes, 2 * 1024 * 1024);
  assert.ok(bytes <= 8 * 1024 * 1024);
  bytes = 0; historicalBytes = 0;
  const second = await reader.read();
  assert.equal(second.lastCompletedTurn.outputTokens, 9310);
  assert.ok(historicalBytes <= 2 * 1024 * 1024);
  assert.ok(bytes <= 8 * 1024 * 1024);
  assert.ok(maximum <= 2 * 1024 * 1024);
});

test('stale mtime probe scans behind unrelated tails and accepts the exact line limit', async (t) => {
  const dir = await tempDirectory(t);
  const record = { timestamp: iso, type: 'session_meta', payload: { id }, padding: '' };
  record.padding = 'x'.repeat(256 * 1024 - Buffer.byteLength(JSON.stringify(record)));
  const exact = JSON.stringify(record);
  assert.equal(Buffer.byteLength(exact), 256 * 1024);
  const path = await writeSession(dir, id, { lines: [] });
  const ignored = { type: 'other', padding: '' };
  ignored.padding = 'x'.repeat(256 * 1024 - 2 - Buffer.byteLength(JSON.stringify(ignored)));
  // Place the metadata exactly at the first probe window's starting byte.
  // The next overlapping window must include its trailing newline.
  const content = Buffer.from('{"type":"other"}\n' + exact + '\n' + JSON.stringify(ignored) + '\n');
  await writeFile(path, content);
  await utimes(path, (now - 1_088_000) / 1000, (now - 1_088_000) / 1000);
  const reader = createSessionReader({ sessionsDir: dir, wallClock: () => now });
  let value;
  for (let poll = 0; poll < 8; poll++) {
    value = await reader.read();
    if (value.state !== 'unavailable' || value.lastCompletedTurn.reason !== 'bootstrap_in_progress') break;
  }
  assert.equal(value.session?.id, id);
  assert.equal(value.eventTimestamp, now);
  assert.equal(value.lastCompletedTurn.reason, 'turn_start_missing');
  assert.equal(value.lastCompletedTurn.outputTokens, null);
});

test('stale mtime probe cannot authorize oversized identity-conflicting or invalid UTF8 telemetry', async (t) => {
  const rows = turnRows();
  const huge = JSON.stringify({ ...JSON.parse(rows[3]), padding: 'x'.repeat(300 * 1024) });
  for (const [lines, reason] of [
    [[...rows.slice(0, 3), huge, rows[4]], 'turn_ambiguous'],
    [[eventLine('session_meta', { id, session_id: idFor(1) }), ...rows.slice(1)], 'identity_conflict'],
    [[Buffer.from([0xff]), ...rows], 'read_failed'],
  ]) {
    const dir = await tempDirectory(t);
    const path = await writeSession(dir, id, { lines: [], mtime: now - 1_088_000 });
    await writeFile(path, Buffer.concat(lines.flatMap((line) => [Buffer.from(line), Buffer.from('\n')])));
    await utimes(path, (now - 1_088_000) / 1000, (now - 1_088_000) / 1000);
    const value = await readActiveSession({ sessionsDir: dir, wallClock: () => now });
    assert.equal(value.lastCompletedTurn.reason, reason);
    assert.equal(value.lastCompletedTurn.outputTokens, null);
    assert.equal(value.turnAverageSpeed.outputTokensPerSecond, null);
  }
});

test('stale mtime close main candidates remain ambiguous after independent probes', async (t) => {
  const dir = await tempDirectory(t);
  await writeSession(dir, id, { mtime: now - 1_088_000 });
  await writeSession(dir, idFor(1), { mtime: now - 1_088_000 });
  const value = await readActiveSession({ sessionsDir: dir, wallClock: () => now });
  assert.equal(value.state, 'ambiguous');
  assert.equal(value.lastCompletedTurn.outputTokens, null);
  assert.equal(value.conversationContext.model, null);
});

test('stale mtime verified main expires while only a subagent keeps writing', async (t) => {
  const dir = await tempDirectory(t);
  let wall = now;
  await writeSession(dir, id, { lines: turnRows(), mtime: now - 1_088_000 });
  const reader = createSessionReader({ sessionsDir: dir, wallClock: () => wall });
  assert.equal((await reader.read()).lastCompletedTurn.outputTokens, 9310);
  wall += 600_001;
  await writeSession(dir, idFor(1), { lines: [eventLine('session_meta', { id: idFor(1), session_id: idFor(2), source: 'subagent' }, 600_001)], mtime: wall });
  const expired = await reader.read();
  assert.equal(expired.state, 'empty');
  assert.equal(expired.session, null);
  assert.equal(expired.lastCompletedTurn.outputTokens, null);
  assert.equal(expired.conversationContext.model, null);
});
function projectRows(rows, dual = true) {
  const state = createTurnState();
  for (const line of rows) observeTelemetry(state, parseTelemetryLine(line, now), id);
  return projectTelemetry(state, dual);
}

function rootStart(turn, offset) {
  return eventLine('task_started', { turn_id: turn, root_turn_id: turn }, offset);
}
function rootContext(turn, offset) {
  return eventLine('turn_context', { turn_id: turn, root_turn_id: turn, model: 'example-provider/gpt-6.1-sol', effort: 'ultra' }, offset);
}
function rootUsage(turn, offset, counts = { input_tokens: 10, output_tokens: 20, total_tokens: 30 }, extra = {}) {
  return eventLine('token_usage_record', { thread_id: id, session_id: id, turn_id: turn, root_turn_id: turn, response_id: 'response-' + turn, turn_token_usage: counts, thread_token_usage: counts, ...extra }, offset);
}
function rootComplete(turn, offset, extra = {}) {
  return eventLine('task_complete', { turn_id: turn, ...extra }, offset);
}
function oversizedItemCompleted(bytes, text = 'SYNTHETIC_ITEM_BODY') {
  const record = { type: 'event_msg', timestamp: iso, payload: { type: 'item_completed', output: text } };
  record.payload.output += 'x'.repeat(bytes - Buffer.byteLength(JSON.stringify(record)));
  const line = JSON.stringify(record);
  assert.equal(Buffer.byteLength(line), bytes);
  return line;
}

test('v7 exact oversized item_completed preserves a real active turn', async (t) => {
  const dir = await tempDirectory(t);
  const rows = turnRows();
  const huge = oversizedItemCompleted(929009, 'SYNTHETIC_ITEM_BODY' + String.fromCharCode(65533) + '汉');
  assert.equal(parseUsageLine(huge, id, now), null);
  assert.equal(parseTelemetryLine(huge, now), null);
  const cache = new Map();
  await writeSession(dir, id, { lines: [...rows.slice(0, 3), huge, ...rows.slice(3)] });
  const result = await readActiveSession({ sessionsDir: dir, wallClock: () => now, cache });
  assert.deepEqual(result.lastCompletedTurn, projectRows(rows, false).lastCompletedTurn);
  assert.equal(result.eventTimestamp, now);
  assertNoBody([cache, result], 'SYNTHETIC_ITEM_BODY');
});

test('v7 a distinct root reconstructs an empty current from its real start', () => {
  const rows = [turnRows()[0], rootStart('a', 0), rootContext('a', 1), rootUsage('a', 2),
    rootStart('b', 3), rootContext('b', 4), rootUsage('b', 5), rootComplete('b', 1003)];
  const result = projectRows(rows);
  assert.equal(result.lastCompletedTurn.state, 'available');
  assert.equal(result.lastCompletedTurn.startedAt, new Date(now + 3).toISOString());
  assert.equal(result.lastCompletedTurn.elapsedSeconds, 1);
  assert.equal(result.lastCompletedTurn.outputTokens, 20);
  assert.equal(result.turnAverageSpeed.outputTokensPerSecond, 20);
});

test('v7 superseded usage revokes completion without publishing old usage or time', async (t) => {
  const dir = await tempDirectory(t);
  const initial = [turnRows()[0], rootStart('a', 0), rootStart('b', 1), rootContext('b', 2), rootUsage('b', 3), rootComplete('b', 1001)];
  const path = await writeSession(dir, id, { lines: initial });
  const cache = new Map();
  const read = () => readActiveSession({ sessionsDir: dir, wallClock: () => now, cache });
  const before = await read();
  assert.equal(before.lastCompletedTurn.state, 'available');
  await fs.appendFile(path, rootUsage('a', 2000, { input_tokens: 100, output_tokens: 200, total_tokens: 300 }) + '\n');
  const after = await read();
  assert.equal(after.lastCompletedTurn.reason, 'turn_ambiguous');
  assert.equal(after.lastCompletedTurn.outputTokens, null);
  assert.equal(after.turnAverageSpeed.outputTokensPerSecond, null);
  assert.equal(after.conversationContext.model, null);
  assert.deepEqual(after.usage, before.usage);
  assert.equal(after.eventTimestamp, before.eventTimestamp);
  assert.equal(cache.get(path).turn.lastTime, now + 1001);
  await fs.appendFile(path, rootComplete('a', 2001) + '\n' + rootStart('c', 2002) + '\n' + rootUsage('c', 2003) + '\n' + rootComplete('c', 3002) + '\n');
  assert.equal((await read()).lastCompletedTurn.reason, 'turn_ambiguous');
});

test('v7 completed guard saturation does not evict or publish the 4097th completion', () => {
  const state = createTurnState();
  const observe = (line) => observeTelemetry(state, parseTelemetryLine(line, now), id);
  observe(turnRows()[0]);
  for (let index = 0; index < 4096; index++) {
    const turn = 'completed-' + index;
    observe(rootStart(turn, index * 3));
    observe(rootUsage(turn, index * 3 + 1, undefined, { thread_token_usage: undefined }));
    observe(rootComplete(turn, index * 3 + 2));
  }
  assert.equal(state.completedIds.size, 4096);
  assert.equal(projectTelemetry(state).lastCompletedTurn.state, 'available');
  observe(rootStart('overflow', 13000));
  observe(rootUsage('overflow', 13001, undefined, { thread_token_usage: undefined }));
  observe(rootComplete('overflow', 14000));
  assert.equal(state.completedIds.size, 4096);
  assert.equal(state.completedIds.has('completed-0'), true);
  assert.equal(state.completedIds.has('overflow'), false);
  assert.equal(projectTelemetry(state).lastCompletedTurn.reason, 'budget_exceeded');
});

test('v7 oversized item_completed exact byte boundaries and damaged schemas stay bounded', async (t) => {
  const dir = await tempDirectory(t);
  const rows = turnRows();
  for (const bytes of [256 * 1024, 256 * 1024 + 1, 929009, 2 * 1024 * 1024]) {
    const line = oversizedItemCompleted(bytes, 'SYNTHETIC_ITEM_BODY汉' + String.fromCharCode(65533));
    const cache = new Map();
    await writeSession(dir, id, { lines: [...rows.slice(0, 3), line, ...rows.slice(3)] });
    const result = await readActiveSession({ sessionsDir: dir, wallClock: () => now, cache });
    assert.equal(result.lastCompletedTurn.outputTokens, 9310, String(bytes));
    assert.equal(result.eventTimestamp, now);
    assertNoBody([cache, result], 'SYNTHETIC_ITEM_BODY');
  }
  const valid = oversizedItemCompleted(300 * 1024);
  const changed = (edit) => { const record = JSON.parse(valid); edit(record); return JSON.stringify(record); };
  const corrupt = [oversizedItemCompleted(2 * 1024 * 1024 + 1),
    changed((r) => { r.payload.type = 'item_started'; }),
    changed((r) => { r.payload.type = 'ITEM_COMPLETED'; }),
    changed((r) => { r.payload.type = 'item_completed '; }),
    changed((r) => { r.payload.type = 'unknown'; r.payload.nested = { type: 'item_completed' }; }),
    changed((r) => { r.type = 'item_completed'; }),
    changed((r) => { r.timestamp = 'invalid'; }),
    changed((r) => { delete r.timestamp; }),
    changed((r) => { r.timestamp = new Date(now + 300001).toISOString(); }),
    changed((r) => { r.payload = ['item_completed', r.payload.output]; }),
    changed((r) => { r.payload = r.payload.output; }),
    valid.slice(0, -1), valid + String.fromCharCode(0),
    Buffer.concat([Buffer.from(valid.slice(0, -2)), Buffer.from([0xff]), Buffer.from(valid.slice(-2))]),
    JSON.stringify({ ...JSON.parse(rootUsage('turn-1', 0)), padding: 'x'.repeat(300 * 1024) }),
    tokenLine(turnCounts, iso, { padding: 'x'.repeat(300 * 1024) })];
  for (let index = 0; index < corrupt.length; index++) {
    const path = await writeSession(dir, id, { lines: [] });
    const cache = new Map();
    await writeFile(path, Buffer.concat([Buffer.from(rows.slice(0, 3).join('\n') + '\n'), Buffer.from(corrupt[index]), Buffer.from('\n') ]));
    const result = await readActiveSession({ sessionsDir: dir, wallClock: () => now, cache });
    assert.notEqual(result.lastCompletedTurn.state, 'available', String(index));
    assert.equal(cache.get(path).hasGap, true, String(index));
    assert.equal(cache.get(path).turn.supersededIds.has('turn-1'), true, String(index));
    assert.equal(cache.get(path).turn.interleaved, false, 'a gap alone is not interleaving');
    assertNoBody([cache, result], 'SYNTHETIC_ITEM_BODY');
  }
});

test('v7 item_completed chunks and polls cannot update identity time or pending errors', async (t) => {
  const dir = await tempDirectory(t);
  const rows = turnRows();
  const marker = 'SYNTHETIC_ITEM_BODY汉';
  const huge = oversizedItemCompleted(929009, marker);
  const filler = JSON.stringify({ type: 'other', text: 'x'.repeat(20000) });
  const cache = new Map();
  const path = await writeSession(dir, id, { lines: [...rows.slice(0, 3), ...Array(450).fill(filler), huge, ...rows.slice(3)] });
  const originalOpen = fs.open;
  const reads = [];
  t.mock.method(fs, 'open', async (...args) => {
    const file = await originalOpen(...args);
    const read = file.read.bind(file);
    file.read = (...params) => { reads.push({ length: params[2], position: params[3] }); return read(...params); };
    return file;
  });
  const poll = async () => {
    const index = reads.length;
    const value = await readActiveSession({ sessionsDir: dir, wallClock: () => now, cache });
    assert.ok(reads.slice(index).reduce((sum, x) => sum + x.length, 0) <= 8 * 1024 * 1024);
    return value;
  };
  const first = await poll();
  assert.equal(first.lastCompletedTurn.reason, 'bootstrap_in_progress');
  assert.equal(first.lastCompletedTurn.outputTokens, null);
  const second = await poll();
  assert.equal(second.lastCompletedTurn.outputTokens, 9310);
  assert.ok(reads.every(x => x.length <= 2 * 1024 * 1024));
  assertNoBody([cache, second], 'SYNTHETIC_ITEM_BODY');
  t.mock.restoreAll();

  const splitCache = new Map();
  await writeSession(dir, id, { lines: rows.slice(0, 3) });
  const pollSplit = () => readActiveSession({ sessionsDir: dir, wallClock: () => now, cache: splitCache });
  await pollSplit();
  const data = Buffer.from(huge);
  const split = data.indexOf(Buffer.from('汉')) + 1;
  await fs.appendFile(path, data.subarray(0, split));
  await pollSplit();
  assert.equal(splitCache.get(path).remainder.length, split);
  await fs.appendFile(path, Buffer.concat([data.subarray(split), Buffer.from('\n' + rows.slice(3).join('\n') + '\n')]));
  assert.equal((await pollSplit()).lastCompletedTurn.outputTokens, 9310);
  assertNoBody(splitCache, 'SYNTHETIC_ITEM_BODY');

  const pendingCache = new Map();
  await writeSession(dir, id, { lines: [...rows.slice(0, 3), 'x'.repeat(300 * 1024), huge] });
  const pending = await readActiveSession({ sessionsDir: dir, wallClock: () => now, cache: pendingCache });
  assert.equal(pending.lastCompletedTurn.reason, 'budget_exceeded');
  assert.equal(pendingCache.get(path).turn.reason, 'read_gap');
  assert.equal(pendingCache.get(path).turn.interleaved, false);
  assertNoBody(pendingCache, 'SYNTHETIC_ITEM_BODY');
});

test('v7 eight real starts and five complete chains recover exactly five completions', () => {
  const state = createTurnState();
  const observe = (line) => observeTelemetry(state, parseTelemetryLine(line, now), id);
  observe(turnRows()[0]);
  const completed = new Set([2, 4, 5, 6, 7]);
  let count = 0;
  for (let number = 1; number <= 8; number++) {
    const turn = 'root-' + number, offset = number * 2000;
    observe(rootStart(turn, offset));
    observe(rootContext(turn, offset + 1));
    if (!completed.has(number)) continue;
    observe(rootUsage(turn, offset + 2, undefined, { thread_token_usage: undefined }));
    observe(rootComplete(turn, offset + 1000));
    const result = projectTelemetry(state);
    assert.equal(result.lastCompletedTurn.state, 'available');
    assert.equal(result.lastCompletedTurn.completedAt, new Date(now + offset + 1000).toISOString());
    assert.equal(result.lastCompletedTurn.elapsedSeconds, 1);
    assert.equal(result.lastCompletedTurn.outputTokens, 20);
    count++;
  }
  assert.equal(count, 5);
  assert.equal(state.completedIds.size, 5);
  assert.deepEqual([...state.supersededIds], ['root-1', 'root-3']);
  assert.equal(projectTelemetry(state).lastCompletedTurn.completedAt, new Date(now + 15000).toISOString());
});

test('v7 replacing incomplete roots keeps prior completion and never inherits old counters', () => {
  const state = createTurnState();
  const observe = (line) => observeTelemetry(state, parseTelemetryLine(line, now), id);
  for (const line of [turnRows()[0], rootStart('c', 0), rootUsage('c', 1), rootComplete('c', 1000)]) observe(line);
  const c = projectTelemetry(state).lastCompletedTurn;
  for (const line of [rootStart('a', 1001), rootContext('a', 1002), rootUsage('a', 1003), rootStart('b', 1004)]) observe(line);
  assert.deepEqual(projectTelemetry(state).lastCompletedTurn, c);
  assert.equal(state.current.start, now + 1004);
  assert.equal(state.current.responses.size, 0);
  assert.equal(state.current.usage, null);
  assert.equal(state.current.before, null);
  assert.equal(state.cumulative, null);
  assert.equal(state.context, null);
  observe(rootContext('b', 1005));
  assert.deepEqual(projectTelemetry(state).lastCompletedTurn, c);
  observe(rootUsage('b', 1006, { input_tokens: 1, output_tokens: 2, total_tokens: 3 }));
  observe(rootComplete('b', 2004));
  assert.equal(projectTelemetry(state).lastCompletedTurn.outputTokens, 2);
  const missing = projectRows([turnRows()[0], rootStart('a', 0), rootUsage('a', 1), rootStart('b', 2), rootComplete('b', 1002)]);
  assert.equal(missing.lastCompletedTurn.reason, 'usage_missing');
  assert.equal(missing.lastCompletedTurn.outputTokens, null);
  const poisoned = projectRows([turnRows()[0], rootStart('a', 0), rootStart('a', 1),
    rootStart('b', 2), rootUsage('b', 3), rootComplete('b', 1002)]);
  assert.equal(poisoned.lastCompletedTurn.reason, 'turn_ambiguous');
  assert.equal(poisoned.lastCompletedTurn.outputTokens, null);
});

test('v7 every superseded context usage or complete revokes eligibility at each poll boundary', async (t) => {
  const dir = await tempDirectory(t);
  for (const kind of ['usage', 'context', 'complete', 'complete-root']) {
    const first = [turnRows()[0], rootStart('a', 0), rootStart('b', 1)];
    const b = [rootContext('b', 2), rootUsage('b', 3), rootComplete('b', 1001)];
    const old = kind === 'usage' ? rootUsage('a', 2000) : kind === 'context' ? rootContext('a', 4)
      : rootComplete('a', 4, kind === 'complete-root' ? { root_turn_id: 'a' } : {});
    const sequence = kind === 'usage' ? [...first, ...b, old, rootComplete('a', 2001)] : [...first, old, ...b.map((line) => {
      const event = JSON.parse(line); event.timestamp = new Date(Date.parse(event.timestamp) + 10).toISOString(); return JSON.stringify(event);
    })];
    for (const cuts of [[3], [3, 6], [6, 7]]) {
      const path = await writeSession(dir, id, { lines: [], finalNewline: false });
      const cache = new Map();
      const read = () => readActiveSession({ sessionsDir: dir, wallClock: () => now, cache });
      let position = 0, ambiguous = false;
      for (const cut of [...cuts, sequence.length].filter((value, index, array) => value <= sequence.length && (index === 0 || value > array[index - 1]))) {
        await fs.appendFile(path, sequence.slice(position, cut).join('\n') + '\n');
        position = cut;
        const result = await read();
        ambiguous ||= cache.get(path).turn.interleaved;
        if (ambiguous) {
          assert.equal(result.lastCompletedTurn.reason, 'turn_ambiguous', kind);
          assert.equal(result.conversationContext.model, null, kind);
          assert.equal(result.turnAverageSpeed.outputTokensPerSecond, null, kind);
        }
      }
      assert.equal(cache.get(path).turn.interleaved, true, kind);
      await fs.appendFile(path, oversizedItemCompleted(300 * 1024) + '\n' + 'x'.repeat(300 * 1024) + '\n'
        + [rootStart('fresh', 3000), rootContext('fresh', 3001), rootUsage('fresh', 3002), rootComplete('fresh', 4000)].join('\n') + '\n');
      const sticky = await read();
      assert.equal(sticky.lastCompletedTurn.reason, 'turn_ambiguous', kind);
      assert.equal(sticky.conversationContext.model, null, kind);
      assert.equal(sticky.turnAverageSpeed.outputTokensPerSecond, null, kind);
      assert.equal(cache.get(path).turn.proof, false);
      assert.equal((await read()).lastCompletedTurn.reason, 'turn_ambiguous');
    }
  }
});

test('v7 old-root identity timestamp and invalid association fail before interleaving', () => {
  const variants = [
    [rootUsage('a', 10, undefined, { thread_id: idFor(9) }), 'identity_conflict'],
    [rootUsage('a', 10, undefined, { session_id: undefined }), 'identity_unverified'],
    [rootUsage('a', 0), 'timestamp_invalid'],
    [rootUsage('a', 10, undefined, { root_turn_id: null }), 'turn_ambiguous'],
    [rootUsage('a', 10, undefined, { turn_id: undefined }), 'turn_ambiguous'],
    [rootComplete('a', 10, { root_turn_id: null }), 'turn_ambiguous'],
    [rootComplete('a', 10, { root_turn_id: 'other' }), 'turn_ambiguous'],
  ];
  for (const [line, reason] of variants) {
    const state = createTurnState();
    for (const row of [turnRows()[0], rootStart('a', 0), rootStart('b', 1), line]) observeTelemetry(state, parseTelemetryLine(row, now), id);
    assert.equal(projectTelemetry(state).lastCompletedTurn.reason, reason);
    assert.equal(state.interleaved, false);
    if (reason === 'timestamp_invalid') {
      assert.equal(state.lastTime, now + 1);
      observeTelemetry(state, parseTelemetryLine(rootUsage('a', 0), now), id);
      assert.equal(state.lastTime, now + 1);
    }
  }
  const missing = parseTelemetryLine(rootComplete('a', 10), now);
  const invalid = parseTelemetryLine(rootComplete('a', 10, { root_turn_id: null }), now);
  assert.equal(missing.rootPresent, false);
  assert.equal(invalid.rootPresent, true);
  assert.equal(invalid.rootInvalid, true);
  for (const timestamp of ['invalid', new Date(now + 300001).toISOString()]) {
    const record = JSON.parse(rootUsage('a', 10)); record.timestamp = timestamp;
    assert.throws(() => parseTelemetryLine(JSON.stringify(record), now), /timestamp_invalid/);
  }
  for (const [patch, reason] of [[{ session_id: undefined }, 'identity_unverified'], [{ thread_id: idFor(9) }, 'identity_conflict']]) {
    const state = createTurnState();
    for (const row of [turnRows()[0], rootStart('a', 0), rootStart('b', 1), rootContext('a', 2), rootUsage('a', 3, undefined, patch)]) {
      observeTelemetry(state, parseTelemetryLine(row, now), id);
    }
    assert.equal(state.interleaved, true);
    assert.equal(projectTelemetry(state, true).lastCompletedTurn.reason, reason);
    assert.equal(projectTelemetry(state, true).lastCompletedTurn.outputTokens, null);
  }
});

test('v7 root and response guards never evict across saturation and gap', () => {
  const state = createTurnState();
  const observe = (line) => observeTelemetry(state, parseTelemetryLine(line, now), id);
  observe(turnRows()[0]);
  for (let index = 0; index <= 4096; index++) observe(rootStart('root-' + index, index));
  assert.equal(state.supersededIds.size, 4096);
  assert.equal(state.current.turn, 'root-4096');
  observe(rootStart('root-overflow', 5000));
  assert.equal(state.supersededIds.size, 4096);
  assert.equal(state.supersededIds.has('root-0'), true);
  assert.equal(state.current.turn, 'root-4096');
  assert.equal(projectTelemetry(state).lastCompletedTurn.reason, 'budget_exceeded');
  const isolated = isolateTurnState(state);
  assert.equal(isolated.supersededIds.size, 4096);
  assert.equal(isolated.saturated, true);
  assert.equal(projectTelemetry(isolated).lastCompletedTurn.reason, 'budget_exceeded');
  observeTelemetry(isolated, parseTelemetryLine(rootStart('new', 6000), now), id);
  assert.equal(isolated.current, null);

  const responses = createTurnState();
  for (const row of [turnRows()[0], rootStart('responses', 0)]) observeTelemetry(responses, parseTelemetryLine(row, now), id);
  for (let index = 0; index < 4096; index++) observeTelemetry(responses, parseTelemetryLine(rootUsage('responses', 1, undefined, { response_id: 'r-' + index }), now), id);
  observeTelemetry(responses, parseTelemetryLine(rootUsage('responses', 1, undefined, { response_id: 'r-0' }), now), id);
  assert.equal(responses.current.responses.size, 4096);
  assert.equal(responses.saturated, false);
  observeTelemetry(responses, parseTelemetryLine(rootUsage('responses', 2, undefined, { response_id: 'overflow' }), now), id);
  assert.equal(responses.current.responses.size, 4096);
  assert.equal(responses.current.responses.has('overflow'), false);
  assert.equal(projectTelemetry(isolateTurnState(responses)).lastCompletedTurn.reason, 'budget_exceeded');
});

test('v7 same-file truncate rewrite read failure and reset cannot erase sticky evidence', async (t) => {
  const dir = await tempDirectory(t);
  const rows = [turnRows()[0], rootStart('a', 0), rootStart('b', 1), rootContext('a', 2)];
  const path = await writeSession(dir, id, { lines: rows });
  const cache = new Map();
  const read = () => readActiveSession({ sessionsDir: dir, wallClock: () => now, cache });
  assert.equal((await read()).lastCompletedTurn.reason, 'turn_ambiguous');
  const fresh = [turnRows()[0], rootStart('c', 3), rootContext('c', 4), rootUsage('c', 5), rootComplete('c', 1003)];
  await writeFile(path, fresh.join('\n') + '\n');
  assert.equal((await read()).lastCompletedTurn.reason, 'turn_ambiguous');
  await fs.appendFile(path, '{\n');
  assert.equal((await read()).state, 'unavailable');
  assert.equal(cache.get(path).turn.interleaved, true);
  assert.equal(cache.get(path).offset, 0);
  await writeFile(path, fresh.join('\n') + '\n');
  assert.equal((await read()).lastCompletedTurn.reason, 'turn_ambiguous');
  await fs.rename(path, path + '.old');
  await writeFile(path, fresh.join('\n') + '\n');
  await utimes(path, now / 1000, now / 1000);
  assert.equal((await read()).lastCompletedTurn.state, 'available');

  await fs.rename(path, path + '.replacement');
  await writeFile(path, rows.join('\n') + '\n');
  await utimes(path, now / 1000, now / 1000);
  const reader = createSessionReader({ sessionsDir: dir, wallClock: () => now });
  assert.equal((await reader.read()).lastCompletedTurn.reason, 'turn_ambiguous');
  reader.reset();
  assert.equal((await reader.read()).lastCompletedTurn.reason, 'turn_ambiguous');
});

test('legal UTF8 U+FFFD in unrelated transcript preserves subsequent telemetry', async (t) => {
  const dir = await tempDirectory(t);
  const transcript = JSON.stringify({ timestamp: iso, type: 'response_item', payload: { type: 'message', content: [{ type: 'output_text', text: 'synthetic ' + String.fromCharCode(65533) }] } });
  assert.equal(Buffer.from(transcript).includes(Buffer.from([0xef, 0xbf, 0xbd])), true);
  await writeSession(dir, id, { lines: [transcript, ...turnRows()] });
  const result = await readActiveSession({ sessionsDir: dir, wallClock: () => now });
  assert.equal(result.state, 'ok');
  assert.deepEqual(result.usage, { inputTokens: 100, outputTokens: 9310, totalTokens: 9410 });
  const expected = projectRows(turnRows(), false);
  assert.deepEqual(result.conversationContext, expected.conversationContext);
  assert.deepEqual(result.lastCompletedTurn, expected.lastCompletedTurn);
  assert.equal(result.conversationContext.state, 'available');
  assert.equal(result.lastCompletedTurn.state, 'available');
  assert.equal(result.lastCompletedTurn.outputTokens, 9310);
});

test('session reader rejects invalid UTF8, raw NUL and malformed JSON', async (t) => {
  const newline = String.fromCharCode(10);
  for (const [name, corrupt] of [
    ['invalid UTF8', Buffer.from([0xff, 10])],
    ['raw NUL', Buffer.from(JSON.stringify({ type: 'response_item', payload: { text: 'synthetic' } }) + String.fromCharCode(0) + newline)],
    ['malformed JSON', Buffer.from('{' + newline)],
  ]) {
    const dir = await tempDirectory(t);
    const file = await writeSession(dir, id, { lines: turnRows() });
    await writeFile(file, Buffer.concat([corrupt, Buffer.from(turnRows().join(newline) + newline)]));
    await utimes(file, now / 1000, now / 1000);
    const result = await readActiveSession({ sessionsDir: dir, wallClock: () => now });
    assert.equal(result.state, 'unavailable', name);
    assert.equal(result.conversationContext.reason, 'read_failed', name);
  }
});

test('legacy injected readers retain sampled speed without borrowing turn average', async () => {
  let clock = 0, output = 10;
  const worker = createTelemetryWorker({ monotonicClock: () => clock, reader: { read: async () => ({
    state: 'ok', session: { id, updatedAt: iso },
    usage: { inputTokens: 10, outputTokens: output, totalTokens: 10 + output },
  }) } });
  try {
    await worker.refresh();
    clock = 1000; output = 30; await worker.refresh();
    assert.deepEqual(worker.snapshot().speed, { outputTokensPerSecond: 20, state: 'available' });
    assert.equal(worker.snapshot().turnAverageSpeed.outputTokensPerSecond, null);
  } finally { await worker.stop(); }
});

test('new telemetry contract blocks sampled speed and resets baselines across invalid evidence', async () => {
  const valid = projectRows(turnRows());
  const unavailable = { outputTokensPerSecond: null, state: 'unavailable' };
  for (const reason of ['read_gap', 'identity_unverified', 'identity_conflict', 'file_changed', 'budget_exceeded', 'read_failed', 'timestamp_invalid', 'turn_ambiguous', 'counter_regression', 'usage_invalid', 'usage_conflict', 'usage_missing']) {
    let clock = 0, output = 10, metrics = unavailableTelemetry(reason);
    const worker = createTelemetryWorker({ monotonicClock: () => clock, reader: { read: async () => ({
      state: 'ok', session: { id, updatedAt: iso },
      usage: { inputTokens: 10, outputTokens: output, totalTokens: 10 + output }, ...metrics,
    }) } });
    const refresh = async (nextOutput) => { clock += 1000; output = nextOutput; await worker.refresh(); return worker.snapshot(); };
    try {
      await worker.refresh();
      assert.deepEqual(worker.snapshot().speed, unavailable, reason);
      assert.deepEqual((await refresh(30)).speed, unavailable, reason);
      metrics = valid;
      assert.deepEqual((await refresh(50)).speed, unavailable, 'recovery starts a new baseline: ' + reason);
      assert.deepEqual((await refresh(70)).speed, { outputTokensPerSecond: 20, state: 'available' });
      assert.notEqual(worker.snapshot().speed.outputTokensPerSecond, valid.turnAverageSpeed.outputTokensPerSecond);
      // One invalid metric must invalidate a previously available estimate.
      metrics = { ...valid, lastCompletedTurn: unavailableTelemetry(reason).lastCompletedTurn };
      assert.deepEqual((await refresh(90)).speed, unavailable, reason);
      clock += 500;
      assert.deepEqual(worker.snapshot().speed, unavailable, 'snapshot stays gated: ' + reason);
      metrics = valid;
      assert.deepEqual((await refresh(110)).speed, unavailable, 'cannot bridge prior counters: ' + reason);
      assert.deepEqual((await refresh(130)).speed, { outputTokensPerSecond: 20, state: 'available' });
    } finally { await worker.stop(); }
  }
});

test('partial new telemetry contracts cannot fall back to legacy sampling', async () => {
  const valid = projectRows(turnRows());
  for (const key of ['conversationContext', 'lastCompletedTurn', 'turnAverageSpeed']) {
    let clock = 0, output = 10;
    const worker = createTelemetryWorker({ monotonicClock: () => clock, reader: { read: async () => ({
      state: 'ok', session: { id, updatedAt: iso },
      usage: { inputTokens: 10, outputTokens: output, totalTokens: 10 + output }, [key]: valid[key],
    }) } });
    try {
      await worker.refresh();
      clock = 1000; output = 30; await worker.refresh();
      assert.deepEqual(worker.snapshot().speed, { outputTokensPerSecond: null, state: 'unavailable' });
    } finally { await worker.stop(); }
  }
});

test('W1 complete turn uses whole elapsed interval and retains previous turn across new start', () => {
  const rows = turnRows();
  const result = projectRows(rows);
  assert.equal(result.conversationContext.model, 'gpt-6.1-sol');
  assert.equal(result.lastCompletedTurn.elapsedSeconds, 1520.559);
  assert.equal(result.turnAverageSpeed.outputTokensPerSecond, 9310 / 1520.559);
  const next = projectRows([...rows, eventLine('task_started', { turn_id: 'turn-2', root_turn_id: 'turn-2' }, 1)]);
  assert.equal(next.conversationContext.model, null);
  assert.equal(next.lastCompletedTurn.outputTokens, 9310);
});

test('W1 identity evidence, cold tails, duplicates, nesting and invalid usage fail closed', () => {
  const rows = turnRows();
  assert.equal(projectRows(rows.slice(1)).lastCompletedTurn.reason, 'identity_unverified');
  assert.equal(projectRows([rows[0], ...rows.slice(2)]).lastCompletedTurn.reason, 'turn_start_missing');
  assert.equal(projectRows([...rows.slice(0, 4), rows[3], rows[4]]).lastCompletedTurn.state, 'available');
  const changed = JSON.parse(rows[3]); changed.payload.turn_token_usage = { input_tokens: 100, output_tokens: 1, total_tokens: 101 };
  assert.equal(projectRows([...rows.slice(0, 4), JSON.stringify(changed), rows[4]]).lastCompletedTurn.reason, 'usage_conflict');
  for (const [patch, reason] of [
    [{ thread_id: idFor(9) }, 'identity_conflict'],
    [{ session_id: undefined }, 'identity_unverified'],
    [{ turn_id: 'nested', root_turn_id: 'turn-1' }, 'turn_ambiguous'],
    [{ turn_token_usage: { input_tokens: 1, output_tokens: 2, total_tokens: 9 } }, 'usage_invalid'],
  ]) {
    const usage = JSON.parse(rows[3]); Object.assign(usage.payload, patch);
    const result = projectRows([...rows.slice(0, 3), JSON.stringify(usage), rows[4]]);
    assert.equal(result.lastCompletedTurn.reason, reason);
    assert.equal(result.lastCompletedTurn.outputTokens, null);
  }
  assert.equal(projectRows([...rows, rows[4]]).lastCompletedTurn.reason, 'turn_ambiguous');
  assert.equal(projectRows([...rows.slice(0, 2), rows[1], ...rows.slice(2)]).lastCompletedTurn.reason, 'turn_ambiguous');
  const invalidTime = JSON.parse(rows[3]); invalidTime.timestamp = new Date(now - 2000000).toISOString();
  assert.equal(projectRows([...rows.slice(0, 3), JSON.stringify(invalidTime), rows[4]]).lastCompletedTurn.reason, 'timestamp_invalid');
});

test('W1 cumulative boundaries must agree and cannot regress', () => {
  const rows = turnRows();
  const before = eventLine('token_usage_record', { thread_id: id, session_id: id, turn_id: 'prior', root_turn_id: 'prior', response_id: 'prior', thread_token_usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }, -1600000);
  assert.equal(projectRows([rows[0], before, ...rows.slice(1)]).lastCompletedTurn.reason, 'usage_conflict');
  const high = JSON.parse(before); high.payload.thread_token_usage = { input_tokens: 1000, output_tokens: 10000, total_tokens: 11000 };
  assert.equal(projectRows([rows[0], JSON.stringify(high), ...rows.slice(1)]).lastCompletedTurn.reason, 'counter_regression');
});

test('underscore dual UUID rollout is discovered with verified token records', async (t) => {
  const dir = await tempDirectory(t);
  const date = join(dir, '2026', '10', '11');
  await mkdir(date, { recursive: true });
  const path = join(date, underscoreRollout);
  const rows = turnRows().map((line) => line.replaceAll(id, underscoreSessionId));
  const nl = String.fromCharCode(10);
  await writeFile(path, rows.join(nl) + nl);
  await utimes(path, now / 1000, now / 1000);
  const result = await readActiveSession({ sessionsDir: dir, wallClock: () => now });
  assert.equal(result.state, 'ok');
  assert.deepEqual(result.session, { id: underscoreSessionId, updatedAt: iso });
  assert.equal(result.conversationContext.model, 'gpt-6.1-sol');
  assert.equal(result.lastCompletedTurn.state, 'available');
  assert.equal(result.lastCompletedTurn.outputTokens, 9310);
  assert.equal(result.turnAverageSpeed.outputTokensPerSecond, 9310 / 1520.559);

  const unverified = JSON.parse(rows[3]);
  delete unverified.payload.session_id;
  rows[3] = JSON.stringify(unverified);
  await writeFile(path, rows.join(nl) + nl);
  const rejected = await readActiveSession({ sessionsDir: dir, wallClock: () => now });
  assert.equal(rejected.lastCompletedTurn.reason, 'identity_unverified');
  assert.equal(rejected.lastCompletedTurn.outputTokens, null);
});

test('W1 dual UUID file reader keeps incremental state and resets on truncation', async (t) => {
  const dir = await tempDirectory(t);
  const path = join(dir, filename(id).replace('.jsonl', '-' + idFor(1) + '.jsonl'));
  const rows = turnRows();
  await writeFile(path, rows.slice(0, 3).join('\n') + '\n');
  await utimes(path, now / 1000, now / 1000);
  const reader = createSessionReader({ sessionsDir: dir, wallClock: () => now });
  assert.equal((await reader.read()).lastCompletedTurn.reason, 'identity_unverified');
  await fs.appendFile(path, rows.slice(3).join('\n') + '\n');
  await utimes(path, (now + 1) / 1000, (now + 1) / 1000);
  const result = await reader.read();
  assert.equal(result.lastCompletedTurn.outputTokens, 9310);
  assert.equal((await reader.read()).lastCompletedTurn.outputTokens, 9310);
  await writeFile(path, rows[0] + '\n' + rows[4] + '\n');
  await utimes(path, (now + 2) / 1000, (now + 2) / 1000);
  assert.equal((await reader.read()).lastCompletedTurn.outputTokens, null);
});

test('W1 conservative config lexer ignores fake keys inside strings and table scope', () => {
  const config = [
    'secret = """', 'SENTINEL # [fake]', 'model = "fake"', '"""',
    'items = ["model = fake", { value = "#not-comment" }]',
    'model = "gpt-6.1-sol" # comment', "model_reasoning_effort = 'max'",
    '[profiles.example]', 'model = "profile-model"',
  ].join('\n');
  const result = parseConfigDefaults(config);
  assert.equal(result.model.value, 'gpt-6.1-sol');
  assert.equal(result.reasoningEffort.value, 'max');
  assert.equal(JSON.stringify(result).includes('SENTINEL'), false);
  for (const [input, reason] of [
    ['profile = "x"\nmodel = "gpt-6"', 'profile_unsupported'],
    ['model = "gpt-6"\nmodel = "gpt-6"', 'duplicate_key'],
    ['secret = """unterminated', 'syntax_unsupported'],
    ['model.bad = "fake"', 'syntax_unsupported'],
    ['model = "bad//value"', 'value_invalid'],
    ['[profiles.foo]\nmodel = "fake"', 'key_missing'],
  ]) assert.equal(parseConfigDefaults(input).model.reason, reason);
});

test('W1 synthetic config reads enforce byte cap, UTF8 and links', async (t) => {
  // This sandbox denies realpath on a user-profile ancestor. Model only that
  // ancestor lookup; file/junction lookups still use the actual filesystem.
  const realpath = fs.realpath.bind(fs);
  t.mock.method(fs, 'realpath', async (path) => {
    try { return await realpath(path); } catch (error) {
      if (error.code === 'EPERM' && !String(path).includes('codex-telemetry-')) return path;
      throw error;
    }
  });
  const dir = await tempDirectory(t);
  const path = join(dir, 'config.toml');
  await writeFile(path, 'model = "gpt-6"\nmodel_reasoning_effort = "max"');
  assert.equal((await readConfigDefaults({ codexHome: dir })).model.value, 'gpt-6');
  await writeFile(path, Buffer.alloc(262145, 32));
  assert.equal((await readConfigDefaults({ codexHome: dir })).model.reason, 'file_too_large');
  await writeFile(path, Buffer.from([255]));
  assert.equal((await readConfigDefaults({ codexHome: dir })).model.reason, 'syntax_unsupported');
  const root = await tempDirectory(t);
  await symlink(dir, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  try {
    assert.equal((await readConfigDefaults({ codexHome: join(root, 'linked') })).model.reason, 'file_unsafe');
  } finally {
    await rm(join(root, 'linked'), { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('W1 catalog slugs and enabled efforts build the selector payload', async (t) => {
  const dir = await tempDirectory(t);
  await writeFile(join(dir, 'magpie-models.json'), JSON.stringify({ models: [
    { slug: 'example-provider/second', display_name: 'Second', priority: 2, base_instructions: 'SENTINEL' },
    { slug: 'example-provider/first', display_name: 'First', priority: 1 },
    { slug: 'bad//slug', display_name: 'Broken', priority: 0 },
    { slug: 'example-provider/no-name', priority: 0 },
    { slug: 'example-provider/control', display_name: 'Bad\u0001Name', priority: 0 },
  ] }));
  await writeFile(join(dir, 'config.toml'), 'model = "example-provider/first"\nmodel_catalog_json = "magpie-models.json"\n[desktop]\nenabled-reasoning-efforts = ["low", "ultra", "persistent", "none"]\n');
  const result = await readConfigDefaults({ codexHome: dir });
  assert.deepEqual(result.availableModels.map((item) => item.slug), ['configured', 'example-provider/first', 'example-provider/second']);
  assert.deepEqual(result.availableModels[0], { slug: 'configured', displayName: '当前配置' });
  assert.deepEqual(result.availableModels[1], { slug: 'example-provider/first', displayName: 'First' });
  assert.equal(JSON.stringify(result).includes('SENTINEL'), false);
  assert.deepEqual(result.availableEfforts[0], { value: 'configured', label: '当前配置' });
  assert.deepEqual(result.availableEfforts.map((item) => item.value), ['configured', 'low', 'ultra', 'persistent', 'none']);
  assert.deepEqual(result.availableEfforts.slice(1).map((item) => item.label), ['low', 'ultra', 'persistent', 'none']);
});

test('W1 selector payload keeps the configured sentinel when the catalog is unusable', async (t) => {
  const dir = await tempDirectory(t);
  await writeFile(join(dir, 'config.toml'), 'model = "example-provider/absent"\nmodel_catalog_json = "missing.json"\n');
  const missing = await readConfigDefaults({ codexHome: dir });
  assert.deepEqual(missing.availableModels, [{ slug: 'configured', displayName: '当前配置' }]);
  assert.deepEqual(missing.availableEfforts.map((item) => item.value), ['configured', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'persistent', 'none']);
  await writeFile(join(dir, 'missing.json'), '{not json');
  assert.deepEqual((await readConfigDefaults({ codexHome: dir })).availableModels.map((item) => item.slug), ['configured']);
  await writeFile(join(dir, 'missing.json'), Buffer.alloc(262145, 32));
  const oversized = await readConfigDefaults({ codexHome: dir });
  assert.deepEqual(oversized.availableModels.map((item) => item.slug), ['configured']);
  assert.equal(oversized.model.value, 'example-provider/absent');
});

test('W1 default cache rate limits and expires, worker coalesces refreshes', async () => {
  let clock = 0, count = 0;
  const defaults = createConfigDefaultsReader({ monotonicClock: () => clock, read: async () => { count++; return parseConfigDefaults('model = "gpt-6"'); } });
  await defaults.refresh(); await defaults.refresh(); assert.equal(count, 1);
  clock = 5000; await defaults.refresh(); assert.equal(count, 2);
  clock = 20001; assert.equal(defaults.snapshot().model.state, 'stale');
  let release, calls = 0;
  const worker = createTelemetryWorker({ reader: { read: async () => { calls++; if (calls === 1) await new Promise((r) => { release = r; }); return { state: 'empty', session: null, usage: null }; } } });
  const started = worker.start();
  for (let i = 0; i < 100; i++) void worker.refresh();
  release(); await started; assert.equal(calls, 2); await worker.stop();
});

test('W1 config escaped quotes, literal multiline, invalid escapes and profile precedence', () => {
  const slash = String.fromCharCode(92), newline = String.fromCharCode(10);
  const config = ['secret = "escaped ' + slash + '" # [fake]"', "other = '''", 'model = "fake"', "'''", 'model = "gpt-6"'].join(newline);
  assert.equal(parseConfigDefaults(config).model.value, 'gpt-6');
  assert.equal(parseConfigDefaults('secret = "' + slash + 'q"' + newline + 'model = "gpt-6"').model.reason, 'syntax_unsupported');
  assert.equal(parseConfigDefaults(['profile = "x"', 'model = "gpt-6"', 'model = "gpt-6"'].join(newline)).model.reason, 'profile_unsupported');
  assert.equal(parseConfigDefaults('model = "gpt-6"').reasoningEffort.reason, 'key_missing');
});

test('W1 config detects identity replacement and rejects uncheckable ancestors', async (t) => {
  let checks = 0;
  const stat = (ino) => ({ ino: BigInt(ino), dev: 1n, size: 20n, mtimeMs: 1n, ctimeMs: 1n, isSymbolicLink: () => false, isDirectory: () => true, isFile: () => true });
  t.mock.method(fs, 'realpath', async (p) => p);
  t.mock.method(fs, 'lstat', async (p) => { if (String(p).endsWith('config.toml')) checks++; return stat(checks > 1 ? 2 : 1); });
  let closed = false;
  t.mock.method(fs, 'open', async () => ({ stat: async () => stat(1), close: async () => { closed = true; } }));
  assert.equal((await readConfigDefaults({ codexHome: join(tmpdir(), 'synthetic') })).model.reason, 'file_changed');
  assert.equal(closed, true);
  t.mock.method(fs, 'realpath', async () => { throw Object.assign(Error('private details'), { code: 'EPERM' }); });
  const result = await readConfigDefaults({ codexHome: join(tmpdir(), 'synthetic') });
  assert.equal(result.model.reason, 'file_unsafe');
  assert.equal(JSON.stringify(result).includes('private'), false);
});

test('W1 stale telemetry has explicit null business fields and preserved sources', async () => {
  let clock = 0;
  const metrics = projectRows(turnRows());
  const worker = createTelemetryWorker({ monotonicClock: () => clock, reader: { read: async () => ({ state: 'ok', session: { id, updatedAt: iso }, usage: { inputTokens: 100, outputTokens: 9310, totalTokens: 9410 }, ...metrics }) } });
  await worker.refresh();
  const snapshot = worker.snapshot(); snapshot.conversationContext.model = 'mutated';
  assert.equal(worker.snapshot().conversationContext.model, 'gpt-6.1-sol');
  clock = 3001;
  const stale = worker.snapshot();
  assert.equal(stale.conversationContext.state, 'stale');
  assert.equal(stale.conversationContext.source, 'turn_context');
  assert.equal(stale.conversationContext.model, null);
  assert.equal(stale.lastCompletedTurn.completedAt, null);
  assert.equal(stale.turnAverageSpeed.outputTokensPerSecond, null);
  await worker.stop();
});

test('W1 cold large-file head establishes identity without guessing filename UUID', async (t) => {
  const dir = await tempDirectory(t);
  const path = join(dir, filename(id).replace('.jsonl', '-' + idFor(1) + '.jsonl'));
  const rows = turnRows();
  const ignored = JSON.stringify({ type: 'other', payload: { text: 'x'.repeat(20000) } });
  await writeFile(path, [rows[0], ...Array(120).fill(ignored), ...rows.slice(1)].join(String.fromCharCode(10)) + String.fromCharCode(10));
  await utimes(path, now / 1000, now / 1000);
  const result = await readActiveSession({ sessionsDir: dir, wallClock: () => now });
  assert.equal(result.lastCompletedTurn.outputTokens, 9310);
  assert.equal(JSON.stringify(result).includes('payload'), false);
});

test('oversized classification is bounded and subsequent complete evidence recovers', async (t) => {
  const dir = await tempDirectory(t);
  const secret = 'OVERSIZED_PRIVATE_TRANSCRIPT';
  const huge = JSON.stringify({ type: 'response_item', payload: { text: secret + 'x'.repeat(885991) } });
  const parsedBytes = [];
  const cache = new Map();
  const parse = JSON.parse;
  t.mock.method(JSON, 'parse', (value, ...args) => {
    parsedBytes.push(Buffer.byteLength(value));
    return parse(value, ...args);
  });
  await writeSession(dir, id, { lines: [huge, ...turnRows()] });
  const result = await readActiveSession({ sessionsDir: dir, wallClock: () => now, cache });
  assert.ok(parsedBytes.every(bytes => bytes <= 2 * 1024 * 1024));
  assert.equal(parsedBytes.filter(bytes => bytes === Buffer.byteLength(huge)).length, 1);
  assertNoBody([cache, result], secret);
  assert.equal(result.state, 'ok');
  assert.deepEqual(result.usage, { inputTokens: 100, outputTokens: 9310, totalTokens: 9410 });
  assert.equal(result.conversationContext.model, 'gpt-6.1-sol');
  assert.equal(result.lastCompletedTurn.outputTokens, 9310);
  assert.equal(result.turnAverageSpeed.outputTokensPerSecond, 9310 / 1520.559);
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test('oversized gaps preserve metadata identity but cannot bridge a started turn', async (t) => {
  const dir = await tempDirectory(t);
  const rows = turnRows();
  const huge = 'x'.repeat(256 * 1024 + 1);
  for (const [lines, reason] of [
    [[...rows.slice(0, 3), huge, ...rows.slice(3)], 'turn_ambiguous'],
    [[...rows.slice(0, 3), huge, rows[0], ...rows.slice(3)], 'turn_ambiguous'],
    [[...rows, huge, rows[0], rows[2], rows[3], rows[4]], 'turn_ambiguous'],
  ]) {
    await writeSession(dir, id, { lines });
    const result = await readActiveSession({ sessionsDir: dir, wallClock: () => now });
    assert.equal(result.lastCompletedTurn.reason, reason);
    assert.equal(result.lastCompletedTurn.outputTokens, null);
    assert.equal(result.turnAverageSpeed.outputTokensPerSecond, null);
  }
  const fresh = rows.map((line) => line.replaceAll('turn-1', 'turn-2'));
  // A real gap alone is recoverable; only later old-root activity is sticky.
  const cache = new Map();
  const path = await writeSession(dir, id, { lines: [...rows.slice(0, 3), huge, rows[0]] });
  const read = () => readActiveSession({ sessionsDir: dir, wallClock: () => now, cache });
  assert.equal((await read()).lastCompletedTurn.reason, 'read_gap');
  assert.equal(cache.get(path).turn.interleaved, false);
  await fs.appendFile(path, fresh.join('\n') + '\n');
  assert.equal((await read()).lastCompletedTurn.outputTokens, 9310);
  await writeSession(dir, id, { lines: [...rows, huge, ...fresh] });
  assert.equal((await readActiveSession({ sessionsDir: dir, wallClock: () => now })).lastCompletedTurn.state, 'available');
  await writeSession(dir, id, { lines: [...rows, huge, ...rows] });
  assert.equal((await readActiveSession({ sessionsDir: dir, wallClock: () => now })).lastCompletedTurn.reason, 'turn_ambiguous');
});

test('oversized unterminated lines stay bounded and discard continuation across polls', async (t) => {
  const dir = await tempDirectory(t);
  const rows = turnRows();
  const cache = new Map();
  const path = await writeSession(dir, id, { lines: [...rows.slice(0, 3), 'x'.repeat(256 * 1024 + 1)], finalNewline: false });
  const read = () => readActiveSession({ sessionsDir: dir, wallClock: () => now, cache });
  const first = await read();
  assert.equal(first.state, 'unavailable');
  assert.equal(first.lastCompletedTurn.reason, 'budget_exceeded');
  assert.equal(cache.get(path).remainder.length, 0);
  await fs.appendFile(path, rows.join('') + 'x'.repeat(256 * 1024 + 1));
  assert.equal((await read()).state, 'unavailable');
  assert.equal(cache.get(path).remainder.length, 0);
  await fs.appendFile(path, '\n' + rows[4] + '\n');
  assert.equal((await read()).lastCompletedTurn.reason, 'turn_ambiguous');
  const fresh = rows.map((line, index) => {
    const event = JSON.parse(line.replaceAll('turn-1', 'turn-2'));
    event.timestamp = new Date(now + index * 10).toISOString();
    return JSON.stringify(event);
  });
  await fs.appendFile(path, fresh.join('\n') + '\n');
  const sticky = await read();
  assert.equal(sticky.lastCompletedTurn.reason, 'turn_ambiguous');
  assert.equal(sticky.lastCompletedTurn.outputTokens, null);
  assert.equal(sticky.turnAverageSpeed.outputTokensPerSecond, null);
});

test('line limit applies to joined byte fragments and permits exactly 256KiB', async (t) => {
  const dir = await tempDirectory(t);
  const rows = turnRows();
  const prefix = '{"type":"other","text":"';
  const suffix = '"}';
  const exact = prefix + 'x'.repeat(256 * 1024 - prefix.length - suffix.length) + suffix;
  const path = await writeSession(dir, id, { lines: [exact, ...rows] });
  const cache = new Map();
  const read = () => readActiveSession({ sessionsDir: dir, wallClock: () => now, cache });
  assert.equal((await read()).lastCompletedTurn.outputTokens, 9310);
  await fs.appendFile(path, 'x'.repeat(200 * 1024));
  await read();
  assert.equal(cache.get(path).remainder.length, 200 * 1024);
  await fs.appendFile(path, 'x'.repeat(100 * 1024));
  assert.equal((await read()).lastCompletedTurn.reason, 'budget_exceeded');
  assert.equal(cache.get(path).remainder.length, 0);
  const fresh = rows.map((line) => line.replaceAll('turn-1', 'turn-2'));
  await fs.appendFile(path, '\n' + fresh.join('\n') + '\n');
  assert.equal((await read()).lastCompletedTurn.outputTokens, 9310);
});

test('oversized isolation preserves identity conflicts and rejects malformed following records', async (t) => {
  const dir = await tempDirectory(t);
  const rows = turnRows();
  const huge = 'x'.repeat(256 * 1024 + 1);
  const conflict = JSON.parse(rows[3]);
  conflict.payload.thread_id = idFor(9);
  await writeSession(dir, id, { lines: [rows[0], JSON.stringify(conflict), huge, ...rows] });
  assert.equal((await readActiveSession({ sessionsDir: dir, wallClock: () => now })).lastCompletedTurn.reason, 'identity_conflict');
  await writeSession(dir, id, { lines: [huge, ...rows, '{'] });
  assert.equal((await readActiveSession({ sessionsDir: dir, wallClock: () => now })).state, 'unavailable');
  await writeSession(dir, id, { lines: [huge, ...rows, metaLine(idFor(9))] });
  assert.equal((await readActiveSession({ sessionsDir: dir, wallClock: () => now })).lastCompletedTurn.reason, 'identity_conflict');
});

test('cold large tails retain head identity across oversized unknown events but reset continuity and proof', async (t) => {
  const dir = await tempDirectory(t);
  const rows = turnRows();
  const path = join(dir, filename(id).replace('.jsonl', '-' + idFor(1) + '.jsonl'));
  const filler = JSON.stringify({ type: 'other', payload: { text: 'x'.repeat(20000) } });
  const huge = JSON.stringify({ type: 'unknown_tool_output', payload: { type: 'function_call_output', output: 'x'.repeat(885991) } });
  const prefix = [rows[0], ...Array(120).fill(filler)];
  const readCold = async (lines) => {
    await writeFile(path, lines.join('\n') + '\n');
    await utimes(path, now / 1000, now / 1000);
    assert.ok((await fs.stat(path)).size > 2 * 1024 * 1024);
    return readActiveSession({ sessionsDir: dir, wallClock: () => now });
  };
  const result = await readCold([...prefix, huge, ...rows.slice(1)]);
  assert.equal(result.state, 'ok');
  assert.deepEqual(result.usage, { inputTokens: 100, outputTokens: 9310, totalTokens: 9410 });
  assert.equal(result.conversationContext.model, 'gpt-6.1-sol');
  assert.equal(result.conversationContext.reasoningEffort, 'ultra');
  assert.equal(result.lastCompletedTurn.elapsedSeconds, 1520.559);
  assert.equal(result.turnAverageSpeed.outputTokensPerSecond, 9310 / 1520.559);

  const crossing = await readCold([...prefix, ...rows.slice(1, 3), huge, ...rows.slice(2)]);
  assert.equal(crossing.conversationContext.model, null);
  assert.equal(crossing.conversationContext.reasoningEffort, null);
  assert.equal(crossing.lastCompletedTurn.reason, 'turn_ambiguous');
  assert.equal(crossing.lastCompletedTurn.outputTokens, null);
  assert.equal(crossing.turnAverageSpeed.outputTokensPerSecond, null);

  const noContext = await readCold([...prefix, ...rows.slice(1, 3), huge, rows[3], rows[4]]);
  assert.equal(noContext.conversationContext.model, null);
  assert.equal(noContext.lastCompletedTurn.reason, 'turn_ambiguous');

  const prior = JSON.parse(rows[3]);
  prior.timestamp = new Date(now - 1600000).toISOString();
  prior.payload.thread_token_usage = { input_tokens: 1000, output_tokens: 10000, total_tokens: 11000 };
  const recovered = await readCold([...prefix, JSON.stringify(prior), huge, ...rows.slice(1)]);
  assert.equal(recovered.lastCompletedTurn.outputTokens, 9310);

  const missingProof = JSON.parse(rows[3]);
  delete missingProof.payload.session_id;
  for (const after of [[rows[1], rows[2], rows[4]], [rows[1], rows[2], JSON.stringify(missingProof), rows[4]]]) {
    const unverified = await readCold([...prefix, rows[3], huge, ...after]);
    assert.equal(unverified.conversationContext.reason, 'identity_unverified');
    assert.equal(unverified.lastCompletedTurn.reason, 'identity_unverified');
    assert.equal(unverified.turnAverageSpeed.outputTokensPerSecond, null);
  }
  const noMeta = await readCold([...prefix.slice(1), huge, ...rows.slice(1)]);
  assert.equal(noMeta.lastCompletedTurn.reason, 'identity_unverified');

  const conflict = JSON.parse(rows[3]);
  conflict.payload.thread_id = idFor(9);
  const rejected = await readCold([...prefix, JSON.stringify(conflict), huge, ...rows.slice(1)]);
  assert.equal(rejected.lastCompletedTurn.reason, 'identity_conflict');
  assert.equal(rejected.conversationContext.model, null);
  assert.equal(rejected.turnAverageSpeed.outputTokensPerSecond, null);
});

test('W1 response ID budget rejects the 4097th record', () => {
  const rows = turnRows();
  const state = createTurnState();
  for (const line of rows.slice(0, 3)) observeTelemetry(state, parseTelemetryLine(line, now), id);
  for (let i = 0; i < 4097; i++) {
    const record = JSON.parse(rows[3]); record.payload.response_id = 'r-' + i;
    observeTelemetry(state, parseTelemetryLine(JSON.stringify(record), now), id);
  }
  observeTelemetry(state, parseTelemetryLine(rows[4], now), id);
  assert.equal(projectTelemetry(state, true).lastCompletedTurn.reason, 'budget_exceeded');
});

test('W1 file replacement and split UTF8 cannot retain another file turn', async (t) => {
  const dir = await tempDirectory(t);
  const path = join(dir, filename(id));
  const rows = turnRows();
  const nl = String.fromCharCode(10);
  await writeFile(path, rows.join(nl) + nl);
  await utimes(path, now / 1000, now / 1000);
  const reader = createSessionReader({ sessionsDir: dir, wallClock: () => now });
  assert.equal((await reader.read()).lastCompletedTurn.outputTokens, 9310);
  await fs.rename(path, path + '.old');
  await writeFile(path, rows[0] + nl + rows[4] + nl);
  await utimes(path, now / 1000, now / 1000);
  assert.equal((await reader.read()).lastCompletedTurn.outputTokens, null);
  const unknown = Buffer.from(JSON.stringify({ type: 'unknown', content: '中' }) + nl);
  const split = unknown.indexOf(Buffer.from('中')) + 1;
  await fs.appendFile(path, unknown.subarray(0, split));
  await reader.read();
  await fs.appendFile(path, unknown.subarray(split));
  assert.equal((await reader.read()).state, 'ok');
});

test('W1 malformed contexts never borrow fields from prior turn', () => {
  const rows = turnRows();
  for (const [patch, reason] of [[{ effort: undefined }, 'context_missing'], [{ model: 'unsafe//model' }, 'context_invalid'], [{ effort: 'unknown' }, 'context_invalid']]) {
    const context = JSON.parse(rows[2]); Object.assign(context.payload, patch);
    const result = projectRows([rows[0], rows[1], JSON.stringify(context), ...rows.slice(3)]);
    assert.equal(result.conversationContext.reason, reason);
    assert.equal(result.conversationContext.model, null);
    assert.equal(result.conversationContext.reasoningEffort, null);
  }
});

function oversizedIgnoredRecord(type, bytes, text = 'SYNTHETIC_BODY_MARKER') {
  const record = { type, timestamp: 'invalid', payload: { type: 'custom_tool_call_output', output: text, thread_id: idFor(9), session_id: idFor(9), nested: { type: 'session_meta', id: idFor(9) } } };
  record.payload.output += 'x'.repeat(bytes - Buffer.byteLength(JSON.stringify(record)));
  const line = JSON.stringify(record);
  assert.equal(Buffer.byteLength(line), bytes);
  return line;
}
function assertNoBody(value, marker, seen = new Set()) {
  if (typeof value === 'string') { assert.equal(value.includes(marker), false); return; }
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (Buffer.isBuffer(value)) { assert.equal(value.includes(Buffer.from(marker)), false); return; }
  if (value instanceof Map) { for (const [key, item] of value) { assertNoBody(key, marker, seen); assertNoBody(item, marker, seen); } }
  else if (value instanceof Set) { for (const item of value) assertNoBody(item, marker, seen); }
  else for (const item of Object.values(value)) assertNoBody(item, marker, seen);
}

for (const type of ['response_item', 'compacted']) {
  const oversizedResponse = (bytes, text) => oversizedIgnoredRecord(type, bytes, text);

test(type + ': ' + 'complete oversized ignored records preserve active and completed turns without retaining body', async (t) => {
  const dir = await tempDirectory(t);
  const rows = turnRows();
  const expected = projectRows(rows, false);
  for (const bytes of [256 * 1024, 256 * 1024 + 1, 323966, 373230]) {
    const huge = oversizedResponse(bytes, 'SYNTHETIC_BODY_MARKER' + String.fromCharCode(65533) + '汉');
    assert.equal(parseUsageLine(huge, id, now), null);
    assert.equal(parseTelemetryLine(huge, now), null);
    for (const recordRows of [[...rows.slice(0, 3), huge, ...rows.slice(3)], [...rows, huge]]) {
      const cache = new Map();
      await writeSession(dir, id, { lines: recordRows });
      const result = await readActiveSession({ sessionsDir: dir, wallClock: () => now, cache });
      assert.deepEqual(result.lastCompletedTurn, expected.lastCompletedTurn);
      assert.deepEqual(result.turnAverageSpeed, expected.turnAverageSpeed);
      assert.deepEqual(result.conversationContext, expected.conversationContext);
      assert.equal(result.eventTimestamp, now);
      assert.deepEqual(result.usage, { inputTokens: 100, outputTokens: 9310, totalTokens: 9410 });
      assertNoBody([cache, result], 'SYNTHETIC_BODY_MARKER');
    }
  }
});

test(type + ': ' + 'oversized classification uses short remainder and enforces exact 2MiB JSON input limit', async (t) => {
  const dir = await tempDirectory(t);
  const rows = turnRows();
  for (const bytes of [2 * 1024 * 1024, 2 * 1024 * 1024 + 1]) {
    const cache = new Map();
    const path = await writeSession(dir, id, { lines: rows.slice(0, 3) });
    const read = () => readActiveSession({ sessionsDir: dir, wallClock: () => now, cache });
    await read();
    const huge = oversizedResponse(bytes);
    const fragment = 200 * 1024;
    await fs.appendFile(path, huge.slice(0, fragment));
    const first = await read();
    assert.equal(cache.get(path).remainder.length, fragment);
    assert.equal(cache.get(path).remainder.includes(Buffer.from('SYNTHETIC_BODY_MARKER')), true);
    const { remainder, ...other } = cache.get(path);
    assertNoBody([other, first], 'SYNTHETIC_BODY_MARKER');
    await fs.appendFile(path, huge.slice(fragment) + String.fromCharCode(10) + rows.slice(3).join(String.fromCharCode(10)) + String.fromCharCode(10));
    const parsedBytes = [];
    const parse = JSON.parse;
    t.mock.method(JSON, 'parse', (value, ...args) => { parsedBytes.push(Buffer.byteLength(value)); return parse(value, ...args); });
    const result = await read();
    t.mock.restoreAll();
    assert.ok(parsedBytes.every(size => size <= 2 * 1024 * 1024));
    assert.equal(parsedBytes.filter(size => size === bytes).length, bytes === 2 * 1024 * 1024 ? 1 : 0);
    assert.equal(cache.get(path).remainder.length, 0);
    assertNoBody([cache, result], 'SYNTHETIC_BODY_MARKER');
    assert.equal(result.lastCompletedTurn.outputTokens, bytes === 2 * 1024 * 1024 ? 9310 : null);
    if (bytes > 2 * 1024 * 1024) assert.equal(result.lastCompletedTurn.reason, 'turn_ambiguous');
  }
});

test(type + ': ' + 'oversized nonwhitelisted and damaged records isolate instead of bridging turns', async (t) => {
  const dir = await tempDirectory(t);
  const rows = turnRows();
  const valid = oversizedResponse(301 * 1024);
  const telemetry = JSON.parse(rows[3]); telemetry.padding = 'x'.repeat(301 * 1024);
  const cases = [valid.replace(type, 'unknown_event'), JSON.stringify(telemetry),
    JSON.stringify(['response_item', 'x'.repeat(301 * 1024)]), JSON.stringify('x'.repeat(301 * 1024)),
    valid.replace(type, type.toUpperCase()), valid.replace(type, type + ' '),
    valid.slice(0, -1), valid + String.fromCharCode(0),
    Buffer.concat([Buffer.from(valid.slice(0, -2)), Buffer.from([0xff]), Buffer.from(valid.slice(-2))])];
  for (const corrupt of cases) {
    const path = await writeSession(dir, id, { lines: [] });
    await writeFile(path, Buffer.concat([Buffer.from(rows.slice(0, 3).join(String.fromCharCode(10)) + String.fromCharCode(10)), Buffer.from(corrupt), Buffer.from(String.fromCharCode(10) + rows.slice(3).join(String.fromCharCode(10)) + String.fromCharCode(10))]));
    const result = await readActiveSession({ sessionsDir: dir, wallClock: () => now });
    assert.equal(result.lastCompletedTurn.reason, 'turn_ambiguous');
    assert.equal(result.turnAverageSpeed.outputTokensPerSecond, null);
  }
});

test(type + ': ' + 'valid oversized output cannot clear pending gaps conflicts replay guards or incomplete discard', async (t) => {
  const dir = await tempDirectory(t);
  const rows = turnRows();
  const huge = oversizedResponse(301 * 1024);
  const unknown = JSON.stringify({ type: 'unknown', text: 'x'.repeat(301 * 1024) });
  const conflict = JSON.parse(rows[3]); conflict.payload.thread_id = idFor(9);
  for (const [records, reason] of [
    [[...rows.slice(0, 3), unknown, huge], 'budget_exceeded'],
    [[rows[0], JSON.stringify(conflict), huge, ...rows.slice(1)], 'identity_conflict'],
    [[...rows, unknown, huge, ...rows], 'turn_ambiguous'],
    [[huge, ...rows.slice(1)], 'identity_unverified']]) {
    await writeSession(dir, id, { lines: records });
    const result = await readActiveSession({ sessionsDir: dir, wallClock: () => now });
    assert.equal(result.lastCompletedTurn.reason, reason);
    assert.equal(result.turnAverageSpeed.outputTokensPerSecond, null);
  }
  const cache = new Map();
  const path = await writeSession(dir, id, { lines: rows.slice(0, 3) });
  const read = () => readActiveSession({ sessionsDir: dir, wallClock: () => now, cache });
  await read();
  await fs.appendFile(path, huge.slice(0, 270 * 1024));
  assert.equal((await read()).lastCompletedTurn.reason, 'budget_exceeded');
  assert.equal(cache.get(path).remainder.length, 0);
  await fs.appendFile(path, huge.slice(270 * 1024) + String.fromCharCode(10) + rows.slice(3).join(String.fromCharCode(10)) + String.fromCharCode(10));
  assert.equal((await read()).lastCompletedTurn.reason, 'turn_ambiguous');
});

test(type + ': ' + 'sequential cold scans recover start evidence on either side of complete ignored records', async (t) => {
  const dir = await tempDirectory(t);
  const rows = turnRows();
  const filler = JSON.stringify({ type: 'other', text: 'x'.repeat(20000) });
  const huge = oversizedResponse(343 * 1024);
  for (const [records, expected] of [
    [[rows[0], ...Array(120).fill(filler), ...rows.slice(1, 3), huge, ...rows.slice(3)], 9310],
    [[...rows.slice(0, 3), ...Array(120).fill(filler), huge, ...rows.slice(3)], 9310],
  ]) {
    await writeSession(dir, id, { lines: records });
    const result = await readActiveSession({ sessionsDir: dir, wallClock: () => now });
    assert.equal(result.lastCompletedTurn.outputTokens, expected);
    if (expected === null) assert.equal(result.turnAverageSpeed.outputTokensPerSecond, null);
  }
});

test(type + ': ' + 'short reads remain real gaps even when followed by complete oversized ignored records', async (t) => {
  const dir = await tempDirectory(t);
  const rows = turnRows();
  const path = await writeSession(dir, id, { lines: rows.slice(0, 3) });
  const cache = new Map();
  const read = () => readActiveSession({ sessionsDir: dir, wallClock: () => now, cache });
  await read();
  const appendOffset = cache.get(path).offset;
  const chunk = JSON.stringify({ type: 'other' }) + String.fromCharCode(10);
  await fs.appendFile(path, chunk + chunk);
  const open = fs.open;
  t.mock.method(fs, 'open', async (...args) => {
    const file = await open(...args);
    const originalRead = file.read.bind(file);
    // Truncate the appended data read, leaving continuity probes intact.
    file.read = (buffer, offset, length, position) => originalRead(buffer, offset, position >= appendOffset ? Math.min(length, chunk.length) : length, position);
    return file;
  });
  await read();
  t.mock.restoreAll();
  assert.equal(cache.get(path).hasGap, true);
  assert.equal(cache.get(path).discardLine, true);
  await fs.appendFile(path, oversizedResponse(301 * 1024) + String.fromCharCode(10) + rows.slice(3).join(String.fromCharCode(10)) + String.fromCharCode(10));
  const result = await read();
  assert.equal(result.lastCompletedTurn.reason, 'turn_ambiguous');
  assert.equal(result.turnAverageSpeed.outputTokensPerSecond, null);
});

}


test('provider model slugs accept exactly one bounded ASCII provider segment', () => {
  for (const model of ['example-provider/gpt-6-astra', 'example-provider/gpt-6.1-sol', 'example-provider/deepseek-v4.1-flash', 'gpt-6.1-sol', 'a/'.padEnd(128, 'b'), 'a'.repeat(128)]) {
    assert.equal(validModel(model), true, model);
    const defaults = parseConfigDefaults('model = "' + model + '"\nmodel_reasoning_effort = "ultra"');
    assert.equal(defaults.model.value, model);
    const context = parseTelemetryLine(eventLine('turn_context', { turn_id: 'turn-1', root_turn_id: 'turn-1', model, effort: 'ultra' }), now);
    assert.equal(context.model, model);
    assert.equal(context.effort, 'ultra');
  }
  for (const model of ['', '/model', 'provider/', 'a//b', 'a/b/c', 'a b', 'a\nb', 'a\\b', 'a\u0000b', 'a\u00e9b', 'a'.repeat(129), 'a/'.padEnd(129, 'b')]) assert.equal(validModel(model), false, model);
});

test('28.7MiB cold rollout recovers a turn across polls without publishing history early', async (t) => {
  const dir = await tempDirectory(t);
  const rows = turnRows();
  rows[2] = rows[2].replace('gpt-6.1-sol', 'example-provider/gpt-6.1-sol');
  const filler = JSON.stringify({ type: 'response_item', payload: { text: 'x'.repeat(100000) } });
  const path = await writeSession(dir, id, { lines: [...rows.slice(0, 3), ...Array(300).fill(filler), ...rows.slice(3)] });
  const cache = new Map();
  const originalOpen = fs.open.bind(fs); let bytes = 0, maxRead = 0;
  t.mock.method(fs, 'open', async (...args) => {
    const f = await originalOpen(...args); const read = f.read.bind(f);
    f.read = (buffer, offset, length, position) => { bytes += length; maxRead = Math.max(maxRead, length); return read(buffer, offset, length, position); };
    return f;
  });
  let result, polls = 0, previous = 0;
  do {
    bytes = 0; result = await readActiveSession({ sessionsDir: dir, wallClock: () => now, cache }); polls++;
    assert.ok(bytes <= 8 * 1024 * 1024);
    assert.ok(maxRead <= 2 * 1024 * 1024);
    assert.ok(cache.get(path).offset > previous); previous = cache.get(path).offset;
    if (!cache.get(path).checkedEof) {
      assert.equal(result.lastCompletedTurn.outputTokens, null);
      assert.equal(result.turnAverageSpeed.outputTokensPerSecond, null);
      assert.equal(result.lastCompletedTurn.reason, 'bootstrap_in_progress');
      assert.equal(cache.get(path).hasGap, undefined);
    }
  } while (!cache.get(path).checkedEof && polls < 8);
  assert.equal(polls, 4);
  assert.equal(result.conversationContext.model, 'example-provider/gpt-6.1-sol');
  assert.equal(result.lastCompletedTurn.elapsedSeconds, 1520.559);
  assert.equal(result.lastCompletedTurn.outputTokens, 9310);
  assert.equal(result.turnAverageSpeed.outputTokensPerSecond, 9310 / 1520.559);
});

test('explicit subagents are excluded by their own metadata while legacy parent IDs remain main', async (t) => {
  for (const source of ['subagent', { subagent: 'review' }, { subagent: { thread_spawn: { parent_thread_id: idFor(4) } } }, { type: 'subagent' }]) {
    const dir = await tempDirectory(t);
    const child = idFor(3);
    const childRows = turnRows().map(line => line.replaceAll(id, child));
    const metadata = JSON.parse(childRows[0]); metadata.payload.source = source;
    childRows[0] = JSON.stringify(metadata);
    await writeSession(dir, child, { lines: childRows });
    assert.equal((await readActiveSession({ sessionsDir: dir, wallClock: () => now })).state, 'empty');
    await writeSession(dir, id, { lines: turnRows() });
    const main = await readActiveSession({ sessionsDir: dir, wallClock: () => now });
    assert.equal(main.session.id, id);
  }
  const dir = await tempDirectory(t);
  const rows = turnRows(); const metadata = JSON.parse(rows[0]); metadata.payload.parent_thread_id = idFor(9); metadata.payload.source = 'vscode'; rows[0] = JSON.stringify(metadata);
  await writeSession(dir, id, { lines: rows });
  assert.equal((await readActiveSession({ sessionsDir: dir, wallClock: () => now })).session.id, id);
  const inherited = eventLine('session_meta', { id: idFor(9), session_id: idFor(9), source: 'vscode', timestamp: iso, parent_thread_id: idFor(8) });
  await writeSession(dir, id, { lines: [rows[0], inherited, ...rows.slice(1)] });
  const result = await readActiveSession({ sessionsDir: dir, wallClock: () => now });
  assert.equal(result.session.id, id);
  assert.equal(result.lastCompletedTurn.outputTokens, 9310);
  await writeSession(dir, idFor(1), { lines: turnRows().map(line => line.replaceAll(id, idFor(1))) });
  assert.equal((await readActiveSession({ sessionsDir: dir, wallClock: () => now })).state, 'ambiguous');
});


test('confirmed subagent metadata excludes malformed child tails without hiding the main turn', async (t) => {
  const dir = await tempDirectory(t);
  await writeSession(dir, id, { lines: turnRows() });
  const child = idFor(3);
  const metadata = JSON.parse(turnRows()[0].replaceAll(id, child));
  metadata.payload.source = { subagent: { thread_spawn: { parent_thread_id: id } } };
  metadata.payload.thread_source = 'subagent';
  await writeSession(dir, child, { lines: [JSON.stringify(metadata), '{'] });
  const cache = new Map();
  const result = await readActiveSession({ sessionsDir: dir, wallClock: () => now, cache });
  assert.equal(result.state, 'ok');
  assert.equal(result.session.id, id);
  assert.equal(result.lastCompletedTurn.outputTokens, 9310);
  assert.equal((await readActiveSession({ sessionsDir: dir, wallClock: () => now, cache })).session.id, id);
});


test('own subagents with independent session IDs cannot replace main when child is newer across polls', async (t) => {
  for (const marker of [{ source: { subagent: { thread_spawn: { parent_thread_id: id } } } }, { thread_source: 'subagent' }]) {
    const dir = await tempDirectory(t);
    const mainRows = turnRows().map((line) => {
      const record = JSON.parse(line);
      record.timestamp = new Date(Date.parse(record.timestamp) - 2000).toISOString();
      return JSON.stringify(record);
    });
    await writeSession(dir, id, { lines: mainRows, mtime: now - 2000 });
    const child = idFor(3), childSession = idFor(4);
    const childRows = turnRows().map((line) => {
      const record = JSON.parse(line.replaceAll(id, child));
      if (record.type === 'session_meta' || record.type === 'token_usage_record') record.payload.session_id = childSession;
      if (record.type === 'session_meta') Object.assign(record.payload, marker);
      return JSON.stringify(record);
    });
    await writeSession(dir, child, { lines: childRows });
    const cache = new Map();
    for (let poll = 0; poll < 2; poll++) {
      const result = await readActiveSession({ sessionsDir: dir, wallClock: () => now, cache });
      assert.equal(result.state, 'ok');
      assert.equal(result.session.id, id);
      assert.equal(result.conversationContext.model, 'gpt-6.1-sol');
      assert.equal(result.lastCompletedTurn.outputTokens, 9310);
      assert.equal(result.lastCompletedTurn.elapsedSeconds, 1520.559);
      assert.equal(result.turnAverageSpeed.outputTokensPerSecond, 9310 / 1520.559);
    }
  }
});

test('own subagents with independent session IDs yield empty when no main exists', async (t) => {
  const dir = await tempDirectory(t);
  const metadata = eventLine('session_meta', { id, session_id: idFor(4), source: { subagent: 'review' } });
  await writeSession(dir, id, { lines: [metadata] });
  const cache = new Map();
  for (let poll = 0; poll < 2; poll++) {
    const result = await readActiveSession({ sessionsDir: dir, wallClock: () => now, cache });
    assert.equal(result.state, 'empty');
    assert.equal(result.session, null);
    assert.equal(result.lastCompletedTurn.reason, 'no_session');
  }
});

test('own subagents with independent session IDs exclude malformed tails before parsing them', async (t) => {
  const dir = await tempDirectory(t);
  await writeSession(dir, id, { lines: turnRows() });
  const child = idFor(3);
  const metadata = eventLine('session_meta', { id: child, session_id: idFor(4), thread_source: 'subagent' });
  await writeSession(dir, child, { lines: [metadata, '{'] });
  const cache = new Map();
  for (let poll = 0; poll < 2; poll++) {
    const result = await readActiveSession({ sessionsDir: dir, wallClock: () => now, cache });
    assert.equal(result.state, 'ok');
    assert.equal(result.session.id, id);
    assert.equal(result.lastCompletedTurn.outputTokens, 9310);
    assert.equal(result.turnAverageSpeed.outputTokensPerSecond, 9310 / 1520.559);
  }
});

test('subagent classification never adopts inherited parent metadata or wrong own IDs', async (t) => {
  const dir = await tempDirectory(t);
  const rows = turnRows();
  const inherited = eventLine('session_meta', { id: idFor(9), session_id: idFor(9), source: 'vscode', timestamp: iso, thread_source: 'subagent' });
  await writeSession(dir, id, { lines: [rows[0], inherited, ...rows.slice(1)] });
  const inheritedResult = await readActiveSession({ sessionsDir: dir, wallClock: () => now });
  assert.equal(inheritedResult.state, 'ok');
  assert.equal(inheritedResult.session.id, id);
  assert.equal(inheritedResult.conversationContext.model, 'gpt-6.1-sol');
  assert.equal(inheritedResult.lastCompletedTurn.outputTokens, 9310);

  const wrongOwn = eventLine('session_meta', { id: idFor(9), session_id: idFor(4), source: { subagent: 'review' } });
  await writeSession(dir, id, { lines: [wrongOwn, ...rows.slice(1)] });
  const rejected = await readActiveSession({ sessionsDir: dir, wallClock: () => now });
  assert.equal(rejected.state, 'unavailable');
  assert.equal(rejected.lastCompletedTurn.reason, 'identity_conflict');
  assert.equal(rejected.conversationContext.model, null);
  assert.equal(rejected.turnAverageSpeed.outputTokensPerSecond, null);
});

test('main and usage identity remain strict after independent child session exclusion', async (t) => {
  for (const [target, patch, reason] of [
    [0, { session_id: idFor(4) }, 'identity_conflict'],
    [3, { thread_id: idFor(4) }, 'identity_conflict'],
    [3, { session_id: idFor(4) }, 'identity_conflict'],
    [3, { thread_id: undefined }, 'identity_unverified'],
    [3, { session_id: undefined }, 'identity_unverified'],
  ]) {
    const dir = await tempDirectory(t);
    const rows = turnRows();
    const record = JSON.parse(rows[target]); Object.assign(record.payload, patch); rows[target] = JSON.stringify(record);
    await writeSession(dir, id, { lines: rows });
    const cache = new Map();
    for (let poll = 0; poll < 2; poll++) {
      const result = await readActiveSession({ sessionsDir: dir, wallClock: () => now, cache });
      assert.equal(result.state, 'ok');
      assert.equal(result.session.id, id);
      assert.equal(result.lastCompletedTurn.reason, reason);
      assert.equal(result.lastCompletedTurn.outputTokens, null);
      assert.equal(result.turnAverageSpeed.outputTokensPerSecond, null);
      if (reason === 'identity_conflict') assert.equal(result.conversationContext.model, null);
    }
  }
});
