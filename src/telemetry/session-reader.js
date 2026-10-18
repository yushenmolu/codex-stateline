import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, isAbsolute, resolve, sep } from 'node:path';
import { parseUsageLine, sessionIdFromFilename, sessionFilenameIdentity, createTurnState, isolateTurnState, parseTelemetryLine, observeTelemetry, projectTelemetry, unavailableTelemetry } from './usage.js';

const LIMIT = 2 * 1024 * 1024;
const TOTAL_LIMIT = 8 * 1024 * 1024;
const LINE_LIMIT = 256 * 1024;
const FRESH_MS = 600_000;
const PROBE_WINDOW = 2 * LINE_LIMIT;
const discoveryStates = new WeakMap();
const ACTIVITY_TYPES = new Set(['session_meta', 'turn_context', 'task_started', 'task_complete', 'token_usage_record', 'token_count']);
const EMPTY = { inputTokens: null, outputTokens: null, totalTokens: null };
function fileStat(stat) {
  return { ino: stat.ino, dev: stat.dev, size: Number(stat.size), mtimeMs: Number(stat.mtimeMs), ctimeMs: stat.ctimeMs == null ? null : Number(stat.ctimeMs),
    isSymbolicLink: () => stat.isSymbolicLink(), isDirectory: () => stat.isDirectory(), isFile: () => stat.isFile() };
}

function inside(root, path) {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep));
}

function sameRevision(a, b) {
  return a && a.ino === b.ino && a.dev === b.dev && a.size === b.size
    && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

function discoveryState(cache) {
  if (!discoveryStates.has(cache)) discoveryStates.set(cache, { cursor: '', probes: new Map() });
  return discoveryStates.get(cache);
}

async function metadata(budget, operation) {
  if (budget.metadata >= 20_000) throw Error('metadata_limit');
  budget.metadata++;
  return operation();
}

// Recheck every ancestor: realpath alone would allow links back into the root.
async function checkedPath(root, parts, budget) {
  let path = root;
  let stat;
  for (let i = 0; i <= parts.length; i++) {
    if (i) path = join(path, parts[i - 1]);
    stat = fileStat(await metadata(budget, () => fs.lstat(path, { bigint: true })));
    if (stat.isSymbolicLink() || (i < parts.length && !stat.isDirectory())) return null;
    const real = await metadata(budget, () => fs.realpath(path));
    if (!inside(root, real) || resolve(real) !== resolve(path)) return null;
  }
  return stat;
}

async function discover(root, now, budget, cache, state) {
  const files = [];
  const after = [], before = [], seen = new Set();
  let pendingProbes = 0;
  const trim = () => {
    while (files.length + after.length + before.length > 100) {
      if (before.length) before.pop(); else after.pop();
    }
  };
  const patterns = [/^\d{4}$/, /^(0[1-9]|1[0-2])$/, /^(0[1-9]|[12]\d|3[01])$/];
  async function visit(parts) {
    let dir;
    try {
      const stat = await checkedPath(root, parts, budget);
      if (!stat?.isDirectory()) return;
      if (budget.directories >= 512) throw Error('directory_limit');
      budget.directories++;
      dir = await metadata(budget, () => fs.opendir(join(root, ...parts)));
      for (;;) {
        const entry = await dir.read();
        if (!entry) break;
        if (budget.entries >= 10_000) throw Error('entry_limit');
        budget.entries++;
        if (entry.isSymbolicLink()) continue;
        const child = [...parts, entry.name];
        if (entry.isDirectory() && parts.length < 3 && patterns[parts.length].test(entry.name)) {
          await visit(child);
        } else if (entry.isFile() && (parts.length === 0 || parts.length === 3)) {
          const id = sessionIdFromFilename(entry.name);
          if (!id || entry.name.includes('reverted')) continue;
          try {
            const stat = await checkedPath(root, child, budget);
            if (!stat?.isFile()) continue;
            const candidate = { id, parts: child, path: join(root, ...child), stat };
            seen.add(candidate.path);
            const cached = cache.get(candidate.path);
            const probe = state.probes.get(candidate.path);
            const revision = cached && { ...cached, size: cached.observedSize };
            // File times are hints, not proof that the log has no recent events.
            // Recheck known live/bootstrap files even while Windows mtime lags.
            if (stat.mtimeMs >= now - FRESH_MS || (cached && (!sameRevision(revision, stat)
              || !cached.checkedEof || cached.latest >= now - FRESH_MS))
              || (sameRevision(probe?.stat, stat) && probe.latest >= now - FRESH_MS)) {
              if (files.length >= 100) throw Error('candidate_limit');
              files.push(candidate);
              trim();
            } else if (!(cached && sameRevision(revision, stat)) && !(sameRevision(probe?.stat, stat) && probe.done)) {
              pendingProbes++;
              const queue = candidate.path > state.cursor ? after : before;
              queue.push(candidate);
              queue.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
              trim();
            }
          } catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    finally { if (dir) await dir.close(); }
  }
  await visit([]);
  for (const path of state.probes.keys()) if (!seen.has(path)) state.probes.delete(path);
  let probeBytes = LIMIT;
  for (const candidate of [...after, ...before]) {
    const previous = state.probes.get(candidate.path);
    const end = sameRevision(previous?.stat, candidate.stat) ? previous.end : candidate.stat.size;
    const offset = Math.max(0, end - PROBE_WINDOW);
    const length = end - offset;
    if (length > probeBytes || length > budget.bytes) break;
    const initialBudget = budget.bytes;
    let read;
    try { read = await readFile(root, candidate, budget, null, { offset, length, stat: candidate.stat }); }
    catch (error) { if (error.code === 'ENOENT') { pendingProbes--; continue; } throw error; }
    probeBytes -= initialBudget - budget.bytes;
    state.cursor = candidate.path;
    if (!read) { pendingProbes--; continue; }
    if (read.changed || read.deferred) continue;
    if (read.gap) throw Error('read_gap');
    const latest = probeActivity(read.data, offset, now);
    const probe = { stat: read.stat, end: Math.max(0, end - (LINE_LIMIT - 1)), done: offset === 0, latest };
    if (!state.probes.has(candidate.path) && state.probes.size >= 10_000) throw Error('probe_limit');
    state.probes.set(candidate.path, probe);
    if (latest !== null) {
      // A freshness hint grants no identity, counters or turn state. Formal
      // parsing below still starts at zero and must reach a checked EOF.
      files.push(candidate);
      pendingProbes--;
    } else if (probe.done) pendingProbes--;
  }
  files.sort((a, b) => Number(Boolean(cache.get(b.path))) - Number(Boolean(cache.get(a.path)))
    || b.stat.mtimeMs - a.stat.mtimeMs || a.path.localeCompare(b.path));
  return { files, probePending: pendingProbes > 0 };
}

function probeActivity(data, offset, now) {
  let latest = null;
  let start = offset ? data.indexOf(10) + 1 : 0;
  if (offset && !start) return null;
  for (;;) {
    const end = data.indexOf(10, start);
    if (end < 0) break;
    if (end - start <= LINE_LIMIT) {
      try {
        const line = new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(start, end));
        if (!line.includes(String.fromCharCode(0))) {
          const event = JSON.parse(line);
          const type = event?.type === 'event_msg' ? event.payload?.type : event?.type;
          const timestamp = typeof event?.timestamp === 'string' ? Date.parse(event.timestamp) : NaN;
          if (event && typeof event === 'object' && !Array.isArray(event) && ACTIVITY_TYPES.has(type)
            && timestamp >= now - FRESH_MS && timestamp <= now + 300_000) latest = Math.max(latest ?? 0, timestamp);
        }
      } catch { /* Partial or corrupt history is not freshness evidence. */ }
    }
    start = end + 1;
  }
  return latest;
}

async function readFile(root, candidate, budget, cached, window) {
  const stat = await checkedPath(root, candidate.parts, budget);
  if (!stat?.isFile()) return null;
  const f = await metadata(budget, () => fs.open(candidate.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)));
  try {
    const opened = fileStat(await metadata(budget, () => f.stat({ bigint: true })));
    const checked = await checkedPath(root, candidate.parts, budget);
    if (!checked?.isFile() || opened.ino !== checked.ino || opened.dev !== checked.dev || stat.ino !== opened.ino || stat.dev !== opened.dev) return null;
    for (let i = 0; i < 2; i++) {
      const a = fileStat(await metadata(budget, () => f.stat({ bigint: true })));
      if (window && !sameRevision(window.stat, a)) return { changed: true };
      let reusable = cached && cached.ino === a.ino && cached.dev === a.dev
        && a.size >= cached.observedSize && a.size >= cached.offset
        && (a.size !== cached.observedSize || (a.mtimeMs === cached.mtimeMs && a.ctimeMs === cached.ctimeMs));
      // Growth alone does not establish append continuity: truncate/rewrite
      // can keep the inode and exceed the old size. Recheck the consumed
      // boundary without retaining transcript bytes in the cache.
      if (reusable && a.size !== cached.observedSize && cached.offset > 0) {
        const length = cached.boundaryLength ?? 0;
        if (!length) reusable = false;
        else {
          if (budget.bytes < length) return { deferred: true };
          budget.bytes -= length;
          const boundary = Buffer.alloc(length);
          const checkedBoundary = await f.read(boundary, 0, length, cached.offset - length);
          if (checkedBoundary.bytesRead !== length) throw Error('read_gap');
          reusable = createHash('sha256').update(boundary).digest('hex') === cached.boundaryHash;
        }
      }
      if (reusable && cached.subagent) return { excluded: true };
      const offset = window ? window.offset : reusable ? cached.offset : 0;
      if (a.size > offset && budget.bytes === 0) return { deferred: true };
      const readLimit = window ? window.length : !reusable && a.size > LIMIT ? LINE_LIMIT : LIMIT;
      const n = Math.min(a.size - offset, readLimit, budget.bytes);
      // Reserve every attempted read, including unstable-file retries.
      budget.bytes -= n;
      const data = Buffer.alloc(n);
      const got = n ? await f.read(data, 0, n, offset) : { bytesRead: 0 };
      const b = fileStat(await metadata(budget, () => f.stat({ bigint: true })));
      const after = await checkedPath(root, candidate.parts, budget);
      if (!after || after.ino !== b.ino || after.dev !== b.dev) throw Error('file_changed');
      if (a.ino === b.ino && a.dev === b.dev && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs) {
        const boundaryLength = Math.min(got.bytesRead, 4096);
        return { data: data.subarray(0, got.bytesRead), stat: b, reusable, offset: offset + got.bytesRead,
          boundaryLength: boundaryLength || (reusable ? cached.boundaryLength : 0),
          boundaryHash: boundaryLength ? createHash('sha256').update(data.subarray(got.bytesRead - boundaryLength, got.bytesRead)).digest('hex') : (reusable ? cached.boundaryHash : null),
        sameIdentity: cached && cached.ino === b.ino && cached.dev === b.dev,
          eof: offset + got.bytesRead === b.size, gap: got.bytesRead !== n };
      }
      if (window) return { changed: true };
    }
    throw Error('changed');
  } finally { await f.close(); }
}


// Only complete, bounded records ignored by both telemetry parsers may cross
// the normal line limit. Keep decoded content and parsed objects local.
function isIgnoredTelemetryRecord(bytes, candidate, now) {
  if (bytes.length > LIMIT) return false;
  try {
    const line = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (line.includes(String.fromCharCode(0))) return false;
    const record = JSON.parse(line);
    if (record === null || typeof record !== 'object' || Array.isArray(record)) return false;
    if (record.type === 'response_item' || record.type === 'compacted') return true;
    if (record.type !== 'event_msg' || !record.payload || typeof record.payload !== 'object'
      || Array.isArray(record.payload) || record.payload.type !== 'item_completed') return false;
    return parseUsageLine(line, candidate.id, now) === null && parseTelemetryLine(line, now) === null;
  } catch { return false; }
}

function parseFile(read, candidate, now, cached, cache) {
  const entry = read.reusable ? cached : { turn: read.sameIdentity ? isolateTurnState(cached.turn) : createTurnState(), usage: EMPTY, latest: null, remainder: Buffer.alloc(0), stage: 'bootstrap', checkedEof: false, subagent: false };
  Object.assign(entry, { ino: read.stat.ino, dev: read.stat.dev, observedSize: read.stat.size,
    mtimeMs: read.stat.mtimeMs, ctimeMs: read.stat.ctimeMs });
  // Retain checked same-file guard evidence even if a later line throws.
  cache.set(candidate.path, entry);
  const isolate = (oversized = true) => {
    // Metadata identity belongs to this checked file, not to turn continuity.
    // Preserve it and sticky conflicts/replay guards, but require fresh token
    // proof and discard all timing, counters and context across unknown bytes.
    entry.turn = isolateTurnState(entry.turn);
    entry.usage = EMPTY;
    entry.hasGap = true;
    entry.oversizedPending = oversized;
  };
  const data = Buffer.concat([entry.remainder, read.data]);
  entry.remainder = Buffer.alloc(0);
  let start = 0;
  while (start < data.length) {
    const end = data.indexOf(10, start);
    const stop = end < 0 ? data.length : end;
    if (entry.discardLine) {
      entry.discardLine = end < 0;
    } else if (stop - start > LINE_LIMIT) {
      // A sequential chunk boundary may split a complete ignored record. Its
      // bounded bytes survive only until the next read, never an unchecked EOF.
      if (end < 0 && !read.eof && stop - start <= LIMIT) {
        entry.remainder = Buffer.from(data.subarray(start));
      } else if (end < 0 || !isIgnoredTelemetryRecord(data.subarray(start, stop), candidate, now)) {
        isolate();
        entry.discardLine = end < 0;
      }
    } else if (end < 0) {
      entry.remainder = Buffer.from(data.subarray(start));
    } else {
      // Bound each line before decoding or JSON parsing, including UTF-8.
      let line;
      try { line = new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(start, end)); } catch { throw Error('read_failed'); }
      if (line.includes(String.fromCharCode(0))) throw Error('read_failed');
      const event = parseTelemetryLine(line, now);
      const legacy = parseUsageLine(line, candidate.id, now);
      // Inherited VS Code metadata has already passed the legacy identity
      // exception; it cannot classify or establish identity for this file.
      const ownEvent = event?.type === 'session_meta' && !legacy ? null : event;
      if (ownEvent?.type === 'session_meta' && ownEvent.id === candidate.id) entry.subagent ||= Boolean(ownEvent.subagent);
      // An own, identity-checked subagent record excludes the whole file.
      // Its unrelated tail cannot invalidate a main-session candidate.
      if (entry.subagent) break;
      const disposition = observeTelemetry(entry.turn, ownEvent, candidate.id);
      const accepted = !ownEvent || disposition === 'accepted';
      if (accepted && legacy) {
        entry.latest = Math.max(entry.latest ?? 0, legacy.timestamp);
        if (legacy.type === 'token_count') entry.usage = legacy.usage ?? EMPTY;
      }
      // Metadata identifies candidate activity even when it reports a conflict;
      // isolated old-turn records never do. A parsed failure still ends an
      // oversized discard so its precise fail-closed reason can be projected.
      if (legacy?.type === 'session_meta') entry.latest = Math.max(entry.latest ?? 0, legacy.timestamp);
      if (event || legacy) entry.oversizedPending = false;
      if (entry.hasGap && !entry.turn.current && !entry.turn.completed && entry.turn.reason === 'turn_start_missing') entry.turn.reason = 'read_gap';
      if (accepted && event?.type === 'token_usage_record' && event.thread === candidate.id && event.sessionId === candidate.id && event.cumulative) entry.usage = event.cumulative;
      if (accepted && event && event.type !== 'session_meta') entry.latest = Math.max(entry.latest ?? 0, event.timestamp);
    }
    if (end < 0) break;
    start = end + 1;
  }
  if (read.gap) { isolate(false); entry.remainder = Buffer.alloc(0); entry.discardLine = true; }
  Object.assign(entry, { ino: read.stat.ino, dev: read.stat.dev, offset: read.offset, observedSize: read.stat.size,
    mtimeMs: read.stat.mtimeMs, ctimeMs: read.stat.ctimeMs, checkedEof: read.eof,
    boundaryLength: read.boundaryLength, boundaryHash: read.boundaryHash });
  if (read.eof) entry.stage = 'live';
  return entry;
}
function restartCachedEntries(cache) {
  for (const entry of cache.values()) {
    entry.turn = isolateTurnState(entry.turn);
    entry.usage = EMPTY; entry.latest = null; entry.remainder = Buffer.alloc(0);
    entry.offset = 0; entry.checkedEof = false; entry.stage = 'bootstrap';
    entry.discardLine = false; entry.hasGap = true; entry.oversizedPending = false;
  }
}
export function createSessionReader(options) {
  const cache = new Map();
  let running = null;
  return { read: () => {
    if (!running) running = readActiveSession({ ...options, cache }).finally(() => { running = null; });
    return running;
  }, reset: () => { restartCachedEntries(cache); discoveryStates.delete(cache); } };
}

export async function readActiveSession({ sessionsDir, wallClock = () => Date.now(), cache = new Map() }) {
  const now = wallClock();
  try {
    const budget = { directories: 0, entries: 0, metadata: 0, bytes: TOTAL_LIMIT };
    const rootStat = await metadata(budget, () => fs.lstat(sessionsDir));
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw Error('root');
    const root = await metadata(budget, () => fs.realpath(sessionsDir));
    const { files, probePending } = await discover(root, now, budget, cache, discoveryState(cache));
    const active = [];
    let oversizedPending = false, bootstrapPending = false;
    for (const f of files) {
      let parsed = cache.get(f.path);
      let read;
      do {
        try { read = await readFile(root, f, budget, parsed); }
        catch (error) { if (error.code === 'ENOENT') { read = null; break; } throw error; }
        if (!read || read.deferred || read.excluded) break;
        parsed = parseFile(read, f, now, parsed, cache);
        cache.delete(f.path); cache.set(f.path, parsed);
        while (cache.size > 100) cache.delete(cache.keys().next().value);
      } while (!parsed.subagent && !read.eof && !read.gap && budget.bytes > 0);
      if (!read) continue;
      if (parsed?.subagent) continue;
      if (read.deferred || !parsed.checkedEof) { bootstrapPending = true; continue; }
      if (parsed.oversizedPending) { oversizedPending = true; continue; }
      if (parsed.latest !== null && parsed.latest >= now - FRESH_MS) active.push({ id: f.id, usage: parsed.usage,
        eventTimestamp: parsed.latest, mtimeMs: parsed.mtimeMs, telemetry: projectTelemetry(parsed.turn, sessionFilenameIdentity(f.path).dual) });
    }
    // Never publish a historical turn while any main candidate is still being
    // scanned. Budget exhaustion is ordinary progress and preserves the cache.
    if (bootstrapPending || (!active.length && probePending)) return { state: 'unavailable', session: null, usage: EMPTY, eventTimestamp: null,
      ...unavailableTelemetry('bootstrap_in_progress') };
    if (!active.length) return { state: oversizedPending ? 'unavailable' : 'empty', session: null, usage: EMPTY, eventTimestamp: null, ...unavailableTelemetry(oversizedPending ? 'budget_exceeded' : 'no_session') };
    active.sort((a, b) => b.eventTimestamp - a.eventTimestamp || b.mtimeMs - a.mtimeMs || a.id.localeCompare(b.id));
    if (active.length > 1 && Math.abs(active[0].eventTimestamp - active[1].eventTimestamp) <= 1000 && Math.abs(active[0].mtimeMs - active[1].mtimeMs) <= 1000) return { state: 'ambiguous', session: null, usage: EMPTY, eventTimestamp: active[0].eventTimestamp, ...unavailableTelemetry('turn_ambiguous') };
    const x = active[0];
    return { state: 'ok', session: { id: x.id, updatedAt: new Date(x.eventTimestamp).toISOString() }, usage: x.usage, eventTimestamp: x.eventTimestamp, ...x.telemetry };
  } catch (error) {
    // An unproven read/rewrite failure must not erase same-file replay guards
    // or sticky identity/interleaving/capacity evidence. Restart at zero.
    restartCachedEntries(cache);
    for (const entry of cache.values()) {
      if (error.message === 'session_mismatch') entry.turn.identityReason = 'identity_conflict';
    }
    return { state: 'unavailable', session: null, usage: EMPTY, eventTimestamp: null, ...unavailableTelemetry(error.message === 'session_mismatch' ? 'identity_conflict' : /limit|line/.test(error.message) ? 'budget_exceeded' : ['timestamp_invalid','file_changed','read_gap','budget_exceeded'].includes(error.message) ? error.message : 'read_failed') };
  }
}
