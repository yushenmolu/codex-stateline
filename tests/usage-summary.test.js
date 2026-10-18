import test from 'node:test';
import assert from 'node:assert/strict';
import fsPromises from 'node:fs/promises';
import { appendFile, mkdir, mkdtemp, open, rm, stat, truncate, writeFile } from 'node:fs/promises';
import { createWriteStream, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import { createUsageSummary, publicUsageSnapshot } from '../src/telemetry/usage-summary.js';

const NOW = Date.parse('2026-10-17T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const ROOT = '11111111-1111-4111-8111-111111111111';
const CHILD = '22222222-2222-4222-8222-222222222222';
const GRANDCHILD = '33333333-3333-4333-8333-333333333333';
const OTHER = '44444444-4444-4444-8444-444444444444';
const execFileAsync = promisify(execFile);

function timestamp(offset = 0) {
  return new Date(NOW + offset).toISOString();
}

function event(type, payload, offset = 0, outer = type) {
  return JSON.stringify({ timestamp: timestamp(offset), type: outer, payload }) + '\n';
}

function meta(id, sessionId = id, extra = {}) {
  return event('session_meta', { id, session_id: sessionId, ...extra }, -1000);
}

function usage(threadId, responseId, input = 10, output = 3, sessionId = threadId, offset = 0, extra = {}) {
  return event('token_usage_record', {
    thread_id: threadId,
    session_id: sessionId,
    response_id: responseId,
    usage: { input_tokens: input, output_tokens: output, total_tokens: input + output },
    ...extra,
  }, offset);
}

function native(input, output, offset = 0, last = [input, output]) {
  const tokens = (values) => values === null ? null : {
    input_tokens: values[0], output_tokens: values[1], total_tokens: values[0] + values[1],
  };
  return event('token_count', {
    type: 'token_count',
    info: { total_token_usage: tokens([input, output]), last_token_usage: tokens(last) },
  }, offset, 'event_msg');
}

function modernCounter(input, output) {
  return { input_tokens: input, output_tokens: output, total_tokens: input + output };
}

function filename(id, compressed = false) {
  return `rollout-2026-10-17T00-00-00-${id}.jsonl${compressed ? '.zst' : ''}`;
}

function dualFilename(first, second, compressed = false) {
  return `rollout-2026-10-17T00-00-00-${first}_${second}.jsonl${compressed ? '.zst' : ''}`;
}

const HAS_ZSTD = typeof zlib.createZstdCompress === 'function'
  && typeof zlib.createZstdDecompress === 'function';

function incompressiblePadding(size) {
  const value = Buffer.alloc(size);
  let state = 0xabcdef01;
  for (let index = 0; index < size; index++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    value[index] = state & 0xff;
  }
  return value.toString('base64');
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'codex-usage-summary-'));
  const sessionsDir = join(directory, 'sessions');
  const archivedDir = join(directory, 'archived_sessions');
  await mkdir(sessionsDir);
  await mkdir(archivedDir);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, sessionsDir, archivedDir };
}

async function settle(summary, rounds = 200, taskId = null) {
  summary.snapshot({ taskId });
  for (let i = 0; i < rounds; i++) {
    await summary.runOnce();
  }
}

function createSummary(sessionsDir, archivedDir, extra = {}) {
  return createUsageSummary({
    sessionsDir,
    archivedDir,
    wallClock: () => NOW,
    chunkBytes: 32,
    roundBytes: 128,
    discoveryIntervalMs: 0,
    busyDelayMs: 1,
    idleDelayMs: 1,
    ...extra,
  });
}

function controlledScheduler() {
  const timers = new Map();
  let nextId = 0;
  let onScheduled = null;
  const scheduler = {
    setTimeout(callback, delay) {
      const id = ++nextId;
      timers.set(id, { callback, delay });
      onScheduled?.();
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
  };
  return {
    scheduler,
    timers,
    async fire() {
      const next = timers.entries().next().value;
      assert.ok(next, 'collector must schedule its next bounded round');
      const [id, timer] = next;
      timers.delete(id);
      let timeout;
      const scheduled = new Promise((resolve, reject) => {
        onScheduled = resolve;
        timeout = setTimeout(() => reject(Error('collector did not schedule its next round')), 2000);
      });
      timer.callback();
      try { await scheduled; } finally { clearTimeout(timeout); onScheduled = null; }
      return timer.delay;
    },
  };
}

test('unfinished discovery uses busy scheduling after completed files and returns idle when done', async (t) => {
  const { sessionsDir, archivedDir } = await fixture(t);
  for (const id of [ROOT, OTHER, CHILD]) {
    await writeFile(join(archivedDir, filename(id)), meta(id) + usage(id, `scheduled-${id}`, 1, 0));
  }
  const timers = new Map();
  let timerId = 0;
  let onScheduled;
  const scheduler = {
    setTimeout(callback, delay) {
      const id = ++timerId;
      timers.set(id, { callback, delay });
      onScheduled?.();
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
  };
  const summary = createSummary(sessionsDir, archivedDir, {
    scheduler,
    chunkBytes: 4096,
    roundBytes: 4096,
    busyDelayMs: 5,
    idleDelayMs: 1000,
    discoveryIntervalMs: 60_000,
    discoveryOps: 512,
  });
  t.after(() => summary.stop());
  summary.ensureStarted();
  assert.equal([...timers.values()][0].delay, 0);
  let observedUnfinished = false;
  let complete = false;
  for (let round = 0; round < 20; round++) {
    const [id, timer] = timers.entries().next().value;
    timers.delete(id);
    let timeout;
    const scheduled = new Promise((resolve, reject) => {
      onScheduled = resolve;
      timeout = setTimeout(() => reject(Error('collector did not schedule its next round')), 2000);
    });
    timer.callback();
    try { await scheduled; } finally { clearTimeout(timeout); onScheduled = null; }
    const block = summary.snapshot().overall;
    const nextDelay = [...timers.values()][0].delay;
    if (block.coverage.complete) {
      assert.equal(nextDelay, 1000);
      complete = true;
      break;
    }
    if (block.coverage.discoveredFiles > 0 && block.coverage.pendingFiles === 0) {
      observedUnfinished = true;
      assert.equal(nextDelay, 5, 'an unfinished discovery sweep must not wait the idle 1000ms');
    }
  }
  assert.equal(observedUnfinished, true);
  assert.equal(complete, true);
  assert.equal(summary.snapshot().overall.usage.totalTokens, 3);
  await summary.stop();
  assert.equal(timers.size, 0, 'stop must cancel the next discovery timer');
});

async function inTimeZone(t, timeZone) {
  if (process.env.CODEX_USAGE_TIMELINE_TEST === t.name) {
    assert.equal(Intl.DateTimeFormat().resolvedOptions().timeZone, timeZone);
    return true;
  }
  const pattern = '^' + t.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$';
  const env = { ...process.env, TZ: timeZone, CODEX_USAGE_TIMELINE_TEST: t.name };
  delete env.NODE_TEST_CONTEXT;
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [
      '--test', '--test-reporter=tap', '--test-name-pattern', pattern, fileURLToPath(import.meta.url),
    ], {
      env,
      maxBuffer: 1024 * 1024,
      timeout: 30_000,
    });
    assert.match(stdout, /# pass 1\r?\n/);
    assert.match(stdout, /# fail 0\r?\n/);
    assert.equal(stderr, '');
    t.diagnostic(`Isolated TZ=${timeZone} child passed`);
  } catch (error) {
    assert.fail(`Isolated TZ=${timeZone} child failed: ${error.stdout ?? ''}\n${error.stderr ?? error.message}`);
  }
  return false;
}

function checkTimeline(timeline, timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  assert.equal(timeline.timeZone, timeZone);
  assert.deepEqual(timeline.ranges.map((range) => range.id), ['today', '7d', '30d', '90d', 'all']);
  const today = timeline.ranges[0];
  assert.equal(today.buckets.length, Math.ceil((Date.parse(today.to) - Date.parse(today.from)) / (2 * 60 * 60 * 1000)));
  assert.ok(today.buckets.length <= 13);
  assert.deepEqual(timeline.ranges.slice(1, 4).map((range) => range.buckets.length), [7, 10, 13]);
  assert.ok(timeline.ranges[4].buckets.length > 0 && timeline.ranges[4].buckets.length <= 14);
  for (const range of timeline.ranges) {
    assert.equal(range.buckets[0].from, range.from);
    assert.equal(range.buckets.at(-1).to, range.to);
    const sum = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    let counted = 0;
    let nativeCounted = 0;
    for (const [index, bucket] of range.buckets.entries()) {
      assert.ok(Date.parse(bucket.to) > Date.parse(bucket.from));
      if (index) assert.equal(bucket.from, range.buckets[index - 1].to);
      counted += bucket.responsesCounted;
      nativeCounted += bucket.nativeIncrementsCounted;
      if (bucket.usage) {
        for (const key of Object.keys(sum)) sum[key] += bucket.usage[key];
        assert.equal(bucket.usage.totalTokens, bucket.usage.inputTokens + bucket.usage.outputTokens);
      }
    }
    assert.equal(range.responsesCounted, counted);
    assert.equal(range.nativeIncrementsCounted, nativeCounted);
    if (range.usage) assert.deepEqual(range.usage, sum);
    else assert.equal(counted + nativeCounted, 0);
  }
}

test('usage timeline has bounded local calendar ranges with inclusive starts and exclusive next-day ends', async (t) => {
  if (!await inTimeZone(t, 'UTC')) return;
  const { sessionsDir, archivedDir } = await fixture(t);
  const rows = meta(ROOT)
    + usage(ROOT, 'timeline-today', 1, 2)
    + usage(ROOT, 'timeline-seven-start', 2, 3, ROOT, -6 * DAY)
    + usage(ROOT, 'timeline-before-seven', 3, 4, ROOT, -6 * DAY - 1)
    + usage(ROOT, 'timeline-thirty-start', 5, 6, ROOT, -29 * DAY)
    + usage(ROOT, 'timeline-before-thirty', 6, 7, ROOT, -29 * DAY - 1)
    + usage(ROOT, 'timeline-ninety-start', 8, 9, ROOT, -89 * DAY)
    + usage(ROOT, 'timeline-before-ninety', 9, 10, ROOT, -89 * DAY - 1)
    + usage(ROOT, 'timeline-long-history', 10, 11, ROOT, -40_000 * DAY);
  await writeFile(join(sessionsDir, filename(ROOT)), rows);
  const summary = createSummary(sessionsDir, archivedDir, { chunkBytes: 4096, roundBytes: 32 * 1024 });
  t.after(() => summary.stop());
  await settle(summary, 20, ROOT);
  const value = summary.snapshot({ taskId: ROOT });
  assert.equal(value.overall.state, 'available');
  assert.equal(value.overall.coverage.complete, true);
  assert.equal(value.overall.usage.totalTokens, 96);
  const timeline = value.overall.timeline;
  checkTimeline(timeline);
  assert.deepEqual(timeline.ranges.map((range) => range.usage.totalTokens), [3, 8, 26, 56, 96]);
  assert.deepEqual(timeline.ranges.map((range) => range.responsesCounted), [1, 2, 4, 6, 8]);
  assert.deepEqual(timeline.ranges.map((range) => range.from), [
    timestamp(), timestamp(-6 * DAY), timestamp(-29 * DAY), timestamp(-89 * DAY), timestamp(-40_000 * DAY),
  ]);
  assert.ok(timeline.ranges.every((range) => range.to === timestamp(DAY)));
  assert.equal(Object.hasOwn(value.selected, 'timeline'), false);

  const openBefore = fsPromises.open;
  const opendirBefore = fsPromises.opendir;
  let fileReads = 0;
  fsPromises.open = async (...args) => { fileReads++; return openBefore(...args); };
  fsPromises.opendir = async (...args) => { fileReads++; return opendirBefore(...args); };
  try {
    assert.deepEqual(publicUsageSnapshot(summary.snapshot({ taskId: ROOT })).overall.timeline, timeline);
    assert.equal(fileReads, 0, 'snapshot and public projection must only read the published chart');
  } finally {
    fsPromises.open = openBefore;
    fsPromises.opendir = opendirBefore;
  }

  const privateValue = structuredClone(value);
  privateValue.overall.timeline.path = 'private-timeline-path';
  privateValue.selected.timeline = timeline;
  for (const range of privateValue.overall.timeline.ranges) {
    range.responseId = 'private-response-id';
    range.usage.transcript = 'private-range-text';
    for (const bucket of range.buckets) {
      bucket.threadId = 'private-thread-id';
      bucket.usage.path = 'private-usage-path';
    }
  }
  const projected = publicUsageSnapshot(privateValue);
  assert.deepEqual(projected.overall.timeline, timeline);
  assert.equal(Object.hasOwn(projected.selected, 'timeline'), false);
});

test('usage timeline assigns accepted future clock skew to the current local day', async (t) => {
  if (!await inTimeZone(t, 'UTC')) return;
  const { sessionsDir, archivedDir } = await fixture(t);
  const now = NOW + DAY - 60_000;
  await writeFile(join(sessionsDir, filename(ROOT)), meta(ROOT)
    + usage(ROOT, 'timeline-near-future', 4, 1, ROOT, DAY + 2 * 60_000)
    + usage(ROOT, 'timeline-too-far-future', 8, 1, ROOT, DAY + 4 * 60_000 + 1));
  const summary = createSummary(sessionsDir, archivedDir, {
    wallClock: () => now,
    chunkBytes: 4096,
    roundBytes: 32 * 1024,
  });
  t.after(() => summary.stop());
  await settle(summary, 20);
  const value = summary.snapshot().overall;
  assert.equal(value.state, 'partial');
  assert.equal(value.reason, 'invalid_usage');
  assert.equal(value.usage.totalTokens, 5);
  assert.equal(value.coverage.responsesCounted, 1);
  assert.equal(value.coverage.invalidResponses, 1);
  checkTimeline(value.timeline);
  for (const range of value.timeline.ranges) {
    assert.equal(range.to, timestamp(DAY));
    assert.equal(range.usage.totalTokens, 5);
    assert.equal(range.buckets.at(-1).usage.totalTokens, 5);
  }
  assert.equal(value.timeline.ranges[4].from, timestamp());
});

test('usage timeline follows the earliest surviving duplicate timestamp after source rollback', async (t) => {
  if (!await inTimeZone(t, 'UTC')) return;
  const { sessionsDir, archivedDir } = await fixture(t);
  const active = join(sessionsDir, filename(ROOT));
  const archived = join(archivedDir, filename(ROOT));
  await writeFile(active, meta(ROOT)
    + usage(ROOT, 'timeline-duplicate', 4, 1, ROOT, -DAY)
    + usage(ROOT, 'timeline-duplicate', 4, 1, ROOT, -2 * DAY));
  await writeFile(archived, meta(ROOT) + usage(ROOT, 'timeline-duplicate', 4, 1, ROOT, -8 * DAY));
  const summary = createSummary(sessionsDir, archivedDir, { chunkBytes: 4096, roundBytes: 32 * 1024 });
  t.after(() => summary.stop());
  await settle(summary, 20);
  let value = summary.snapshot().overall;
  checkTimeline(value.timeline);
  assert.equal(value.coverage.responsesCounted, 1);
  assert.equal(value.coverage.duplicateResponses, 1);
  assert.equal(value.timeline.ranges[1].usage.totalTokens, 0);
  assert.equal(value.timeline.ranges[4].from, timestamp(-8 * DAY));
  assert.equal(value.timeline.ranges[4].usage.totalTokens, 5);

  await rm(archived);
  await settle(summary, 20);
  value = summary.snapshot().overall;
  assert.equal(value.timeline.ranges[1].usage.totalTokens, 5);
  assert.equal(value.timeline.ranges[4].from, timestamp(-2 * DAY));
  assert.equal(value.timeline.ranges[4].responsesCounted, 1);

  await writeFile(active, meta(ROOT) + usage(ROOT, 'timeline-duplicate', 4, 1, ROOT, -DAY));
  await settle(summary, 20);
  value = summary.snapshot().overall;
  assert.equal(value.timeline.ranges[4].from, timestamp(-DAY));
  assert.equal(value.timeline.ranges[4].usage.totalTokens, 5);

  await appendFile(active, usage(ROOT, 'timeline-duplicate', 4, 1, ROOT, -4 * DAY));
  await settle(summary, 20);
  assert.equal(summary.snapshot().overall.timeline.ranges[4].from, timestamp(-4 * DAY));

  await appendFile(active, '{"broken"\n');
  await settle(summary, 20);
  value = summary.snapshot().overall;
  assert.equal(value.coverage.failedFiles, 1);
  assert.equal(value.coverage.responsesCounted, 0);
  assert.equal(value.timeline, null);
  await writeFile(join(sessionsDir, filename(OTHER)), meta(OTHER) + usage(OTHER, 'timeline-duplicate', 2, 1));
  await settle(summary, 20);
  value = summary.snapshot().overall;
  checkTimeline(value.timeline);
  assert.equal(value.timeline.ranges[4].from, timestamp());
  assert.equal(value.timeline.ranges[4].usage.totalTokens, 3);
  assert.equal(value.coverage.conflictingResponses, 0);
});

test('usage timeline preserves partial unknown buckets and distinguishes real zero-token responses', async (t) => {
  if (!await inTimeZone(t, 'UTC')) return;
  const { sessionsDir, archivedDir } = await fixture(t);
  const path = join(sessionsDir, filename(ROOT));
  const failedPath = join(sessionsDir, filename(OTHER));
  await writeFile(path, meta(ROOT) + usage(ROOT, 'timeline-old-only', 2, 1, ROOT, -20 * DAY));
  await writeFile(failedPath, '{"broken"\n');
  const summary = createSummary(sessionsDir, archivedDir, { chunkBytes: 4096, roundBytes: 32 * 1024 });
  t.after(() => summary.stop());
  await settle(summary, 20);
  let value = summary.snapshot().overall;
  assert.equal(value.state, 'partial');
  assert.equal(value.coverage.complete, false);
  checkTimeline(value.timeline);
  assert.equal(value.timeline.ranges[0].usage, null);
  assert.equal(value.timeline.ranges[0].responsesCounted, 0);
  for (const range of value.timeline.ranges) {
    for (const bucket of range.buckets) if (!bucket.responsesCounted) assert.equal(bucket.usage, null);
  }

  await appendFile(path, usage(ROOT, 'timeline-real-zero', 0, 0));
  await settle(summary, 20);
  value = summary.snapshot().overall;
  checkTimeline(value.timeline);
  assert.deepEqual(value.timeline.ranges[0].usage, { inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  assert.equal(value.timeline.ranges[0].responsesCounted, 1);
  assert.equal(value.timeline.ranges[0].buckets[0].usage.totalTokens, 0);
  assert.equal(value.timeline.ranges[0].buckets[0].responsesCounted, 1);
  assert.equal(value.timeline.ranges[0].buckets.at(-1).usage, null);

  await rm(failedPath);
  await settle(summary, 20);
  value = summary.snapshot().overall;
  assert.equal(value.coverage.complete, true);
  checkTimeline(value.timeline);
  assert.equal(value.timeline.ranges[0].buckets.at(-1).usage.totalTokens, 0);
  assert.equal(value.timeline.ranges[0].buckets.at(-1).responsesCounted, 0);
});

test('usage timeline uses Shanghai midnight and combines conversations without changing selected scope', async (t) => {
  if (!await inTimeZone(t, 'Asia/Shanghai')) return;
  const { sessionsDir, archivedDir } = await fixture(t);
  const midnight = Date.parse('2026-10-18T00:00:00.000+08:00');
  let now = Date.parse('2026-10-18T07:00:00.000+08:00');
  const hour = 60 * 60 * 1000;
  const at = (id, responseId, tokens, instant) => usage(id, responseId, tokens, 0, id, instant - NOW);
  const active = join(sessionsDir, filename(ROOT));
  const archived = join(archivedDir, filename(ROOT));
  await writeFile(active, meta(ROOT)
    + at(ROOT, 'local-yesterday', 1, midnight - 1)
    + at(ROOT, 'local-midnight', 2, midnight)
    + at(ROOT, 'local-before-two', 3, midnight + 2 * hour - 1)
    + at(ROOT, 'local-at-two', 4, midnight + 2 * hour)
    + at(ROOT, 'local-duplicate', 5, midnight + hour / 2)
    + at(ROOT, 'local-seven-start', 7, midnight - 6 * DAY));
  await writeFile(archived, meta(ROOT) + at(ROOT, 'local-duplicate', 5, midnight + 2.5 * hour));
  await writeFile(join(sessionsDir, filename(OTHER)), meta(OTHER)
    + at(OTHER, 'local-other-conversation', 6, midnight + 4 * hour)
    + at(OTHER, 'local-before-seven', 8, midnight - 6 * DAY - 1));
  const summary = createSummary(sessionsDir, archivedDir, {
    wallClock: () => now, chunkBytes: 4096, roundBytes: 32 * 1024,
  });
  t.after(() => summary.stop());
  await settle(summary, 20, ROOT);
  const value = summary.snapshot({ taskId: ROOT });
  checkTimeline(value.overall.timeline);
  assert.equal(value.overall.usage.totalTokens, 36);
  assert.equal(value.overall.coverage.responsesCounted, 8);
  assert.equal(value.overall.coverage.conversationsCounted, 2);
  assert.equal(value.overall.coverage.duplicateResponses, 1);
  assert.equal(value.selected.usage.totalTokens, 22);
  assert.equal(Object.hasOwn(value.selected, 'timeline'), false);
  const timeline = value.overall.timeline;
  assert.deepEqual(timeline.ranges.map((range) => range.usage.totalTokens), [20, 28, 36, 36, 36]);
  assert.deepEqual(timeline.ranges.map((range) => range.responsesCounted), [5, 7, 8, 8, 8]);
  assert.deepEqual(timeline.ranges.map((range) => range.from), [
    '2026-10-17T16:00:00.000Z', '2026-10-11T16:00:00.000Z',
    '2026-09-18T16:00:00.000Z', '2026-07-20T16:00:00.000Z', '2026-10-10T16:00:00.000Z',
  ]);
  assert.ok(timeline.ranges.every((range) => range.to === '2026-10-18T16:00:00.000Z'));
  const today = timeline.ranges[0];
  assert.deepEqual(today.buckets.map((bucket) => bucket.usage.totalTokens), [10, 4, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(today.buckets[0].to, '2026-10-17T18:00:00.000Z');

  await writeFile(active, meta(ROOT) + at(ROOT, 'local-duplicate', 5, midnight + 3.5 * hour));
  await settle(summary, 20, ROOT);
  const replayed = summary.snapshot({ taskId: ROOT }).overall;
  checkTimeline(replayed.timeline);
  assert.equal(replayed.timeline.ranges[0].buckets[0].usage.totalTokens, 0);
  assert.equal(replayed.timeline.ranges[0].buckets[1].usage.totalTokens, 5);
  assert.equal(replayed.timeline.ranges[0].responsesCounted, 2);

  const failed = join(sessionsDir, filename(CHILD));
  await writeFile(failed, '{"broken"\n');
  await appendFile(active, at(ROOT, 'local-zero-response', 0, midnight + 6 * hour));
  await settle(summary, 20, ROOT);
  const partial = summary.snapshot({ taskId: ROOT }).overall;
  assert.equal(partial.state, 'partial');
  assert.equal(partial.reason, 'read_failed');
  checkTimeline(partial.timeline);
  assert.equal(partial.timeline.ranges[0].buckets[0].usage, null);
  assert.equal(partial.timeline.ranges[0].buckets[3].usage.totalTokens, 0);
  assert.equal(partial.timeline.ranges[0].buckets[3].responsesCounted, 1);
  assert.equal(partial.timeline.ranges[0].responsesCounted, 3);
  assert.deepEqual(publicUsageSnapshot(summary.snapshot({ taskId: ROOT })).overall.timeline, partial.timeline);

  await rm(failed);
  now = midnight + DAY + hour;
  await settle(summary, 20, ROOT);
  const nextDay = summary.snapshot({ taskId: ROOT }).overall;
  assert.equal(nextDay.state, 'available');
  assert.equal(nextDay.usage.totalTokens, 19);
  assert.equal(nextDay.timeline.ranges[0].from, '2026-10-18T16:00:00.000Z');
  assert.equal(nextDay.timeline.ranges[0].to, '2026-10-19T16:00:00.000Z');
  assert.equal(nextDay.timeline.ranges[0].usage.totalTokens, 0);
  assert.equal(nextDay.timeline.ranges[0].responsesCounted, 0);
  assert.equal(nextDay.timeline.ranges[0].buckets[3].usage.totalTokens, 0);
});

for (const day of [
  { label: 'spring', from: '2026-03-08T05:00:00.000Z', to: '2026-03-09T04:00:00.000Z', hours: 23, buckets: 12 },
  { label: 'fall', from: '2026-11-01T04:00:00.000Z', to: '2026-11-02T05:00:00.000Z', hours: 25, buckets: 13 },
]) {
  test(`usage timeline ${day.label} DST day uses real two-hour buckets and local calendar boundaries`, async (t) => {
    if (!await inTimeZone(t, 'America/New_York')) return;
    const { sessionsDir, archivedDir } = await fixture(t);
    const from = Date.parse(day.from);
    const to = Date.parse(day.to);
    const hour = 60 * 60 * 1000;
    const at = (id, tokens, instant) => usage(ROOT, id, tokens, 0, ROOT, instant - NOW);
    const rows = meta(ROOT)
      + at('dst-before-midnight', 1, from - 1)
      + at('dst-midnight', 2, from)
      + at('dst-first-before', 3, from + 2 * hour - 1)
      + at('dst-second-start', 4, from + 2 * hour)
      + at('dst-final-hour', 5, to - 30 * 60 * 1000);
    await writeFile(join(sessionsDir, filename(ROOT)), rows);
    const summary = createSummary(sessionsDir, archivedDir, {
      wallClock: () => to - 1, chunkBytes: 4096, roundBytes: 32 * 1024,
    });
    t.after(() => summary.stop());
    await settle(summary, 20);
    const value = summary.snapshot().overall;
    assert.equal(value.usage.totalTokens, 15);
    checkTimeline(value.timeline);
    const today = value.timeline.ranges[0];
    assert.equal(today.from, day.from);
    assert.equal(today.to, day.to);
    assert.equal(Date.parse(today.to) - Date.parse(today.from), day.hours * hour);
    assert.equal(today.buckets.length, day.buckets);
    assert.equal(today.usage.totalTokens, 14);
    assert.equal(today.responsesCounted, 4);
    assert.equal(today.buckets[0].usage.totalTokens, 5);
    assert.equal(today.buckets[1].usage.totalTokens, 4);
    assert.equal(today.buckets.at(-1).usage.totalTokens, 5);
    for (const bucket of today.buckets.slice(0, -1)) {
      assert.equal(Date.parse(bucket.to) - Date.parse(bucket.from), 2 * hour);
    }
    assert.equal(Date.parse(today.buckets.at(-1).to) - Date.parse(today.buckets.at(-1).from), hour);
    const seven = value.timeline.ranges[1];
    assert.equal(seven.buckets.at(-1).from, day.from);
    assert.equal(seven.buckets.at(-1).to, day.to);
    assert.equal(seven.usage.totalTokens, 15);
    for (const range of value.timeline.ranges) {
      assert.equal(range.to, day.to);
      for (const bucket of range.id === 'today' ? [] : range.buckets) {
        for (const bound of [bucket.from, bucket.to]) {
          const local = new Date(bound);
          assert.equal(local.getHours(), 0);
          assert.equal(local.getMinutes(), 0);
        }
      }
    }
    assert.deepEqual(publicUsageSnapshot(summary.snapshot()).overall.timeline, value.timeline);
  });
}

test('usage timeline falls back to UTC when the local IANA timezone is unavailable', async (t) => {
  if (!await inTimeZone(t, 'Asia/Shanghai')) return;
  const { sessionsDir, archivedDir } = await fixture(t);
  await writeFile(join(sessionsDir, filename(ROOT)), meta(ROOT) + usage(ROOT, 'timezone-fallback', 2, 1));
  const originalFormatter = Intl.DateTimeFormat;
  try {
    for (const unavailable of [undefined, 'Invalid/Zone', 'throws']) {
      Intl.DateTimeFormat = function fallbackFormatter(...args) {
        if (args.length) return new originalFormatter(...args);
        if (unavailable === 'throws') throw Error('timezone unavailable');
        return { resolvedOptions: () => ({ timeZone: unavailable }) };
      };
      const summary = createSummary(sessionsDir, archivedDir, { chunkBytes: 4096, roundBytes: 32 * 1024 });
      try {
        await settle(summary, 20);
        const timeline = summary.snapshot().overall.timeline;
        checkTimeline(timeline, 'UTC');
        assert.equal(timeline.ranges[0].from, timestamp());
        assert.equal(timeline.ranges[0].to, timestamp(DAY));
        assert.equal(timeline.ranges[0].usage.totalTokens, 3);
      } finally {
        await summary.stop();
      }
    }
  } finally {
    Intl.DateTimeFormat = originalFormatter;
  }
});

test('public timeline projection supports five local ranges and preserves four legacy UTC ranges', () => {
  const triple = { inputTokens: 1, outputTokens: 0, totalTokens: 1 };
  const ids = ['today', '7d', '30d', '90d', 'all'];
  const timeline = {
    timeZone: 'Asia/Shanghai',
    ranges: ids.map((id) => ({
      id, from: '2026-10-17T16:00:00.000Z', to: '2026-10-18T16:00:00.000Z',
      usage: triple, responsesCounted: 1, nativeIncrementsCounted: 0,
      buckets: [{ from: '2026-10-17T16:00:00.000Z', to: '2026-10-18T16:00:00.000Z', usage: triple, responsesCounted: 1, nativeIncrementsCounted: 0 }],
    })),
  };
  const project = (candidate) => publicUsageSnapshot({
    sampledAt: timestamp(), overall: { state: 'partial', usage: triple, coverage: {}, timeline: candidate }, selected: null,
  }).overall.timeline;
  assert.deepEqual(project(timeline), timeline);
  const legacy = { timeZone: 'UTC', ranges: timeline.ranges.slice(1) };
  assert.deepEqual(project(legacy), legacy);
  assert.equal(project({ ...legacy, timeZone: 'Asia/Shanghai' }), null);
  for (const timeZone of [null, '', '+08:00', 'UTC+8', '../private', 'Invalid/Zone', {}, 1]) {
    assert.equal(project({ ...timeline, timeZone }), null);
  }
  assert.equal(project({ ...timeline, ranges: timeline.ranges.slice().reverse() }), null);
  const oversized = structuredClone(timeline);
  const emptyBucket = { ...oversized.ranges[0].buckets[0], usage: null, responsesCounted: 0 };
  oversized.ranges[0].buckets = [oversized.ranges[0].buckets[0], ...Array(13).fill(emptyBucket)];
  assert.equal(project(oversized), null);
  oversized.ranges[0].buckets.pop();
  assert.deepEqual(project(oversized), oversized);
});

test('rollout filenames include plain and underscore variants', async (t) => {
  const { sessionsDir, archivedDir } = await fixture(t);
  await writeFile(join(sessionsDir, filename(ROOT)), meta(ROOT) + usage(ROOT, 'r1', 2, 1));
  await writeFile(join(sessionsDir, filename(`${ROOT}_${CHILD}`)), meta(CHILD, ROOT, { parent_thread_id: ROOT }) + usage(CHILD, 'r2', 3, 1, ROOT));
  const summary = createSummary(sessionsDir, archivedDir);
  t.after(() => summary.stop());
  await settle(summary);
  const snapshot = summary.snapshot();
  assert.equal(snapshot.overall.coverage.discoveredFiles, 2);
  assert.equal(snapshot.overall.coverage.responsesCounted, 2);
});

test('native cumulative snapshots count verified increments and ignore repeated last usage', async (t) => {
  const { sessionsDir, archivedDir } = await fixture(t);
  const rows = meta(ROOT) + native(10, 2, -400)
    + native(10, 2, -300, [999, 999])
    + native(15, 5, -200, [5, 3])
    + native(15, 5, -100, null);
  await writeFile(join(sessionsDir, filename(ROOT)), rows);
  await writeFile(join(archivedDir, filename(ROOT)), rows);
  const summary = createSummary(sessionsDir, archivedDir, { chunkBytes: 4096, roundBytes: 16384 });
  t.after(() => summary.stop());
  await settle(summary, 20, ROOT);
  const value = summary.snapshot({ taskId: ROOT });
  for (const block of [value.overall, value.selected]) {
    assert.equal(block.state, 'available');
    assert.deepEqual(block.usage, { inputTokens: 15, outputTokens: 5, totalTokens: 20 });
    assert.equal(block.coverage.responsesCounted, 0);
    assert.equal(block.coverage.nativeIncrementsCounted, 2);
    assert.equal(block.coverage.conversationsCounted, 1);
    assert.equal(block.coverage.duplicateResponses, 0);
  }
  checkTimeline(value.overall.timeline);
  const all = value.overall.timeline.ranges.at(-1);
  assert.equal(all.responsesCounted, 0);
  assert.equal(all.nativeIncrementsCounted, 2);
  assert.deepEqual(all.usage, value.overall.usage);
});

test('native mixed coverage subtracts verified modern intervals without discarding older native history', async (t) => {
  const { sessionsDir, archivedDir } = await fixture(t);
  const rows = meta(ROOT) + native(10, 2, -400)
    + usage(ROOT, 'mixed-response', 5, 3, ROOT, -300, { thread_token_usage: modernCounter(15, 5) })
    + native(20, 7, -200, [10, 5])
    + usage(ROOT, 'modern-ahead', 1, 1, ROOT, -100, { thread_token_usage: modernCounter(21, 8) });
  await writeFile(join(sessionsDir, filename(ROOT)), rows);
  const summary = createSummary(sessionsDir, archivedDir, { chunkBytes: 4096, roundBytes: 16384 });
  t.after(() => summary.stop());
  await settle(summary, 20);
  const value = summary.snapshot().overall;
  assert.equal(value.state, 'available');
  assert.deepEqual(value.usage, { inputTokens: 21, outputTokens: 8, totalTokens: 29 });
  assert.equal(value.coverage.responsesCounted, 2);
  assert.equal(value.coverage.nativeIncrementsCounted, 2);
  assert.equal(value.timeline.ranges.at(-1).nativeIncrementsCounted, 2);
});

test('native and modern overlap is recomputed for either discovery order and after source removal', async (t) => {
  for (const nativeFirst of [false, true]) {
    const { sessionsDir, archivedDir } = await fixture(t);
    const nativePath = join(sessionsDir, filename(ROOT));
    const modernPath = join(archivedDir, filename(ROOT));
    const nativeRows = meta(ROOT) + native(10, 2, -300);
    const modernRows = meta(ROOT) + usage(ROOT, 'overlap-response', 10, 2, ROOT, -200, {
      thread_token_usage: modernCounter(10, 2),
    });
    await writeFile(nativeFirst ? nativePath : modernPath, nativeFirst ? nativeRows : modernRows);
    const summary = createSummary(sessionsDir, archivedDir, { chunkBytes: 4096, roundBytes: 16384 });
    t.after(() => summary.stop());
    await settle(summary, 20);
    assert.equal(summary.snapshot().overall.usage.totalTokens, 12);
    await writeFile(nativeFirst ? modernPath : nativePath, nativeFirst ? modernRows : nativeRows);
    await settle(summary, 20);
    let value = summary.snapshot().overall;
    assert.equal(value.state, 'available');
    assert.equal(value.usage.totalTokens, 12);
    assert.equal(value.coverage.responsesCounted, 1);
    assert.equal(value.coverage.nativeIncrementsCounted, 0);
    await rm(modernPath);
    await settle(summary, 20);
    value = summary.snapshot().overall;
    assert.equal(value.state, 'available');
    assert.equal(value.usage.totalTokens, 12);
    assert.equal(value.coverage.responsesCounted, 0);
    assert.equal(value.coverage.nativeIncrementsCounted, 1);
    await summary.stop();
  }
});

test('native unknown baseline, missing info, and ownership gaps never become a known zero', async (t) => {
  const { sessionsDir, archivedDir } = await fixture(t);
  const path = join(sessionsDir, filename(ROOT));
  await writeFile(path, meta(ROOT) + native(10, 2, -300, null) + native(15, 3, -200, [5, 1]));
  const summary = createSummary(sessionsDir, archivedDir, { chunkBytes: 4096, roundBytes: 16384 });
  t.after(() => summary.stop());
  await settle(summary, 20);
  let value = summary.snapshot().overall;
  assert.equal(value.state, 'partial');
  assert.equal(value.reason, 'invalid_usage');
  assert.equal(value.usage.totalTokens, 6);
  assert.equal(value.coverage.nativeIncrementsCounted, 1);
  await writeFile(path, meta(ROOT) + event('token_count', { type: 'token_count', info: null }, 0, 'event_msg'));
  await settle(summary, 20);
  value = summary.snapshot().overall;
  assert.equal(value.usage, null);
  assert.equal(value.timeline, null);
  assert.equal(value.coverage.nativeIncrementsCounted, 0);
  assert.equal(value.reason, 'invalid_usage');
  await writeFile(path, native(5, 1));
  await settle(summary, 20);
  assert.equal(summary.snapshot().overall.usage, null);
  assert.equal(summary.snapshot().overall.coverage.nativeIncrementsCounted, 0);
});

test('native verified zero has its own measurement count and cannot count as a response', async (t) => {
  const { sessionsDir, archivedDir } = await fixture(t);
  await writeFile(join(sessionsDir, filename(ROOT)), meta(ROOT) + native(0, 0) + native(0, 0));
  const summary = createSummary(sessionsDir, archivedDir, { chunkBytes: 4096, roundBytes: 16384 });
  t.after(() => summary.stop());
  await settle(summary, 20, ROOT);
  const value = summary.snapshot({ taskId: ROOT });
  assert.equal(value.overall.state, 'available');
  assert.equal(value.overall.usage.totalTokens, 0);
  assert.equal(value.overall.coverage.responsesCounted, 0);
  assert.equal(value.overall.coverage.nativeIncrementsCounted, 1);
  checkTimeline(value.overall.timeline);
  assert.equal(value.selected.usage.totalTokens, 0);
});

test('native resets and compaction never merge equal counters across epochs', async (t) => {
  const { sessionsDir, archivedDir } = await fixture(t);
  const path = join(sessionsDir, filename(ROOT));
  const modern = usage(ROOT, 'surviving-modern', 2, 1, ROOT, -100, { thread_token_usage: modernCounter(22, 4) });
  const summary = createSummary(sessionsDir, archivedDir, { chunkBytes: 4096, roundBytes: 16384 });
  t.after(() => summary.stop());
  for (const boundary of [native(1, 1, -300), event('compacted', {}, -300)]) {
    await writeFile(path, meta(ROOT) + native(10, 2, -500) + boundary + native(10, 2, -200) + modern);
    await settle(summary, 20);
    const value = summary.snapshot().overall;
    assert.equal(value.state, 'partial');
    assert.equal(value.reason, 'invalid_usage');
    assert.equal(value.usage.totalTokens, 3);
    assert.equal(value.coverage.nativeIncrementsCounted, 0);
    assert.equal(value.coverage.responsesCounted, 1);
  }
});

test('native foreign metadata and forked first baselines do not recount inherited usage', async (t) => {
  const { sessionsDir, archivedDir } = await fixture(t);
  await writeFile(join(sessionsDir, filename(ROOT)), meta(ROOT) + usage(ROOT, 'parent-only', 2, 1));
  const childPath = join(sessionsDir, filename(CHILD));
  await writeFile(childPath, meta(CHILD, CHILD, { forked_from_id: ROOT, parent_thread_id: ROOT })
    + native(100, 20, -500) + native(104, 21, -400, [4, 1])
    + meta(OTHER) + native(999, 999, -300)
    + usage(CHILD, 'child-modern', 1, 1, CHILD, -100));
  const summary = createSummary(sessionsDir, archivedDir, { chunkBytes: 4096, roundBytes: 16384 });
  t.after(() => summary.stop());
  await settle(summary, 30, ROOT);
  const value = summary.snapshot({ taskId: ROOT });
  assert.equal(value.overall.state, 'partial');
  assert.equal(value.overall.usage.totalTokens, 5, 'unverified modern endpoint conservatively suppresses child native');
  assert.equal(value.selected.usage.totalTokens, 5, 'foreign metadata must not replace the verified parent relationship');
  await writeFile(childPath, meta(CHILD, CHILD, { forked_from_id: ROOT, parent_thread_id: ROOT })
    + native(100, 20, -500) + native(104, 21, -400, [4, 1]));
  await settle(summary, 30, ROOT);
  assert.equal(summary.snapshot({ taskId: ROOT }).selected.usage.totalTokens, 8);
  assert.equal(summary.snapshot().overall.coverage.nativeIncrementsCounted, 1);
});

test('native conflicting counter components and missing modern endpoints preserve only modern usage', async (t) => {
  const { sessionsDir, archivedDir } = await fixture(t);
  const path = join(sessionsDir, filename(ROOT));
  const summary = createSummary(sessionsDir, archivedDir, { chunkBytes: 4096, roundBytes: 16384 });
  t.after(() => summary.stop());
  for (const endpoint of [undefined, modernCounter(11, 1)]) {
    await writeFile(path, meta(ROOT) + native(10, 2, -300)
      + usage(ROOT, 'ambiguous-modern', 5, 1, ROOT, -200, { thread_token_usage: endpoint }));
    await settle(summary, 20);
    const value = summary.snapshot().overall;
    assert.equal(value.state, 'partial');
    assert.equal(value.reason, 'invalid_usage');
    assert.equal(value.usage.totalTokens, 6);
    assert.equal(value.coverage.nativeIncrementsCounted, 0);
  }
});

test('native sources revoke old intervals on rewrite and remain within the shared bookkeeping cap', async (t) => {
  const { sessionsDir, archivedDir } = await fixture(t);
  const path = join(sessionsDir, filename(ROOT));
  await writeFile(path, meta(ROOT) + native(10, 2, -300) + native(15, 3, -200, [5, 1]));
  const summary = createSummary(sessionsDir, archivedDir, { chunkBytes: 4096, roundBytes: 16384 });
  t.after(() => summary.stop());
  await settle(summary, 20);
  assert.equal(summary.snapshot().overall.usage.totalTokens, 18);
  await writeFile(path, meta(ROOT) + native(1, 1, -100));
  await settle(summary, 20);
  assert.equal(summary.snapshot().overall.usage.totalTokens, 2);
  assert.equal(summary.snapshot().overall.coverage.nativeIncrementsCounted, 1);
  const bounded = createSummary(sessionsDir, archivedDir, {
    chunkBytes: 4096, roundBytes: 16384, limits: { maxResponses: 2 },
  });
  t.after(() => bounded.stop());
  await settle(bounded, 20);
  assert.equal(bounded.snapshot().overall.reason, 'budget_exceeded');
  assert.equal(bounded.snapshot().overall.coverage.nativeIncrementsCounted, 0);
  assert.equal(bounded.snapshot().overall.usage, null);
});

test('public native counters default only when absent and validate independent bucket totals', async () => {
  const triple = { inputTokens: 1, outputTokens: 0, totalTokens: 1 };
  const candidate = {
    sampledAt: timestamp(),
    overall: {
      state: 'available', reason: null, scope: 'local_all', usage: triple, updatedAt: timestamp(),
      coverage: { responsesCounted: 0, nativeIncrementsCounted: 1, complete: true },
      timeline: { timeZone: 'UTC', ranges: ['today', '7d', '30d', '90d', 'all'].map((id) => ({
        id, from: timestamp(), to: timestamp(DAY), usage: triple, responsesCounted: 0, nativeIncrementsCounted: 1,
        buckets: [{ from: timestamp(), to: timestamp(DAY), usage: triple, responsesCounted: 0, nativeIncrementsCounted: 1 }],
      })) },
    }, selected: null,
  };
  assert.deepEqual(publicUsageSnapshot(candidate).overall.timeline, candidate.overall.timeline);
  for (const bad of [null, -1, 1.5, '1', Number.MAX_SAFE_INTEGER + 1]) {
    const changed = structuredClone(candidate);
    changed.overall.coverage.nativeIncrementsCounted = bad;
    const value = publicUsageSnapshot(changed).overall;
    assert.equal(value.state, 'partial');
    assert.equal(value.reason, 'invalid_usage');
    assert.equal(value.usage, null);
    assert.equal(value.coverage.nativeIncrementsCounted, 0);
    assert.equal(value.coverage.complete, false);
    assert.equal(value.timeline, null);
    changed.overall.coverage.nativeIncrementsCounted = 1;
    changed.overall.timeline.ranges[0].buckets[0].nativeIncrementsCounted = bad;
    assert.equal(publicUsageSnapshot(changed).overall.timeline, null);
    assert.deepEqual(publicUsageSnapshot(changed).overall.usage, triple);
  }
  const mismatch = structuredClone(candidate);
  mismatch.overall.timeline.ranges[0].buckets[0].nativeIncrementsCounted = 2;
  assert.equal(publicUsageSnapshot(mismatch).overall.timeline, null);
  const legacy = structuredClone(candidate);
  delete legacy.overall.coverage.nativeIncrementsCounted;
  for (const range of legacy.overall.timeline.ranges) {
    range.responsesCounted = 1;
    range.buckets[0].responsesCounted = 1;
    delete range.nativeIncrementsCounted;
    delete range.buckets[0].nativeIncrementsCounted;
  }
  assert.equal(publicUsageSnapshot(legacy).overall.coverage.nativeIncrementsCounted, 0);
  assert.equal(publicUsageSnapshot(legacy).overall.timeline.ranges[0].nativeIncrementsCounted, 0);
});

test('exhausted budgets retain fresh partial totals through bounded automatic source revalidation', async (t) => {
  const { sessionsDir, archivedDir } = await fixture(t);
  const path = join(sessionsDir, filename(ROOT));
  await writeFile(path, meta(ROOT) + native(10, 2, -300)
    + usage(ROOT, 'capped-modern', 5, 1, ROOT, -200, { thread_token_usage: modernCounter(15, 3) })
    + native(15, 3, -100, [5, 1]));
  const controlled = controlledScheduler();
  let clock = 0;
  let wall = NOW;
  let operations = 0;
  const summary = createSummary(sessionsDir, archivedDir, {
    scheduler: controlled.scheduler,
    wallClock: () => wall,
    monotonicClock: () => clock,
    staleMs: 100,
    chunkBytes: 4096,
    roundBytes: 16384,
    limits: { maxResponses: 9 },
    discoveryOps: { limit: 2, before: () => operations++ },
  });
  t.after(() => summary.stop());
  summary.snapshot({ taskId: ROOT });
  summary.ensureStarted();
  for (let round = 0; round < 60 && summary.snapshot({ taskId: ROOT }).overall.state !== 'available'; round++) {
    operations = 0;
    await controlled.fire();
    assert.ok(operations <= 2);
  }
  assert.equal(summary.snapshot({ taskId: ROOT }).overall.usage.totalTokens, 18);
  await writeFile(join(sessionsDir, filename(OTHER)), meta(OTHER) + usage(OTHER, 'over-cap', 100, 1));
  for (let round = 0; round < 60 && summary.snapshot({ taskId: ROOT }).overall.reason !== 'budget_exceeded'; round++) {
    operations = 0;
    await controlled.fire();
    assert.ok(operations <= 2);
  }
  assert.equal(summary.snapshot({ taskId: ROOT }).overall.reason, 'budget_exceeded');
  const openBefore = fsPromises.open;
  const opendirBefore = fsPromises.opendir;
  let opened = 0;
  let decoded = 0;
  fsPromises.open = async (...args) => { decoded++; return openBefore(...args); };
  fsPromises.opendir = async (...args) => { opened++; return opendirBefore(...args); };
  try {
    for (let round = 0; round < 32; round++) {
      clock += 10;
      operations = 0;
      await controlled.fire();
      assert.ok(operations <= 2, 'retained checks must share the existing operation cap');
      for (const block of Object.values(summary.snapshot({ taskId: ROOT })).filter((value) => value?.coverage)) {
        assert.equal(block.state, 'partial');
        assert.equal(block.reason, 'budget_exceeded');
        assert.equal(block.coverage.complete, false);
        assert.equal(block.usage.totalTokens, 18);
      }
    }
    assert.ok(clock > 3 * 100, 'automatic verification must survive multiple stale windows');
    wall += 2 * DAY;
    for (let round = 0; round < 5; round++) await controlled.fire();
    const timeline = summary.snapshot().overall.timeline;
    assert.equal(timeline.ranges[0].from, new Date(new Date(wall).setHours(0, 0, 0, 0)).toISOString());
    assert.equal(timeline.ranges[0].usage, null);
    assert.equal(timeline.ranges.at(-1).usage.totalTokens, 18);
    assert.equal(decoded, 0, 'hard caps must remain terminal for usage decoding');
    assert.equal(opened, 0, 'hard caps must not resume directory discovery');
    clock += 101;
    const stale = summary.snapshot().overall;
    assert.equal(stale.reason, 'snapshot_stale', 'unverified cache must still become stale if automatic checks stop');
    assert.equal(stale.usage, null);
    assert.equal(stale.timeline, null);
  } finally {
    fsPromises.open = openBefore;
    fsPromises.opendir = opendirBefore;
  }
  await summary.stop();
  assert.equal(controlled.timers.size, 0);
});

test('exhausted budgets revoke changed and unreadable sources without accepting replacement usage', async (t) => {
  const { sessionsDir, archivedDir } = await fixture(t);
  const path = join(sessionsDir, filename(ROOT));
  const original = meta(ROOT) + native(10, 2, -300)
    + usage(ROOT, 'capped-modern', 5, 1, ROOT, -200, { thread_token_usage: modernCounter(15, 3) })
    + native(15, 3, -100, [5, 1]);
  const lstatBefore = fsPromises.lstat;
  const realpathBefore = fsPromises.realpath;
  for (const mutation of ['delete', 'same-size', 'truncate', 'grow-rewrite', 'unsafe', 'read-failed']) {
    await t.test(mutation, async (caseT) => {
      await writeFile(path, original);
      const summary = createSummary(sessionsDir, archivedDir, {
        chunkBytes: 4096, roundBytes: 16384, limits: { maxResponses: 9 },
      });
      caseT.after(() => summary.stop());
      await settle(summary, 20, ROOT);
      assert.equal(summary.snapshot().overall.usage.totalTokens, 18);
      await writeFile(join(sessionsDir, filename(OTHER)), meta(OTHER) + usage(OTHER, 'over-cap', 100, 1));
      await settle(summary, 20, ROOT);
      assert.equal(summary.snapshot().overall.reason, 'budget_exceeded');
      if (mutation === 'delete') await rm(path);
      if (mutation === 'same-size') await writeFile(path, original.replace('capped-modern', 'edited-modern'));
      if (mutation === 'truncate') await truncate(path, 0);
      if (mutation === 'grow-rewrite') await writeFile(path, original.replace('capped-modern', 'edited-modern') + native(50, 20));
      if (mutation === 'unsafe') {
        fsPromises.realpath = async (...args) => args[0] === path ? path + '.redirected' : realpathBefore(...args);
      }
      if (mutation === 'read-failed') {
        fsPromises.lstat = async (...args) => {
          if (args[0] === path) throw Object.assign(Error('fixture read failure'), { code: 'EACCES' });
          return lstatBefore(...args);
        };
      }
      try {
        await settle(summary, 10, ROOT);
        const value = summary.snapshot({ taskId: ROOT });
        for (const block of [value.overall, value.selected]) {
          assert.equal(block.state, 'partial');
          assert.equal(block.reason, 'budget_exceeded');
          assert.equal(block.usage, null);
          assert.equal(block.coverage.responsesCounted, 0);
          assert.equal(block.coverage.nativeIncrementsCounted, 0);
          assert.equal(block.coverage.conversationsCounted, 0);
          assert.equal(block.coverage.complete, false);
        }
        assert.equal(value.overall.timeline, null);
      } finally {
        fsPromises.lstat = lstatBefore;
        fsPromises.realpath = realpathBefore;
      }
      await summary.stop();
      await rm(join(sessionsDir, filename(OTHER)));
    });
  }
});

test('exhausted-budget verification does not refresh partial sweeps and stop ignores late I/O', async (t) => {
  const { sessionsDir, archivedDir } = await fixture(t);
  const path = join(sessionsDir, filename(ROOT));
  await writeFile(path, meta(ROOT) + usage(ROOT, 'before-cap', 3, 1));
  let clock = 0;
  let limit = 512;
  let operations = 0;
  const controls = { get limit() { return limit; }, before: () => operations++ };
  const summary = createSummary(sessionsDir, archivedDir, {
    chunkBytes: 4096, roundBytes: 16384, limits: { maxResponses: 2 },
    staleMs: 100, monotonicClock: () => clock, discoveryOps: controls,
  });
  t.after(() => summary.stop());
  await settle(summary, 20);
  await writeFile(join(sessionsDir, filename(OTHER)), meta(OTHER) + usage(OTHER, 'over-cap', 5, 1));
  await settle(summary, 20);
  assert.equal(summary.snapshot().overall.usage.totalTokens, 4);
  limit = 1;
  clock = 101;
  operations = 0;
  await summary.runOnce();
  assert.equal(operations, 1);
  assert.equal(summary.snapshot().overall.reason, 'snapshot_stale');
  const lstatBefore = fsPromises.lstat;
  let entered;
  let release;
  const checking = new Promise((resolve) => { entered = resolve; });
  const held = new Promise((resolve) => { release = resolve; });
  fsPromises.lstat = async (...args) => {
    if (args[0] === path) { entered(); await held; }
    return lstatBefore(...args);
  };
  try {
    const inFlight = summary.runOnce();
    // This round may be realpath-only; advance until the confirming stat is held.
    const ready = await Promise.race([checking.then(() => true), inFlight.then(() => false)]);
    const running = ready ? inFlight : summary.runOnce();
    await checking;
    const stopping = summary.stop();
    release();
    await running;
    await stopping;
    const value = summary.snapshot().overall;
    assert.equal(value.reason, 'scan_interrupted');
    assert.equal(value.usage, null);
    assert.equal(value.timeline, null);
  } finally {
    release();
    fsPromises.lstat = lstatBefore;
  }
});

test('a first-round exhausted budget expires while its first automatic verification is stalled', async (t) => {
  const { sessionsDir, archivedDir } = await fixture(t);
  const path = join(sessionsDir, filename(ROOT));
  await writeFile(path, meta(ROOT) + usage(ROOT, 'first-round-retained', 3, 1)
    + event('token_usage_record', { usage: null }));
  const controlled = controlledScheduler();
  let clock = 0;
  const summary = createSummary(sessionsDir, archivedDir, {
    scheduler: controlled.scheduler,
    chunkBytes: 4096, roundBytes: 16384, limits: { maxResponses: 2 },
    staleMs: 100, monotonicClock: () => clock,
  });
  t.after(() => summary.stop());
  await summary.start();
  await controlled.fire();
  const initial = summary.snapshot().overall;
  assert.equal(initial.state, 'partial');
  assert.equal(initial.reason, 'budget_exceeded');
  assert.equal(initial.usage.totalTokens, 4);
  assert.equal(initial.coverage.responsesCounted, 1);
  const lstatBefore = fsPromises.lstat;
  let entered;
  let release;
  const checking = new Promise((resolve) => { entered = resolve; });
  const held = new Promise((resolve) => { release = resolve; });
  fsPromises.lstat = async (...args) => {
    if (args[0] === path) { entered(); await held; }
    return lstatBefore(...args);
  };
  try {
    const [id, timer] = controlled.timers.entries().next().value;
    controlled.timers.delete(id);
    timer.callback();
    await checking;
    clock = 101;
    const stale = summary.snapshot().overall;
    assert.equal(stale.state, 'unavailable');
    assert.equal(stale.reason, 'snapshot_stale');
    assert.equal(stale.usage, null);
    assert.equal(stale.timeline, null);
    const stopping = summary.stop();
    release();
    await stopping;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(summary.snapshot().overall.reason, 'scan_interrupted');
    assert.equal(summary.snapshot().overall.usage, null);
    assert.equal(controlled.timers.size, 0, 'late automatic verification must not publish or reschedule after stop');
  } finally {
    release();
    fsPromises.lstat = lstatBefore;
  }
});

test('response-local usage is counted once per response across duplicates and archive copies', async (t) => {
  const { sessionsDir, archivedDir } = await fixture(t);
  const rows = meta(ROOT)
    + usage(ROOT, 'same', 10, 5)
    + usage(ROOT, 'same', 10, 5)
    + usage(ROOT, 'turn-a', 1, 1)
    + usage(ROOT, 'turn-b', 2, 2, ROOT, 0, {
      turn_token_usage: { input_tokens: 100, output_tokens: 100, total_tokens: 200 },
      thread_token_usage: { input_tokens: 300, output_tokens: 300, total_tokens: 600 },
    });
  await writeFile(join(sessionsDir, filename(ROOT)), rows);
  await writeFile(join(archivedDir, filename(ROOT)), rows);
  const summary = createSummary(sessionsDir, archivedDir);
  t.after(() => summary.stop());
  await settle(summary);
  const value = summary.snapshot();
  assert.equal(value.overall.usage.totalTokens, 21);
  assert.equal(value.overall.coverage.responsesCounted, 3);
  assert.equal(value.overall.coverage.duplicateResponses, 3);
  assert.equal(value.overall.coverage.complete, true);
});

test('root, child and grandchild attribution follows verified metadata chains', async (t) => {
  const { sessionsDir, archivedDir } = await fixture(t);
  await writeFile(join(sessionsDir, filename(ROOT)), meta(ROOT) + usage(ROOT, 'root-response', 1, 1));
  await writeFile(join(sessionsDir, filename(CHILD)), meta(CHILD, ROOT, { parent_thread_id: ROOT }) + usage(CHILD, 'child-response', 2, 1, ROOT));
  await writeFile(join(sessionsDir, filename(GRANDCHILD)), meta(GRANDCHILD, ROOT, { parent_thread_id: CHILD }) + usage(GRANDCHILD, 'grandchild-response', 4, 2, ROOT));
  const summary = createSummary(sessionsDir, archivedDir);
  t.after(() => summary.stop());
  await settle(summary, 200, ROOT);
  const snapshot = summary.snapshot({ taskId: ROOT });
  const overall = snapshot.overall;
  assert.equal(overall.usage.totalTokens, 11);
  assert.equal(overall.coverage.conversationsCounted, 1);
  assert.equal(overall.coverage.subagentThreadsCounted, 2);
  const selected = snapshot.selected;
  assert.equal(selected.state, 'available');
  assert.equal(selected.usage.totalTokens, 11);
  await settle(summary, 200, CHILD);
  assert.equal(summary.snapshot({ taskId: CHILD }).selected.usage.totalTokens, 11);
});

test('parent cycles remain unresolved without being treated as roots', async (t) => {
  const { sessionsDir, archivedDir } = await fixture(t);
  await writeFile(join(sessionsDir, filename(ROOT)), [
    meta(ROOT, ROOT, { parent_thread_id: CHILD }),
    usage(ROOT, 'cycle-root', 1, 1),
  ].join('\n'));
  await writeFile(join(sessionsDir, filename(CHILD)), [
    meta(CHILD, CHILD, { parent_thread_id: ROOT }),
    usage(CHILD, 'cycle-child', 2, 1),
  ].join('\n'));
  const summary = createSummary(sessionsDir, archivedDir);
  t.after(() => summary.stop());
  await settle(summary, 200, ROOT);
  const value = summary.snapshot({ taskId: ROOT });
  assert.equal(value.overall.usage.totalTokens, 5);
  assert.equal(value.overall.state, 'partial');
  assert.equal(value.overall.reason, 'ownership_unverified');
  assert.equal(value.overall.coverage.complete, false);
  assert.equal(value.selected.state, 'partial');
  assert.equal(value.selected.reason, 'ownership_unverified');
  assert.equal(value.selected.usage, null);
});

test('conflicting parent declarations do not establish ownership', async (t) => {
  const { sessionsDir, archivedDir } = await fixture(t);
  await writeFile(join(sessionsDir, filename(ROOT)), meta(ROOT) + usage(ROOT, 'conflict-root', 1, 1));
  await writeFile(join(sessionsDir, filename(`${ROOT}_${CHILD}`)), [
    meta(CHILD, ROOT, { parent_thread_id: ROOT }),
    usage(CHILD, 'conflict-child-a', 2, 1, ROOT),
  ].join('\n'));
  await writeFile(join(sessionsDir, filename(CHILD)), [
    meta(CHILD, CHILD, { parent_thread_id: OTHER }),
    usage(CHILD, 'conflict-child-b', 3, 1),
  ].join('\n'));
  const summary = createSummary(sessionsDir, archivedDir);
  t.after(() => summary.stop());
  await settle(summary, 200, ROOT);
  const value = summary.snapshot({ taskId: ROOT });
  assert.equal(value.overall.usage.totalTokens, 9);
  assert.equal(value.overall.state, 'partial');
  assert.equal(value.overall.reason, 'ownership_unverified');
  assert.equal(value.overall.coverage.complete, false);
  assert.equal(value.selected.usage.totalTokens, 2);
  assert.equal(value.selected.coverage.responsesCounted, 1);
  assert.equal(value.selected.state, 'partial');
  assert.equal(value.selected.reason, 'ownership_unverified');
});

test('payload and spawn parent declarations must agree', async (t) => {
  const { sessionsDir, archivedDir } = await fixture(t);
  await writeFile(join(sessionsDir, filename(ROOT)), meta(ROOT) + usage(ROOT, 'parent-conflict-root', 1, 1));
  await writeFile(join(sessionsDir, filename(CHILD)), [
    meta(CHILD, ROOT, {
      parent_thread_id: ROOT,
      source: { subagent: { thread_spawn: { parent_thread_id: OTHER } } },
    }),
    usage(CHILD, 'parent-conflict-child', 2, 1, ROOT),
  ].join('\n'));
  const summary = createSummary(sessionsDir, archivedDir);
  t.after(() => summary.stop());
  await settle(summary, 200, ROOT);
  const value = summary.snapshot({ taskId: ROOT });
  assert.equal(value.overall.usage.totalTokens, 5);
  assert.equal(value.overall.state, 'partial');
  assert.equal(value.overall.reason, 'ownership_unverified');
  assert.equal(value.selected.usage.totalTokens, 2);
  assert.equal(value.selected.state, 'partial');
  assert.equal(value.selected.reason, 'ownership_unverified');
});

test('dual UUID filenames attribute verified child usage to the conversation', async (t) => {
  const { sessionsDir, archivedDir } = await fixture(t);
  await writeFile(join(sessionsDir, filename(ROOT)), meta(ROOT) + usage(ROOT, 'dual-root', 1, 1));
  await writeFile(join(sessionsDir, dualFilename(ROOT, CHILD)), [
    meta(CHILD, ROOT, { parent_thread_id: ROOT }),
    usage(CHILD, 'dual-child', 3, 1, ROOT),
  ].join('\n'));
  const summary = createSummary(sessionsDir, archivedDir);
  t.after(() => summary.stop());
  await settle(summary, 200, ROOT);
  const value = summary.snapshot({ taskId: ROOT });
  for (const block of [value.overall, value.selected]) {
    assert.equal(block.state, 'available');
    assert.equal(block.usage.totalTokens, 6);
  }
  assert.equal(value.overall.coverage.complete, true);
});

test('explicit child metadata is supported while undeclared ownership stays unresolved', async (t) => {
  const { sessionsDir, archivedDir } = await fixture(t);
  await writeFile(join(sessionsDir, filename(ROOT)), meta(ROOT));
  await writeFile(join(sessionsDir, filename(CHILD)), [
    meta(CHILD, CHILD, { parent_thread_id: ROOT }),
    usage(CHILD, 'independent', 5, 2, CHILD),
  ].join('\n'));
  await writeFile(join(sessionsDir, filename(GRANDCHILD)), [
    meta(GRANDCHILD, ROOT),
    usage(GRANDCHILD, 'standalone', 7, 1, ROOT),
  ].join('\n'));
  const summary = createSummary(sessionsDir, archivedDir);
  t.after(() => summary.stop());
  await settle(summary, 200, ROOT);
  const value = summary.snapshot({ taskId: ROOT });
  assert.equal(value.overall.usage.totalTokens, 15);
  assert.equal(value.overall.state, 'partial');
  assert.equal(value.overall.reason, 'ownership_unverified');
  assert.equal(value.selected.usage.totalTokens, 7);
  assert.equal(value.selected.state, 'partial');
  assert.equal(value.selected.reason, 'ownership_unverified');
});

test('child rows in a root-owned file cannot impersonate the child', async (t) => {
  const { sessionsDir, archivedDir } = await fixture(t);
  await writeFile(join(sessionsDir, filename(ROOT)), [
    meta(ROOT),
    usage(CHILD, 'misowned', 10, 5, ROOT),
  ].join('\n'));
  await writeFile(join(sessionsDir, filename(OTHER)), meta(OTHER) + usage(OTHER, 'known-overall', 2, 1));
  const summary = createSummary(sessionsDir, archivedDir);
  t.after(() => summary.stop());
  await settle(summary, 200, CHILD);
  const value = summary.snapshot({ taskId: CHILD });
  assert.equal(value.overall.usage.totalTokens, 3);
  assert.equal(value.overall.state, 'partial');
  assert.equal(value.overall.reason, 'invalid_usage');
  assert.equal(value.overall.coverage.invalidResponses, 1);
  assert.equal(value.selected.state, 'unavailable');
  assert.equal(value.selected.usage, null);
});

test('selected-only unknown ownership publishes a null partial block', async (t) => {
  const { sessionsDir, archivedDir } = await fixture(t);
  await writeFile(join(sessionsDir, filename(ROOT)), meta(ROOT));
  await writeFile(join(sessionsDir, filename(CHILD)), [
    meta(CHILD, ROOT),
    usage(CHILD, 'unknown-selected', 10, 5, ROOT),
  ].join('\n'));
  await writeFile(join(sessionsDir, filename(OTHER)), meta(OTHER) + usage(OTHER, 'known-overall', 2, 1));
  const summary = createSummary(sessionsDir, archivedDir);
  t.after(() => summary.stop());
  await settle(summary, 200, ROOT);
  const value = summary.snapshot({ taskId: ROOT });
  assert.equal(value.overall.usage.totalTokens, 18);
  assert.equal(value.overall.state, 'partial');
  assert.equal(value.overall.reason, 'ownership_unverified');
  assert.equal(value.selected.state, 'partial');
  assert.equal(value.selected.reason, 'ownership_unverified');
  assert.equal(value.selected.usage, null);
  assert.equal(value.selected.coverage.complete, false);
});

test('legacy-only, invalid and overflowing records remain explicit gaps', async (t) => {
  const { sessionsDir, archivedDir } = await fixture(t);
  const legacy = event('token_usage_record', {
    thread_id: OTHER,
    session_id: OTHER,
    response_id: 'legacy',
    turn_token_usage: { input_tokens: 50, output_tokens: 50, total_tokens: 100 },
  });
  const invalid = event('token_usage_record', {
    thread_id: OTHER,
    session_id: OTHER,
    response_id: 'invalid',
    usage: { input_tokens: 2, output_tokens: 1, total_tokens: 99 },
  });
  await writeFile(join(sessionsDir, filename(OTHER)), meta(OTHER) + legacy + invalid);
  const summary = createSummary(sessionsDir, archivedDir);
  t.after(() => summary.stop());
  await settle(summary);
  const value = summary.snapshot().overall;
  assert.equal(value.usage, null);
  assert.equal(value.state, 'unavailable');
  assert.equal(value.reason, 'invalid_usage');
  assert.equal(value.coverage.legacyOnlyConversations, 1);
  assert.equal(value.coverage.invalidResponses, 1);
  assert.equal(value.timeline, null);

  const overflowResponse = 'overflow';
  await writeFile(join(sessionsDir, filename(ROOT)), meta(ROOT) + usage(ROOT, overflowResponse, 1, 1));
  const overflow = createSummary(sessionsDir, archivedDir, { limits: { maxResponses: 1 } });
  t.after(() => overflow.stop());
  await settle(overflow, 200, ROOT);
  const overflowValue = overflow.snapshot({ taskId: ROOT });
  assert.equal(overflowValue.overall.reason, 'budget_exceeded');
  assert.equal(overflowValue.selected.state, 'partial');
  assert.equal(overflowValue.selected.reason, 'budget_exceeded');
});

test('aggregate overflow of individually safe responses clears exact values', async (t) => {
  const { sessionsDir, archivedDir } = await fixture(t);
  await writeFile(join(sessionsDir, filename(ROOT)), [
    meta(ROOT),
    usage(ROOT, 'safe-max', Number.MAX_SAFE_INTEGER, 0),
    usage(ROOT, 'safe-unit', 1, 0),
  ].join('\n'));
  const summary = createSummary(sessionsDir, archivedDir);
  t.after(() => summary.stop());
  await settle(summary, 200, ROOT);
  const value = summary.snapshot({ taskId: ROOT });
  for (const block of [value.overall, value.selected]) {
    assert.equal(block.state, 'partial');
    assert.equal(block.reason, 'invalid_usage');
    assert.equal(block.usage, null);
    assert.equal(block.coverage.complete, false);
  }
  assert.equal(value.overall.timeline, null);
  assert.equal(Object.hasOwn(value.selected, 'timeline'), false);
});

test('conflicting response identities revoke one response only once', async (t) => {
  const { sessionsDir, archivedDir } = await fixture(t);
  await writeFile(join(sessionsDir, filename(ROOT)), [
    meta(ROOT),
    usage(ROOT, 'duplicate', 4, 2),
    usage(ROOT, 'duplicate', 9, 1),
    usage(ROOT, 'safe', 3, 3),
  ].join('\n'));
  const summary = createSummary(sessionsDir, archivedDir);
  t.after(() => summary.stop());
  await settle(summary);
  const value = summary.snapshot().overall;
  assert.equal(value.usage.totalTokens, 6);
  assert.equal(value.coverage.conflictingResponses, 1);
  assert.equal(value.state, 'partial');
  assert.equal(value.reason, 'identity_conflict');
  checkTimeline(value.timeline);
  for (const range of value.timeline.ranges) {
    assert.equal(range.usage.totalTokens, 6);
    assert.equal(range.responsesCounted, 1);
  }
});

test('conflicting variants and invalid records share the bounded response budget', async (t) => {
  const { sessionsDir, archivedDir } = await fixture(t);
  await writeFile(join(sessionsDir, filename(ROOT)), [
    meta(ROOT),
    usage(ROOT, 'many-variants', 1, 0),
    usage(ROOT, 'many-variants', 2, 0),
    usage(ROOT, 'many-variants', 3, 0),
    '{"timestamp":"2026-10-17T00:00:00.000Z","type":"token_usage_record","payload":{"usage":null}}\n',
    '{"timestamp":"2026-10-17T00:00:00.000Z","type":"token_usage_record","payload":{"usage":null}}\n',
  ].join('\n'));
  const summary = createSummary(sessionsDir, archivedDir, { limits: { maxResponses: 3 } });
  t.after(() => summary.stop());
  await settle(summary);
  const value = summary.snapshot().overall;
  assert.equal(value.state, 'partial');
  assert.equal(value.reason, 'budget_exceeded');
  assert.equal(value.usage, null);
  assert.equal(value.coverage.complete, false);
});

test('anonymous invalid records consume the bounded response budget', async (t) => {
  const { sessionsDir, archivedDir } = await fixture(t);
  await writeFile(join(sessionsDir, filename(ROOT)), [
    meta(ROOT),
    usage(ROOT, 'valid-before-invalid-budget', 10, 3),
    '{"timestamp":"2026-10-17T00:00:00.000Z","type":"token_usage_record","payload":{"usage":null}}\n',
    '{"timestamp":"2026-10-17T00:00:00.000Z","type":"token_usage_record","payload":{"usage":null}}\n',
  ].join('\n'));
  const summary = createSummary(sessionsDir, archivedDir, { limits: { maxResponses: 3 } });
  t.after(() => summary.stop());
  await settle(summary);
  const value = summary.snapshot().overall;
  assert.equal(value.state, 'partial');
  assert.equal(value.reason, 'budget_exceeded');
  assert.equal(value.usage.totalTokens, 13);
  assert.equal(value.coverage.invalidResponses, 1);
  assert.equal(value.coverage.complete, false);
});

test('a failed new response is rolled back before spending variance budget', async (t) => {
  const { sessionsDir, archivedDir } = await fixture(t);
  await writeFile(join(sessionsDir, filename(ROOT)), meta(ROOT) + usage(ROOT, 'one-response', 1, 1));
  const summary = createSummary(sessionsDir, archivedDir, { limits: { maxResponses: 1 } });
  t.after(() => summary.stop());
  await settle(summary);
  const value = summary.snapshot().overall;
  assert.equal(value.reason, 'budget_exceeded');
  assert.equal(value.coverage.complete, false);
});

test('plain decoded-byte limits stop with a partial budget result', async (t) => {
  const { sessionsDir, archivedDir } = await fixture(t);
  const rows = meta(ROOT) + usage(ROOT, 'byte-budget', 10, 5);
  await writeFile(join(sessionsDir, filename(ROOT)), rows);
  const summary = createSummary(sessionsDir, archivedDir, {
    limits: { maxDecodedBytes: Buffer.byteLength(meta(ROOT)) + 8 },
  });
  t.after(() => summary.stop());
  await settle(summary);
  const value = summary.snapshot().overall;
  assert.equal(value.state, 'partial');
  assert.equal(value.reason, 'budget_exceeded');
  assert.equal(value.usage, null);
  assert.equal(value.coverage.complete, false);
});

test('a root path that is an ordinary file reports read_failed', async (t) => {
  const { sessionsDir, archivedDir } = await fixture(t);
  await rm(sessionsDir, { recursive: true });
  await writeFile(sessionsDir, 'not-a-directory');
  const summary = createSummary(sessionsDir, archivedDir);
  t.after(() => summary.stop());
  await settle(summary, 20, ROOT);
  const value = summary.snapshot({ taskId: ROOT });
  assert.equal(value.overall.state, 'unavailable');
  assert.equal(value.overall.reason, 'read_failed');
  assert.equal(value.selected.state, 'unavailable');
  assert.equal(value.selected.reason, 'read_failed');
});

test('a file replaced by a directory is dropped from discovery on the next round', async (t) => {
  const { sessionsDir, archivedDir } = await fixture(t);
  const path = join(sessionsDir, filename(ROOT));
  await writeFile(join(sessionsDir, filename(OTHER)), meta(OTHER) + usage(OTHER, 'stable', 2, 1));
  await writeFile(path, meta(ROOT) + usage(ROOT, 'vanishing', 1, 1));
  const summary = createSummary(sessionsDir, archivedDir);
  t.after(() => summary.stop());
  await settle(summary);
  await rm(path);
  await mkdir(path);
  await settle(summary);
  const value = summary.snapshot({ taskId: ROOT });
  assert.equal(value.overall.coverage.discoveredFiles, 1);
  assert.equal(value.overall.usage.totalTokens, 3);
  assert.equal(value.selected.state, 'loading');
  await summary.stop();
});

test('a missing file does not retry forever before the next discovery', async (t) => {
  const { sessionsDir, archivedDir } = await fixture(t);
  const path = join(sessionsDir, filename(ROOT));
  await writeFile(path, meta(ROOT) + usage(ROOT, 'missing-after-prefix', 10, 5));
  const summary = createSummary(sessionsDir, archivedDir, {
    roundBytes: 32,
    discoveryIntervalMs: 60_000,
  });
  t.after(() => summary.stop());
  await summary.runOnce({ discover: true });
  assert.equal(summary.snapshot().overall.coverage.pendingFiles, 1);
  await rm(path);
  await summary.runOnce();
  const value = summary.snapshot().overall;
  assert.equal(value.state, 'unavailable');
  assert.equal(value.reason, 'read_failed');
  assert.equal(value.coverage.failedFiles, 1);
  assert.equal(value.coverage.pendingFiles, 0);
  await summary.stop();
});

test('invalid and valid variants of one response conflict without counting invalid usage', async (t) => {
  const { sessionsDir, archivedDir } = await fixture(t);
  await writeFile(join(sessionsDir, filename(ROOT)), [
    meta(ROOT),
    usage(ROOT, 'mixed', 2, 2),
    event('token_usage_record', {
      thread_id: ROOT, session_id: ROOT, response_id: 'mixed',
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 7 },
    }),
  ].join('\n'));
  const summary = createSummary(sessionsDir, archivedDir);
  t.after(() => summary.stop());
  await settle(summary);
  const value = summary.snapshot().overall;
  assert.equal(value.coverage.conflictingResponses, 1);
  assert.equal(value.usage, null);
});

test('unknown ownership remains in overall but never leaks into selected usage', async (t) => {
  const { sessionsDir, archivedDir } = await fixture(t);
  await writeFile(join(sessionsDir, filename(ROOT)), meta(ROOT) + usage(ROOT, 'root', 1, 1));
  await writeFile(join(sessionsDir, filename(CHILD)), [
    meta(CHILD, ROOT),
    usage(CHILD, 'unknown', 10, 10, ROOT),
  ].join('\n'));
  const summary = createSummary(sessionsDir, archivedDir);
  t.after(() => summary.stop());
  await settle(summary, 200, ROOT);
  const overall = summary.snapshot().overall;
  assert.equal(overall.usage.totalTokens, 22);
  assert.equal(overall.state, 'partial');
  assert.equal(overall.reason, 'ownership_unverified');
  assert.equal(overall.coverage.complete, false);
  const selected = summary.snapshot({ taskId: ROOT }).selected;
  // Selecting ROOT after the default snapshot starts a new bounded publication;
  // it must not reuse the previous overall scan's selected block.
  await settle(summary, 200, ROOT);
  const published = summary.snapshot({ taskId: ROOT }).selected;
  assert.equal(selected.state, 'loading');
  assert.equal(published.state, 'partial');
  assert.equal(published.reason, 'ownership_unverified');
  assert.equal(published.usage.totalTokens, 2);
});

test('append, replacement, truncation and deletion revoke or add contributions', async (t) => {
  const { sessionsDir, archivedDir } = await fixture(t);
  const path = join(sessionsDir, filename(ROOT));
  await writeFile(path, meta(ROOT) + usage(ROOT, 'first', 1, 1));
  const summary = createSummary(sessionsDir, archivedDir);
  t.after(() => summary.stop());
  await settle(summary);
  assert.equal(summary.snapshot().overall.usage.totalTokens, 2);
  await appendFile(path, usage(ROOT, 'second', 2, 2));
  await settle(summary);
  assert.equal(summary.snapshot().overall.usage.totalTokens, 6);
  await writeFile(path, meta(ROOT) + usage(ROOT, 'replacement', 5, 5));
  await settle(summary);
  assert.equal(summary.snapshot().overall.usage.totalTokens, 10);
  await truncate(path, 0);
  await settle(summary);
  assert.equal(summary.snapshot().overall.usage, null);
  await rm(path);
  await settle(summary);
  assert.equal(summary.snapshot().overall.coverage.discoveredFiles, 0);
});

test('split lines and selected task not found do not invalidate overall', async (t) => {
  const { sessionsDir, archivedDir } = await fixture(t);
  const data = Buffer.from(meta(ROOT) + usage(ROOT, 'split', 4, 1));
  await writeFile(join(sessionsDir, filename(ROOT)), data);
  const summary = createSummary(sessionsDir, archivedDir);
  t.after(() => summary.stop());
  await settle(summary, 200, OTHER);
  // Requesting a new selection publishes a loading block until the background
  // round has scanned it.
  const value = summary.snapshot({ taskId: OTHER });
  assert.equal(value.overall.usage.totalTokens, 5);
  assert.equal(value.overall.state, 'available');
  assert.equal(value.overall.coverage.complete, true);
  assert.equal(value.selected.state, 'unavailable');
  assert.equal(value.selected.reason, 'task_not_found');
  assert.equal(value.selected.coverage.complete, false);
});

test('an unfinished pending file keeps an unknown selection loading', async (t) => {
  const { sessionsDir, archivedDir } = await fixture(t);
  await writeFile(join(sessionsDir, filename(ROOT)), meta(ROOT) + usage(ROOT, 'pending', 4, 1));
  const summary = createSummary(sessionsDir, archivedDir);
  t.after(() => summary.stop());
  await summary.runOnce();
  const value = summary.snapshot({ taskId: OTHER });
  assert.equal(value.overall.state, 'loading');
  assert.equal(value.overall.timeline, null);
  assert.equal(value.overall.coverage.pendingFiles, 1);
  assert.equal(value.selected.state, 'loading');
  assert.equal(value.selected.reason, 'scan_in_progress');
  await summary.stop();
});

test('a selected root exposes pending and failed child files as incomplete', async (t) => {
  const { sessionsDir, archivedDir } = await fixture(t);
  await writeFile(join(sessionsDir, filename(ROOT)), meta(ROOT) + usage(ROOT, 'root', 2, 1));
  const summary = createSummary(sessionsDir, archivedDir);
  t.after(() => summary.stop());
  await settle(summary, 20);

  await writeFile(join(sessionsDir, dualFilename(ROOT, CHILD)), meta(CHILD, ROOT, { parent_thread_id: ROOT }) + usage(CHILD, 'pending-child', 4, 2, ROOT));
  summary.snapshot({ taskId: ROOT });
  await summary.runOnce();
  const pending = summary.snapshot({ taskId: ROOT }).selected;
  assert.equal(pending.coverage.pendingFiles, 1);
  assert.equal(pending.coverage.complete, false);
  assert.notEqual(pending.state, 'available');

  const failedPath = join(sessionsDir, dualFilename(ROOT, GRANDCHILD));
  await writeFile(failedPath, meta(GRANDCHILD, ROOT, { parent_thread_id: ROOT }) + '{"broken"\n');
  await settle(summary, 20, ROOT);
  const failed = summary.snapshot({ taskId: ROOT }).selected;
  assert.equal(failed.coverage.failedFiles, 1);
  assert.equal(failed.coverage.complete, false);
  assert.equal(failed.state, 'partial');
  assert.equal(failed.reason, 'read_failed');
});

test('a selected root never publishes available while an independent child is unresolved', async (t) => {
  const { sessionsDir, archivedDir } = await fixture(t);
  await writeFile(join(sessionsDir, filename(ROOT)), meta(ROOT) + usage(ROOT, 'root', 2, 1));
  const summary = createSummary(sessionsDir, archivedDir);
  t.after(() => summary.stop());
  await settle(summary, 20, ROOT);
  assert.equal(summary.snapshot({ taskId: ROOT }).selected.state, 'available');

  const pendingPath = join(sessionsDir, filename(CHILD));
  await writeFile(pendingPath, meta(CHILD, CHILD, {
    parent_thread_id: ROOT,
    padding: 'x'.repeat(256),
  }) + usage(CHILD, 'pending-independent-child', 4, 2, CHILD));
  await summary.runOnce();
  const pending = summary.snapshot({ taskId: ROOT });
  assert.equal(pending.overall.coverage.pendingFiles, 1);
  assert.notEqual(pending.selected.state, 'available');
  assert.equal(pending.selected.coverage.complete, false);

  await rm(pendingPath);
  const failedPath = join(sessionsDir, filename(GRANDCHILD));
  await writeFile(failedPath, meta(GRANDCHILD, GRANDCHILD, {
    parent_thread_id: ROOT,
  }) + '{"broken"\n');
  await settle(summary, 20, ROOT);
  const failed = summary.snapshot({ taskId: ROOT });
  assert.equal(failed.overall.coverage.failedFiles, 1);
  assert.notEqual(failed.selected.state, 'available');
  assert.equal(failed.selected.coverage.complete, false);

  const repairedPath = join(sessionsDir, filename(CHILD));
  await writeFile(repairedPath, meta(CHILD, CHILD, {
    parent_thread_id: ROOT,
  }) + usage(CHILD, 'repaired-independent-child', 4, 2, CHILD));
  await rm(failedPath);
  await settle(summary, 50, ROOT);
  const repaired = summary.snapshot({ taskId: ROOT });
  assert.equal(repaired.overall.state, 'available');
  assert.equal(repaired.selected.state, 'available');
  assert.equal(repaired.selected.coverage.complete, true);
  assert.equal(repaired.selected.usage.totalTokens, 9);
});

test('an uninspected compressed child keeps a selected root incomplete', async (t) => {
  const { sessionsDir, archivedDir } = await fixture(t);
  await writeFile(join(sessionsDir, filename(ROOT)), meta(ROOT) + usage(ROOT, 'root', 2, 1));
  await writeFile(join(archivedDir, filename(CHILD, true)), meta(CHILD, CHILD, {
    parent_thread_id: ROOT,
  }) + usage(CHILD, 'compressed-independent-child', 4, 2, CHILD));
  const summary = createSummary(sessionsDir, archivedDir, { zstdFactory: null });
  t.after(() => summary.stop());
  await settle(summary, 50, ROOT);
  const value = summary.snapshot({ taskId: ROOT });
  assert.equal(value.overall.coverage.excludedFiles, 1);
  assert.equal(value.overall.state, 'partial');
  assert.equal(value.overall.reason, 'compressed_unsupported');
  assert.equal(value.overall.coverage.complete, false);
  assert.equal(value.selected.state, 'partial');
  assert.equal(value.selected.reason, 'compressed_unsupported');
  assert.equal(value.selected.coverage.complete, false);
});

test('a malformed tail recovers only after its observed revision changes', async (t) => {
  const { sessionsDir, archivedDir } = await fixture(t);
  const path = join(sessionsDir, filename(ROOT));
  await writeFile(path, meta(ROOT) + '{"broken"\n');
  const summary = createSummary(sessionsDir, archivedDir);
  t.after(() => summary.stop());
  await settle(summary);
  const failed = summary.snapshot().overall;
  assert.equal(failed.state, 'unavailable');
  assert.equal(failed.reason, 'read_failed');
  assert.equal(failed.coverage.failedFiles, 1);
  assert.equal(failed.coverage.complete, false);

  await settle(summary, 20, OTHER);
  const missing = summary.snapshot({ taskId: OTHER }).selected;
  assert.equal(missing.state, 'unavailable');
  assert.equal(missing.reason, 'read_failed');
  assert.equal(missing.coverage.complete, false);

  await writeFile(path, meta(ROOT) + usage(ROOT, 'recovered', 3, 2));
  await settle(summary);
  const recovered = summary.snapshot().overall;
  assert.equal(recovered.state, 'available');
  assert.equal(recovered.reason, null);
  assert.equal(recovered.usage.totalTokens, 5);
  assert.equal(recovered.coverage.complete, true);
});

test('real zstd fixtures decode incrementally and append after EOF', {
  skip: !HAS_ZSTD && 'Node runtime has no built-in zstd stream API',
}, async (t) => {
  const { sessionsDir, archivedDir } = await fixture(t);
  const first = meta(ROOT) + usage(ROOT, 'z1', 2, 1);
  const second = usage(ROOT, 'z2', 3, 2);
  await pipeline(Readable.from([first]), zlib.createZstdCompress(), createWriteStream(join(archivedDir, filename(ROOT, true))));
  const summary = createSummary(sessionsDir, archivedDir, {
    chunkBytes: 64,
    roundBytes: 64 * 1024,
  });
  t.after(() => summary.stop());
  await settle(summary, 30);
  assert.equal(summary.snapshot().overall.usage.totalTokens, 3);
  await pipeline(Readable.from([second]), zlib.createZstdCompress(), createWriteStream(join(archivedDir, filename(ROOT, true)), { flags: 'a' }));
  await settle(summary, 30);
  assert.equal(summary.snapshot().overall.usage.totalTokens, 8);
});

test('compressed files report compressed_unsupported without a zstd decoder', async (t) => {
  const { sessionsDir, archivedDir } = await fixture(t);
  await writeFile(join(archivedDir, filename(ROOT, true)), Buffer.from('not-a-zstd-stream'));
  const summary = createSummary(sessionsDir, archivedDir, { zstdFactory: null });
  t.after(() => summary.stop());
  await settle(summary, 20, ROOT);
  const value = summary.snapshot({ taskId: ROOT });
  assert.equal(value.overall.state, 'unavailable');
  assert.equal(value.overall.reason, 'compressed_unsupported');
  assert.equal(value.overall.coverage.excludedFiles, 1);
  assert.equal(value.overall.coverage.complete, false);
  assert.equal(value.selected.state, 'unavailable');
  assert.equal(value.selected.reason, 'compressed_unsupported');
  assert.equal(value.selected.coverage.complete, false);
  await settle(summary, 20, OTHER);
  const missing = summary.snapshot({ taskId: OTHER });
  assert.equal(missing.selected.state, 'unavailable');
  assert.equal(missing.selected.reason, 'compressed_unsupported');
  assert.equal(missing.selected.coverage.complete, false);
});

test('compressed decoded-byte limits stop a high-ratio stream', {
  skip: !HAS_ZSTD && 'Node runtime has no built-in zstd stream API',
}, async (t) => {
  const { sessionsDir, archivedDir } = await fixture(t);
  const rows = meta(ROOT) + usage(ROOT, 'compressed-budget', 10, 5);
  await pipeline(
    Readable.from([rows]),
    zlib.createZstdCompress(),
    createWriteStream(join(archivedDir, filename(ROOT, true))),
  );
  const summary = createSummary(sessionsDir, archivedDir, {
    limits: { maxCompressedDecodedBytes: 8 },
  });
  t.after(() => summary.stop());
  await settle(summary);
  const value = summary.snapshot().overall;
  assert.equal(value.state, 'partial');
  assert.equal(value.reason, 'budget_exceeded');
  assert.equal(value.coverage.complete, false);
});

test('public projection is an allowlist and never exposes identities or paths', () => {
  const value = publicUsageSnapshot({
    sampledAt: '2026-10-17T00:00:00.000Z',
    overall: {
      state: 'partial', reason: 'invalid_usage', scope: 'local_all',
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      coverage: {
        discoveredFiles: 1, completeFiles: 1, pendingFiles: 0, excludedFiles: 0,
        failedFiles: 0, responsesCounted: 1, conversationsCounted: 1,
        subagentThreadsCounted: 0, legacyOnlyConversations: 0, duplicateResponses: 0,
        conflictingResponses: 0, invalidResponses: 0, complete: false,
        path: 'C:\\secret', responseId: 'secret-response',
      },
      updatedAt: '2026-10-17T00:00:00.000Z',
      transcript: 'private', path: 'C:\\secret',
    },
    selected: null,
  });
  assert.deepEqual(Object.keys(value), ['sampledAt', 'overall', 'selected']);
  assert.deepEqual(Object.keys(value.overall), ['state', 'reason', 'scope', 'usage', 'coverage', 'updatedAt']);
  assert.equal(value.overall.coverage.path, undefined);
  assert.equal(value.overall.coverage.responseId, undefined);
  assert.equal(value.overall.transcript, undefined);
});

test('stale published available and partial snapshots clear exact usage', async (t) => {
  const { sessionsDir, archivedDir } = await fixture(t);
  const path = join(sessionsDir, filename(ROOT));
  await writeFile(path, meta(ROOT) + usage(ROOT, 'stale-available', 1, 1));
  let now = 0;
  const summary = createSummary(sessionsDir, archivedDir, {
    monotonicClock: () => now,
    staleMs: 100,
  });
  t.after(() => summary.stop());

  await settle(summary, 200, ROOT);
  const available = summary.snapshot({ taskId: ROOT });
  assert.equal(available.overall.state, 'available');
  assert.equal(available.selected.state, 'available');
  checkTimeline(available.overall.timeline);

  now = 101;
  const staleAvailable = summary.snapshot({ taskId: ROOT });
  for (const block of [staleAvailable.overall, staleAvailable.selected]) {
    assert.equal(block.state, 'unavailable');
    assert.equal(block.reason, 'snapshot_stale');
    assert.equal(block.usage, null);
    assert.equal(block.updatedAt, null);
  }
  assert.equal(staleAvailable.overall.timeline, null);
  assert.equal(Object.hasOwn(staleAvailable.selected, 'timeline'), false);

  await appendFile(path, event('token_usage_record', {
    thread_id: ROOT,
    session_id: ROOT,
    response_id: 'stale-invalid',
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 9 },
  }));
  now = 201;
  await settle(summary, 200, ROOT);
  const partial = summary.snapshot({ taskId: ROOT });
  assert.equal(partial.overall.state, 'partial');
  assert.equal(partial.overall.reason, 'invalid_usage');
  assert.equal(partial.selected.state, 'partial');
  assert.equal(partial.selected.reason, 'invalid_usage');
  assert.equal(partial.overall.usage.totalTokens, 2);
  checkTimeline(partial.overall.timeline);

  now = 302;
  const stalePartial = summary.snapshot({ taskId: ROOT });
  for (const block of [stalePartial.overall, stalePartial.selected]) {
    assert.equal(block.state, 'unavailable');
    assert.equal(block.reason, 'snapshot_stale');
    assert.equal(block.usage, null);
    assert.equal(block.updatedAt, null);
  }
  assert.equal(stalePartial.overall.timeline, null);

  // Expiry is distinct from the terminal stop state.
  await summary.stop();
  const stopped = summary.snapshot({ taskId: ROOT });
  assert.equal(stopped.overall.reason, 'scan_interrupted');
  assert.equal(stopped.selected.reason, 'scan_interrupted');
  assert.equal(stopped.overall.timeline, null);
});

test('stopping invalidates published and empty snapshots with scan_interrupted', async (t) => {
  const { sessionsDir, archivedDir } = await fixture(t);
  await writeFile(join(sessionsDir, filename(ROOT)), meta(ROOT) + usage(ROOT, 'stop', 1, 1));
  const summary = createSummary(sessionsDir, archivedDir);
  t.after(() => summary.stop());
  assert.equal(summary.snapshot().overall.timeline, null);
  await summary.start();
  await settle(summary, 200, ROOT);

  const before = summary.snapshot({ taskId: ROOT });
  assert.equal(before.overall.state, 'available');
  assert.equal(before.selected.state, 'available');
  checkTimeline(before.overall.timeline);
  await summary.stop();

  const after = summary.snapshot({ taskId: ROOT });
  for (const block of [after.overall, after.selected]) {
    assert.equal(block.state, 'unavailable');
    assert.equal(block.reason, 'scan_interrupted');
    assert.equal(block.usage, null);
  }
  assert.equal(after.overall.timeline, null);
  assert.equal(Object.hasOwn(after.selected, 'timeline'), false);
});

test('same-inode growth replaces the previously read prefix', async (t) => {
  const { sessionsDir, archivedDir } = await fixture(t);
  const path = join(sessionsDir, filename(ROOT));
  const original = meta(ROOT) + usage(ROOT, 'rewrite-old', 8, 1) + usage(ROOT, 'rewrite-old-tail', 0, 0);
  const replacement = meta(ROOT)
    + usage(ROOT, 'rewrite-new', 7, 1)
    + usage(ROOT, 'rewrite-old-tail', 0, 0)
    + usage(ROOT, 'rewrite-c', 8, 1);
  assert.equal(Buffer.byteLength(usage(ROOT, 'rewrite-old', 8, 1)), Buffer.byteLength(usage(ROOT, 'rewrite-new', 7, 1)));
  assert.equal(
    Buffer.byteLength(meta(ROOT) + usage(ROOT, 'rewrite-new', 7, 1) + usage(ROOT, 'rewrite-old-tail', 0, 0)),
    Buffer.byteLength(meta(ROOT) + usage(ROOT, 'rewrite-old', 8, 1) + usage(ROOT, 'rewrite-old-tail', 0, 0)),
  );
  assert.ok(Buffer.byteLength(replacement) > Buffer.byteLength(original));
  await writeFile(path, original);
  const summary = createSummary(sessionsDir, archivedDir);
  t.after(() => summary.stop());
  await settle(summary, 200, ROOT);
  assert.equal(summary.snapshot({ taskId: ROOT }).selected.usage.totalTokens, 9);

  const before = await stat(path);
  const handle = await open(path, 'r+');
  try {
    await handle.writeFile(replacement);
  } finally {
    await handle.close();
  }
  const after = await stat(path);
  assert.equal(after.ino, before.ino, 'fixture must replace bytes without replacing the file identity');

  await settle(summary, 200, ROOT);
  const value = summary.snapshot({ taskId: ROOT });
  for (const block of [value.overall, value.selected]) {
    assert.equal(block.state, 'available');
    assert.equal(block.reason, null);
    assert.equal(block.usage.totalTokens, 17);
    assert.equal(block.coverage.responsesCounted, 3);
    assert.equal(block.coverage.complete, true);
  }
});

test('plain same-inode append refunds the replaced revision before replay', async (t) => {
  const { sessionsDir, archivedDir } = await fixture(t);
  const path = join(sessionsDir, filename(ROOT));
  const original = meta(ROOT) + usage(ROOT, 'budget-old', 1, 1);
  const appended = usage(ROOT, 'budget-new', 2, 2);
  const finalRows = original + appended;
  const cap = 800;
  assert.ok(Buffer.byteLength(finalRows) < cap);
  assert.ok(Buffer.byteLength(original) + Buffer.byteLength(finalRows) > cap);
  await writeFile(path, original);
  const summary = createSummary(sessionsDir, archivedDir, {
    limits: { maxDecodedBytes: cap },
  });
  t.after(() => summary.stop());
  await settle(summary, 200, ROOT);
  assert.equal(summary.snapshot({ taskId: ROOT }).selected.usage.totalTokens, 2);

  const before = await stat(path);
  await appendFile(path, appended);
  const after = await stat(path);
  assert.equal(after.ino, before.ino, 'fixture must append without replacing the file identity');

  await settle(summary, 200, ROOT);
  const value = summary.snapshot({ taskId: ROOT });
  for (const block of [value.overall, value.selected]) {
    assert.equal(block.state, 'available');
    assert.equal(block.reason, null);
    assert.equal(block.usage.totalTokens, 6);
    assert.equal(block.coverage.responsesCounted, 2);
    assert.equal(block.coverage.complete, true);
  }
});

test('repeated same-inode growth replays within the final decoded-byte size', async (t) => {
  const { sessionsDir, archivedDir } = await fixture(t);
  const path = join(sessionsDir, filename(ROOT));
  const first = meta(ROOT) + usage(ROOT, 'growth-a', 1, 0);
  const second = first + usage(ROOT, 'growth-b', 2, 0);
  const finalRows = second + usage(ROOT, 'growth-c', 3, 0);
  assert.ok(Buffer.byteLength(first) < Buffer.byteLength(second));
  assert.ok(Buffer.byteLength(second) < Buffer.byteLength(finalRows));
  assert.ok(Buffer.byteLength(first) + Buffer.byteLength(second) > Buffer.byteLength(finalRows));

  await writeFile(path, first);
  const summary = createSummary(sessionsDir, archivedDir, {
    limits: { maxDecodedBytes: Buffer.byteLength(finalRows) },
  });
  t.after(() => summary.stop());
  const before = await stat(path);
  await settle(summary, 200, ROOT);
  assert.equal(summary.snapshot({ taskId: ROOT }).selected.usage.totalTokens, 1);

  const handle = await open(path, 'r+');
  try {
    await handle.writeFile(second);
  } finally {
    await handle.close();
  }
  assert.equal((await stat(path)).ino, before.ino);
  await settle(summary, 200, ROOT);
  assert.equal(summary.snapshot({ taskId: ROOT }).selected.usage.totalTokens, 3);

  const rewrite = await open(path, 'r+');
  try {
    await rewrite.writeFile(finalRows);
  } finally {
    await rewrite.close();
  }
  assert.equal((await stat(path)).ino, before.ino);
  await settle(summary, 200, ROOT);
  const value = summary.snapshot({ taskId: ROOT });
  for (const block of [value.overall, value.selected]) {
    assert.equal(block.state, 'available');
    assert.equal(block.usage.totalTokens, 6);
    assert.equal(block.coverage.responsesCounted, 3);
    assert.equal(block.coverage.complete, true);
  }
});

test('decoded-byte accounting refunds a deleted revision at the exact cap', async (t) => {
  const { sessionsDir, archivedDir } = await fixture(t);
  const path = join(sessionsDir, filename(ROOT));
  const first = meta(ROOT) + usage(ROOT, 'reuse-a', 1, 1);
  const replacement = meta(ROOT) + usage(ROOT, 'reuse-b', 3, 3);
  assert.equal(Buffer.byteLength(replacement), Buffer.byteLength(first));
  await writeFile(path, first);
  const summary = createSummary(sessionsDir, archivedDir, {
    limits: { maxDecodedBytes: Buffer.byteLength(first) },
  });
  t.after(() => summary.stop());
  await settle(summary, 200, ROOT);
  assert.equal(summary.snapshot({ taskId: ROOT }).selected.usage.totalTokens, 2);

  await rm(path);
  await settle(summary, 200, ROOT);
  assert.equal(summary.snapshot().overall.coverage.discoveredFiles, 0);

  await writeFile(path, replacement);
  await settle(summary, 200, ROOT);
  const value = summary.snapshot({ taskId: ROOT });
  for (const block of [value.overall, value.selected]) {
    assert.equal(block.state, 'available');
    assert.equal(block.usage.totalTokens, 6);
    assert.equal(block.coverage.responsesCounted, 1);
    assert.equal(block.coverage.complete, true);
  }
});

test('compressed same-inode growth replays the complete revision', {
  skip: !HAS_ZSTD && 'Node runtime has no built-in zstd stream API',
}, async (t) => {
  const { sessionsDir, archivedDir } = await fixture(t);
  const path = join(archivedDir, filename(ROOT, true));
  const prefix = '0123456789abcdef';
  const oldRows = meta(ROOT) + usage(ROOT, 'compressed-old', 8, 1, ROOT, 0, { padding: prefix });
  const replacementRows = meta(ROOT)
    + usage(ROOT, 'compressed-new', 7, 1, ROOT, 0, { padding: prefix })
    + usage(ROOT, 'compressed-tail', 8, 1);
  const laterRows = usage(ROOT, 'compressed-later', 0, 0);
  const replacementDecoded = replacementRows + laterRows;
  const oldFrame = zlib.zstdCompressSync(Buffer.from(oldRows));
  const replacementFrames = Buffer.concat([
    zlib.zstdCompressSync(Buffer.from(replacementRows)),
    zlib.zstdCompressSync(Buffer.from(laterRows)),
  ]);
  assert.ok(Buffer.byteLength(replacementFrames) > Buffer.byteLength(oldFrame));
  assert.equal(
    Buffer.byteLength(replacementDecoded) > Buffer.byteLength(oldRows),
    true,
    'replacement revision must exceed the old decoded revision',
  );
  await writeFile(path, oldFrame);
  const decoders = [];
  let lateCallbackQueued = false;
  const summary = createSummary(sessionsDir, archivedDir, {
    roundBytes: 32 * 1024,
    limits: { maxDecodedBytes: Buffer.byteLength(replacementDecoded) },
    zstdFactory: () => {
      const decoder = zlib.createZstdDecompress();
      decoders.push(decoder);
      if (decoders.length === 2 && !lateCallbackQueued) {
        lateCallbackQueued = true;
        queueMicrotask(() => decoders[0].emit('readable'));
      }
      return decoder;
    },
  });
  t.after(() => summary.stop());
  await settle(summary, 200, ROOT);
  assert.equal(summary.snapshot({ taskId: ROOT }).selected.usage.totalTokens, 9);

  const before = await stat(path);
  await writeFile(path, replacementFrames);
  const after = await stat(path);
  assert.equal(after.ino, before.ino, 'fixture must keep the compressed file identity');

  await settle(summary, 200, ROOT);
  assert.equal(lateCallbackQueued, true, 'fixture did not create the replacement decoder');
  const value = summary.snapshot({ taskId: ROOT });
  for (const block of [value.overall, value.selected]) {
    assert.equal(block.state, 'available');
    assert.equal(block.usage.totalTokens, 17);
    assert.equal(block.coverage.responsesCounted, 3);
    assert.equal(block.coverage.complete, true);
  }
});

test('compressed revision changes during a read are rolled back and replayed', {
  skip: !HAS_ZSTD && 'Node runtime has no built-in zstd stream API',
}, async (t) => {
  const { sessionsDir, archivedDir } = await fixture(t);
  const path = join(archivedDir, filename(ROOT, true));
  const first = zlib.zstdCompressSync(Buffer.from(meta(ROOT) + usage(ROOT, 'mid-read-old', 8, 1)));
  const replacement = Buffer.concat([
    zlib.zstdCompressSync(Buffer.from(meta(ROOT) + usage(ROOT, 'mid-read-new', 7, 1))),
    zlib.zstdCompressSync(Buffer.from(usage(ROOT, 'mid-read-later', 9, 1))),
  ]);
  await writeFile(path, first);

  let replaceOnEnd = true;
  const summary = createSummary(sessionsDir, archivedDir, {
    roundBytes: 32 * 1024,
    zstdFactory: () => {
      const decoder = zlib.createZstdDecompress();
      const end = decoder.end.bind(decoder);
      decoder.end = (...args) => {
        const result = end(...args);
        if (replaceOnEnd) {
          replaceOnEnd = false;
          writeFileSync(path, replacement);
        }
        return result;
      };
      return decoder;
    },
  });
  t.after(() => summary.stop());
  await settle(summary, 200, ROOT);
  const value = summary.snapshot({ taskId: ROOT });
  for (const block of [value.overall, value.selected]) {
    assert.equal(block.state, 'available');
    assert.equal(block.usage.totalTokens, 18);
    assert.equal(block.coverage.responsesCounted, 2);
    assert.equal(block.coverage.complete, true);
  }
});

test('concatenated zstd frames survive backpressure without dropping usage', {
  skip: !HAS_ZSTD && 'Node runtime has no built-in zstd stream API',
}, async (t) => {
  const { sessionsDir, archivedDir } = await fixture(t);
  const responses = 40;
  const random = (size, seed) => {
    const value = Buffer.alloc(size);
    let state = seed;
    for (let index = 0; index < size; index++) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      value[index] = state & 0xff;
    }
    return value.toString('base64');
  };
  const frames = [zlib.zstdCompressSync(Buffer.from(meta(ROOT)))];
  let expectedTokens = 0;
  for (let index = 0; index < responses; index++) {
    // Large, incompressible padding forces the compressed input across several
    // read chunks while output backpressure is active.
    frames.push(zlib.zstdCompressSync(Buffer.from(
      usage(ROOT, `zstd-backpressure-${index}`, 1, 0, ROOT, 0, {
        padding: random(896, 0x9e3779b9 ^ index),
      }),
    )));
    expectedTokens += 1;
  }
  const compressed = Buffer.concat(frames);
  assert.ok(compressed.length > 32 * 1024, 'fixture must exceed zstd input backpressure');
  await writeFile(join(archivedDir, filename(ROOT, true)), compressed);
  const summary = createSummary(sessionsDir, archivedDir, {
    chunkBytes: 32,
    roundBytes: 512 * 1024,
  });
  t.after(() => summary.stop());
  await settle(summary, 80, ROOT);

  const value = summary.snapshot({ taskId: ROOT });
  for (const block of [value.overall, value.selected]) {
    assert.equal(block.usage?.totalTokens, expectedTokens);
    assert.equal(block.coverage.responsesCounted, responses);
    assert.equal(block.coverage.complete, true);
    assert.equal(block.state, 'available');
  }
});

test('a single large compressed frame spanning many reads is not dropped', {
  skip: !HAS_ZSTD && 'Node runtime has no built-in zstd stream API',
}, async (t) => {
  const { sessionsDir, archivedDir } = await fixture(t);
  const random = (size, seed) => {
    const value = Buffer.alloc(size);
    let state = seed;
    for (let index = 0; index < size; index++) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      value[index] = state & 0xff;
    }
    return value.toString('base64');
  };
  const rows = meta(ROOT) + usage(ROOT, 'zstd-large-frame', 1, 0, ROOT, 0, {
    padding: random(48 * 1024, 0x12345678),
  });
  const compressed = zlib.zstdCompressSync(Buffer.from(rows));
  assert.ok(compressed.length > 32 * 1024);
  await writeFile(join(archivedDir, filename(ROOT, true)), compressed);
  const summary = createSummary(sessionsDir, archivedDir, {
    chunkBytes: 32,
    roundBytes: 2 * 1024 * 1024,
  });
  t.after(() => summary.stop());
  await settle(summary, 80, ROOT);

  const value = summary.snapshot({ taskId: ROOT });
  for (const block of [value.overall, value.selected]) {
    assert.equal(block.usage?.totalTokens, 1);
    assert.equal(block.coverage.responsesCounted, 1);
    assert.equal(block.coverage.complete, true);
    assert.equal(block.state, 'available');
  }
});

test('frame staging cap rejects an oversized compressed frame without retaining it', {
  skip: !HAS_ZSTD && 'Node runtime has no built-in zstd stream API',
}, async (t) => {
  const { sessionsDir, archivedDir } = await fixture(t);
  const random = (size, seed) => {
    const value = Buffer.alloc(size);
    let state = seed;
    for (let index = 0; index < size; index++) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      value[index] = state & 0xff;
    }
    return value.toString('base64');
  };
  const rows = meta(ROOT) + usage(ROOT, 'zstd-frame-cap', 1, 0, ROOT, 0, {
    padding: random(64 * 1024, 0xabcdef01),
  });
  const compressed = zlib.zstdCompressSync(Buffer.from(rows));
  assert.ok(compressed.length > 32 * 1024);
  await writeFile(join(archivedDir, filename(ROOT, true)), compressed);
  const summary = createSummary(sessionsDir, archivedDir, {
    chunkBytes: 32,
    roundBytes: 32 * 1024,
  });
  t.after(() => summary.stop());
  await settle(summary, 100, ROOT);

  const value = summary.snapshot({ taskId: ROOT });
  for (const block of [value.overall, value.selected]) {
    assert.equal(block.state, 'partial');
    assert.equal(block.reason, 'budget_exceeded');
    assert.equal(block.usage, null);
    assert.equal(block.coverage.complete, false);
    assert.equal(block.coverage.failedFiles, 1);
  }
});

test('a frame staging failure keeps discovering and counting later valid files', {
  skip: !HAS_ZSTD && 'Node runtime has no built-in zstd stream API',
}, async (t) => {
  const { sessionsDir, archivedDir } = await fixture(t);
  const cap = 4 * 1024;
  const oversized = zlib.zstdCompressSync(Buffer.from(meta(ROOT)
    + usage(ROOT, 'unread-oversized-response', 90, 0, ROOT, 0, {
      padding: incompressiblePadding(cap * 2),
    })));
  assert.ok(oversized.length > cap);
  await writeFile(join(archivedDir, filename(ROOT, true)), oversized);
  const decoders = [];
  const summary = createSummary(sessionsDir, archivedDir, {
    roundBytes: cap,
    discoveryOps: 4,
    zstdFactory: () => {
      const decoder = zlib.createZstdDecompress();
      decoders.push(decoder);
      return decoder;
    },
  });
  t.after(() => summary.stop());
  await settle(summary, 40, ROOT);
  const failed = summary.snapshot({ taskId: ROOT });
  for (const block of [failed.overall, failed.selected]) {
    assert.equal(block.reason, 'budget_exceeded');
    assert.equal(block.coverage.failedFiles, 1);
    assert.equal(block.usage, null);
  }
  assert.equal(decoders.length, 1);
  assert.equal(decoders[0].destroyed, true, 'failed file must release its decoder');

  const archivedRows = meta(OTHER) + usage(OTHER, 'later-archive', 4, 1);
  const archivedFrame = zlib.zstdCompressSync(Buffer.from(archivedRows));
  assert.ok(archivedFrame.length < cap);
  await writeFile(join(archivedDir, filename(OTHER, true)), archivedFrame);
  const dayDir = join(sessionsDir, '2026', '10', '17');
  await mkdir(dayDir, { recursive: true });
  await writeFile(join(dayDir, filename(CHILD)), meta(CHILD) + usage(CHILD, 'later-plain', 7, 2));
  await settle(summary, 100, ROOT);
  const value = summary.snapshot({ taskId: ROOT });
  assert.equal(value.overall.usage?.totalTokens, 14, 'later logs must be scanned after the file failure');
  assert.equal(value.overall.state, 'partial');
  assert.equal(value.overall.reason, 'budget_exceeded');
  assert.equal(value.overall.coverage.discoveredFiles, 3);
  assert.equal(value.overall.coverage.completeFiles, 2);
  assert.equal(value.overall.coverage.pendingFiles, 0);
  assert.equal(value.overall.coverage.failedFiles, 1);
  assert.equal(value.overall.coverage.responsesCounted, 2);
  assert.equal(value.overall.coverage.complete, false);
  assert.equal(value.selected.reason, 'budget_exceeded');
  assert.equal(value.selected.usage, null);

  await settle(summary, 20, OTHER);
  const selected = summary.snapshot({ taskId: OTHER }).selected;
  assert.equal(selected.usage?.totalTokens, 5, 'an independent selection must retain its valid usage');
  assert.equal(selected.coverage.responsesCounted, 1);
  assert.equal(selected.coverage.failedFiles, 0);

  summary.snapshot({ taskId: GRANDCHILD });
  let unknown;
  for (let round = 0; round < 200; round++) {
    await summary.runOnce();
    unknown = summary.snapshot({ taskId: GRANDCHILD }).selected;
    if (unknown.state !== 'loading') break;
  }
  assert.equal(unknown.state, 'partial');
  assert.equal(unknown.reason, 'budget_exceeded');
  assert.equal(unknown.usage, null);
});

test('a frame staging failure rolls back counted prefixes and refunds decoded bytes', {
  skip: !HAS_ZSTD && 'Node runtime has no built-in zstd stream API',
}, async (t) => {
  const { sessionsDir, archivedDir } = await fixture(t);
  const cap = 4 * 1024;
  const prefixRows = meta(ROOT) + usage(ROOT, 'reused-after-frame-failure', 90, 0)
    + event('padding', { text: 'x'.repeat(cap * 3) });
  const prefix = zlib.zstdCompressSync(Buffer.from(prefixRows));
  assert.ok(prefix.length + 8 < cap);
  // Align the next frame with a later input read so the prefix is published
  // before its oversized successor causes the entire file to be revoked.
  const skipped = Buffer.alloc(cap - prefix.length);
  skipped.writeUInt32LE(0x184D2A50, 0);
  skipped.writeUInt32LE(skipped.length - 8, 4);
  const oversized = zlib.zstdCompressSync(Buffer.from(event('padding', {
    text: incompressiblePadding(cap * 2),
  })));
  assert.ok(oversized.length > cap);
  await writeFile(join(archivedDir, filename(ROOT, true)), Buffer.concat([prefix, skipped, oversized]));
  const decoders = [];
  const summary = createSummary(sessionsDir, archivedDir, {
    chunkBytes: cap,
    roundBytes: cap,
    limits: { maxDecodedBytes: Buffer.byteLength(prefixRows) },
    zstdFactory: () => {
      const decoder = zlib.createZstdDecompress();
      decoders.push(decoder);
      return decoder;
    },
  });
  t.after(() => summary.stop());
  summary.snapshot({ taskId: ROOT });
  let countedPrefix = false;
  for (let round = 0; round < 20; round++) {
    await summary.runOnce();
    if (summary.snapshot({ taskId: ROOT }).overall.usage?.totalTokens === 90) countedPrefix = true;
    if (summary.snapshot({ taskId: ROOT }).overall.coverage.failedFiles) break;
  }
  assert.equal(countedPrefix, true, 'fixture must count the prefix before the frame failure');
  assert.equal(summary.snapshot({ taskId: ROOT }).overall.coverage.failedFiles, 1);
  assert.equal(summary.snapshot({ taskId: ROOT }).overall.usage, null);
  assert.equal(decoders[0].destroyed, true);

  const goodRows = meta(OTHER) + usage(OTHER, 'reused-after-frame-failure', 4, 1);
  await writeFile(join(sessionsDir, filename(OTHER)), goodRows);
  await settle(summary, 40, OTHER);
  const value = summary.snapshot({ taskId: OTHER });
  for (const block of [value.overall, value.selected]) {
    assert.equal(block.usage?.totalTokens, 5, 'failed prefix must not retain identity or decoded-byte charges');
    assert.equal(block.coverage.responsesCounted, 1);
    assert.equal(block.coverage.conversationsCounted, 1);
    assert.equal(block.coverage.conflictingResponses, 0);
    assert.equal(block.coverage.invalidResponses, 0);
  }
  assert.equal(value.overall.reason, 'budget_exceeded');
  assert.equal(value.overall.coverage.completeFiles, 1);
  assert.equal(value.overall.coverage.pendingFiles, 0);
  assert.equal(value.overall.coverage.failedFiles, 1);
});

test('global hard caps still stop scanning after a file-local frame failure', {
  skip: !HAS_ZSTD && 'Node runtime has no built-in zstd stream API',
}, async (t) => {
  const cap = 4 * 1024;
  const oversized = zlib.zstdCompressSync(Buffer.from(event('padding', {
    text: incompressiblePadding(cap * 2),
  })));
  assert.ok(oversized.length > cap);
  for (const [name, limits] of [
    ['files', { maxFiles: 1 }],
    ['responses', { maxResponses: 1 }],
    ['threads', { maxThreads: 1 }],
    ['decoded bytes', { maxDecodedBytes: Buffer.byteLength(meta(OTHER)) + 8 }],
  ]) {
    await t.test(name, async (caseT) => {
      const { sessionsDir, archivedDir } = await fixture(caseT);
      await writeFile(join(archivedDir, filename(ROOT, true)), oversized);
      const summary = createSummary(sessionsDir, archivedDir, { roundBytes: cap, limits });
      caseT.after(() => summary.stop());
      await settle(summary, 20);
      assert.equal(summary.snapshot().overall.coverage.failedFiles, 1);

      await writeFile(join(sessionsDir, filename(OTHER)), meta(OTHER)
        + usage(OTHER, 'before-global-cap', 4, 1));
      await settle(summary, 20);
      if (name === 'threads') {
        assert.equal(summary.snapshot().overall.usage?.totalTokens, 5);
        await writeFile(join(sessionsDir, filename(CHILD)), meta(CHILD) + usage(CHILD, 'thread-overflow', 7, 2));
        await settle(summary, 20);
      }
      const exhausted = summary.snapshot().overall;
      assert.equal(exhausted.state, 'partial');
      assert.equal(exhausted.reason, 'budget_exceeded');
      assert.equal(exhausted.coverage.complete, false);
      assert.ok(exhausted.coverage.responsesCounted <= (name === 'threads' ? 1 : 0));

      await writeFile(join(sessionsDir, filename(GRANDCHILD)), meta(GRANDCHILD)
        + usage(GRANDCHILD, 'after-global-cap', 11, 2));
      await settle(summary, 20);
      const stopped = summary.snapshot().overall;
      assert.deepEqual(stopped.usage, exhausted.usage, 'a true global cap must remain terminal');
      assert.equal(stopped.coverage.responsesCounted, exhausted.coverage.responsesCounted);
    });
  }
});

test('wrong-owner inherited response ids do not revoke trusted rows', async (t) => {
  const { sessionsDir, archivedDir } = await fixture(t);
  await writeFile(join(sessionsDir, filename(ROOT)), meta(ROOT) + usage(ROOT, 'shared', 2, 1));
  await writeFile(join(sessionsDir, filename(CHILD)), [
    meta(ROOT),
    meta(CHILD, CHILD, { parent_thread_id: ROOT }),
    usage(ROOT, 'shared', 2, 1, ROOT),
    usage(CHILD, 'child-owned', 7, 1, CHILD),
  ].join('\n'));
  const summary = createSummary(sessionsDir, archivedDir);
  t.after(() => summary.stop());
  await settle(summary, 200, ROOT);

  const value = summary.snapshot({ taskId: ROOT });
  for (const block of [value.overall, value.selected]) {
    assert.equal(block.state, 'partial');
    assert.equal(block.reason, 'invalid_usage');
    assert.equal(block.usage.totalTokens, 11);
    assert.equal(block.coverage.responsesCounted, 2);
    assert.equal(block.coverage.conflictingResponses, 0);
    assert.equal(block.coverage.invalidResponses, 1);
    assert.equal(block.coverage.complete, false);
  }
});

test('selected scope inherits global ownership gaps from unrelated unresolved children', async (t) => {
  const { sessionsDir, archivedDir } = await fixture(t);
  await writeFile(join(sessionsDir, filename(ROOT)), meta(ROOT) + usage(ROOT, 'verified-root', 2, 1));
  await writeFile(join(sessionsDir, filename(CHILD)), [
    meta(CHILD, CHILD, {
      parent_thread_id: ROOT,
      source: { subagent: { thread_spawn: { parent_thread_id: OTHER } } },
    }),
    usage(CHILD, 'parent-conflict-a', 5, 3, CHILD),
  ].join('\n'));
  await writeFile(join(sessionsDir, dualFilename(OTHER, CHILD)), [
    meta(CHILD, CHILD, { parent_thread_id: ROOT }),
    usage(CHILD, 'parent-conflict-b', 4, 2, CHILD),
  ].join('\n'));
  const summary = createSummary(sessionsDir, archivedDir);
  t.after(() => summary.stop());
  await settle(summary, 300, ROOT);

  const value = summary.snapshot({ taskId: ROOT });
  assert.equal(value.overall.state, 'partial');
  assert.equal(value.overall.reason, 'ownership_unverified');
  assert.equal(value.overall.usage.totalTokens, 17);
  assert.equal(value.overall.coverage.responsesCounted, 3);
  assert.equal(value.overall.coverage.complete, false);
  assert.equal(value.selected.state, 'partial');
  assert.equal(value.selected.reason, 'ownership_unverified');
  assert.equal(value.selected.usage.totalTokens, 3);
  assert.equal(value.selected.coverage.responsesCounted, 1);
  assert.equal(value.selected.coverage.complete, false);
});

test('independent files with conflicting child parents keep the verified root subset', async (t) => {
  const { sessionsDir, archivedDir } = await fixture(t);
  await writeFile(join(sessionsDir, filename(ROOT)), meta(ROOT) + usage(ROOT, 'cross-file-root', 2, 1));
  await writeFile(join(sessionsDir, filename(CHILD)), [
    meta(CHILD, CHILD, { parent_thread_id: ROOT }),
    usage(CHILD, 'cross-file-child-a', 5, 3, CHILD),
  ].join('\n'));
  await writeFile(join(sessionsDir, dualFilename(OTHER, CHILD)), [
    meta(CHILD, CHILD, { parent_thread_id: OTHER }),
    usage(CHILD, 'cross-file-child-b', 4, 2, CHILD),
  ].join('\n'));
  const summary = createSummary(sessionsDir, archivedDir);
  t.after(() => summary.stop());
  await settle(summary, 300, ROOT);

  const value = summary.snapshot({ taskId: ROOT });
  assert.equal(value.overall.state, 'partial');
  assert.equal(value.overall.reason, 'ownership_unverified');
  assert.equal(value.overall.usage.totalTokens, 17);
  assert.equal(value.overall.coverage.responsesCounted, 3);
  assert.equal(value.overall.coverage.complete, false);
  assert.equal(value.selected.state, 'partial');
  assert.equal(value.selected.reason, 'ownership_unverified');
  assert.equal(value.selected.usage.totalTokens, 3);
  assert.equal(value.selected.coverage.responsesCounted, 1);
  assert.equal(value.selected.coverage.complete, false);
});

test('selected scope keeps ownership gaps visible when a higher-priority gap exists', async (t) => {
  const { sessionsDir, archivedDir } = await fixture(t);
  await writeFile(join(sessionsDir, filename(ROOT)), meta(ROOT) + usage(ROOT, 'verified-root', 2, 1));
  await writeFile(join(sessionsDir, filename(CHILD)), [
    meta(CHILD, CHILD, {
      parent_thread_id: ROOT,
      source: { subagent: { thread_spawn: { parent_thread_id: OTHER } } },
    }),
    usage(CHILD, 'parent-conflict-a', 5, 3, CHILD),
  ].join('\n'));
  await writeFile(join(sessionsDir, dualFilename(OTHER, CHILD)), [
    meta(CHILD, CHILD, { parent_thread_id: ROOT }),
    usage(CHILD, 'parent-conflict-b', 4, 2, CHILD),
  ].join('\n'));
  await writeFile(join(sessionsDir, filename(GRANDCHILD)), [
    meta(GRANDCHILD),
    usage(GRANDCHILD, 'invalid-elsewhere', 1, 1, GRANDCHILD, 0, {
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 9 },
    }),
  ].join('\n'));
  const summary = createSummary(sessionsDir, archivedDir);
  t.after(() => summary.stop());
  await settle(summary, 300, ROOT);

  const value = summary.snapshot({ taskId: ROOT });
  assert.equal(value.overall.state, 'partial');
  assert.equal(value.overall.reason, 'invalid_usage');
  assert.equal(value.overall.coverage.complete, false);
  assert.equal(value.selected.state, 'partial');
  assert.equal(value.selected.reason, 'invalid_usage');
  assert.equal(value.selected.coverage.complete, false);
});

test('a selected root revalidates appends before a long discovery sweep finishes', async (t) => {
  const { sessionsDir, archivedDir } = await fixture(t);
  const selectedPath = join(sessionsDir, filename(ROOT));
  await writeFile(selectedPath, meta(ROOT) + usage(ROOT, 'before-append', 2, 1));
  for (let index = 0; index < 80; index++) {
    const day = String((index % 4) + 1).padStart(2, '0');
    const dayDir = join(sessionsDir, '2026', '11', day);
    await mkdir(dayDir, { recursive: true });
    const id = `bbbbbbbb-bbbb-4bbb-8bbb-${index.toString(16).padStart(12, '0')}`;
    await writeFile(join(dayDir, filename(id)), meta(id) + usage(id, `bulk-${index}`, 1, 0));
  }
  const originalReaddir = fsPromises.readdir;
  let readdirCalls = 0;
  fsPromises.readdir = async (...args) => {
    readdirCalls++;
    return originalReaddir.apply(fsPromises, args);
  };
  t.after(() => {
    fsPromises.readdir = originalReaddir;
  });
  let operationsThisRound = 0;
  const summary = createSummary(sessionsDir, archivedDir, {
    roundBytes: 1024,
    discoveryOps: {
      limit: 5,
      before: () => {
        operationsThisRound++;
      },
    },
  });
  t.after(() => summary.stop());
  summary.snapshot({ taskId: ROOT });
  let selectedReady = false;
  for (let round = 0; round < 4; round++) {
    await summary.runOnce();
    const value = summary.snapshot({ taskId: ROOT });
    assert.equal(value.overall.coverage.complete, false);
    if (value.selected.usage?.totalTokens === 3) {
      selectedReady = true;
      break;
    }
  }
  assert.equal(selectedReady, true, 'selected file was not read before the long sweep');

  await appendFile(selectedPath, usage(ROOT, 'after-append', 4, 1));
  let observedDuringSweep = false;
  for (let round = 0; round < 12; round++) {
    operationsThisRound = 0;
    await summary.runOnce();
    assert.ok(operationsThisRound <= 5, 'selected revalidation exceeded the discovery operation cap');
    const value = summary.snapshot({ taskId: ROOT });
    assert.equal(value.overall.coverage.complete, false, 'fixture sweep finished before append was observed');
    if (value.selected.usage?.totalTokens === 8) {
      observedDuringSweep = true;
      break;
    }
  }
  assert.equal(observedDuringSweep, true, 'selected append was not visible during the long discovery sweep');
  assert.equal(readdirCalls, 0, 'selected discovery used an unbounded readdir probe');
});

test('a selected file is revalidated while discovery has many entries and operations are bounded', async (t) => {
  const { sessionsDir, archivedDir } = await fixture(t);
  const selectedPath = join(sessionsDir, filename(ROOT));
  const initialRows = meta(ROOT) + usage(ROOT, 'selected-before-probe', 15, 3);
  await writeFile(selectedPath, initialRows);
  const appendedRow = usage(ROOT, 'selected-after-append', 8, 4);
  // Keep both revisions within one round's byte budget. The regression is the
  // unbounded directory probe borrowing the whole discovery batch, not budget.
  assert.ok(Buffer.byteLength(initialRows + appendedRow) < 1024);
  for (let index = 0; index < 80; index++) {
    const id = `cccccccc-cccc-4ccc-8ccc-${index.toString(16).padStart(12, '0')}`;
    await writeFile(join(sessionsDir, filename(id)), meta(id) + usage(id, `probe-${index}`, 1, 0));
  }

  const operationLimit = 5;
  let operationsThisRound = 0;
  let largestBatch = 0;
  const summary = createSummary(sessionsDir, archivedDir, {
    roundBytes: 1024,
    discoveryOps: {
      limit: operationLimit,
      before: () => {
        operationsThisRound++;
      },
    },
  });
  t.after(() => summary.stop());
  summary.snapshot({ taskId: ROOT });
  for (let round = 0; round < 10; round++) {
    operationsThisRound = 0;
    await summary.runOnce();
    largestBatch = Math.max(largestBatch, operationsThisRound);
    assert.ok(operationsThisRound <= operationLimit, 'selected revalidation exceeded the discovery operation cap');
    if (summary.snapshot({ taskId: ROOT }).selected.usage?.totalTokens === 18) break;
  }
  assert.equal(summary.snapshot({ taskId: ROOT }).selected.usage?.totalTokens, 18);

  await appendFile(selectedPath, appendedRow);
  let observed = false;
  for (let round = 0; round < 12; round++) {
    operationsThisRound = 0;
    await summary.runOnce();
    assert.ok(operationsThisRound <= operationLimit, 'discovery batch exceeded its operation cap');
    const value = summary.snapshot({ taskId: ROOT });
    assert.equal(value.overall.coverage.complete, false, 'discovery finished before the selected append was observed');
    if (value.selected.usage?.totalTokens === 30) {
      observed = true;
      break;
    }
  }
  assert.ok(largestBatch <= 8, `discovery batch used ${largestBatch} operations, expected an incremental Dirent cursor`);
  assert.equal(observed, true, 'selected append was not observed during the long bounded discovery sweep');
});

test('discovery is resumable and bounded across filesystem operations', async (t) => {
  const { sessionsDir, archivedDir } = await fixture(t);
  const operationLimit = 6;
  const bulkIds = Array.from({ length: 12 }, (_, index) => (
    `aaaaaaaa-aaaa-4aaa-8aaa-${index.toString(16).padStart(12, '0')}`
  ));
  const selectedPath = join(sessionsDir, filename(ROOT));
  await writeFile(selectedPath, meta(ROOT) + usage(ROOT, 'selected-before-bootstrap', 2, 1));
  const bulkPaths = [];
  for (let index = 0; index < bulkIds.length; index++) {
    const day = String((index % 4) + 1).padStart(2, '0');
    const dayDir = join(sessionsDir, '2026', '10', day);
    await mkdir(dayDir, { recursive: true });
    const path = join(dayDir, filename(bulkIds[index]));
    bulkPaths.push(path);
    await writeFile(path, meta(bulkIds[index]) + usage(bulkIds[index], `bulk-${index}`, 1, 0));
  }
  const totalFiles = 1 + bulkIds.length;
  const totalUsage = 3 + bulkIds.length;
  let operationsThisRound = 0;
  const summary = createSummary(sessionsDir, archivedDir, {
    roundBytes: 128,
    discoveryOps: {
      limit: operationLimit,
      before: () => {
        operationsThisRound++;
      },
    },
  });
  t.after(() => summary.stop());
  summary.snapshot({ taskId: ROOT });

  let selectedReady = false;
  for (let round = 0; round < 40 && !selectedReady; round++) {
    operationsThisRound = 0;
    await summary.runOnce();
    assert.ok(operationsThisRound > 0, 'discovery must use the bounded operation hook');
    assert.ok(operationsThisRound <= operationLimit, 'one discovery batch exceeded its operation cap');
    const value = summary.snapshot({ taskId: ROOT });
    if (value.selected.usage?.totalTokens === 3) {
      selectedReady = true;
      assert.equal(value.overall.coverage.complete, false, 'selected append completed only after bootstrap had already finished');
      assert.ok(value.overall.coverage.discoveredFiles < totalFiles, 'the first discovery batch was not bounded');
    }
  }
  assert.equal(selectedReady, true, 'selected append never advanced while discovery continued in batches');

  for (let round = 0; round < 100; round++) {
    if (summary.snapshot().overall.coverage.complete) break;
    operationsThisRound = 0;
    await summary.runOnce();
    assert.ok(operationsThisRound <= operationLimit, 'a resumed discovery batch exceeded its operation cap');
  }
  const complete = summary.snapshot().overall;
  assert.equal(complete.coverage.discoveredFiles, totalFiles);
  assert.equal(complete.usage.totalTokens, totalUsage);
  assert.equal(complete.coverage.complete, true);

  const removedPath = bulkPaths[bulkPaths.length - 1];
  await rm(removedPath);
  operationsThisRound = 0;
  await summary.runOnce();
  const retained = summary.snapshot().overall;
  assert.ok(operationsThisRound <= operationLimit);
  assert.equal(retained.coverage.discoveredFiles, totalFiles, 'an incomplete discovery sweep deleted an unvisited entry');
  assert.equal(retained.usage.totalTokens, totalUsage);
  assert.equal(retained.coverage.complete, false);

  for (let round = 0; round < 100; round++) {
    if (summary.snapshot().overall.coverage.complete) break;
    operationsThisRound = 0;
    await summary.runOnce();
    assert.ok(operationsThisRound <= operationLimit, 'a resumed reconciliation batch exceeded its operation cap');
  }
  const reconciled = summary.snapshot().overall;
  assert.equal(reconciled.coverage.discoveredFiles, totalFiles - 1);
  assert.equal(reconciled.usage.totalTokens, totalUsage - 1);
  assert.equal(reconciled.coverage.complete, true);
});

test('stop settles while bounded discovery is suspended', async (t) => {
  const { sessionsDir, archivedDir } = await fixture(t);
  await writeFile(join(sessionsDir, filename(ROOT)), meta(ROOT) + usage(ROOT, 'stop-mid-discovery', 1, 1));
  let enteredResolve;
  let releaseResolve;
  const entered = new Promise((resolve) => { enteredResolve = resolve; });
  const release = new Promise((resolve) => { releaseResolve = resolve; });
  const summary = createSummary(sessionsDir, archivedDir, {
    discoveryOps: {
      limit: 100,
      before: async () => {
        enteredResolve?.();
        enteredResolve = null;
        await release;
      },
    },
  });
  t.after(() => summary.stop());
  const run = summary.runOnce();
  const reached = await Promise.race([
    entered.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 200)),
  ]);
  if (!reached) {
    await summary.stop();
    assert.fail('discovery operation hook was not reached');
  }
  const stopping = summary.stop();
  releaseResolve();
  await Promise.race([
    stopping,
    new Promise((_, reject) => setTimeout(() => reject(new Error('stop did not settle after discovery was released')), 1000)),
  ]);
  await run;
  assert.equal(summary.snapshot().overall.reason, 'scan_interrupted');
});

test('stop closes a directory returned by a late-opendir operation', async (t) => {
  const { sessionsDir, archivedDir } = await fixture(t);
  await writeFile(join(sessionsDir, filename(ROOT)), meta(ROOT) + usage(ROOT, 'stop-late-opendir', 1, 1));
  const originalOpendir = fsPromises.opendir;
  let lateDirectory = null;
  let closeCompleted = false;
  let openedResolve;
  let releaseResolve;
  const opened = new Promise((resolve) => { openedResolve = resolve; });
  const release = new Promise((resolve) => { releaseResolve = resolve; });
  fsPromises.opendir = async function patchedOpendir(...args) {
    const directory = await originalOpendir.apply(this, args);
    if (resolve(args[0]) !== resolve(sessionsDir)) return directory;
    lateDirectory = directory;
    const originalClose = directory.close.bind(directory);
    directory.close = async () => {
      await originalClose();
      closeCompleted = true;
    };
    openedResolve?.();
    openedResolve = null;
    await release;
    return directory;
  };
  let summary;
  try {
    summary = createSummary(sessionsDir, archivedDir);
    t.after(() => summary.stop());
    const run = summary.runOnce();
    const reached = await Promise.race([
      opened.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 1000)),
    ]);
    if (!reached) assert.fail('discovery did not open the fixture directory');
    const stopping = summary.stop();
    releaseResolve();
    await Promise.race([
      stopping,
      new Promise((_, reject) => setTimeout(() => reject(new Error('stop did not settle after late opendir')), 1000)),
    ]);
    await run;
    assert.equal(closeCompleted, true, 'the late directory handle was not closed');
    const stoppedSnapshot = summary.snapshot({ taskId: ROOT });
    assert.equal(stoppedSnapshot.selected.usage, null);
    assert.equal(stoppedSnapshot.selected.reason, 'scan_interrupted');
    await summary.runOnce();
    assert.deepEqual(summary.snapshot({ taskId: ROOT }), stoppedSnapshot);
  } finally {
    releaseResolve?.();
    fsPromises.opendir = originalOpendir;
    if (lateDirectory && !closeCompleted) {
      try {
        await lateDirectory.close();
      } catch {}
    }
  }
});

test('stop closes a directory that was already attached before a suspended read', async (t) => {
  const { sessionsDir, archivedDir } = await fixture(t);
  await writeFile(join(sessionsDir, filename(ROOT)), meta(ROOT) + usage(ROOT, 'stop-open-handle', 1, 1));
  const originalOpendir = fsPromises.opendir;
  let openedDirectory = null;
  let closeCompleted = false;
  let openedResolve;
  let releaseResolve;
  const opened = new Promise((resolve) => { openedResolve = resolve; });
  const release = new Promise((resolve) => { releaseResolve = resolve; });
  fsPromises.opendir = async function patchedOpendir(...args) {
    const directory = await originalOpendir.apply(this, args);
    if (resolve(args[0]) !== resolve(sessionsDir)) return directory;
    openedDirectory = directory;
    const originalClose = directory.close.bind(directory);
    directory.close = async () => {
      await originalClose();
      closeCompleted = true;
    };
    const originalRead = directory.read.bind(directory);
    let paused = false;
    directory.read = async () => {
      if (!paused) {
        paused = true;
        openedResolve?.();
        openedResolve = null;
        await release;
      }
      return originalRead();
    };
    return directory;
  };
  let summary;
  try {
    summary = createSummary(sessionsDir, archivedDir);
    t.after(() => summary.stop());
    const run = summary.runOnce();
    const reached = await Promise.race([
      opened.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 1000)),
    ]);
    if (!reached) assert.fail('discovery did not attach and read the fixture directory');
    const stopping = summary.stop();
    releaseResolve();
    await Promise.race([
      stopping,
      new Promise((_, reject) => setTimeout(() => reject(new Error('stop did not settle with an open discovery Dirent')), 1000)),
    ]);
    await run;
    assert.equal(closeCompleted, true, 'the attached directory handle was not closed');
    assert.equal(summary.snapshot().overall.reason, 'scan_interrupted');
  } finally {
    releaseResolve?.();
    fsPromises.opendir = originalOpendir;
    if (openedDirectory && !closeCompleted) {
      try {
        await openedDirectory.close();
      } catch {}
    }
  }
});
