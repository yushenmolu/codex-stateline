import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, relative, isAbsolute, resolve, sep } from 'node:path';
import { parseTaskLine, sessionFilenameIdentity, taskUsageEmpty } from './usage.js';

// Bounded task monitor. Every window below is a hard cap; nothing here scans a
// whole file or a whole sessions tree per request.
export const TASK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const IDENTITY_HEAD = 64 * 1024;
const TAIL_WINDOW = 256 * 1024;
const BOOTSTRAP_LIMIT = 2 * 1024 * 1024;
const CHUNK = 256 * 1024;
const ROUND_BYTES = 2 * 1024 * 1024;
const CHILD_LRU = 128;
const LINE_LIMIT = 256 * 1024;
const MAX_TASKS = 50;
const MAX_AGENTS = 64;
const STALE_MS = 90_000;
const METADATA_LIMIT = 20_000;
const DIRECTORY_LIMIT = 512;
const ENTRY_LIMIT = 10_000;
const CANDIDATE_LIMIT = 512;
const INDEX_BYTES = 1024 * 1024;
const INDEX_LIMIT = 256;
const INDEX_TTL_MS = 30_000;
const TITLE_LIMIT = 160;
const DISCOVERY_TTL_MS = 30_000;
const DISCOVERY_DIRS = 24;
const DISCOVERY_FILES = 128;
// The rest of the library must keep making progress even while a large pinned
// bootstrap consumes its own half of the round budget. Identity probes ask
// "whose session is this?" from a small head read and share one round lane.
const PROBE_BUDGET = 512 * 1024;
const DATE_PATTERNS = [/^\d{4}$/, /^(0[1-9]|1[0-2])$/, /^(0[1-9]|[12]\d|3[01])$/];

function inside(root, path) {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep));
}

function statOf(stat) {
  return {
    ino: stat.ino, dev: stat.dev, size: Number(stat.size),
    mtimeMs: Number(stat.mtimeMs), ctimeMs: stat.ctimeMs == null ? null : Number(stat.ctimeMs),
  };
}

function metadata(budget, operation) {
  if (budget.metadata >= METADATA_LIMIT) throw Error('metadata_limit');
  budget.metadata++;
  return operation();
}

function sanitizeTitle(value) {
  if (typeof value !== 'string') return null;
  const flat = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return flat ? flat.slice(0, TITLE_LIMIT) : null;
}

// Bounded mirror of the main reader's discovery rules: date directories only,
// UUID rollout filenames only, no links, hard metadata/directory/entry caps.
// The walk is resumable: one sample visits at most DISCOVERY_DIRS directories
// and the remaining queue survives in the discovery state, so a large library
// is covered over several samples instead of being rescanned per refresh.
// Discovered paths are only hints: every tracked file is re-statted on every
// sample, so an append to a known file is visible on the next sample.
async function discover(root, budget, state, restart, pinnedId) {
  if (restart) {
    state.queue = [[]];
    state.walkFiles = new Map();
    state.walkDone = false;
    state.truncated = false;
  }
  let visited = 0;
  while (state.queue.length && visited < DISCOVERY_DIRS) {
    if (budget.directories >= DIRECTORY_LIMIT || budget.entries >= ENTRY_LIMIT) {
      state.truncated = true;
      state.queue = [];
      break;
    }
    // Newest date directories first: the pinned/current session lives in the
    // most recent day directory, so a bounded sample reaches it without a full
    // walk of the whole library.
    state.queue.sort((a, b) => a.length === 0 ? -1 : b.length === 0 ? 1 : b.join('/').localeCompare(a.join('/')));
    const parts = state.queue.shift();
    visited++;
    budget.directories++;
    const dirPath = join(root, ...parts);
    if (parts.length) {
      const stat = await metadata(budget, () => fs.lstat(dirPath, { bigint: true }));
      const real = await metadata(budget, () => fs.realpath(dirPath));
      if (stat.isSymbolicLink() || !stat.isDirectory() || !inside(root, real) || resolve(real) !== resolve(dirPath)) continue;
    }
    let dir;
    try { dir = await fs.opendir(dirPath); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    try {
      for (;;) {
        const item = await dir.read();
        if (!item) break;
        if (budget.entries >= ENTRY_LIMIT) { state.truncated = true; state.queue = []; break; }
        budget.entries++;
        if (item.isSymbolicLink()) continue;
        const child = [...parts, item.name];
        if (item.isDirectory()) {
          if (parts.length < 3 && DATE_PATTERNS[parts.length].test(item.name)) state.queue.push(child);
          continue;
        }
        if (!item.isFile() || (parts.length !== 0 && parts.length !== 3)) continue;
        const identity = sessionFilenameIdentity(item.name);
        if (!identity || item.name.includes('reverted')) continue;
        const path = join(root, ...child);
        const stat = await metadata(budget, () => fs.lstat(path, { bigint: true }));
        if (stat.isSymbolicLink() || !stat.isFile()) continue;
        state.walkFiles.set(path, { path, id: identity.id, stat: statOf(stat) });
        if (pinnedId !== null && identity.id === pinnedId) state.pinned.add(identity.id);
      }
    } finally { await dir.close(); }
  }
  const finished = state.queue.length === 0 && !state.walkDone;
  if (state.queue.length === 0) state.walkDone = true;
  const source = state.walkDone ? state.walkFiles : new Map([...state.files, ...state.walkFiles]);
  const ranked = [...source.values()]
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs || a.path.localeCompare(b.path));
  const tracked = new Map();
  for (const file of ranked) {
    const pinned = state.pinned.has(file.id);
    if (!pinned && tracked.size >= DISCOVERY_FILES) { state.truncated = true; continue; }
    let stat;
    try { stat = await metadata(budget, () => fs.lstat(file.path, { bigint: true })); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (stat.isSymbolicLink() || !stat.isFile()) continue;
    tracked.set(file.path, { path: file.path, id: file.id, stat: statOf(stat) });
  }
  state.files = tracked;
  return { candidates: [...tracked.values()], complete: state.walkDone && !state.truncated, finished };
}

// Keep the cache bounded without dropping the pinned task: protected paths are
// skipped and, once they fill the cap, every unprotected entry is released.
function evictCache(cache, keep) {
  if (keep.size >= CHILD_LRU) {
    for (const key of [...cache.keys()]) if (!keep.has(key)) cache.delete(key);
    return;
  }
  for (const key of [...cache.keys()]) {
    if (cache.size <= CHILD_LRU) return;
    if (!keep.has(key)) cache.delete(key);
  }
}

// Spend one bounded lane across a group of files: the group may use at most
// `total` bytes and a single file at most `perFile`, so no large log can eat a
// share that was reserved for another group. Returns the last item the lane
// actually reached (for cursor bookkeeping) or null when it reached none.
async function spendLane(list, total, perFile, budget, spendOne) {
  let left = Math.min(total, budget.bytes);
  let reached = null;
  for (const item of list) {
    const lane = { left: Math.min(perFile, left) };
    const before = budget.bytes;
    await spendOne(item, lane);
    left -= before - budget.bytes;
    reached = item;
    if (left <= 0) return reached;
  }
  return reached;
}

// Single stable read of one window; links, replacement and concurrent writes
// are rejected instead of being published. `lane` is a mutable byte share: a
// read that would cross it is deferred whole, so no caller can spend a share
// that was reserved for another caller.
async function readWindow(path, expect, offset, length, budget, lane) {
  if (length <= 0) return null;
  const share = lane === undefined ? budget.bytes : lane.left;
  if (length > budget.bytes || length > share) return { deferred: true };
  let handle;
  try {
    const before = await fs.lstat(path, { bigint: true });
    if (before.isSymbolicLink() || !before.isFile()) return { unsafe: true };
    if (before.ino !== expect.ino || before.dev !== expect.dev) return { changed: true };
    budget.bytes -= length;
    if (lane !== undefined) lane.left -= length;
    handle = await fs.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat({ bigint: true });
    if (opened.ino !== before.ino || opened.dev !== before.dev) return { changed: true };
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    const after = statOf(await handle.stat({ bigint: true }));
    if (after.ino !== opened.ino || after.dev !== opened.dev || after.size !== Number(opened.size)
      || after.mtimeMs !== Number(opened.mtimeMs) || after.ctimeMs !== (opened.ctimeMs == null ? null : Number(opened.ctimeMs))) return { changed: true };
    return { data: buffer.subarray(0, bytesRead), stat: after, short: bytesRead < length };
  } catch (error) {
    if (error.code === 'ENOENT') return { missing: true };
    return { failed: true };
  } finally { await handle?.close(); }
}

function createEntry(candidate) {
  return {
    path: candidate.path, id: candidate.id, ...candidate.stat,
    identity: null, conflict: false, usageIdentityConflict: false, damaged: false, oversized: false,
    coveredEnd: 0, tailEnd: 0, tailCoveredStart: null, bootstrapEnd: 0, tailAligned: false,
    headDone: false, identityProbed: false,
    turns: new Map(), turnRoots: new Map(),
    latest: null, model: null, effort: null, modelAt: null, rejected: false,
  };
}

function turnRecord(entry, turn) {
  let record = entry.turns.get(turn);
  if (!record) {
    record = { turn, root: null, model: null, effort: null, startedAt: null, completedAt: null,
      abortedAt: null, lifecycleAt: null, lifecycleRank: -1, lastAt: null, lastType: null, usage: null, usageAt: null };
    entry.turns.set(turn, record);
  }
  return record;
}

// A file is only fully covered when one parsed interval really reaches its end
// and the file stops on a complete line. Reading the tail of a large log jumps
// coverage ahead, so the interval must be contiguous: either the sequential
// prefix from byte 0 reaches the tail run, or the run starts exactly where that
// prefix ends. Anything else leaves a middle gap that must be reported.
function coverageComplete(entry) {
  const size = entry.size ?? 0;
  if (entry.tailEnd < size) return false;
  if (entry.bootstrapEnd >= size) return true;
  if (entry.tailCoveredStart === null) return false;
  return entry.bootstrapEnd >= entry.tailCoveredStart;
}

function apply(entry, event) {
  if (event.type === 'token_usage_record') {
    // Counters are attributable only when the record carries no foreign
    // thread/session identity; mismatches never touch the file or its root.
    const expectedSession = entry.identity?.sessionId ?? entry.id;
    if ((event.thread !== null && event.thread !== entry.id)
      || (event.sessionId !== null && event.sessionId !== expectedSession)) {
      entry.usageIdentityConflict = true;
      return;
    }
  }
  entry.latest = Math.max(entry.latest ?? 0, event.timestamp);
  if (event.type === 'session_meta') {
    // Only the self-identifying record defines this file; inherited VS Code
    // metadata (id != filename id) is ignored and never used for grouping.
    if (event.id !== entry.id || event.sessionId === null) return;
    if (!entry.identity) entry.identity = { id: event.id, sessionId: event.sessionId, parentId: event.parentId, role: event.role };
    else if (entry.identity.sessionId !== event.sessionId || entry.identity.id !== event.id) entry.conflict = true;
    return;
  }
  if (!event.turn) return;
  if (event.root) entry.turnRoots.set(event.turn, event.root);
  const record = turnRecord(entry, event.turn);
  const root = event.root ?? entry.turnRoots.get(event.turn) ?? null;
  if (root && !record.root) record.root = root;
  if (event.type === 'turn_context') {
    record.model = event.model;
    record.effort = event.effort;
    if (entry.modelAt === null || event.timestamp >= entry.modelAt) {
      entry.model = event.model; entry.effort = event.effort; entry.modelAt = event.timestamp;
    }
    return;
  }
  if (event.type === 'token_usage_record') {
    if (event.usage && (record.usageAt === null || event.timestamp >= record.usageAt)) {
      record.usage = event.usage; record.usageAt = event.timestamp;
    }
    // Usage is an accounting signal, not a lifecycle one: it may advance
    // activity and counters, but it never rewrites the turn's state.
    if (record.lastAt === null || event.timestamp >= record.lastAt) record.lastAt = event.timestamp;
    return;
  }
  const field = event.type === 'task_started' ? 'startedAt' : event.type === 'task_complete' ? 'completedAt' : 'abortedAt';
  if (record[field] === null) record[field] = event.timestamp;
  const lifecycle = event.type === 'task_started' ? 'started' : event.type === 'task_complete' ? 'completed' : 'aborted';
  // Terminal ranks are distinct so two same-stamp terminal records also resolve
  // deterministically instead of by replay order.
  const rank = lifecycle === 'started' ? 0 : lifecycle === 'aborted' ? 1 : 2;
  const decided = record.lifecycleAt === null;
  // A terminal record and a start sharing one timestamp must resolve the same
  // way in either replay order, so the terminal rank wins ties and a start may
  // only reopen the turn when it is strictly newer.
  const wins = decided || event.timestamp > record.lifecycleAt
    || (event.timestamp === record.lifecycleAt && rank > record.lifecycleRank);
  if (wins) {
    record.lifecycleAt = event.timestamp;
    record.lifecycleRank = rank;
    record.lastType = lifecycle;
  }
  if (record.lastAt === null || event.timestamp >= record.lastAt) record.lastAt = event.timestamp;
}

// `atLineStart` means data[0] is the first byte of a line. Only a read that
// begins mid-line may skip a partial first line; skipping at a known boundary
// would silently drop the first complete line of the window. Returns the
// absolute offset where the next unread line begins, or -1 when the window
// holds no complete line at all.
function ingest(entry, data, offset, now, atLineStart = offset === 0) {
  let position = 0;
  if (!atLineStart) {
    const newline = data.indexOf(10);
    if (newline < 0) return -1;
    position = newline + 1;
  }
  let nextLineStart = -1;
  while (position < data.length) {
    const end = data.indexOf(10, position);
    if (end < 0) break;
    const length = end - position;
    if (length > LINE_LIMIT) entry.oversized = true;
    else if (length > 0) {
      let line;
      try { line = new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(position, end)); } catch { entry.damaged = true; line = null; }
      if (line !== null && line.includes(String.fromCharCode(0))) { entry.damaged = true; line = null; }
      if (line !== null) {
        let event = null;
        try { event = parseTaskLine(line, now); } catch { entry.damaged = true; }
        if (event) apply(entry, event);
      }
    }
    position = end + 1;
    nextLineStart = offset + position;
  }
  return nextLineStart;
}

// One bounded refresh pass for a single cached file. `lane` caps what this one
// file may spend this round.
//
// Every read resumes from a recorded line boundary, so an append that starts
// exactly where the previous read stopped is still parsed as a whole line. A
// partial trailing line is never guessed at: its boundary is kept and the line
// is recovered once its newline lands.
async function ingestFile(entry, stat, budget, now, lane) {
  const replaced = stat.ino !== entry.ino || stat.dev !== entry.dev;
  if (replaced || stat.size < entry.coveredEnd) {
    Object.assign(entry, createEntry({ path: entry.path, id: entry.id, stat }));
    budget.lag = true;
  }
  const tailStart = Math.max(0, stat.size - TAIL_WINDOW);
  // The bootstrap must reach the start of the line-aligned tail interval, not
  // merely the raw window offset, or the line spanning both windows could never
  // be parsed.
  const bootTarget = () => Math.min(stat.size, BOOTSTRAP_LIMIT,
    Math.max(tailStart, IDENTITY_HEAD, entry.tailCoveredStart ?? 0));
  const unchanged = entry.headDone && entry.size !== null && entry.size === stat.size
    && entry.mtimeMs === stat.mtimeMs && entry.ctimeMs === stat.ctimeMs;
  Object.assign(entry, { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs });
  if (unchanged && entry.tailEnd >= stat.size && entry.bootstrapEnd >= bootTarget()) return;
  // Head window: learns the identity and covers any small file completely.
  if (!entry.headDone) {
    const length = Math.min(stat.size, IDENTITY_HEAD + TAIL_WINDOW);
    if (length > 0) {
      const read = await readWindow(entry.path, entry, 0, length, budget, lane);
      if (!read) return;
      if (read.deferred) { budget.lag = true; return; }
      if (read.changed || read.missing || read.unsafe || read.failed) { budget.lag = true; return; }
      const boundary = ingest(entry, read.data, 0, now, true);
      entry.coveredEnd = Math.max(entry.coveredEnd, read.data.length);
      entry.bootstrapEnd = boundary >= 0 ? boundary : 0;
      entry.tailEnd = Math.max(entry.tailEnd, entry.bootstrapEnd);
      // Contiguous coverage from byte 0 ends at the last complete line of the
      // head window; the same boundary is where the bootstrap continues.
      entry.tailCoveredStart = entry.bootstrapEnd;
      entry.tailAligned = true;
      if (read.short || boundary < 0) budget.lag = true;
    }
    entry.headDone = true;
    entry.identityProbed = true;
  }
  // Tail: the hot window of an appended rollout. Only bytes past the last
  // consumed line are re-read, so an unchanged file costs no budget.
  if (entry.tailEnd < stat.size) {
    const aligned = entry.tailAligned && entry.tailEnd >= tailStart;
    const offset = aligned ? entry.tailEnd : tailStart;
    const length = Math.min(TAIL_WINDOW, stat.size - offset);
    const read = await readWindow(entry.path, entry, offset, length, budget, lane);
    if (!read) return;
    if (read.deferred) { budget.lag = true; return; }
    if (read.changed || read.missing || read.unsafe || read.failed) { budget.lag = true; return; }
    const previousTailStart = entry.tailCoveredStart;
    const previousTailEnd = entry.tailEnd;
    const boundary = ingest(entry, read.data, offset, now, aligned);
    entry.coveredEnd = Math.max(entry.coveredEnd, offset + read.data.length);
    // Track the left edge of the run of bytes that is parsed and contiguous
    // with the tail end. An aligned read extends that run; a window that jumped
    // forward starts a new run (its first partial line is skipped, so the run
    // begins after the first newline) unless it still overlaps the old one.
    if (aligned) {
      if (previousTailStart === null) entry.tailCoveredStart = offset;
    } else {
      const firstLine = read.data.indexOf(10);
      if (firstLine >= 0) {
        const parsedStart = offset + firstLine + 1;
        entry.tailCoveredStart = previousTailStart !== null && parsedStart <= previousTailEnd
          ? previousTailStart : parsedStart;
      }
    }
    // `boundary >= 0` is the next line start, so an unchanged file that ended on
    // a newline is not re-read at all.
    if (boundary >= 0) { entry.tailEnd = boundary; entry.tailAligned = true; }
    else if (offset + read.data.length >= stat.size) {
      // A write was cut mid-line: keep the last boundary and parse the whole
      // line once its newline lands. This is transient, not a defect.
      entry.tailAligned = true;
    } else {
      // A full window without one newline: the line is longer than any window
      // we will read, so it can never be parsed. Report it and stop re-reading.
      entry.tailEnd = stat.size; entry.tailAligned = false; entry.oversized = true;
    }
    if (read.short || boundary < 0) budget.lag = true;
  }
  // Bootstrap: sequential chunks up to BOOTSTRAP_LIMIT so the beginning of a
  // very large log is eventually parsed too.
  if (entry.bootstrapEnd < bootTarget()) {
    const offset = entry.bootstrapEnd;
    const length = Math.min(CHUNK, bootTarget() - offset);
    const read = await readWindow(entry.path, entry, offset, length, budget, lane);
    if (!read) return;
    if (read.deferred) { budget.lag = true; return; }
    if (read.changed || read.missing || read.unsafe || read.failed) { budget.lag = true; return; }
    const boundary = ingest(entry, read.data, offset, now, true);
    entry.coveredEnd = Math.max(entry.coveredEnd, offset + read.data.length);
    if (boundary >= 0) entry.bootstrapEnd = boundary;
    else { entry.bootstrapEnd = offset + read.data.length; entry.oversized = true; }
    if (read.short || boundary < 0) budget.lag = true;
  }
}

// Cheap "whose session is this?" read: one head window per revision, so a round
// can classify many siblings without ingesting any of them.
async function probeFile(entry, stat, budget, now, lane) {
  const replaced = stat.ino !== entry.ino || stat.dev !== entry.dev;
  if (replaced) {
    Object.assign(entry, createEntry({ path: entry.path, id: entry.id, stat }));
    budget.lag = true;
  }
  const unchanged = entry.identityProbed && entry.size !== null && entry.size === stat.size
    && entry.mtimeMs === stat.mtimeMs && entry.ctimeMs === stat.ctimeMs;
  Object.assign(entry, { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs });
  if (unchanged) return;
  const length = Math.min(stat.size, IDENTITY_HEAD);
  if (length <= 0) { entry.identityProbed = true; return; }
  const read = await readWindow(entry.path, entry, 0, length, budget, lane);
  if (!read) return;
  if (read.deferred) { budget.lag = true; return; }
  if (read.changed || read.missing || read.unsafe || read.failed) { budget.lag = true; return; }
  const boundary = ingest(entry, read.data, 0, now, true);
  entry.coveredEnd = Math.max(entry.coveredEnd, read.data.length);
  entry.bootstrapEnd = Math.max(entry.bootstrapEnd, boundary >= 0 ? boundary : 0);
  entry.identityProbed = true;
  if (read.short || boundary < 0) budget.lag = true;
}

function latestTurn(entry) {
  let best = null;
  for (const record of entry.turns.values()) {
    if (record.lastAt === null) continue;
    if (!best || record.lastAt > best.lastAt || (record.lastAt === best.lastAt && record.turn < best.turn)) best = record;
  }
  return best;
}

// An unfinished turn stays in_progress: age is reported through task staleness,
// never as an end that was not observed.
function turnState(record) {
  if (!record) return 'unknown';
  if (record.lastType === 'completed') return 'completed';
  if (record.lastType === 'aborted') return 'aborted';
  return record.lastAt !== null ? 'in_progress' : 'unknown';
}

function currentTurn(entry) {
  const record = latestTurn(entry);
  return record && turnState(record) === 'in_progress' ? record : null;
}

function agentProjection(entry, rootTurnId) {
  const record = latestTurn(entry);
  const usage = record?.usage ?? taskUsageEmpty();
  const ownRoot = record?.root ?? null;
  return {
    id: entry.id,
    parentId: entry.identity?.parentId ?? null,
    role: entry.identity?.role ?? null,
    model: entry.model ?? null,
    effort: entry.effort ?? null,
    rootTurnId: ownRoot,
    association: ownRoot === null || rootTurnId === null ? 'unknown' : ownRoot === rootTurnId ? 'current_turn' : 'other_turn',
    state: turnState(record),
    updatedAt: entry.latest === null ? null : new Date(entry.latest).toISOString(),
    usage,
    usageUpdatedAt: record?.usageAt == null ? null : new Date(record.usageAt).toISOString(),
  };
}

function createTitleIndex({ codexHome, monotonicClock }) {
  const cache = new Map();
  let loadedAt = null, failed = false;
  async function load() {
    const path = join(codexHome, 'session_index.jsonl');
    let handle;
    try {
      const stat = await fs.lstat(path, { bigint: true });
      if (stat.isSymbolicLink() || !stat.isFile()) throw Error('index_unsafe');
      const size = Number(stat.size);
      const offset = Math.max(0, size - INDEX_BYTES);
      const length = Math.min(INDEX_BYTES, size);
      handle = await fs.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n');
      if (offset > 0) lines.shift();
      const rows = [];
      for (const line of lines) {
        if (!line.trim()) continue;
        let row;
        try { row = JSON.parse(line); } catch { continue; }
        if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
        const id = typeof row.id === 'string' && TASK_ID.test(row.id) ? row.id : null;
        const title = sanitizeTitle(row.thread_name ?? row.title);
        if (id && title !== null) rows.push([id, title]);
      }
      if (rows.length) {
        cache.clear();
        for (const [id, title] of rows.slice(-INDEX_LIMIT)) cache.set(id, title);
      }
      failed = false;
    } catch { failed = true; }
    finally { await handle?.close(); }
    loadedAt = monotonicClock();
  }
  return {
    async refresh(force = false) {
      if (!force && loadedAt !== null && monotonicClock() - loadedAt < INDEX_TTL_MS) return;
      await load();
    },
    get(id) {
      if (failed || !cache.has(id)) return null;
      const title = cache.get(id);
      cache.delete(id); cache.set(id, title);
      return title;
    },
  };
}

export function createTaskSummary({
  sessionsDir,
  codexHome = resolve(sessionsDir ?? '.', '..'),
  wallClock = () => Date.now(),
  monotonicClock = () => performance.now(),
  refreshIntervalMs = 1000,
  budgetBytes = ROUND_BYTES,
} = {}) {
  const cache = new Map();
  const titles = createTitleIndex({ codexHome, monotonicClock });
  const discovery = { queue: [[]], walkFiles: new Map(), walkDone: false, pinned: new Set(),
    truncated: false, files: new Map(), loadedAt: null, cursor: null, probeCursor: null };
  let last = null, trusted = null, scannedAt = null, chain = Promise.resolve();

  async function scan(pinnedId) {
    const now = wallClock();
    const budget = { metadata: 0, directories: 0, entries: 0, bytes: budgetBytes, lag: false };
    await titles.refresh();
    const tasks = [];
    let error = null, truncated = false;
    try {
      const rootStat = await metadata(budget, () => fs.lstat(sessionsDir, { bigint: true }));
      if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw Error('root_unsafe');
      const root = await metadata(budget, () => fs.realpath(sessionsDir));
      // The TTL belongs to a finished directory listing. It starts when a walk
      // finishes and is never pushed forward by an ordinary sample; otherwise a
      // 2s refresh would postpone re-discovery of new rollout files forever.
      // A walk still in flight is resumed instead of being expired.
      const expired = discovery.walkDone && (discovery.loadedAt === null
        || monotonicClock() - discovery.loadedAt >= DISCOVERY_TTL_MS);
      // While the walk is still in progress the pin simply has not been reached
      // yet; restarting would discard that progress. Only a finished walk that
      // never saw the pin is retried from the top.
      const pinMissing = pinnedId !== null && discovery.walkDone && !discovery.pinned.has(pinnedId)
        && ![...cache.values()].some((entry) => entry.identity?.sessionId === pinnedId);
      const restart = expired || pinMissing;
      const { candidates, complete, finished } = await discover(root, budget, discovery, restart, pinnedId);
      if (restart || finished) discovery.loadedAt = monotonicClock();
      if (!complete) truncated = true;
      if (candidates.length > CANDIDATE_LIMIT) truncated = true;
      const pinned = [];
      const rest = [];
      for (const candidate of candidates) {
        const known = cache.get(candidate.path);
        const isPinned = pinnedId !== null && (candidate.id === pinnedId || known?.identity?.sessionId === pinnedId);
        (isPinned ? pinned : rest).push(candidate);
      }
      const selected = [...pinned, ...rest.slice(0, Math.max(0, CHILD_LRU - pinned.length))];
      if (candidates.length > selected.length) truncated = true;
      // A pinned task is tracked ahead of the budget and survives eviction.
      const keep = new Set(pinned.map((candidate) => candidate.path));
      const tracked = rest.slice(0, Math.max(0, CHILD_LRU - pinned.length));
      const headRead = IDENTITY_HEAD + TAIL_WINDOW;
      // Round-robin from the last file this stream reached, so the tail of a
      // long library is reached after finitely many rounds.
      const rotate = (list, cursor, skip = null, limit = Infinity) => {
        const span = skip === null ? list : list.filter((candidate) => !skip.has(candidate.path));
        const index = cursor === null ? -1 : span.findIndex((candidate) => candidate.path === cursor);
        const ordered = index < 0 ? span.slice() : [...span.slice(index + 1), ...span.slice(0, index + 1)];
        return ordered.slice(0, limit);
      };
      const touch = (candidate) => {
        const entry = cache.get(candidate.path) ?? createEntry(candidate);
        // Re-insert so the most recently touched entries are evicted last.
        cache.delete(candidate.path);
        cache.set(candidate.path, entry);
        return entry;
      };
      // A pinned log is often far larger than one round budget, so a pinned
      // bootstrap does not own the whole lane: it keeps a guaranteed half and
      // leaves the rest for the other sessions instead of wasting it. The half
      // is widened when it could not even fit one atomic pinned read, so the
      // bootstrap still advances every round.
      const pinnedLane = pinned.length && tracked.length
        ? Math.max(Math.floor(budgetBytes / 2), Math.min(headRead, budgetBytes))
        : budgetBytes;
      const pinnedSet = new Set(pinned.map((candidate) => candidate.path));
      await spendLane(pinned, pinnedLane, budgetBytes, budget, async (candidate, lane) => {
        await ingestFile(touch(candidate), candidate.stat, budget, now, lane);
      });
      // Identity probes run over the untouched remainder of the round: a 64 KiB
      // head read is enough to learn whose session a file belongs to, so one
      // round can classify many siblings without ingesting any of them. The
      // probe stream keeps its own cursor, so classification sweeps the whole
      // tracked set across rounds instead of re-probing the newest files.
      if (pinnedId !== null) {
        const probeTargets = tracked.filter((candidate) =>
          !cache.get(candidate.path)?.identityProbed && !pinnedSet.has(candidate.path));
        const probed = await spendLane(rotate(probeTargets, discovery.probeCursor), PROBE_BUDGET,
          IDENTITY_HEAD, budget, async (candidate, lane) => {
          await probeFile(touch(candidate), candidate.stat, budget, now, lane);
        });
        if (probed !== null) discovery.probeCursor = probed.path;
      }
      // Children of the pinned task are ingested before unrelated sessions, and
      // every attempt is capped to one head read: a single large log can never
      // eat the round, and an unchanged file costs nothing.
      const children = [];
      const others = [];
      for (const candidate of tracked) {
        const entry = cache.get(candidate.path);
        const child = pinnedId !== null && entry?.identity?.sessionId === pinnedId;
        (child ? children : others).push(candidate);
      }
      const childSet = new Set(children.map((candidate) => candidate.path));
      const tail = rotate(others, discovery.cursor, null, Math.max(0, CHILD_LRU - childSet.size));
      await spendLane([...children, ...tail], budgetBytes, headRead, budget, async (candidate, lane) => {
        await ingestFile(touch(candidate), candidate.stat, budget, now, lane);
        if (!childSet.has(candidate.path)) discovery.cursor = candidate.path;
      });
      evictCache(cache, keep);
      const entries = [...cache.values()];
      // Conflicting identity/usage evidence is never grouped: a file that
      // contradicts itself cannot be attributed to any root.
      const usable = (entry) => !entry.rejected && !entry.conflict && !entry.usageIdentityConflict;
      const roots = entries.filter((entry) => usable(entry) && entry.identity
        && entry.identity.id === entry.id && entry.identity.sessionId === entry.id);
      for (const entry of entries) {
        if (entry.conflict || entry.usageIdentityConflict || entry.damaged || entry.oversized) truncated = true;
      }
      for (const entry of roots) {
        const members = entries.filter((candidate) => usable(candidate) && candidate.identity?.sessionId === entry.id);
        const current = currentTurn(entry);
        // An idle task reports no root turn: a completed turn is history, not
        // the current association key.
        const rootTurnId = current?.turn ?? null;
        const agents = members.map((member) => agentProjection(member, rootTurnId))
          .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '') || a.id.localeCompare(b.id));
        const cap = agents.length > MAX_AGENTS;
        const updatedAt = members.reduce((max, member) => Math.max(max, member.latest ?? 0), 0) || null;
        const partial = members.some((member) => !coverageComplete(member)
          || member.damaged || member.oversized || member.conflict || member.usageIdentityConflict);
        tasks.push({
          id: entry.id,
          updatedAt,
          rootTurnId,
          stale: updatedAt === null || now - updatedAt > STALE_MS || budget.lag,
          truncated: cap || partial || truncated,
          currentTurn: current ? { id: current.turn, usage: current.usage ?? taskUsageEmpty(),
            usageUpdatedAt: current.usageAt == null ? null : new Date(current.usageAt).toISOString() } : null,
          agents: agents.slice(0, MAX_AGENTS),
        });
      }
    } catch (caught) {
      error = caught.message === 'root_unsafe' ? 'root_unsafe' : /limit/.test(caught.message) ? 'budget_exceeded' : 'read_failed';
    }
    tasks.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || a.id.localeCompare(b.id));
    if (tasks.length > MAX_TASKS) truncated = true;
    // The pinned task survives the response cap even when it is not among the
    // most recently updated roots.
    let published = tasks.slice(0, MAX_TASKS);
    if (pinnedId !== null && !published.some((task) => task.id === pinnedId)) {
      const pinnedTask = tasks.find((task) => task.id === pinnedId);
      if (pinnedTask) published = [...published.slice(0, Math.max(0, MAX_TASKS - 1)), pinnedTask];
    }
    last = {
      sampledAt: now, error, truncated: truncated || error !== null,
      tasks: published,
    };
    // A failed sample must not erase the last trusted view: keep it for reads
    // and mark it stale instead of publishing an empty list.
    if (error === null) trusted = { sampledAt: last.sampledAt, truncated: truncated, tasks: last.tasks };
    scannedAt = monotonicClock();
    return last;
  }

  function refresh({ pinnedId = null, force = false } = {}) {
    const run = chain.then(() => {
      const fresh = last !== null && scannedAt !== null && monotonicClock() - scannedAt < refreshIntervalMs;
      const covered = pinnedId === null || trusted?.tasks.some((task) => task.id === pinnedId) || last?.tasks.some((task) => task.id === pinnedId);
      if (!force && fresh && covered) return last;
      return scan(pinnedId);
    });
    chain = run.then(() => {}, () => {});
    return run;
  }

  function list() {
    const snapshot = trusted ?? { sampledAt: last?.sampledAt ?? wallClock(), truncated: true, tasks: [] };
    const failed = last !== null && last.error !== null;
    const tasks = snapshot.tasks.map((task) => ({ id: task.id, title: titles.get(task.id),
      updatedAt: task.updatedAt === null ? null : new Date(task.updatedAt).toISOString() }));
    return {
      tasks,
      sampledAt: new Date(snapshot.sampledAt).toISOString(),
      stale: failed || trusted === null || tasks.length === 0 || snapshot.tasks.every((task) => task.stale),
      truncated: failed ? true : snapshot.truncated,
    };
  }

  function detail(taskId, selection = 'pinned') {
    if (trusted === null) return { unavailable: true, reason: last?.error ?? 'not_scanned' };
    const failed = last !== null && last.error !== null;
    const task = trusted.tasks.find((candidate) => candidate.id === taskId);
    // Only a successful sample may prove absence; an unreadable library cannot.
    if (!task) return failed ? { unavailable: true, reason: last.error } : null;
    return {
      task: {
        id: task.id, title: titles.get(task.id), selection,
        rootTurnId: task.rootTurnId,
        updatedAt: task.updatedAt === null ? null : new Date(task.updatedAt).toISOString(),
        stale: failed || task.stale, truncated: failed ? true : task.truncated,
      },
      currentTurn: task.currentTurn,
      agents: task.agents,
      sampledAt: new Date(trusted.sampledAt).toISOString(),
    };
  }

  return { refresh, list, detail, reset: () => {
    cache.clear(); last = null; trusted = null; scannedAt = null;
    discovery.queue = [[]]; discovery.walkFiles = new Map(); discovery.walkDone = false;
    discovery.pinned = new Set(); discovery.truncated = false; discovery.files = new Map();
    discovery.loadedAt = null; discovery.cursor = null; discovery.probeCursor = null;
  } };
}
