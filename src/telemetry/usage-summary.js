import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import zlib from 'node:zlib';

const UUID_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const UUID = new RegExp(`^${UUID_SOURCE}$`);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const FILE = new RegExp(`^rollout-[0-9T:.Z-]+-(${UUID_SOURCE})(?:[_-](${UUID_SOURCE}))?\\.jsonl(\\.zst)?$`);
const DATE_PART = [/^\d{4}$/, /^(0[1-9]|1[0-2])$/, /^(0[1-9]|[12]\d|3[01])$/];
const USAGE_KEYS = ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens'];

export const USAGE_LIMITS = Object.freeze({
  maxFiles: 20_000,
  maxResponses: 200_000,
  // `maxResponses` counts distinct responses, and the same figure used to cap
  // `bookkeeping`, which holds one slot per response *signature*, per native
  // counter interval and per modern endpoint. On this machine 10 856 responses
  // carried 77 824 native intervals and 10 856 endpoints, so the slot budget ran
  // out at 200 000 with the response count still five percent of its own limit.
  // Reaching it set a permanent `budgetExceeded` that froze the whole scan at
  // 1 214 of 6 450 rollouts — the reason today's total read 1.9e8 against a
  // verified 5.9e8. The slot budget is now its own, larger figure.
  maxBookkeeping: 4_000_000,
  maxThreads: 10_000,
  maxDecodedBytes: 96 * 1024 * 1024 * 1024,
  // Rollout rows are not bounded by the counters this scanner keeps: an
  // `event_msg`/`item_completed` row inlines the whole tool output, and a real
  // session measured 12 such rows between 1.1 MB and 2.27 MB. The previous 1 MiB
  // ceiling failed the *entire file* the moment one of them appeared, which is
  // why 46 of 108 files were marked `budget_exceeded` and today's total read
  // 1.72e8 against a verified 5.75e8. The ceiling exists to bound a single
  // buffered line, not to model row size, so it stays generous.
  maxLineBytes: 8 * 1024 * 1024,
  // One archived rollout decompressed past the old 1 GiB per-file ceiling, and
  // hitting that ceiling set a permanent `budgetExceeded` latch. The per-file
  // figure only exists to stop a decompression bomb, so it sits well above a
  // real rollout while the global `maxDecodedBytes` still caps the whole scan.
  // This machine holds 6.2 GB of zstd rollouts that expand several times over,
  // so a 4 GiB ceiling stopped the archive walk part-way and latched
  // `budget_exceeded` on whichever file crossed it.
  maxCompressedDecodedBytes: 24 * 1024 * 1024 * 1024,
});

const DEFAULT_LIMITS = USAGE_LIMITS;
const DEFAULT_CHUNK = 1024 * 1024;
// A round allowance is a scheduling quantum, not a ceiling. It has to be big
// enough that a realistic archive walks forward instead of only re-reading the
// same heads: 8 MiB covered eight files per round while discovery alone needed
// dozens of rounds for this machine's 6 450 rollouts, and the ledger latched a
// permanent `budget_exceeded` before today's session was ever reached.
const DEFAULT_ROUND = 64 * 1024 * 1024;
const MAX_COMPRESSED_FRAME_STAGING = 64 * 1024 * 1024;
const DEFAULT_STALE_MS = 60_000;
const DEFAULT_DISCOVERY_MS = 2_000;
const DEFAULT_BUSY_MS = 5;
const DEFAULT_IDLE_MS = 1_000;
const DEFAULT_DISCOVERY_OPS = 512;
// Discovery spends several operations per file (directory read, lstat,
// realpath), so 512 covered roughly 170 rollouts per round. With 6 450 on disk
// that is ~38 rounds, and because the per-round byte allowance used to latch a
// terminal budget failure the scan never got far enough to see today's session
// at all. Discovery now walks a realistic archive in a handful of rounds while
// still yielding to work between batches.
const DEFAULT_DISCOVERY_OPS_LARGE = 8_192;
const DAY_MS = 24 * 60 * 60 * 1000;
const TIMELINE_RANGE_IDS = ['today', '7d', '30d', '90d', 'all'];
const LEGACY_TIMELINE_RANGE_IDS = ['7d', '30d', '90d', 'all'];

function safeInt(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function inside(root, path) {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep));
}

function statOf(stat) {
  return {
    ino: stat.ino,
    dev: stat.dev,
    size: Number(stat.size),
    mtimeMs: Number(stat.mtimeMs),
    ctimeMs: Number(stat.ctimeMs),
  };
}

function sameFile(a, b) {
  return Boolean(a && b) && a.ino === b.ino && a.dev === b.dev;
}

function sameRevision(a, b) {
  return sameFile(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

function timeValue(value, now) {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed <= now + 5 * 60_000 ? parsed : null;
}

function filenameIdentity(name) {
  const match = basename(name).match(FILE);
  if (!match || name.includes('reverted')) return null;
  return { id: match[1], dual: match[2] ?? null, compressed: Boolean(match[3]) };
}

function usageShape(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const values = {};
  for (const key of USAGE_KEYS) {
    const value = raw[key];
    if (value !== undefined && value !== null && !safeInt(value)) return null;
    values[key] = value ?? null;
  }
  if (![values.input_tokens, values.output_tokens, values.total_tokens].every(safeInt)) return null;
  if (values.total_tokens !== values.input_tokens + values.output_tokens) return null;
  return values;
}

function signatureOf(threadId, usage) {
  return JSON.stringify([threadId, ...USAGE_KEYS.map((key) => usage[key])]);
}

function counterKey(usage) {
  return JSON.stringify([usage.input_tokens, usage.output_tokens, usage.total_tokens]);
}

function sameCounter(a, b) {
  return a.input_tokens === b.input_tokens && a.output_tokens === b.output_tokens
    && a.total_tokens === b.total_tokens;
}

function counterDelta(start, end) {
  if (end.input_tokens < start.input_tokens || end.output_tokens < start.output_tokens
    || end.total_tokens < start.total_tokens) return null;
  return {
    input_tokens: end.input_tokens - start.input_tokens,
    output_tokens: end.output_tokens - start.output_tokens,
    total_tokens: end.total_tokens - start.total_tokens,
  };
}

const ZERO_COUNTER = Object.freeze({ input_tokens: 0, output_tokens: 0, total_tokens: 0 });

export function parseUsageRecord(line, now = Date.now()) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    throw Error('invalid_json');
  }
  if (!event || typeof event !== 'object' || Array.isArray(event)) throw Error('invalid_event');
  const payload = event.payload;
  const type = event.type === 'event_msg' ? payload?.type : event.type;
  if (type === 'compacted') return { type: 'native_compacted' };
  if (type !== 'session_meta' && type !== 'token_usage_record' && type !== 'token_count') return null;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw Error('invalid_payload');
  const timestamp = timeValue(event.timestamp, now);

  if (type === 'session_meta') {
    const id = typeof payload.id === 'string' && ID.test(payload.id) ? payload.id : null;
    const sessionId = typeof payload.session_id === 'string' && ID.test(payload.session_id) ? payload.session_id : null;
    const spawn = payload.source && typeof payload.source === 'object' && !Array.isArray(payload.source)
      ? payload.source.subagent?.thread_spawn : null;
    const payloadParent = typeof payload.parent_thread_id === 'string' && ID.test(payload.parent_thread_id)
      ? payload.parent_thread_id
      : null;
    const spawnParent = typeof spawn?.parent_thread_id === 'string' && ID.test(spawn.parent_thread_id)
      ? spawn.parent_thread_id : null;
    const parentConflict = Boolean(payloadParent && spawnParent && payloadParent !== spawnParent);
    const parentId = parentConflict ? undefined : payloadParent ?? spawnParent;
    const forked = payload.forked_from_id != null || payload.forked_from != null;
    return { type, timestamp, threadId: id, sessionId, parentId, parentConflict, forked };
  }

  if (type === 'token_count') {
    const info = payload.info;
    return {
      type: 'native', timestamp,
      missing: info == null,
      usage: usageShape(info?.total_token_usage),
      lastUsage: usageShape(info?.last_token_usage),
    };
  }

  const responseId = typeof payload.response_id === 'string' && ID.test(payload.response_id) ? payload.response_id : null;
  const threadId = typeof payload.thread_id === 'string' && ID.test(payload.thread_id) ? payload.thread_id : null;
  const sessionId = typeof payload.session_id === 'string' && ID.test(payload.session_id) ? payload.session_id : null;
  const raw = payload.usage;
  if (raw == null) {
    if (payload.turn_token_usage != null || payload.thread_token_usage != null) {
      return { type: 'legacy', timestamp, threadId, sessionId, responseId };
    }
    return { type: 'invalid', timestamp, reason: 'usage_missing', threadId, sessionId, responseId };
  }
  const usage = usageShape(raw);
  if (!usage) return { type: 'invalid', timestamp, reason: 'usage_invalid', threadId, sessionId, responseId, usage: null };
  if (!responseId || !threadId || !sessionId || !timestamp) {
    return { type: 'invalid', timestamp, reason: 'identity_invalid', threadId, sessionId, responseId, usage };
  }
  return {
    type: 'usage', timestamp, responseId, threadId, sessionId, usage,
    threadUsage: usageShape(payload.thread_token_usage),
    signature: signatureOf(threadId, usage),
  };
}

function emptyCoverage() {
  return {
    discoveredFiles: 0,
    completeFiles: 0,
    pendingFiles: 0,
    excludedFiles: 0,
    failedFiles: 0,
    responsesCounted: 0,
    nativeIncrementsCounted: 0,
    conversationsCounted: 0,
    subagentThreadsCounted: 0,
    legacyOnlyConversations: 0,
    duplicateResponses: 0,
    conflictingResponses: 0,
    invalidResponses: 0,
    complete: false,
  };
}

function incompleteCoverage(coverage) {
  return { ...coverage, complete: false };
}

function reasonForGaps({
  pending = 0,
  failed = 0,
  discoveryFailed = false,
  excluded = 0,
  conflicts = 0,
  invalid = 0,
  legacy = 0,
  ownership = 0,
  budget = false,
} = {}) {
  if (budget) return 'budget_exceeded';
  if (failed || discoveryFailed) return 'read_failed';
  if (excluded) return 'compressed_unsupported';
  if (conflicts) return 'identity_conflict';
  if (invalid) return 'invalid_usage';
  if (legacy) return 'legacy_usage_only';
  if (ownership) return 'ownership_unverified';
  if (pending) return 'scan_in_progress';
  return null;
}

function increment(map, key, amount = 1) {
  map.set(key, (map.get(key) ?? 0) + amount);
}

class ResponseLedger {
  constructor(limits) {
    this.limits = limits;
    this.responses = new Map();
    this.threads = new Map();
    this.legacyThreads = new Map();
    this.invalidRecords = new Map();
    this.nativeIntervals = new Map();
    this.modernEndpoints = new Map();
    this.bookkeeping = 0;
    this.budgetExceeded = false;
  }

  reserveBookkeeping() {
    const ceiling = Number.isSafeInteger(this.limits.maxBookkeeping)
      ? this.limits.maxBookkeeping : this.limits.maxResponses;
    if (this.bookkeeping >= ceiling) {
      this.budgetExceeded = true;
      return false;
    }
    this.bookkeeping++;
    return true;
  }

  releaseBookkeeping() {
    if (this.bookkeeping > 0) this.bookkeeping--;
  }

  addCounterRef(map, entryKeys, key, entry, detail) {
    let item = map.get(key);
    const created = !item;
    if (!item) {
      if (!this.reserveBookkeeping()) return false;
      item = { ...detail, refs: new Map() };
      map.set(key, item);
    }
    if (!item.refs.has(entry.key)) {
      if (!this.reserveBookkeeping()) {
        if (created) {
          map.delete(key);
          this.releaseBookkeeping();
        }
        return false;
      }
      item.refs.set(entry.key, detail.timestamp);
      entryKeys.add(key);
    } else {
      item.refs.set(entry.key, Math.min(item.refs.get(entry.key), detail.timestamp));
    }
    return true;
  }

  removeCounterRef(map, fileKey, key) {
    const item = map.get(key);
    if (!item || !item.refs.delete(fileKey)) return;
    this.releaseBookkeeping();
    if (!item.refs.size) {
      map.delete(key);
      this.releaseBookkeeping();
    }
  }

  addNative(entry, start, record, knownZero = false) {
    const key = JSON.stringify([entry.nativeThreadId, counterKey(start), counterKey(record.usage), knownZero]);
    return this.addCounterRef(this.nativeIntervals, entry.nativeKeys, key, entry, {
      threadId: entry.nativeThreadId, start, end: record.usage, knownZero, timestamp: record.timestamp,
    });
  }

  addModernEndpoint(entry, record) {
    if (!record.threadUsage || !counterDelta(record.usage, record.threadUsage)) return true;
    const key = JSON.stringify([record.responseId, record.signature, counterKey(record.threadUsage)]);
    return this.addCounterRef(this.modernEndpoints, entry.modernKeys, key, entry, {
      responseId: record.responseId, signature: record.signature,
      end: record.threadUsage, timestamp: record.timestamp,
    });
  }

  addResponse(fileKey, signature, record, entry, count = 1) {
    let response = this.responses.get(record.responseId);
    let addedResponse = false;
    if (!response) {
      if (!this.reserveBookkeeping()) return false;
      response = { signatures: new Map() };
      this.responses.set(record.responseId, response);
      addedResponse = true;
    }
    let variant = response.signatures.get(signature);
    if (!variant) {
      if (!this.reserveBookkeeping()) {
        if (addedResponse && response.signatures.size === 0) {
          this.responses.delete(record.responseId);
          this.releaseBookkeeping();
        }
        return false;
      }
      variant = {
        refs: new Set(),
        timestamps: new Map(),
        occurrences: 0,
        threadId: record.threadId ?? null,
        sessionId: record.sessionId ?? null,
        usage: record.usage ?? null,
        invalid: Boolean(record.invalid),
        invalidReason: record.invalidReason ?? null,
      };
      response.signatures.set(signature, variant);
    }
    variant.refs.add(fileKey);
    if (Number.isFinite(record.timestamp)) {
      variant.timestamps.set(fileKey, Math.min(variant.timestamps.get(fileKey) ?? Infinity, record.timestamp));
    }
    variant.occurrences += count;
    return true;
  }

  removeResponse(fileKey, signature, responseId, count = 1) {
    const response = this.responses.get(responseId);
    if (!response) return;
    const variant = response.signatures.get(signature);
    if (!variant) return;
    variant.occurrences -= count;
    variant.timestamps.delete(fileKey);
    if (variant.occurrences <= 0) {
      variant.refs.delete(fileKey);
      response.signatures.delete(signature);
      this.releaseBookkeeping();
    } else {
      // Other entries may still refer to this variant. The file key is only
      // removed once this entry's contribution is fully rolled back.
      variant.refs.delete(fileKey);
    }
    if (response.signatures.size === 0) {
      this.responses.delete(responseId);
      this.releaseBookkeeping();
    }
  }

  addThread(fileKey, threadId, parentId) {
    let thread = this.threads.get(threadId);
    if (!thread) {
      if (this.threads.size >= this.limits.maxThreads) {
        this.budgetExceeded = true;
        return false;
      }
      thread = new Map();
      this.threads.set(threadId, thread);
    }
    let parents = thread.get(fileKey);
    if (!parents) {
      parents = new Set();
      thread.set(fileKey, parents);
    }
    // Keep an undeclared parent as undefined so resolveRoots() can distinguish
    // it from an explicit self-root.
    parents.add(parentId);
    return true;
  }

  removeThread(fileKey, threadId) {
    const thread = this.threads.get(threadId);
    if (!thread) return;
    thread.delete(fileKey);
    if (thread.size === 0) this.threads.delete(threadId);
  }

  addLegacy(fileKey, threadId) {
    if (!threadId) return;
    let refs = this.legacyThreads.get(threadId);
    if (!refs) {
      refs = new Set();
      this.legacyThreads.set(threadId, refs);
    }
    refs.add(fileKey);
  }

  removeLegacy(fileKey, threadId) {
    const refs = this.legacyThreads.get(threadId);
    if (!refs) return;
    refs.delete(fileKey);
    if (refs.size === 0) this.legacyThreads.delete(threadId);
  }

  addInvalid(fileKey, key, record, entry) {
    let detail = this.invalidRecords.get(key);
    if (!detail) {
      if (!this.reserveBookkeeping()) return false;
      detail = {
        refs: new Set(),
        threadId: record.threadId ?? null,
        sessionId: record.sessionId ?? null,
        responseId: record.responseId ?? null,
      };
      this.invalidRecords.set(key, detail);
    }
    detail.refs.add(fileKey);
    entry.invalidKeys.add(key);
    return true;
  }

  removeInvalid(fileKey, key) {
    const detail = this.invalidRecords.get(key);
    if (!detail) return;
    detail.refs.delete(fileKey);
    if (detail.refs.size === 0) {
      this.invalidRecords.delete(key);
      this.releaseBookkeeping();
    }
  }

  parentOf(threadId) {
    const refs = this.threads.get(threadId);
    if (!refs || refs.size === 0) return { known: false, conflict: false, parent: null };
    const values = new Set();
    for (const parents of refs.values()) for (const parent of parents) values.add(parent);
    if (values.size !== 1) return { known: true, conflict: true, parent: null };
    return { known: true, conflict: false, parent: values.values().next().value };
  }

  resolveRoots() {
    const roots = new Map();
    const unresolved = new Map();
    const resolveOne = (start) => {
      if (roots.has(start)) return roots.get(start);
      if (unresolved.has(start)) return null;
      const path = [];
      const positions = new Map();
      let current = start;
      for (;;) {
        if (roots.has(current)) {
          const root = roots.get(current);
          for (const id of path) roots.set(id, root);
          return root;
        }
        if (positions.has(current)) {
          for (const id of path) unresolved.set(id, true);
          return null;
        }
        positions.set(current, path.length);
        path.push(current);
        const info = this.parentOf(current);
        if (!info.known || info.conflict || info.parent === undefined) {
          for (const id of path) unresolved.set(id, true);
          return null;
        }
        if (info.parent === null) {
          for (const id of path) roots.set(id, current);
          return current;
        }
        current = info.parent;
      }
    };
    for (const threadId of this.threads.keys()) resolveOne(threadId);
    for (const response of this.responses.values()) {
      for (const variant of response.signatures.values()) if (variant.threadId) resolveOne(variant.threadId);
    }
    return { roots, unresolved };
  }

  responseState(response) {
    let validCount = 0;
    let invalidCount = 0;
    let valid = null;
    let invalid = null;
    for (const [signature, variant] of response.signatures) {
      if (variant.invalid) {
        invalidCount++;
        invalid ??= { signature, variant };
      } else {
        validCount++;
        valid ??= { signature, variant };
      }
    }
    if (validCount > 1 || (validCount > 0 && invalidCount > 0)) return { state: 'conflict' };
    if (validCount === 1) return { state: 'valid', ...valid };
    if (invalidCount > 0) return { state: 'invalid', ...(invalid ?? {}) };
    return { state: 'invalid' };
  }
}

function newEntry(candidate) {
  const entry = {
    key: candidate.path,
    path: candidate.path,
    source: candidate.source,
    compressed: candidate.compressed,
    id: candidate.identity.id,
    dual: candidate.identity.dual,
    ...candidate.stat,
    observed: null,
    sessionId: null,
    parentId: null,
    metadataConflict: false,
    lineNumber: 0,
    nativeThreadId: null,
    nativeSegmentOwned: false,
    nativeCanStart: false,
    nativePrevious: null,
    nativeReserved: false,
    nativeSeen: false,
    nativeGap: false,
    nativeBroken: false,
    nativeKeys: new Set(),
    modernKeys: new Set(),
    buffer: Buffer.alloc(0),
    offset: 0,
    complete: false,
    failed: false,
    failReason: null,
    excluded: candidate.compressed && typeof zlib.createZstdDecompress !== 'function',
    eofProbe: 0,
    latest: null,
    variantKeys: new Map(),
    invalidKeys: new Set(),
    anonymousInvalid: 0,
    threadMeta: new Map(),
    legacyThreads: new Set(),
    decodedBytes: 0,
    readStream: null,
    decoder: null,
    decoderAborted: false,
    compressedOffset: 0,
    compressedEof: false,
    decoderEnded: false,
    decoderWritableReady: true,
    decoderGeneration: 0,
    decoderWake: null,
    decompressedChunk: null,
    zstdError: null,
    zstdRetryable: null,
    pendingInput: Buffer.alloc(0),
    compressedFrames: [],
    compressedQueuedBytes: 0,
    compressedInputComplete: false,
    lastTouched: 0,
  };
  return entry;
}

function clearEntries(entry) {
  entry.buffer = Buffer.alloc(0);
  entry.offset = 0;
  entry.complete = false;
  entry.failed = false;
  entry.failReason = null;
  entry.eofProbe = 0;
  entry.latest = null;
  entry.variantKeys.clear();
  entry.threadMeta.clear();
  entry.legacyThreads.clear();
  entry.invalidKeys.clear();
  entry.anonymousInvalid = 0;
  entry.decodedBytes = 0;
  entry.compressedOffset = 0;
  entry.compressedEof = false;
  entry.decoderAborted = false;
  entry.decoderEnded = false;
  entry.decoderWritableReady = true;
  entry.decoderGeneration++;
  entry.decoderWake = null;
  entry.decompressedChunk = null;
  entry.zstdError = null;
  entry.zstdRetryable = null;
  entry.pendingInput = Buffer.alloc(0);
  entry.compressedFrames = [];
  entry.compressedQueuedBytes = 0;
  entry.compressedInputComplete = false;
  entry.sessionId = null;
  entry.parentId = null;
  entry.metadataConflict = false;
  entry.lineNumber = 0;
  entry.nativeThreadId = null;
  entry.nativeSegmentOwned = false;
  entry.nativeCanStart = false;
  entry.nativePrevious = null;
  entry.nativeReserved = false;
  entry.nativeSeen = false;
  entry.nativeGap = false;
  entry.nativeBroken = false;
  entry.nativeKeys.clear();
  entry.modernKeys.clear();
}

async function closeEntry(entry) {
  entry.decoderAborted = true;
  try { entry.decoder?.destroy(); } catch {}
  try { entry.readStream?.destroy(); } catch {}
  entry.decoder = null;
  entry.readStream = null;
  entry.decoderEnded = false;
  entry.decoderWritableReady = true;
  entry.decoderGeneration++;
  const wake = entry.decoderWake;
  entry.decoderWake = null;
  entry.decompressedChunk = null;
  entry.zstdRetryable = null;
  entry.pendingInput = Buffer.alloc(0);
  entry.compressedFrames = [];
  entry.compressedQueuedBytes = 0;
  entry.compressedInputComplete = false;
  wake?.();
}

function rollback(entry, ledger) {
  for (const info of entry.variantKeys.values()) {
    ledger.removeResponse(entry.key, info.signature, info.responseId, info.count);
  }
  entry.variantKeys.clear();
  for (const key of entry.invalidKeys) ledger.removeInvalid(entry.key, key);
  entry.invalidKeys.clear();
  for (const threadId of entry.threadMeta.keys()) ledger.removeThread(entry.key, threadId);
  for (const threadId of entry.legacyThreads) ledger.removeLegacy(entry.key, threadId);
  for (const key of entry.nativeKeys) ledger.removeCounterRef(ledger.nativeIntervals, entry.key, key);
  for (const key of entry.modernKeys) ledger.removeCounterRef(ledger.modernEndpoints, entry.key, key);
  entry.nativeKeys.clear();
  entry.modernKeys.clear();
  if (entry.nativeReserved) ledger.releaseBookkeeping();
  entry.nativeReserved = false;
}

function refundDecodedBytes(entry, ledger) {
  ledger.decodedBytes = Math.max(0, ledger.decodedBytes - entry.decodedBytes);
  entry.decodedBytes = 0;
}

async function resetEntry(entry, ledger, stat = null) {
  rollback(entry, ledger);
  await closeEntry(entry);
  refundDecodedBytes(entry, ledger);
  if (stat) {
    entry.ino = stat.ino;
    entry.dev = stat.dev;
    entry.size = stat.size;
    entry.mtimeMs = stat.mtimeMs;
    entry.ctimeMs = stat.ctimeMs;
    entry.observed = stat;
  }
  clearEntries(entry);
}

async function failEntry(entry, ledger, reason) {
  await resetEntry(entry, ledger);
  entry.failed = true;
  entry.failReason = reason;
}

function addSignature(entry, ledger, record, signature, usage = null) {
  const key = `${record.responseId}\u0000${signature}`;
  const existing = entry.variantKeys.get(key);
  if (existing) {
    existing.count++;
    ledger.addResponse(entry.key, signature, { ...record, signature, usage }, entry);
    return true;
  }
  const ok = ledger.addResponse(entry.key, signature, { ...record, signature, usage }, entry);
  if (!ok) return false;
  entry.variantKeys.set(key, {
    signature,
    responseId: record.responseId,
    count: 1,
  });
  return true;
}

function addInvalid(entry, ledger, record, reason) {
  const key = record.responseId
    ? `response:${record.responseId}`
    : `anonymous:${entry.key}:${entry.anonymousInvalid}`;
  if (!ledger.addInvalid(entry.key, key, record, entry)) return false;
  if (!record.responseId) entry.anonymousInvalid++;
  if (record.responseId) {
    const signature = `invalid:${reason}:${record.threadId ?? ''}:${record.sessionId ?? ''}`;
    const added = addSignature(entry, ledger, {
      responseId: record.responseId,
      threadId: record.threadId ?? null,
      sessionId: record.sessionId ?? null,
      invalid: true,
      invalidReason: reason,
    }, signature, null);
    if (!added) {
      ledger.removeInvalid(entry.key, key);
      entry.invalidKeys.delete(key);
      return false;
    }
  }
  return true;
}

function ownIds(entry) {
  return new Set([entry.id, entry.dual].filter(Boolean));
}

function ownsRecord(entry, record) {
  if (!record.threadId || !record.sessionId) return false;
  const ids = ownIds(entry);
  const declaredThreads = new Set([...ids, ...entry.threadMeta.keys()]);
  if (entry.sessionId !== null) declaredThreads.add(entry.sessionId);
  if (!declaredThreads.has(record.threadId)) return false;
  if (!ids.has(record.sessionId) && entry.sessionId !== record.sessionId) return false;
  return true;
}

function recordMeta(entry, ledger, record) {
  const ids = ownIds(entry);
  const self = Boolean(record.threadId) && ids.has(record.threadId);
  if (!self) {
    entry.nativeSegmentOwned = false;
    entry.nativeCanStart = false;
    entry.nativePrevious = null;
    if (entry.nativeSeen) entry.nativeGap = true;
    return true;
  }
  if (!record.threadId || !record.sessionId) {
    entry.nativeSegmentOwned = false;
    entry.nativeCanStart = false;
    entry.nativePrevious = null;
    if (entry.nativeSeen) entry.nativeGap = true;
    addInvalid(entry, ledger, { ...record, responseId: null }, 'identity_invalid');
    return true;
  }
  if (entry.sessionId !== null && entry.sessionId !== record.sessionId) {
    return failEntry(entry, ledger, 'identity_conflict');
  }
  entry.sessionId = record.sessionId;
  if (entry.nativeThreadId && entry.nativeThreadId !== record.threadId) entry.nativeBroken = true;
  entry.nativeThreadId = record.threadId;
  entry.nativeSegmentOwned = true;
  entry.nativeCanStart = entry.lineNumber === 1 && !record.forked && !entry.nativeSeen;
  if (record.parentConflict) entry.metadataConflict = true;
  // A session id identifies the owning conversation, not the parent thread.
  // Only an explicit parent declaration or a self-root can establish a
  // verified chain. An undeclared parent stays unresolved.
  const parent = record.parentConflict
    ? undefined
    : record.threadId === record.sessionId
      ? record.parentId ?? null
      : record.parentId ?? undefined;
  if (!entry.threadMeta.has(record.threadId)) {
    entry.threadMeta.set(record.threadId, parent);
  }
  // A repeated declaration with another parent stays in the ledger as an
  // explicitly unresolved parent chain. Valid usage remains in overall, but
  // can never be silently assigned to a selected conversation.
  if (!ledger.addThread(entry.key, record.threadId, parent)) return false;
  entry.parentId = parent;
  if (record.timestamp !== null) entry.latest = Math.max(entry.latest ?? 0, record.timestamp);
  return true;
}

function ensureRootThread(entry, ledger, threadId) {
  if (entry.threadMeta.has(threadId)) return true;
  entry.threadMeta.set(threadId, null);
  return ledger.addThread(entry.key, threadId, null);
}

function ownershipFailure(entry, ledger, record) {
  // Do not retain an unverified thread identity in either the invalid ledger
  // or response signatures. Otherwise a wrong-owner row could surface as a
  // selected-task gap for the very thread it falsely names.
  addInvalid(entry, ledger, {
    ...record,
    threadId: null,
    sessionId: null,
    responseId: null,
  }, 'identity_mismatch');
  return true;
}

function recordUsage(entry, ledger, record) {
  if (record.timestamp !== null) entry.latest = Math.max(entry.latest ?? 0, record.timestamp);
  if (record.type === 'invalid') {
    if ((record.threadId || record.sessionId) && !ownsRecord(entry, record)) {
      return ownershipFailure(entry, ledger, record);
    }
    addInvalid(entry, ledger, record, record.reason ?? 'usage_invalid');
    return true;
  }
  if (record.type === 'legacy') {
    if ((record.threadId || record.sessionId) && !ownsRecord(entry, record)) {
      return ownershipFailure(entry, ledger, record);
    }
    if (record.threadId) {
      if (!entry.legacyThreads.has(record.threadId)) {
        entry.legacyThreads.add(record.threadId);
        ledger.addLegacy(entry.key, record.threadId);
      }
    }
    return true;
  }
  if (record.type !== 'usage') return true;

  if (!ownsRecord(entry, record)) return ownershipFailure(entry, ledger, record);
  if (entry.sessionId !== null && record.sessionId !== entry.sessionId) {
    addInvalid(entry, ledger, { ...record, usage: null }, 'identity_mismatch');
    return true;
  }
  if (entry.sessionId === null) entry.sessionId = record.sessionId;

  if (record.threadId === record.sessionId) {
    // An independent subagent file can identify its own session while its
    // metadata declares a parent thread. Keep that verified chain instead of
    // flattening it into a synthetic root.
    if (!ensureRootThread(entry, ledger, record.threadId)) return false;
  }
  if (!addSignature(entry, ledger, record, record.signature, record.usage)) return false;
  return ledger.addModernEndpoint(entry, record);
}

function recordNative(entry, ledger, record) {
  entry.nativeSeen = true;
  if (record.timestamp !== null) entry.latest = Math.max(entry.latest ?? 0, record.timestamp);
  if (!entry.nativeSegmentOwned || !entry.nativeThreadId || !entry.sessionId) {
    entry.nativeGap = true;
    entry.nativeCanStart = false;
    return true;
  }
  if (!record.usage || record.timestamp === null) {
    entry.nativeGap = true;
    entry.nativeCanStart = false;
    return true;
  }
  if (!entry.nativeReserved) {
    if (!ledger.reserveBookkeeping()) return false;
    entry.nativeReserved = true;
  }
  const previous = entry.nativePrevious;
  entry.nativePrevious = record.usage;
  if (entry.nativeBroken) return true;
  if (!previous) {
    const verifiedStart = entry.nativeCanStart && record.lastUsage
      && sameCounter(record.usage, record.lastUsage);
    entry.nativeCanStart = false;
    if (!verifiedStart) {
      entry.nativeGap = true;
      return true;
    }
    return ledger.addNative(entry, ZERO_COUNTER, record, record.usage.total_tokens === 0);
  }
  const delta = counterDelta(previous, record.usage);
  if (!delta) {
    // A reset has no stable epoch id. Exclude this thread's native evidence
    // rather than joining equal counters from unrelated epochs.
    entry.nativeBroken = true;
    entry.nativeGap = true;
    return true;
  }
  if (!delta.total_tokens) return true;
  return ledger.addNative(entry, previous, record);
}

function consumeLine(entry, ledger, line, now) {
  entry.lineNumber++;
  if (!line.length) return true;
  if (line.length > ledger.limits.maxLineBytes) return failEntry(entry, ledger, 'budget_exceeded');
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(line);
  } catch {
    return failEntry(entry, ledger, 'read_failed');
  }
  if (text.includes(String.fromCharCode(0))) return failEntry(entry, ledger, 'read_failed');
  let record;
  try {
    record = parseUsageRecord(text, now);
  } catch {
    return failEntry(entry, ledger, 'read_failed');
  }
  if (!record) return true;
  if (record.type === 'session_meta') return recordMeta(entry, ledger, record);
  if (record.type === 'native_compacted') {
    entry.nativeBroken = true;
    if (entry.nativeSeen) entry.nativeGap = true;
    return true;
  }
  if (record.type === 'native') return recordNative(entry, ledger, record);
  return recordUsage(entry, ledger, record);
}

async function consumeBytes(entry, ledger, data, now, final = false) {
  if (!data.length && !final) return true;
  entry.buffer = entry.buffer.length ? Buffer.concat([entry.buffer, data]) : Buffer.from(data);
  let start = 0;
  for (;;) {
    const end = entry.buffer.indexOf(10, start);
    if (end < 0) break;
    const ok = await consumeLine(entry, ledger, entry.buffer.subarray(start, end), now);
    if (!ok) return false;
    start = end + 1;
  }
  if (start) entry.buffer = Buffer.from(entry.buffer.subarray(start));
  if (entry.buffer.length > ledger.limits.maxLineBytes) {
    await failEntry(entry, ledger, 'budget_exceeded');
    return false;
  }
  if (final && entry.buffer.length > 0) {
    const ok = await consumeLine(entry, ledger, entry.buffer, now);
    if (ok) entry.buffer = Buffer.alloc(0);
    return ok;
  }
  return true;
}

async function checkedFile(path) {
  try {
    const before = await fs.lstat(path, { bigint: true });
    if (before.isSymbolicLink() || !before.isFile()) return { unsafe: true };
    const real = await fs.realpath(path);
    if (resolve(real) !== resolve(path)) return { unsafe: true };
    return { stat: statOf(before) };
  } catch (error) {
    if (error.code === 'ENOENT') return { missing: true };
    return { failed: true };
  }
}

async function readPlain(entry, ledger, stat, budget, now) {
  let handle;
  let progressed = false;
  try {
    handle = await fs.open(entry.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = statOf(await handle.stat({ bigint: true }));
    if (!sameFile(opened, stat)) return { changed: true, stat: opened };
    if (entry.offset < stat.size) {
      // The round allowance is a scheduling quantum: running out of it only
      // means the scheduler revisits this file in the next round. The
      // cumulative decoded total is a separate, much larger guard against a
      // runaway archive walk — it is checked here so a caller that narrows
      // `maxDecodedBytes` still sees the documented partial result.
      const remaining = Math.min(ledger.chunkBytes, budget.bytes, stat.size - entry.offset);
      if (remaining === 0 && entry.offset < stat.size) {
        // The round allowance is spent, so this file waits for the next round.
        // Reporting `progressed: false` is enough — the scheduler sees no byte
        // movement and stops offering this entry within the same round.
        return { progressed: false };
      }
      if (remaining > 0) {
        if (ledger.decodedBytes + remaining > ledger.limits.maxDecodedBytes) {
          ledger.budgetExceeded = true;
          return { failed: true };
        }
        const buffer = Buffer.alloc(remaining);
        const { bytesRead } = await handle.read(buffer, 0, remaining, entry.offset);
        if (bytesRead > 0) {
          entry.offset += bytesRead;
          budget.bytes -= bytesRead;
          entry.decodedBytes += bytesRead;
          ledger.decodedBytes += bytesRead;
          progressed = true;
          const ok = await consumeBytes(entry, ledger, buffer.subarray(0, bytesRead), now);
          if (!ok) return { failed: true };
        }
      }
    }
    const after = statOf(await handle.stat({ bigint: true }));
    if (!sameRevision(after, stat)) return { changed: true, stat: after };
    if (entry.offset >= stat.size) {
      if (!entry.buffer.length) {
        entry.complete = true;
        entry.eofProbe = 0;
      } else {
        entry.eofProbe++;
        if (entry.eofProbe >= 2) {
          const ok = await consumeBytes(entry, ledger, Buffer.alloc(0), now, true);
          if (!ok) return { failed: true };
          if (!entry.buffer.length) entry.complete = true;
          else await failEntry(entry, ledger, 'read_failed');
        }
      }
    } else {
      entry.eofProbe = 0;
    }
    return { progressed };
  } catch {
    return { failed: true };
  } finally {
    await handle?.close();
  }
}

function wakeDecoder(entry) {
  const wake = entry.decoderWake;
  entry.decoderWake = null;
  wake?.();
}

function readDecoderOutput(entry, ledger, current) {
  if (!current() || entry.zstdError || entry.decoderAborted || entry.decompressedChunk) return;
  let chunk;
  try {
    chunk = entry.decoder.read();
  } catch (error) {
    entry.zstdError = error;
    wakeDecoder(entry);
    return;
  }
  if (chunk === null) return;
  const bytes = chunk.length;
  const entryDecoded = entry.decodedBytes + bytes;
  const totalDecoded = ledger.decodedBytes + bytes;
  // Two separate guards: one rollout, and the whole archive. The per-file figure
  // sits above any real rollout so only a decompression bomb trips it. The
  // archive figure used to be 4 GiB, which this machine's 6.2 GB of zstd
  // rollouts (expanding several times over) crossed part-way through the walk,
  // latching a permanent `budget_exceeded` on whichever file happened to reach
  // it — the reason today's total read 1.9e8 against a verified 5.9e8.
  if (entryDecoded > ledger.limits.maxCompressedDecodedBytes
    || totalDecoded > ledger.limits.maxDecodedBytes) {
    ledger.budgetExceeded = true;
    entry.zstdError = Error('budget_exceeded');
    try { entry.decoder.destroy(); } catch {}
    wakeDecoder(entry);
    return;
  }
  entry.decodedBytes = entryDecoded;
  ledger.decodedBytes = totalDecoded;
  entry.decompressedChunk = chunk;
  wakeDecoder(entry);
}

function createDecoder(zstdFactory, entry, ledger) {
  const decoder = zstdFactory();
  const generation = ++entry.decoderGeneration;
  const current = () => entry.decoder === decoder && entry.decoderGeneration === generation;
  entry.decoderEnded = false;
  entry.decoderWritableReady = true;
  decoder.on('readable', () => {
    if (!current()) return;
    readDecoderOutput(entry, ledger, current);
    wakeDecoder(entry);
  });
  decoder.on('drain', () => {
    if (!current()) return;
    entry.decoderWritableReady = true;
    wakeDecoder(entry);
  });
  decoder.on('error', (error) => {
    if (!current()) return;
    entry.zstdError = error;
    wakeDecoder(entry);
  });
  decoder.on('end', () => {
    if (!current()) return;
    readDecoderOutput(entry, ledger, current);
    entry.decoderEnded = true;
    wakeDecoder(entry);
  });
  return decoder;
}

function decoderSettled(entry) {
  return entry.decoderAborted || Boolean(entry.zstdError) || Boolean(entry.decompressedChunk)
    || entry.decoderEnded;
}

function waitDecoderProgress(entry) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (entry.decoderWake === wake) entry.decoderWake = null;
      resolve();
    };
    const wake = () => finish();
    entry.decoderWake = wake;
    if (decoderSettled(entry)) finish();
  });
}

const ZSTD_MAGIC = 0xFD2FB528;
const ZSTD_SKIPPABLE_MIN = 0x184D2A50;
const ZSTD_SKIPPABLE_MAX = 0x184D2A5F;
const ZSTD_MAX_HEADER_BYTES = 18;

function zstdFrameLength(input, final) {
  if (input.length === 0) return 0;
  if (input.length < 4) {
    if (!final) return 0;
    return -1;
  }
  const magic = input.readUInt32LE(0);
  if (magic >= ZSTD_SKIPPABLE_MIN && magic <= ZSTD_SKIPPABLE_MAX) {
    if (input.length < 8) return final ? -1 : 0;
    const end = 8 + input.readUInt32LE(4);
    if (end > input.length) return final ? -1 : 0;
    return end;
  }
  if (magic !== ZSTD_MAGIC) return -1;
  if (input.length < 5) return final ? -1 : 0;

  const descriptor = input[4];
  if (descriptor & 0x08) return -1; // reserved bit
  const singleSegment = Boolean(descriptor & 0x20);
  const checksum = Boolean(descriptor & 0x04);
  const dictionaryBytes = [0, 1, 2, 4][descriptor & 0x03];
  const contentFlag = descriptor >> 6;
  const contentBytes = [singleSegment ? 1 : 0, 2, 4, 8][contentFlag];
  const windowBytes = singleSegment ? 0 : 1;
  const headerBytes = 5 + dictionaryBytes + windowBytes + contentBytes;
  if (headerBytes > ZSTD_MAX_HEADER_BYTES) return -1;
  if (input.length < headerBytes) return final ? -1 : 0;

  let offset = headerBytes;
  for (;;) {
    if (input.length < offset + 3) return final ? -1 : 0;
    const blockHeader = input[offset]
      | (input[offset + 1] << 8)
      | (input[offset + 2] << 16);
    offset += 3;
    const blockType = (blockHeader >>> 1) & 0x03;
    const blockSize = blockHeader >>> 3;
    if (blockType === 3) return -1;
    const payloadBytes = blockType === 1 ? 1 : blockSize;
    if (input.length < offset + payloadBytes) return final ? -1 : 0;
    offset += payloadBytes;
    if (blockHeader & 0x01) {
      if (checksum) {
        if (input.length < offset + 4) return final ? -1 : 0;
        offset += 4;
      }
      return offset;
    }
  }
}

function splitZstdInput(entry, bytes, limit, complete = false) {
  if (entry.pendingInput.length + bytes.length > limit) {
    entry.zstdError = Error('budget_exceeded');
    entry.pendingInput = Buffer.alloc(0);
    entry.compressedFrames = [];
    entry.compressedQueuedBytes = 0;
    return [];
  }
  entry.pendingInput = entry.pendingInput.length
    ? Buffer.concat([entry.pendingInput, bytes]) : Buffer.from(bytes);
  const frames = [];
  for (;;) {
    const length = zstdFrameLength(entry.pendingInput, complete);
    if (length === 0) break;
    if (length < 0) {
      entry.zstdError = Error('invalid_zstd_stream');
      return frames;
    }
    frames.push(entry.pendingInput.subarray(0, length));
    entry.pendingInput = entry.pendingInput.subarray(length);
  }
  if (complete && entry.pendingInput.length) {
    const error = Error('truncated_zstd_stream');
    // A compressed append can expose a partial next frame while the writer is
    // still publishing it. Keep that tail for the next revision instead of
    // poisoning the current decoder.
    entry.zstdRetryable = error;
    return frames;
  }
  return frames;
}

async function feedCompressed(entry, ledger, budget) {
  if (entry.zstdError) return false;
  if (!entry.decoder) {
    entry.decoder = createDecoder(ledger.zstdFactory, entry, ledger);
    entry.decoderAborted = false;
    entry.compressedEof = false;
  }
  while (budget.bytes > 0 && !entry.zstdError && !entry.decoderAborted) {
    const current = entry.decoder;
    const generation = entry.decoderGeneration;
    const isCurrent = () => entry.decoder === current && entry.decoderGeneration === generation;
    readDecoderOutput(entry, ledger, isCurrent);
    if (entry.decompressedChunk) return true;
    if (entry.compressedEof) return true;
    if (!entry.decoderWritableReady) {
      await waitDecoderProgress(entry);
      if (entry.zstdError || entry.decoderAborted) return false;
      continue;
    }
    if (entry.compressedFrames.length) {
      const frame = entry.compressedFrames[0];
      try {
        entry.decoderWritableReady = entry.decoder.write(frame) !== false;
      } catch (error) {
        entry.zstdError = error;
        return false;
      }
      entry.compressedFrames.shift();
      entry.compressedQueuedBytes -= frame.length;
      readDecoderOutput(entry, ledger, isCurrent);
      continue;
    }
    if (entry.compressedInputComplete && !entry.decoderEnded) {
      entry.compressedEof = true;
      try {
        entry.decoder.end();
      } catch (error) {
        entry.zstdError = error;
        return false;
      }
      if (entry.zstdError) return false;
      return true;
    }
    if (entry.compressedOffset >= entry.size) {
      entry.compressedEof = true;
      return true;
    }
    const remaining = Math.min(256 * 1024, entry.size - entry.compressedOffset, budget.bytes);
    if (remaining <= 0) return true;
    let handle;
    let bytesRead;
    let bytes;
    try {
      handle = await fs.open(entry.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const opened = statOf(await handle.stat({ bigint: true }));
      if (!sameFile(opened, entry)) {
        entry.zstdRetryable = Error('file_replaced');
        return false;
      }
      const buffer = Buffer.alloc(remaining);
      ({ bytesRead } = await handle.read(buffer, 0, remaining, entry.compressedOffset));
      if (bytesRead <= 0) return true;
      bytes = buffer.subarray(0, bytesRead);
    } catch {
      return false;
    } finally {
      await handle?.close();
    }
    if (entry.decoderAborted || !isCurrent()) return false;
    entry.compressedOffset += bytesRead;
    budget.bytes = Math.max(0, budget.bytes - bytesRead);
    const completeInput = entry.compressedOffset >= entry.size;
    const frames = splitZstdInput(entry, bytes, ledger.compressedFrameCap, completeInput);
    if (entry.zstdError) return false;
    entry.compressedInputComplete = completeInput && !entry.pendingInput.length;
    const queuedBytes = frames.reduce((sum, frame) => sum + frame.length, entry.compressedQueuedBytes);
    if (entry.pendingInput.length + queuedBytes > ledger.compressedFrameCap) {
      entry.zstdError = Error('budget_exceeded');
      entry.pendingInput = Buffer.alloc(0);
      entry.compressedFrames = [];
      entry.compressedQueuedBytes = 0;
      entry.compressedInputComplete = false;
      return false;
    }
    entry.compressedFrames.push(...frames);
    entry.compressedQueuedBytes = queuedBytes;
    if (entry.zstdRetryable) return false;
  }
  return !entry.zstdError && !entry.decoderAborted;
}

async function resetCompressedDecoder(entry) {
  entry.decoderAborted = true;
  try { entry.decoder?.destroy(); } catch {}
  entry.decoder = null;
  entry.decoderEnded = false;
  entry.decoderWritableReady = true;
  entry.decoderGeneration++;
  entry.decompressedChunk = null;
  wakeDecoder(entry);
  entry.zstdError = null;
  entry.zstdRetryable = null;
  entry.pendingInput = Buffer.alloc(0);
  entry.compressedFrames = [];
  entry.compressedQueuedBytes = 0;
  entry.compressedInputComplete = false;
  entry.compressedEof = false;
  entry.decoderAborted = false;
}

async function readCompressed(entry, ledger, stat, budget, now) {
  let progressed = false;
  if (entry.decoderAborted) return { failed: true };
  if (entry.size === 0) {
    await consumeBytes(entry, ledger, Buffer.alloc(0), now, true);
    entry.complete = true;
    return { progressed: false };
  }
  while (budget.bytes > 0 && !entry.zstdError && !entry.decoderAborted) {
    let chunk = entry.decompressedChunk;
    if (!chunk && !entry.compressedEof) {
      const ok = await feedCompressed(entry, ledger, budget);
      if (!ok) {
        if (entry.zstdRetryable) {
          const retryStat = await checkedFile(entry.path);
          if (retryStat.stat && sameRevision(retryStat.stat, stat)) {
            return { failed: true };
          }
          return { retry: true, stat: retryStat.stat ?? stat };
        }
        return { failed: true };
      }
      progressed = true;
      chunk = entry.decompressedChunk;
    }
    if (!chunk && entry.compressedEof) {
      const current = entry.decoder;
      const generation = entry.decoderGeneration;
      const isCurrent = () => entry.decoder === current && entry.decoderGeneration === generation;
      readDecoderOutput(entry, ledger, isCurrent);
      chunk = entry.decompressedChunk;
      if (!chunk) {
        if (entry.decoderEnded) break;
        await waitDecoderProgress(entry);
        if (entry.zstdError || entry.decoderAborted) return { failed: true };
        continue;
      }
    }
    if (!chunk) continue;
    const take = Math.min(chunk.length, ledger.chunkBytes, budget.bytes);
    const data = chunk.subarray(0, take);
    entry.decompressedChunk = take < chunk.length ? chunk.subarray(take) : null;
    budget.bytes = Math.max(0, budget.bytes - take);
    const ok = await consumeBytes(entry, ledger, data, now);
    if (!ok) return { failed: true };
    progressed = true;
    if (!entry.decompressedChunk && entry.decoder) {
      const current = entry.decoder;
      const generation = entry.decoderGeneration;
      readDecoderOutput(entry, ledger, () => entry.decoder === current && entry.decoderGeneration === generation);
    }
  }
  if (entry.compressedEof && !entry.decompressedChunk && entry.decoderEnded && budget.bytes > 0) {
    const after = await checkedFile(entry.path);
    if (!after.stat) return { changed: true, stat: after.stat };
    if (!sameFile(after.stat, stat)) return { changed: true, stat: after.stat };
    if (after.stat.size > stat.size) return { changed: true, stat: after.stat };
    if (!sameRevision(after.stat, stat)) return { changed: true, stat: after.stat };
    const ok = await consumeBytes(entry, ledger, Buffer.alloc(0), now, true);
    if (!ok) return { failed: true };
    if (entry.buffer.length) return { failed: true };
    entry.complete = true;
  }
  return { progressed };
}

function observationDiffers(entry) {
  const observed = entry.observed;
  if (!observed) return false;
  return !sameRevision(entry, observed);
}

function retryableFailure(entry) {
  return entry.failed && observationDiffers(entry);
}

function needsWork(entry) {
  if (entry.excluded) return false;
  if (entry.failed) return retryableFailure(entry);
  if (!entry.complete) return true;
  return observationDiffers(entry);
}

function priorityOf(entry, roots, selectedId) {
  if (selectedId) {
    if (entry.id === selectedId || entry.dual === selectedId || entry.sessionId === selectedId) return 0;
    for (const threadId of entry.threadMeta.keys()) {
      if (roots.get(threadId) === selectedId || threadId === selectedId) return 0;
    }
  }
  if (entry.source === 'sessions') return 1;
  return 2;
}

function discoveryLimit(discoveryOps) {
  const value = discoveryOps;
  if (Number.isSafeInteger(value) && value > 0) return value;
  if (value && Number.isSafeInteger(value.limit) && value.limit > 0) return value.limit;
  return DEFAULT_DISCOVERY_OPS_LARGE;
}

function createDiscoveryBatch(discoveryOps, limits) {
  const before = discoveryOps && typeof discoveryOps === 'object'
    && typeof discoveryOps.before === 'function' ? discoveryOps.before : null;
  const after = discoveryOps && typeof discoveryOps === 'object'
    && typeof discoveryOps.after === 'function' ? discoveryOps.after : null;
  const batch = {
    remaining: discoveryLimit(discoveryOps),
    stopped: false,
    operations: 0,
  };
  batch.take = async () => {
    if (batch.stopped || batch.remaining <= 0) return false;
    batch.remaining--;
    batch.operations++;
    await before?.();
    await after?.();
    return !batch.stopped;
  };
  void limits;
  return batch;
}

class DiscoverySuspended extends Error {}

async function closeDiscoveryRoot(rootState) {
  if (!rootState.directory) return;
  const directory = rootState.directory;
  rootState.directory = null;
  try {
    await directory.close();
  } catch {}
}

async function closeDiscoverySweep(sweep) {
  if (!sweep) return;
  for (const rootState of sweep.roots) await closeDiscoveryRoot(rootState);
}

function newDiscoveryRoot(root, source) {
  return {
    root,
    source,
    phase: 'root-lstat',
    readFailed: false,
    directory: null,
    directoryParts: null,
    queue: [],
    pendingFile: null,
  };
}

function revalidationCandidates(files, rootsMap, rootStates, selectedId, cursor) {
  const prioritized = [];
  if (selectedId) {
    for (const entry of files.values()) {
      if (priorityOf(entry, rootsMap, selectedId) !== 0) continue;
      const rootState = rootStates.find((candidate) => inside(candidate.root, entry.path));
      if (!rootState) continue;
      prioritized.push({
        path: entry.path,
        root: rootState.root,
        source: rootState.source,
        identity: {
          id: entry.id,
          dual: entry.dual,
          compressed: entry.compressed,
        },
      });
    }
  }
  prioritized.sort((a, b) => a.path.localeCompare(b.path));
  if (!prioritized.length) return { candidates: new Map(), cursor: 0 };
  const start = cursor % prioritized.length;
  const ordered = [
    ...prioritized.slice(start),
    ...prioritized.slice(0, start),
  ];
  const candidates = new Map();
  for (const candidate of ordered) {
    candidates.set(candidate.path, {
      root: candidate.root,
      source: candidate.source,
      identity: candidate.identity,
    });
  }
  return { candidates, cursor: start };
}

async function discoverStep(rootState, batch, state, commit) {
  const parts = rootState.directoryParts;
  if (rootState.phase === 'root-lstat') {
    if (!await batch.take()) return false;
    try {
      const rootStat = await fs.lstat(rootState.root, { bigint: true });
      if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
        rootState.readFailed = true;
        rootState.phase = 'done';
      } else {
        rootState.phase = 'root-realpath';
      }
    } catch (error) {
      if (error.code !== 'ENOENT') rootState.readFailed = true;
      rootState.phase = 'done';
    }
    return true;
  }

  if (rootState.phase === 'root-realpath') {
    if (!await batch.take()) return false;
    try {
      const realRoot = await fs.realpath(rootState.root);
      // A junction or symlinked root would make later path membership checks
      // ambiguous. Ordinary Windows spellings still compare equal after
      // resolution.
      if (resolve(realRoot) !== resolve(rootState.root)) rootState.readFailed = true;
      else rootState.queue.push([]);
    } catch (error) {
      if (error.code !== 'ENOENT') rootState.readFailed = true;
    }
    rootState.phase = 'next-directory';
    return true;
  }

  if (rootState.phase === 'next-directory') {
    if (!rootState.queue.length) {
      rootState.phase = 'done';
      return true;
    }
    rootState.directoryParts = rootState.queue.shift();
    rootState.phase = 'directory-lstat';
    return true;
  }

  if (rootState.phase === 'directory-lstat') {
    if (!await batch.take()) return false;
    const current = join(rootState.root, ...parts);
    try {
      const before = await fs.lstat(current, { bigint: true });
      if (before.isSymbolicLink() || !before.isDirectory()) {
        rootState.directoryParts = null;
        rootState.phase = 'next-directory';
      } else {
        rootState.phase = 'directory-open';
      }
    } catch (error) {
      if (error.code !== 'ENOENT') rootState.readFailed = true;
      rootState.directoryParts = null;
      rootState.phase = 'next-directory';
    }
    return true;
  }

  if (rootState.phase === 'directory-open') {
    if (!await batch.take()) return false;
    try {
      rootState.directory = await fs.opendir(join(rootState.root, ...parts));
      rootState.phase = 'directory-read';
    } catch (error) {
      if (error.code !== 'ENOENT') rootState.readFailed = true;
      rootState.directoryParts = null;
      rootState.phase = 'next-directory';
    }
    return true;
  }

  if (rootState.phase === 'directory-read') {
    if (!await batch.take()) return false;
    let entry;
    try {
      entry = await rootState.directory.read();
    } catch {
      rootState.readFailed = true;
      await closeDiscoveryRoot(rootState);
      rootState.directoryParts = null;
      rootState.phase = 'next-directory';
      return true;
    }
    if (!entry) {
      await closeDiscoveryRoot(rootState);
      rootState.directoryParts = null;
      rootState.phase = 'next-directory';
      return true;
    }
    if (entry.isSymbolicLink()) return true;
    const child = [...parts, entry.name];
    if (entry.isDirectory()) {
      if (parts.length < 3 && DATE_PART[parts.length].test(entry.name)) {
        rootState.queue.push(child);
      }
      return true;
    }
    if (!entry.isFile() || (parts.length !== 0 && parts.length !== 3)) return true;
    const path = join(rootState.root, ...child);
    const identity = filenameIdentity(entry.name);
    if (!identity) return true;
    rootState.pendingFile = { path, identity };
    rootState.phase = 'file-lstat';
    return true;
  }

  if (rootState.phase === 'file-lstat') {
    if (!await batch.take()) return false;
    const pending = rootState.pendingFile;
    rootState.pendingFile = null;
    rootState.phase = 'directory-read';
    if (!pending) return true;
    try {
      const fileStat = await fs.lstat(pending.path, { bigint: true });
      if (fileStat.isSymbolicLink() || !fileStat.isFile() || !inside(rootState.root, pending.path)) {
        return true;
      }
      if (state.seen.size >= state.limits.maxFiles && !state.seen.has(pending.path)) {
        state.budgetExceeded = true;
        return true;
      }
      state.seen.add(pending.path);
      commit({
        path: pending.path,
        source: rootState.source,
        compressed: pending.identity.compressed,
        identity: pending.identity,
        stat: statOf(fileStat),
      });
    } catch (error) {
      if (error.code !== 'ENOENT') rootState.readFailed = true;
    }
    return true;
  }

  return false;
}

async function discoverSweep(sweep, batch, limits, commit) {
  sweep.seen ??= new Set();
  sweep.readFailed ??= false;
  sweep.budgetExceeded ??= false;
  const state = {
    seen: sweep.seen,
    readFailed: sweep.readFailed,
    budgetExceeded: sweep.budgetExceeded,
    pausedForWork: false,
    limits,
  };
  const revalidation = sweep.revalidate ?? new Set();
  if (revalidation.size) {
    const discoveryActive = sweep.roots.some((rootState) => rootState.phase !== 'done');
    let revalidationLimit = batch.remaining;
    if (discoveryActive && batch.remaining > 1) {
      revalidationLimit = Math.max(1, Math.floor(batch.remaining / 2));
    } else if (discoveryActive) {
      revalidationLimit = sweep.revalidationTurn === false ? 0 : 1;
      sweep.revalidationTurn = sweep.revalidationTurn === false;
    }
    await commit.revalidate(revalidation, batch, state, revalidationLimit);
    if (batch.stopped || !batch.remaining) {
      if (commit.pending) {
        commit.pending.clear();
        commit.pending = null;
      }
      sweep.readFailed = state.readFailed
        || sweep.roots.some((rootState) => rootState.readFailed);
      sweep.budgetExceeded = state.budgetExceeded;
      sweep.state = state;
      return state;
    }
  }
  while (!batch.stopped && batch.remaining > 0) {
    const active = sweep.roots.filter((rootState) => rootState.phase !== 'done');
    if (!active.length) break;
    let selected = null;
    for (let offset = 0; offset < sweep.roots.length; offset++) {
      const index = (sweep.cursor + offset) % sweep.roots.length;
      if (sweep.roots[index].phase !== 'done') {
        selected = sweep.roots[index];
        sweep.cursor = (index + 1) % sweep.roots.length;
        break;
      }
    }
    if (!selected) break;
    if (!await discoverStep(selected, batch, state, commit)) break;
    if (commit.pending && commit.pending.size) {
      state.pausedForWork = true;
      break;
    }
  }
  if (commit.pending) {
    commit.pending.clear();
    commit.pending = null;
  }
  sweep.readFailed = state.readFailed
    || sweep.roots.some((rootState) => rootState.readFailed);
  sweep.budgetExceeded = state.budgetExceeded;
  sweep.state = state;
  return state;
}

function makeCoverage(files) {
  const coverage = emptyCoverage();
  for (const entry of files) {
    coverage.discoveredFiles++;
    if (entry.complete) coverage.completeFiles++;
    else if (entry.failed) coverage.failedFiles++;
    else if (entry.excluded) coverage.excludedFiles++;
    else coverage.pendingFiles++;
  }
  return coverage;
}

function usageNumber(value) {
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
}

function usageObject(input, output, total) {
  const values = [usageNumber(input), usageNumber(output), usageNumber(total)];
  if (values.some((value) => value === null)) return null;
  return { inputTokens: values[0], outputTokens: values[1], totalTokens: values[2] };
}

function nativeEvidence(ledger, files) {
  const byThread = new Map();
  const getThread = (threadId) => {
    let thread = byThread.get(threadId);
    if (!thread) {
      thread = { native: [], modern: [], unsafe: false };
      byThread.set(threadId, thread);
    }
    return thread;
  };
  for (const item of ledger.nativeIntervals.values()) getThread(item.threadId).native.push(item);
  for (const entry of files) {
    if (entry.nativeBroken && entry.nativeThreadId) getThread(entry.nativeThreadId).unsafe = true;
  }
  const endpoints = new Map();
  for (const item of ledger.modernEndpoints.values()) {
    const key = JSON.stringify([item.responseId, item.signature]);
    let values = endpoints.get(key);
    if (!values) { values = []; endpoints.set(key, values); }
    values.push(item.end);
  }
  for (const [responseId, response] of ledger.responses) {
    const state = ledger.responseState(response);
    if (state.state !== 'valid') {
      for (const variant of response.signatures.values()) {
        if (variant.threadId && byThread.has(variant.threadId)) getThread(variant.threadId).unsafe = true;
      }
      continue;
    }
    const variant = state.variant;
    if (!byThread.has(variant.threadId)) continue;
    const thread = getThread(variant.threadId);
    const values = endpoints.get(JSON.stringify([responseId, state.signature])) ?? [];
    const end = values[0];
    if (!end || values.some((value) => !sameCounter(value, end))) {
      thread.unsafe = true;
      continue;
    }
    const start = counterDelta(variant.usage, end);
    if (!start) { thread.unsafe = true; continue; }
    thread.modern.push({ start, end, usage: variant.usage });
  }
  const records = [];
  const gaps = new Set();
  for (const [threadId, thread] of byThread) {
    if (!thread.native.length) continue;
    const points = thread.native.flatMap((item) => [item.start, item.end]);
    for (const item of thread.modern) points.push(item.start, item.end);
    points.sort((a, b) => a.total_tokens - b.total_tokens);
    for (let index = 1; index < points.length && !thread.unsafe; index++) {
      if (!counterDelta(points[index - 1], points[index])) thread.unsafe = true;
    }
    thread.modern.sort((a, b) => a.start.total_tokens - b.start.total_tokens
      || a.end.total_tokens - b.end.total_tokens);
    for (let index = 1; index < thread.modern.length; index++) {
      if (thread.modern[index].start.total_tokens < thread.modern[index - 1].end.total_tokens) {
        thread.unsafe = true;
      }
    }
    if (thread.unsafe) { gaps.add(threadId); continue; }
    thread.native.sort((a, b) => a.start.total_tokens - b.start.total_tokens
      || b.end.total_tokens - a.end.total_tokens);
    let acceptedEnd = -1;
    let modernIndex = 0;
    for (const item of thread.native) {
      if (item.knownZero) {
        if (thread.modern.length || acceptedEnd >= 0) continue;
      } else if (item.start.total_tokens < acceptedEnd) {
        if (item.end.total_tokens > acceptedEnd) gaps.add(threadId);
        continue;
      }
      acceptedEnd = Math.max(acceptedEnd, item.end.total_tokens);
      while (modernIndex < thread.modern.length
        && thread.modern[modernIndex].end.total_tokens <= item.start.total_tokens) modernIndex++;
      const remaining = counterDelta(item.start, item.end);
      let covered = false;
      let ambiguous = false;
      for (let index = modernIndex; index < thread.modern.length; index++) {
        const modern = thread.modern[index];
        if (modern.start.total_tokens >= item.end.total_tokens) break;
        if (modern.end.total_tokens <= item.start.total_tokens) continue;
        if (modern.start.total_tokens <= item.start.total_tokens
          && modern.end.total_tokens >= item.end.total_tokens) {
          covered = true;
          break;
        }
        if (modern.start.total_tokens < item.start.total_tokens
          || modern.end.total_tokens > item.end.total_tokens) {
          ambiguous = true;
          break;
        }
        remaining.input_tokens -= modern.usage.input_tokens;
        remaining.output_tokens -= modern.usage.output_tokens;
        remaining.total_tokens -= modern.usage.total_tokens;
      }
      if (ambiguous || !Object.values(remaining).every(safeInt)) { gaps.add(threadId); continue; }
      if (covered || (!remaining.total_tokens && !item.knownZero)) continue;
      let timestamp = Infinity;
      for (const value of item.refs.values()) timestamp = Math.min(timestamp, value);
      records.push({ threadId, usage: remaining, timestamp, native: true });
    }
  }
  return { records, gaps };
}

function validTimeZone(value) {
  if (value === 'UTC') return true;
  if (typeof value !== 'string' || value.length > 100 || !/^[A-Za-z][A-Za-z0-9_+./-]*$/.test(value)) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function createTimeline(records, now, complete) {
  if (!records.length) return null;
  let timeZone = 'UTC';
  try {
    const local = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (validTimeZone(local)) timeZone = local;
  } catch {}
  const utc = timeZone === 'UTC';
  const startOfDay = (timestamp) => {
    const date = new Date(timestamp);
    if (utc) date.setUTCHours(0, 0, 0, 0);
    else date.setHours(0, 0, 0, 0);
    return date.getTime();
  };
  const addDays = (timestamp, days) => {
    const date = new Date(timestamp);
    if (utc) {
      date.setUTCDate(date.getUTCDate() + days);
      date.setUTCHours(0, 0, 0, 0);
    } else {
      date.setDate(date.getDate() + days);
      date.setHours(0, 0, 0, 0);
    }
    return date.getTime();
  };
  const calendarDay = (timestamp) => {
    const date = new Date(timestamp);
    const label = new Date(0);
    // UTC labels measure calendar days without counting 23/25-hour DST days.
    label.setUTCFullYear(
      utc ? date.getUTCFullYear() : date.getFullYear(),
      utc ? date.getUTCMonth() : date.getMonth(),
      utc ? date.getUTCDate() : date.getDate(),
    );
    return label.getTime() / DAY_MS;
  };
  const today = startOfDay(now);
  const to = addDays(today, 1);
  let firstTimestamp = now;
  for (const record of records) firstTimestamp = Math.min(firstTimestamp, record.timestamp);
  const earliest = startOfDay(firstTimestamp);
  const daySpan = calendarDay(to) - calendarDay(earliest);
  const definitions = [
    { id: 'today', from: today, hours: 2 },
    { id: '7d', from: addDays(to, -7), days: 1 },
    { id: '30d', from: addDays(to, -30), days: 3 },
    { id: '90d', from: addDays(to, -90), days: 7 },
    { id: 'all', from: earliest, days: Math.max(1, Math.ceil(daySpan / 14)) },
  ];
  const empty = () => ({ input: 0n, output: 0n, total: 0n, responsesCounted: 0, nativeIncrementsCounted: 0 });
  const add = (target, usage, native) => {
    target.input += BigInt(usage.input_tokens);
    target.output += BigInt(usage.output_tokens);
    target.total += BigInt(usage.total_tokens);
    if (native) target.nativeIncrementsCounted++;
    else target.responsesCounted++;
  };
  const resultUsage = (value) => value.responsesCounted || value.nativeIncrementsCounted || complete
    ? usageObject(value.input, value.output, value.total) : null;
  const ranges = definitions.map((definition) => {
    const aggregate = empty();
    const buckets = [];
    for (let from = definition.from; from < to;) {
      const end = Math.min(to, definition.hours
        ? from + definition.hours * 60 * 60 * 1000 : addDays(from, definition.days));
      buckets.push({ from, to: end, ...empty() });
      from = end;
    }
    for (const record of records) {
      // Keep accepted future clock skew in the current local day and hour bin.
      const timestamp = Math.min(record.timestamp, now);
      if (timestamp < definition.from || timestamp >= to) continue;
      let low = 0;
      let high = buckets.length - 1;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (timestamp < buckets[middle].to) high = middle;
        else low = middle + 1;
      }
      add(aggregate, record.usage, record.native);
      add(buckets[low], record.usage, record.native);
    }
    return {
      id: definition.id,
      from: new Date(definition.from).toISOString(),
      to: new Date(to).toISOString(),
      usage: resultUsage(aggregate),
      responsesCounted: aggregate.responsesCounted,
      nativeIncrementsCounted: aggregate.nativeIncrementsCounted,
      buckets: buckets.map((bucket) => ({
        from: new Date(bucket.from).toISOString(),
        to: new Date(bucket.to).toISOString(),
        usage: resultUsage(bucket),
        responsesCounted: bucket.responsesCounted,
        nativeIncrementsCounted: bucket.nativeIncrementsCounted,
      })),
    };
  });
  return { timeZone, ranges };
}

function updatedAt(files) {
  let latest = null;
  for (const entry of files) if (entry.latest !== null) latest = Math.max(latest ?? 0, entry.latest);
  return latest === null ? null : new Date(latest).toISOString();
}

export function createUsageSummary({
  sessionsDir,
  archivedDir = sessionsDir ? join(dirname(sessionsDir), 'archived_sessions') : null,
  wallClock = () => Date.now(),
  monotonicClock = () => performance.now(),
  scheduler = globalThis,
  zstdFactory = typeof zlib.createZstdDecompress === 'function'
    ? () => zlib.createZstdDecompress() : null,
  limits = {},
  chunkBytes = DEFAULT_CHUNK,
  roundBytes = DEFAULT_ROUND,
  staleMs = DEFAULT_STALE_MS,
  discoveryIntervalMs = DEFAULT_DISCOVERY_MS,
  busyDelayMs = DEFAULT_BUSY_MS,
  idleDelayMs = DEFAULT_IDLE_MS,
  discoveryOps = DEFAULT_DISCOVERY_OPS_LARGE,
  compressedFrameBytes = MAX_COMPRESSED_FRAME_STAGING,
} = {}) {
  const configuredLimits = { ...DEFAULT_LIMITS, ...limits };
  // A caller that narrows `maxResponses` is describing a small, bounded ledger —
  // that is how the usage tests provoke exhaustion. Leaving `maxBookkeeping` at
  // the shipped 4 000 000 would silently ignore such a request, so an explicit
  // `maxResponses` carries over unless the caller names a bookkeeping figure.
  if (Number.isSafeInteger(limits?.maxResponses) && !Number.isSafeInteger(limits?.maxBookkeeping)) {
    configuredLimits.maxBookkeeping = limits.maxResponses;
  }
  const roots = [...new Set([sessionsDir, archivedDir].filter(Boolean))];
  const ledger = new ResponseLedger(configuredLimits);
  ledger.zstdFactory = zstdFactory;
  // The staging cap bounds one compressed frame held in memory before it is
  // handed to the decoder. It must not be derived from the per-round read
  // allowance: tying it to `roundBytes` made a 9.4 MB archived rollout fail
  // outright, because its first frame was larger than the round budget. A real
  // archive carried frames past 8 MiB, so the staging cap is independent and
  // generous while the global decoded limits still bound the scan.
  ledger.compressedFrameCap = Number.isSafeInteger(compressedFrameBytes) && compressedFrameBytes > 0
    ? compressedFrameBytes : MAX_COMPRESSED_FRAME_STAGING;
  ledger.chunkBytes = Math.max(1, Math.min(chunkBytes, DEFAULT_CHUNK));
  ledger.decodedBytes = 0;
  const files = new Map();
  const discovery = { discovered: false, lastAt: null, readFailed: false, budgetExceeded: false };
  let discoverySweep = null;
  let discoveryCommit = null;
  let discoveryBatch = null;
  let overallPublished = null;
  let selectedPublished = null;
  let publishedSelectedId = null;
  let publishedSelectedKnown = false;
  let selectedId = null;
  let started = false;
  let stopped = false;
  let timer = null;
  let chain = Promise.resolve();
  let lastProgress = null;
  let stoppedAt = null;
  let tick = 0;
  let scanExhausted = false;
  let revalidationCursor = 0;
  let retainedSweep = null;
  let retainedPrepared = false;

  function schedule(delay) {
    if (stopped || timer !== null) return;
    timer = scheduler.setTimeout(() => {
      timer = null;
      void runOnce().catch(() => {}).finally(() => {
        if (stopped) return;
        const pending = scanExhausted ? retainedSweep !== null
          : discoverySweep !== null || [...files.values()].some((entry) => needsWork(entry));
        schedule(pending ? busyDelayMs : idleDelayMs);
      });
    }, delay);
  }

  function scheduleSoon() {
    if (stopped) return;
    if (timer !== null) {
      scheduler.clearTimeout(timer);
      timer = null;
    }
    schedule(0);
  }

  async function revalidateRetained() {
    if (!retainedPrepared) {
      await closeDiscoverySweep(discoverySweep);
      discoverySweep = null;
      discoveryCommit = null;
      discoveryBatch = null;
      for (const entry of files.values()) await closeEntry(entry);
      retainedPrepared = true;
    }
    retainedSweep ??= {
      entries: files.values(), entry: null, phase: 'stat', stat: null,
      startedAt: monotonicClock(),
    };
    const sweep = retainedSweep;
    const batch = createDiscoveryBatch(discoveryOps, ledger.limits);
    discoveryBatch = batch;
    while (!stopped && !batch.stopped) {
      if (!sweep.entry) {
        const next = sweep.entries.next();
        if (next.done) {
          // Freshness covers the oldest check, not just the end of a slow
          // sweep. A stalled sweep must still become genuinely stale.
          lastProgress = sweep.startedAt;
          retainedSweep = null;
          break;
        }
        sweep.entry = next.value;
        sweep.phase = 'stat';
        sweep.stat = null;
      }
      if (!await batch.take()) break;
      const entry = sweep.entry;
      try {
        if (sweep.phase === 'realpath') {
          const real = await fs.realpath(entry.path);
          if (resolve(real) !== resolve(entry.path)) {
            await failEntry(entry, ledger, 'unsafe');
            sweep.entry = null;
          } else sweep.phase = 'confirm';
          continue;
        }
        const checked = await fs.lstat(entry.path, { bigint: true });
        const stat = statOf(checked);
        const unsafe = checked.isSymbolicLink() || !checked.isFile();
        if (unsafe || !sameRevision(entry, stat)
          || (sweep.stat && !sameRevision(sweep.stat, stat))) {
          await resetEntry(entry, ledger, stat);
          entry.failed = true;
          entry.failReason = unsafe ? 'unsafe' : 'budget_exceeded';
          sweep.entry = null;
        } else if (sweep.phase === 'stat') {
          sweep.stat = stat;
          sweep.phase = 'realpath';
        } else sweep.entry = null;
      } catch (error) {
        await failEntry(entry, ledger, 'read_failed');
        if (error.code === 'ENOENT') files.delete(entry.key);
        sweep.entry = null;
      }
    }
    discoveryBatch = null;
  }

  async function rememberDiscovery(now) {
    if (!discoverySweep) {
      const rootOrder = roots
        .map((root) => newDiscoveryRoot(root, root === sessionsDir ? 'sessions' : 'archived'));
      discoverySweep = {
        roots: rootOrder,
        cursor: 0,
        revalidate: new Map(),
        revalidationTurn: true,
      };
      discoveryCommit = new Map();
      // Until this sweep finishes, retained entries do not prove current
      // completeness; a removed file may still be in an unvisited directory.
      discovery.discovered = false;
    }
    const batch = createDiscoveryBatch(discoveryOps, ledger.limits);
    discoveryBatch = batch;
    const { roots: rootsMap } = ledger.resolveRoots();
    const revalidation = revalidationCandidates(
      files,
      rootsMap,
      discoverySweep.roots,
      selectedId,
      revalidationCursor,
    );
    discoverySweep.revalidate = revalidation.candidates;
    revalidationCursor = revalidation.cursor;
    const commit = (candidate) => {
      discoveryCommit.set(candidate.path, candidate);
      if (!files.has(candidate.path)) commit.pending.add(candidate.path);
    };
    commit.pending = new Set();
    commit.revalidate = async (paths, batch, state, limit) => {
      let checked = 0;
      while (!batch.stopped && batch.remaining > 0 && paths.size && checked < limit) {
        const [path, entry] = paths.entries().next().value;
        paths.delete(path);
        revalidationCursor++;
        checked++;
        if (!await batch.take()) return;
        try {
          if (!entry || !inside(entry.root, path)) continue;
          const fileStat = await fs.lstat(path, { bigint: true });
          if (fileStat.isSymbolicLink() || !fileStat.isFile()) continue;
          commit({
            path,
            source: entry.source,
            compressed: entry.identity.compressed,
            identity: entry.identity,
            stat: statOf(fileStat),
          });
        } catch (error) {
          if (error.code !== 'ENOENT') state.readFailed = true;
        }
      }
    };
    let state;
    try {
      state = await discoverSweep(
        discoverySweep,
        batch,
        ledger.limits,
        commit,
      );
      if (batch.stopped) throw new DiscoverySuspended();
      if (state.pausedForWork) {
        discovery.lastAt = now;
        discovery.readFailed = state.readFailed;
        if (state.budgetExceeded) {
          discovery.budgetExceeded = true;
          ledger.budgetExceeded = true;
        }
        await mergeDiscoveryCandidates(discoveryCommit, false);
        return 'paused';
      }
      if (batch.remaining <= 0) {
        discovery.lastAt = now;
        discovery.readFailed = state.readFailed;
        if (state.budgetExceeded) {
          discovery.budgetExceeded = true;
          ledger.budgetExceeded = true;
        }
        await mergeDiscoveryCandidates(discoveryCommit, false);
        throw new DiscoverySuspended();
      }
    } catch (error) {
      if (error instanceof DiscoverySuspended) throw error;
      discovery = { ...discovery, discovered: true, readFailed: true };
    }
    if (!state) throw new DiscoverySuspended();
    const reconciled = discoverySweep?.roots.every((rootState) => rootState.phase === 'done');
    if (!reconciled) {
      discovery.lastAt = now;
      discovery.readFailed = discoverySweep?.roots.some((rootState) => rootState.readFailed);
      throw new DiscoverySuspended();
    }
    const completedSweep = discoverySweep;
    const candidates = discoveryCommit;
    discoverySweep = null;
    discoveryCommit = null;
    await closeDiscoverySweep(completedSweep);
    let changed = await mergeDiscoveryCandidates(candidates, true);
    discovery.discovered = true;
    discovery.lastAt = now;
    discovery.readFailed = completedSweep.roots.some((rootState) => rootState.readFailed);
    if (completedSweep?.state?.budgetExceeded) {
      discovery.budgetExceeded = true;
      ledger.budgetExceeded = true;
    }
    return changed;
  }

  async function mergeDiscoveryCandidates(candidates, reconcile) {
    let changed = false;
    if (!candidates) return changed;
    if (reconcile) {
      for (const [path, entry] of [...files]) {
        if (candidates.has(path)) continue;
        await resetEntry(entry, ledger);
        files.delete(path);
        changed = true;
      }
    }
    const selected = (candidate) => Boolean(selectedId) && (
      candidate.identity?.id === selectedId || candidate.identity?.dual === selectedId
    );
    const ordered = [...candidates].sort(([, a], [, b]) => Number(selected(b)) - Number(selected(a)));
    for (const [path, candidate] of ordered) {
      let entry = files.get(path);
      if (!entry) {
        entry = newEntry(candidate);
        if (entry.compressed && typeof zstdFactory !== 'function') entry.excluded = true;
        files.set(path, entry);
        changed = true;
      } else {
        entry.source = candidate.source;
        entry.compressed = candidate.compressed;
        if (entry.compressed && typeof zstdFactory !== 'function') entry.excluded = true;
        else if (!entry.compressed) entry.excluded = false;
        // Discovery observes revisions; it never destroys the committed read
        // boundary that prepare() needs to detect append/replace/truncate.
        entry.observed = candidate.stat;
      }
    }
    return changed;
  }

  async function prepare(entry) {
    const check = await checkedFile(entry.path);
    if (check.missing || check.unsafe) {
      await resetEntry(entry, ledger);
      entry.failed = true;
      entry.failReason = check.missing ? 'missing' : 'unsafe';
      return null;
    }
    if (check.failed) {
      await failEntry(entry, ledger, 'read_failed');
      return null;
    }
    const stat = check.stat;
    if (entry.failed && observationDiffers(entry)) {
      await resetEntry(entry, ledger, stat);
    }
    const replaced = !sameFile(entry, stat);
    const truncated = stat.size < entry.size;
    const replacedSameSize = !replaced && stat.size === entry.size && !sameRevision(entry, stat);
    if (replaced || truncated) {
      await resetEntry(entry, ledger, stat);
      return stat;
    }
    if (replacedSameSize) {
      // A same-size rewrite is a replacement, not an append. Revoke the old
      // revision before re-reading from byte zero.
      await resetEntry(entry, ledger, stat);
      return stat;
    }
    if (stat.size > entry.size) {
      // A growing path may have been rewritten before it grew. Replaying from
      // zero is the only way to avoid retaining rows from the old revision.
      await resetEntry(entry, ledger, stat);
      return stat;
    }
    if (stat.size !== entry.size) {
      entry.ino = stat.ino;
      entry.dev = stat.dev;
      entry.size = stat.size;
    }
    entry.mtimeMs = stat.mtimeMs;
    entry.ctimeMs = stat.ctimeMs;
    return stat;
  }

  async function processEntry(entry, budget, now, rootsMap) {
    if (entry.excluded) return;
    const stat = await prepare(entry);
    if (!stat) return;
    entry.lastTouched = ++tick;
    let result;
    if (entry.compressed) {
      if (!zstdFactory) {
        await resetEntry(entry, ledger);
        entry.excluded = true;
        return;
      }
      result = await readCompressed(entry, ledger, stat, budget, now);
    } else {
      result = await readPlain(entry, ledger, stat, budget, now);
    }
    if (result?.changed) {
      await resetEntry(entry, ledger, result.stat ?? stat);
    } else if (result?.retry) {
      await resetEntry(entry, ledger, result.stat ?? stat);
    } else if (result?.failed && !entry.failed) {
      const budgetExceeded = ledger.budgetExceeded || entry.zstdError?.message === 'budget_exceeded';
      await failEntry(entry, ledger, budgetExceeded ? 'budget_exceeded' : 'read_failed');
    }
    void rootsMap;
  }

  async function scanRound() {
    // `scanExhausted` describes one round, not the process. It is cleared here
    // and re-derived below, so it can never survive as a one-way latch. What
    // remains terminal is a latched ledger/discovery budget, which is a
    // documented fail-closed limit rather than something a later round clears.
    if (ledger.budgetExceeded || discovery.budgetExceeded) {
      scanExhausted = true;
      await revalidateRetained();
      return;
    }
    scanExhausted = false;
    const now = wallClock();
    const due = !discovery.discovered || discovery.lastAt === null
      || now - discovery.lastAt >= discoveryIntervalMs;
    const shouldDiscover = due;
    if (discoverySweep || shouldDiscover) {
      let result;
      try {
        result = await rememberDiscovery(now);
      } catch (error) {
        if (!(error instanceof DiscoverySuspended)) throw error;
      }
      void result;
    }
    if (discovery.readFailed) discovery.discovered = true;
    if (ledger.budgetExceeded || discovery.budgetExceeded) {
      scanExhausted = true;
      return;
    }
    const { roots: rootsMap } = ledger.resolveRoots();
    const budget = { bytes: roundBytes };
    const attempted = new Set();
    while (budget.bytes > 0 && !stopped) {
      const candidates = [...files.values()]
        .filter((entry) => {
          if (!needsWork(entry) || attempted.has(entry.key)) return false;
          return true;
        })
        .sort((a, b) => priorityOf(a, rootsMap, selectedId) - priorityOf(b, rootsMap, selectedId)
          || a.lastTouched - b.lastTouched
          || b.mtimeMs - a.mtimeMs
          || a.path.localeCompare(b.path));
      if (!candidates.length) break;
      const entry = candidates[0];
      const beforeBytes = budget.bytes;
      await processEntry(entry, budget, now, rootsMap);
      if (stopped) break;
      if (ledger.budgetExceeded) {
        scanExhausted = true;
        break;
      }
      const selectedPriority = priorityOf(entry, rootsMap, selectedId) === 0;
      const madeProgress = budget.bytes < beforeBytes;
      if (!selectedPriority || !needsWork(entry) || !madeProgress) {
        attempted.add(entry.key);
      }
    }
    if (scanExhausted) {
      return;
    }
    lastProgress = monotonicClock();
  }

  function runOnce({ discover = false } = {}) {
    if (timer !== null) {
      scheduler.clearTimeout(timer);
      timer = null;
    }
    const run = chain.then(async () => {
      if (stopped) return;
      lastProgress ??= monotonicClock();
      started = true;
      if (discover) discovery.discovered = false;
      await scanRound();
      if (!stopped) publish();
    });
    chain = run.then(() => {}, () => {});
    return run;
  }

  function ensureStarted() {
    if (stopped || started) return;
    started = true;
    schedule(0);
  }

  async function start() {
    ensureStarted();
    return snapshot();
  }

  function taskRoot(taskId, rootsMap) {
    return rootsMap.has(taskId) ? rootsMap.get(taskId) : taskId;
  }

  function taskKnown(taskId, rootsMap) {
    // A task is addressable by its root, its own child file, or a child thread
    // whose verified chain resolves to that root.
    if (rootsMap.has(taskId)) return true;
    for (const root of rootsMap.values()) if (root === taskId) return true;
    for (const entry of files.values()) {
      if (entry.id === taskId || entry.dual === taskId || entry.sessionId === taskId) return true;
      if (entry.threadMeta.has(taskId)) return true;
    }
    return false;
  }

  function fileRelevant(entry, scopeRoot, rootsMap) {
    if (entry.id === scopeRoot || entry.dual === scopeRoot || entry.sessionId === scopeRoot) return true;
    for (const [threadId, parentId] of entry.threadMeta) {
      if (threadId === scopeRoot || rootsMap.get(threadId) === scopeRoot
        || parentId === scopeRoot || (parentId && rootsMap.get(parentId) === scopeRoot)) return true;
    }
    for (const info of entry.variantKeys.values()) {
      const response = ledger.responses.get(info.responseId);
      const variant = response?.signatures.get(info.signature);
      if (variant?.threadId && rootsMap.get(variant.threadId) === scopeRoot) return true;
    }
    return false;
  }

  function selectedRelevantFiles(taskId, rootsMap) {
    const scopeRoot = taskRoot(taskId, rootsMap);
    return [...files.values()].filter((entry) => fileRelevant(entry, scopeRoot, rootsMap));
  }

  function analyze(scopeId = null) {
    const { roots: rootsMap, unresolved } = ledger.resolveRoots();
    const scopeRoot = scopeId === null ? null : taskRoot(scopeId, rootsMap);
    const relevantFiles = scopeId === null ? [...files.values()] : selectedRelevantFiles(scopeId, rootsMap);
    const relevantKeys = new Set(relevantFiles.map((entry) => entry.key));
    const relevantNativeThreads = new Set(relevantFiles.map((entry) => entry.nativeThreadId));
    const coverage = makeCoverage(relevantFiles);
    const native = nativeEvidence(ledger, files.values());
    const timelineRecords = [];
    const now = wallClock();
    let input = 0n;
    let output = 0n;
    let total = 0n;
    let counted = 0;
    let nativeCounted = 0;
    let unknown = 0;
    const conversations = new Set();
    const threads = new Set();
    const subagentThreads = new Set();
    const validThreads = new Set();
    const duplicateSeen = new Set();
    const legacyKeys = new Set();
    const conflictSeen = new Set();
    let invalid = 0;

    for (const [responseId, response] of ledger.responses) {
      const state = ledger.responseState(response);
      if (state.state === 'conflict') {
        let inScope = scopeId === null;
        if (!inScope) {
          for (const variant of response.signatures.values()) {
            if ((variant.threadId && rootsMap.get(variant.threadId) === scopeRoot)
              || [...variant.refs].some((fileKey) => relevantKeys.has(fileKey))) {
              inScope = true;
              break;
            }
          }
        }
        if (inScope && !conflictSeen.has(responseId)) {
          conflictSeen.add(responseId);
          coverage.conflictingResponses++;
        }
        continue;
      }
      if (state.state !== 'valid') continue;
      const variant = state.variant;
      const root = variant.threadId ? rootsMap.get(variant.threadId) ?? null : null;
      const refsRelevant = [...variant.refs].some((fileKey) => relevantKeys.has(fileKey));
      const inScope = scopeId === null || root === scopeRoot;
      if (root === null && (scopeId === null || refsRelevant)) unknown++;
      if (!inScope) continue;
      input += BigInt(variant.usage.input_tokens);
      output += BigInt(variant.usage.output_tokens);
      total += BigInt(variant.usage.total_tokens);
      counted++;
      if (scopeId === null) {
        let timestamp = Infinity;
        for (const value of variant.timestamps.values()) timestamp = Math.min(timestamp, value);
        timelineRecords.push({ timestamp, usage: variant.usage });
      }
      validThreads.add(variant.threadId);
      if (root !== null) {
        conversations.add(root);
        threads.add(variant.threadId);
        if (variant.threadId !== root) subagentThreads.add(variant.threadId);
      }
      if (variant.occurrences > 1 && !duplicateSeen.has(responseId)) {
        duplicateSeen.add(responseId);
        coverage.duplicateResponses++;
      }
    }

    for (const record of native.records) {
      const root = rootsMap.get(record.threadId) ?? null;
      const inScope = scopeId === null || root === scopeRoot;
      if (root === null && (scopeId === null || relevantNativeThreads.has(record.threadId))) {
        unknown++;
      }
      if (!inScope) continue;
      input += BigInt(record.usage.input_tokens);
      output += BigInt(record.usage.output_tokens);
      total += BigInt(record.usage.total_tokens);
      nativeCounted++;
      if (scopeId === null) timelineRecords.push(record);
      validThreads.add(record.threadId);
      if (root !== null) {
        conversations.add(root);
        threads.add(record.threadId);
        if (record.threadId !== root) subagentThreads.add(record.threadId);
      }
    }
    for (const threadId of native.gaps) {
      if (scopeId === null || rootsMap.get(threadId) === scopeRoot
        || relevantNativeThreads.has(threadId)) invalid++;
    }
    for (const entry of relevantFiles) {
      if (entry.nativeSeen && (entry.nativeGap || entry.nativeBroken)) invalid++;
    }

    // Metadata that cannot resolve to a verified root is a coverage gap even
    // when it contributed no valid usage. Keep it in both the global view and
    // the selected view whose files expose the unresolved thread.
    for (const entry of relevantFiles) {
      for (const threadId of entry.threadMeta.keys()) {
        if (!rootsMap.has(threadId)) {
          unknown++;
          break;
        }
      }
    }

    for (const [key, detail] of ledger.invalidRecords) {
      let inScope = scopeId === null;
      if (!inScope) {
        const root = detail.threadId && rootsMap.has(detail.threadId)
          ? rootsMap.get(detail.threadId) : null;
        inScope = root === scopeRoot || [...detail.refs].some((fileKey) => relevantKeys.has(fileKey));
      }
      if (inScope) invalid++;
    }

    for (const [threadId, refs] of ledger.legacyThreads) {
      if (refs.size === 0) continue;
      const root = rootsMap.has(threadId) ? rootsMap.get(threadId) : null;
      const inScope = scopeId === null || root === scopeRoot || threadId === scopeRoot
        || [...refs].some((fileKey) => relevantKeys.has(fileKey));
      if (!inScope) continue;
      // Per-thread precedence: a thread's own valid response ledger makes its
      // cumulative-only rows redundant. A different child in the same
      // conversation can still require an explicit legacy gap.
      if (validThreads.has(threadId)) continue;
      legacyKeys.add(root ?? threadId);
    }

    coverage.responsesCounted = counted;
    coverage.nativeIncrementsCounted = nativeCounted;
    coverage.conversationsCounted = conversations.size;
    coverage.subagentThreadsCounted = subagentThreads.size;
    coverage.legacyOnlyConversations = legacyKeys.size;
    coverage.invalidResponses = invalid;

    const budget = discovery.budgetExceeded || ledger.budgetExceeded
      || relevantFiles.some((entry) => entry.failReason === 'budget_exceeded');
    const values = [input, output, total];
    const totalRecords = counted + nativeCounted;
    const overflow = totalRecords > 0 && values.some((value) => value > BigInt(Number.MAX_SAFE_INTEGER));
    const complete = discovery.discovered && !discovery.readFailed && !budget && !overflow
      && coverage.pendingFiles === 0 && coverage.failedFiles === 0
      && coverage.excludedFiles === 0 && coverage.conflictingResponses === 0
      && coverage.invalidResponses === 0 && coverage.legacyOnlyConversations === 0
      && unknown === 0;
    coverage.complete = complete;
    const gapReason = reasonForGaps({
      pending: coverage.pendingFiles,
      failed: coverage.failedFiles,
      discoveryFailed: discovery.readFailed,
      excluded: coverage.excludedFiles,
      conflicts: coverage.conflictingResponses,
      invalid: coverage.invalidResponses,
      legacy: coverage.legacyOnlyConversations,
      ownership: unknown,
      budget,
    });
    return {
      rootsMap,
      unresolved,
      files: relevantFiles,
      coverage,
      usage: totalRecords && !overflow ? usageObject(input, output, total) : null,
      timeline: scopeId === null && !overflow ? createTimeline(timelineRecords, now, complete) : null,
      counted: totalRecords,
      unknown,
      threads,
      updatedAt: updatedAt(relevantFiles),
      gapReason,
      aggregateOverflow: overflow,
      complete,
    };
  }

  function publish() {
    overallPublished = analyze(null);
    if (selectedId === null) {
      selectedPublished = null;
      publishedSelectedId = null;
      publishedSelectedKnown = false;
      return;
    }
    selectedPublished = analyze(selectedId);
    publishedSelectedId = selectedId;
    publishedSelectedKnown = taskKnown(selectedId, overallPublished.rootsMap);
  }

  function stateFor(result, selected = false) {
    if (stopped || stoppedAt !== null) return { state: 'unavailable', reason: 'scan_interrupted' };
    if (!started) return { state: 'loading', reason: 'scan_in_progress' };
    if (lastProgress !== null && monotonicClock() - lastProgress > staleMs) {
      return { state: 'unavailable', reason: 'snapshot_stale' };
    }
    if (result.aggregateOverflow) return { state: 'partial', reason: 'invalid_usage' };
    if (result.gapReason === 'budget_exceeded') return { state: 'partial', reason: 'budget_exceeded' };
    if (result.counted === 0) {
      if (!discovery.discovered || result.coverage.pendingFiles > 0) {
        return { state: 'loading', reason: 'scan_in_progress' };
      }
      if (selected && result.gapReason === 'ownership_unverified') {
        return { state: 'partial', reason: 'ownership_unverified' };
      }
      return { state: 'unavailable', reason: result.gapReason ?? 'no_usage_data' };
    }
    if (result.complete) {
      if (selected) {
        const overallCoverage = overallPublished?.coverage;
        if (!discovery.discovered || overallCoverage?.pendingFiles > 0) {
          return { state: 'partial', reason: 'scan_in_progress' };
        }
        if (overallCoverage?.failedFiles > 0 || discovery.readFailed) {
          return { state: 'partial', reason: 'read_failed' };
        }
        if (overallCoverage?.excludedFiles > 0) {
          return { state: 'partial', reason: 'compressed_unsupported' };
        }
        if (overallPublished?.gapReason) {
          return { state: 'partial', reason: overallPublished.gapReason };
        }
      }
      return { state: 'available', reason: null };
    }
    if (selected) {
      const overallCoverage = overallPublished?.coverage;
      if (overallCoverage?.failedFiles > 0 || discovery.readFailed) {
        return { state: 'partial', reason: 'read_failed' };
      }
      if (overallCoverage?.excludedFiles > 0) {
        return { state: 'partial', reason: 'compressed_unsupported' };
      }
      if (overallPublished?.gapReason) {
        return { state: 'partial', reason: overallPublished.gapReason };
      }
    }
    return { state: 'partial', reason: result.gapReason ?? 'scan_in_progress' };
  }

  function absentTaskReason() {
    if (overallPublished?.gapReason === 'budget_exceeded') return 'budget_exceeded';
    if (!discovery.discovered) return 'scan_in_progress';
    const coverage = overallPublished?.coverage;
    if (!coverage) return 'scan_in_progress';
    if (coverage.pendingFiles > 0) return 'scan_in_progress';
    if (discovery.readFailed || coverage?.failedFiles > 0) return 'read_failed';
    if (coverage?.excludedFiles > 0) return 'compressed_unsupported';
    return null;
  }

  function blockFor(result, scope, taskId = null) {
    const state = stateFor(result, taskId !== null);
    const stale = state.reason === 'snapshot_stale' || state.reason === 'scan_interrupted';
    const coverage = state.state === 'available'
      ? result.coverage
      : incompleteCoverage(result.coverage);
    const block = {
      state: state.state,
      reason: state.reason,
      scope,
      usage: state.state === 'partial' || state.state === 'available' ? result.usage : null,
      coverage,
      updatedAt: result.updatedAt,
    };
    if (taskId !== null) block.taskId = taskId;
    else block.timeline = state.state === 'partial' || state.state === 'available' ? result.timeline : null;
    if (stale) {
      block.usage = null;
      block.updatedAt = null;
    }
    return block;
  }

  function snapshot({ taskId = null } = {}) {
    if (taskId !== selectedId) {
      selectedId = taskId;
      // A newly selected scope needs its own bounded scan. Never traverse the
      // whole ledger on the request path.
      if (taskId !== null) {
        selectedPublished = null;
        publishedSelectedId = null;
        publishedSelectedKnown = false;
        scheduleSoon();
      } else {
        selectedPublished = null;
        publishedSelectedId = null;
        publishedSelectedKnown = false;
      }
    }
    const overall = overallPublished
      ? blockFor(overallPublished, 'local_all')
      : {
        ...(stopped || stoppedAt !== null
          ? { state: 'unavailable', reason: 'scan_interrupted' }
          : { state: 'loading', reason: 'scan_in_progress' }),
        scope: 'local_all',
        usage: null, coverage: emptyCoverage(), updatedAt: null, timeline: null,
      };
    let selected = null;
    if (taskId !== null) {
      if (!selectedPublished || publishedSelectedId !== taskId) {
        selected = {
          ...(stopped || stoppedAt !== null
            ? { state: 'unavailable', reason: 'scan_interrupted' }
            : { state: 'loading', reason: 'scan_in_progress' }),
          scope: 'selected_task',
          taskId, usage: null, coverage: emptyCoverage(), updatedAt: null,
        };
      } else if (!publishedSelectedKnown && absentTaskReason() === null) {
        selected = {
          state: 'unavailable', reason: 'task_not_found', scope: 'selected_task',
          taskId, usage: null, coverage: incompleteCoverage(selectedPublished.coverage), updatedAt: null,
        };
      } else if (!publishedSelectedKnown) {
        const reason = absentTaskReason();
        if (reason === 'scan_in_progress') {
          selected = {
            state: 'loading', reason, scope: 'selected_task',
            taskId, usage: null, coverage: incompleteCoverage(selectedPublished.coverage), updatedAt: null,
          };
        } else if (reason === 'budget_exceeded') {
          selected = {
            state: 'partial', reason, scope: 'selected_task',
            taskId, usage: null, coverage: incompleteCoverage(selectedPublished.coverage), updatedAt: null,
          };
        } else {
          selected = {
            state: 'unavailable', reason: reason ?? 'no_usage_data', scope: 'selected_task',
            taskId, usage: null, coverage: incompleteCoverage(selectedPublished.coverage), updatedAt: null,
          };
        }
      } else {
        selected = blockFor(selectedPublished, 'selected_task', taskId);
      }
    }
    return { sampledAt: new Date(wallClock()).toISOString(), overall, selected };
  }

  async function stop() {
    if (stopped) {
      await chain;
      return;
    }
    stopped = true;
    stoppedAt = monotonicClock();
    const stoppingSweep = discoverySweep;
    if (discoveryBatch) discoveryBatch.stopped = true;
    discoveryBatch = null;
    if (timer !== null) scheduler.clearTimeout(timer);
    timer = null;
    await closeDiscoverySweep(discoverySweep);
    discoverySweep = null;
    discoveryCommit = null;
    // Wake in-flight writes before waiting for the chain to settle.
    for (const entry of files.values()) await closeEntry(entry);
    await chain;
    // opendir may have completed after the first close attempt and attached
    // its handle to the now-suspended sweep.
    await closeDiscoverySweep(stoppingSweep);
    for (const entry of files.values()) await closeEntry(entry);
    retainedSweep = null;
    overallPublished = null;
    selectedPublished = null;
    publishedSelectedId = null;
    publishedSelectedKnown = false;
  }

  return {
    start,
    ensureStarted,
    runOnce,
    snapshot,
    stop,
    get selectedTaskId() { return selectedId; },
  };
}

export function publicUsageSnapshot(value) {
  const usage = (item) => item ? {
    inputTokens: item.inputTokens,
    outputTokens: item.outputTokens,
    totalTokens: item.totalTokens,
  } : null;
  const timeline = (item) => {
    if (!item || !Array.isArray(item.ranges)) return null;
    const ids = item.ranges.length === TIMELINE_RANGE_IDS.length ? TIMELINE_RANGE_IDS
      : item.timeZone === 'UTC' && item.ranges.length === LEGACY_TIMELINE_RANGE_IDS.length
        ? LEGACY_TIMELINE_RANGE_IDS : null;
    if (!ids || !validTimeZone(item.timeZone)
      || !item.ranges.every((range, index) => range && typeof range === 'object' && !Array.isArray(range)
        && range.id === ids[index] && Array.isArray(range.buckets) && range.buckets.length > 0
        && range.buckets.length <= (range.id === 'today' ? 13 : 14)
        && range.buckets.every((bucket) => bucket && typeof bucket === 'object' && !Array.isArray(bucket)))) return null;
    const validCounts = (record) => {
      const nativeCount = Object.hasOwn(record, 'nativeIncrementsCounted') ? record.nativeIncrementsCounted : 0;
      if (!safeInt(record.responsesCounted) || !safeInt(nativeCount)
        || !safeInt(record.responsesCounted + nativeCount)) return false;
      const count = record.responsesCounted + nativeCount;
      if (record.usage === null) return true;
      if (!record.usage || ![record.usage.inputTokens, record.usage.outputTokens, record.usage.totalTokens].every(safeInt)
        || record.usage.totalTokens !== record.usage.inputTokens + record.usage.outputTokens) return false;
      return count > 0 || record.usage.totalTokens === 0;
    };
    for (const range of item.ranges) {
      if (!validCounts(range) || !range.buckets.every(validCounts)) return null;
      let responses = 0;
      let native = 0;
      const totals = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
      for (const bucket of range.buckets) {
        responses += bucket.responsesCounted;
        native += bucket.nativeIncrementsCounted ?? 0;
        if (bucket.usage) for (const key of Object.keys(totals)) totals[key] += bucket.usage[key];
      }
      if (responses !== range.responsesCounted || native !== (range.nativeIncrementsCounted ?? 0)
        || (range.usage && Object.keys(totals).some((key) => totals[key] !== range.usage[key]))) return null;
    }
    return {
      timeZone: item.timeZone,
      ranges: item.ranges.map((range) => ({
        id: range.id,
        from: range.from,
        to: range.to,
        usage: usage(range.usage),
        responsesCounted: range.responsesCounted,
        nativeIncrementsCounted: range.nativeIncrementsCounted ?? 0,
        buckets: range.buckets.map((bucket) => ({
          from: bucket.from,
          to: bucket.to,
          usage: usage(bucket.usage),
          responsesCounted: bucket.responsesCounted,
          nativeIncrementsCounted: bucket.nativeIncrementsCounted ?? 0,
        })),
      })),
    };
  };
  const block = (item, selected = false) => {
    if (!item) return null;
    const coverage = item.coverage;
    const invalidNative = Object.hasOwn(coverage, 'nativeIncrementsCounted')
      && !safeInt(coverage.nativeIncrementsCounted);
    const out = {
      state: invalidNative ? 'partial' : item.state,
      reason: invalidNative ? 'invalid_usage' : item.reason,
      scope: item.scope,
      usage: invalidNative ? null : usage(item.usage),
      coverage: {
        discoveredFiles: coverage.discoveredFiles,
        completeFiles: coverage.completeFiles,
        pendingFiles: coverage.pendingFiles,
        excludedFiles: coverage.excludedFiles,
        failedFiles: coverage.failedFiles,
        responsesCounted: coverage.responsesCounted,
        nativeIncrementsCounted: invalidNative ? 0 : coverage.nativeIncrementsCounted ?? 0,
        conversationsCounted: coverage.conversationsCounted,
        subagentThreadsCounted: coverage.subagentThreadsCounted,
        legacyOnlyConversations: coverage.legacyOnlyConversations,
        duplicateResponses: coverage.duplicateResponses,
        conflictingResponses: coverage.conflictingResponses,
        invalidResponses: coverage.invalidResponses,
        complete: invalidNative ? false : coverage.complete,
      },
      updatedAt: item.updatedAt,
    };
    if (selected) out.taskId = item.taskId;
    else if (Object.hasOwn(item, 'timeline')) {
      out.timeline = !invalidNative && (item.state === 'available' || item.state === 'partial') ? timeline(item.timeline) : null;
    }
    return out;
  };
  return {
    sampledAt: value.sampledAt,
    overall: block(value.overall),
    selected: block(value.selected, true),
  };
}
