import { open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const freshCache = () => ({
  size: null, mtimeMs: null, tail: '', skipping: false,
  records: [], matched: new Map(), bad: false, badSessions: new Set(),
});

export function createMagpieUsage({
  filePath = join(process.env.USERPROFILE ?? '', '.config', 'magpie', 'usage.jsonl'),
  wallClock = () => Date.now(),
  refreshMs = 1000,
  maxLineBytes = 1024 * 1024,
} = {}) {
  if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes < 1) {
    throw new RangeError('maxLineBytes must be a positive safe integer');
  }
  let cache = freshCache();
  let timer = null;
  let active = null;
  let pending = false;
  let pendingForce = false;
  let stopped = false;
  let readFailed = false;

  const processLine = (target, source) => {
    const line = source.endsWith('\r') ? source.slice(0, -1) : source;
    if (!line.trim()) return;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      target.bad = true;
      return;
    }
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      target.bad = true;
      return;
    }
    // Older Magpie rows predate session attribution. They cannot belong to a
    // verifiable per-session total, but must not make every identified session
    // permanently partial merely because they coexist in the same global log.
    if (typeof record.session !== 'string') return;
    const { session } = record;
    target.matched.set(session, (target.matched.get(session) ?? 0) + 1);
    const invalid = () => { target.badSessions.add(session); };
    const present = ['in', 'out', 'cache_read'].filter((field) => has(record, field));
    if (present.length === 0 && !has(record, 'reasoning')) {
      target.records.push({ session, usage: null, t: null });
      return;
    }
    if (present.length !== 3) {
      invalid();
      return;
    }
    const values = {};
    for (const field of [...present, ...(has(record, 'reasoning') ? ['reasoning'] : [])]) {
      const value = record[field];
      if (!Number.isSafeInteger(value) || value < 0) {
        invalid();
        return;
      }
      values[field] = value;
    }
    const input = values.in + values.cache_read;
    const total = input + values.out;
    if (!Number.isSafeInteger(input) || !Number.isSafeInteger(total)) {
      invalid();
      return;
    }
    let t = null;
    if (has(record, 't')) {
      if (typeof record.t !== 'string' || !Number.isFinite(Date.parse(record.t))) {
        invalid();
        return;
      }
      t = new Date(record.t).toISOString();
    }
    const usage = total === 0 && !values.reasoning ? null
      : { input, output: values.out, cached: values.cache_read, reasoning: values.reasoning };
    target.records.push({ session, t: usage ? t : null, usage });
  };

  const scan = async (target, from, size) => {
    const handle = await open(filePath, 'r');
    const decoder = new StringDecoder('utf8');
    const consume = (text) => {
      if (!text) return;
      text = (target.skipping ? '' : target.tail) + text;
      let start = 0;
      for (let end; (end = text.indexOf('\n', start)) !== -1; start = end + 1) {
        if (target.skipping) target.skipping = false;
        else processLine(target, text.slice(start, end));
      }
      target.tail = target.skipping ? '' : text.slice(start);
      if (!target.skipping && Buffer.byteLength(target.tail) > maxLineBytes) {
        target.tail = '';
        target.skipping = true;
        target.bad = true;
      }
    };
    try {
      for (let position = from; position < size;) {
        const length = Math.min(maxLineBytes, size - position);
        const buffer = Buffer.allocUnsafe(length);
        let offset = 0;
        while (offset < length) {
          const { bytesRead } = await handle.read(buffer, offset, length - offset, position + offset);
          if (bytesRead === 0) throw new Error('Magpie usage file changed during read');
          offset += bytesRead;
        }
        consume(decoder.write(buffer));
        position += length;
      }
      consume(decoder.end());
    } finally {
      await handle.close();
    }
  };

  const performRefresh = async (force) => {
    try {
      const info = await stat(filePath);
      if (!info.isFile()) throw new Error('Magpie usage path is not a file');
      const known = cache.size !== null;
      if (!force && known && info.size === cache.size && info.mtimeMs === cache.mtimeMs) {
        readFailed = false;
        return;
      }
      let next;
      const append = !force && known && info.size > cache.size && info.mtimeMs !== cache.mtimeMs;
      if (append) {
        next = {
          ...cache,
          records: cache.records.slice(),
          matched: new Map(cache.matched),
          badSessions: new Set(cache.badSessions),
        };
        await scan(next, cache.size, info.size);
      } else {
        next = freshCache();
        if (info.size > 0) await scan(next, 0, info.size);
      }
      next.size = info.size;
      next.mtimeMs = info.mtimeMs;
      cache = next;
      readFailed = false;
    } catch {
      readFailed = true;
    }
  };

  const refresh = ({ force = false } = {}) => {
    if (stopped) return Promise.resolve();
    pending = true;
    if (force) pendingForce = true;
    if (active) return active;
    active = (async () => {
      try {
        while (pending && !stopped) {
          const forceRound = pendingForce;
          pending = false;
          pendingForce = false;
          await performRefresh(forceRound);
        }
      } finally {
        active = null;
      }
    })();
    return active;
  };

  const start = () => {
    if (stopped || timer) return;
    timer = setInterval(() => { void refresh(); }, refreshMs);
    timer.unref?.();
    void refresh();
  };

  const snapshot = ({ taskId } = {}) => {
    const result = {
      state: 'unavailable', reason: readFailed ? 'read_failed' : null,
      observedAt: null, matchedRequests: 0, countedRequests: 0, usage: null,
    };
    if (cache.size === null || typeof taskId !== 'string') {
      result.reason = readFailed || cache.size === null ? 'read_failed' : 'no_records';
      return result;
    }
    result.matchedRequests = cache.matched.get(taskId) ?? 0;
    const totals = { input: 0, output: 0, total: 0, cached: 0, reasoning: 0 };
    let allReasoning = true;
    let invalid = cache.bad || cache.badSessions.has(taskId);
    for (const entry of cache.records) {
      if (entry.session !== taskId || !entry.usage) continue;
      const usage = entry.usage;
      const input = totals.input + usage.input;
      const output = totals.output + usage.output;
      const cached = totals.cached + usage.cached;
      const total = input + output;
      if (![input, output, cached, total].every(Number.isSafeInteger)) {
        invalid = true;
        break;
      }
      Object.assign(totals, { input, output, cached, total });
      if (usage.reasoning === undefined) allReasoning = false;
      else if (allReasoning) {
        totals.reasoning += usage.reasoning;
        if (!Number.isSafeInteger(totals.reasoning)) {
          invalid = true;
          break;
        }
      }
      result.countedRequests++;
      if (entry.t !== null) result.observedAt = entry.t;
    }
    if (result.countedRequests > 0) {
      result.usage = {
        inputTokens: totals.input,
        outputTokens: totals.output,
        totalTokens: totals.total,
        cachedInputTokens: totals.cached,
      };
      if (allReasoning) result.usage.reasoningOutputTokens = totals.reasoning;
    }
    result.state = readFailed ? 'unavailable' : invalid ? 'partial'
      : result.countedRequests > 0 ? 'available' : 'waiting';
    result.reason = readFailed ? 'read_failed' : invalid ? 'invalid_record'
      : result.countedRequests > 0 ? null : 'no_records';
    return result;
  };

  const stop = async () => {
    stopped = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (active) await active;
  };

  return { start, refresh, snapshot, stop };
}
