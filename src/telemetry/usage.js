import { basename } from 'node:path';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const FILE = new RegExp(`^rollout-[0-9T:.Z-]+-(${UUID})(?:[_-](${UUID}))?\.jsonl$`);
const TYPES = new Set(['session_meta', 'event_msg']);
const SESSION_ID = new RegExp(`^${UUID}$`);
const safeInt = (value) => Number.isSafeInteger(value) && value >= 0;
const COUNTER_KEYS = ['input_tokens', 'output_tokens', 'total_tokens'];

function validCounters(value) {
  return Boolean(value) && COUNTER_KEYS.every((key) => safeInt(value[key]))
    && safeInt(value.input_tokens + value.output_tokens)
    && value.total_tokens === value.input_tokens + value.output_tokens;
}

function invalidCompleteCounters(value) {
  return Boolean(value) && COUNTER_KEYS.every((key) => value[key] != null) && !validCounters(value);
}

export function sessionIdFromFilename(filename) {
  return basename(filename).match(FILE)?.[1] ?? null;
}

function isoTime(value, now) {
  if (typeof value !== 'string') return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time) || time > now + 5 * 60_000) return null;
  return time;
}

export function parseUsageLine(line, expectedSessionId, now = Date.now()) {
  let event;
  try { event = JSON.parse(line); } catch { throw new Error('malformed_line'); }
  if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('invalid_event');
  if (!TYPES.has(event.type)) return null;
  const timestamp = isoTime(event.timestamp, now);
  if (timestamp === null) throw new Error('invalid_timestamp');
  const payload = event.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('invalid_payload');

  if (event.type === 'session_meta') {
    const id = payload.id;
    // VS Code forks retain parent metadata. Ignore only the self-identifying
    // legacy record; never use its identity or timestamp as current activity.
    if (id !== expectedSessionId && typeof id === 'string' && SESSION_ID.test(id)
      && typeof expectedSessionId === 'string' && SESSION_ID.test(expectedSessionId)
      && payload.session_id === id && payload.source === 'vscode'
      && isoTime(payload.timestamp, now) !== null) return null;
    if (typeof id !== 'string' || id !== expectedSessionId) throw new Error('session_mismatch');
    return { type: 'session_meta', timestamp, sessionId: id };
  }

  if (payload.type !== 'token_count') return null;
  const info = payload.info;
  const usage = info?.total_token_usage;
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) throw new Error('invalid_usage');
  const values = [usage.input_tokens, usage.output_tokens, usage.total_tokens];
  if (values.every((value) => value == null)) {
    return { type: 'token_count', timestamp, sessionId: expectedSessionId, usage: null };
  }
  if (!validCounters(usage)) throw new Error('invalid_usage');
  return {
    type: 'token_count', timestamp, sessionId: expectedSessionId,
    usage: { inputTokens: values[0], outputTokens: values[1], totalTokens: values[2] },
  };
}

export function publicUsage(state, session, usage, speed, telemetry = unavailableTelemetry(state === 'empty' ? 'no_session' : state === 'ambiguous' ? 'turn_ambiguous' : 'identity_unverified')) {
  return {
    state,
    conversationContext: pick(telemetry.conversationContext, ['state', 'source', 'reason', 'model', 'reasoningEffort', 'observedAt']),
    lastCompletedTurn: pick(telemetry.lastCompletedTurn, ['state', 'source', 'reason', 'startedAt', 'completedAt', 'elapsedSeconds', 'inputTokens', 'outputTokens', 'totalTokens']),
    turnAverageSpeed: pick(telemetry.turnAverageSpeed, ['state', 'source', 'reason', 'outputTokensPerSecond', 'completedAt', 'includesToolsAndWait']),
    session: session ? { id: session.id, updatedAt: session.updatedAt ?? null } : null,
    usage: usage ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, totalTokens: usage.totalTokens } : { inputTokens: null, outputTokens: null, totalTokens: null },
    speed: speed?.state === 'available'
      ? { outputTokensPerSecond: speed.outputTokensPerSecond, state: 'available' }
      : { outputTokensPerSecond: null, state: 'unavailable' },
  };
}
function pick(value, keys) { return Object.fromEntries(keys.map((key) => [key, value[key] ?? null])); }
export function sessionFilenameIdentity(filename) {
  const match = basename(filename).match(FILE);
  return match ? { id: match[1], dual: Boolean(match[2]) } : null;
}
export const validModel = (v) => typeof v === 'string' && v.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)?$/.test(v);
// Every reasoning level Codex accepts in `enabled-reasoning-efforts`; the
// whitelist also keeps an arbitrary string out of `-c model_reasoning_effort=`.
export const EFFORT_VALUES = Object.freeze(['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'persistent']);
export const validEffort = (v) => typeof v === 'string' && EFFORT_VALUES.includes(v);
const validId = (v) => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v);
export function unavailableTelemetry(reason = 'no_session', state = 'unavailable', sources = {}) {
  return {
    conversationContext: { state, source: sources.conversationContext ?? 'none', reason, model: null, reasoningEffort: null, observedAt: null },
    lastCompletedTurn: { state, source: sources.lastCompletedTurn ?? 'none', reason, startedAt: null, completedAt: null, elapsedSeconds: null, inputTokens: null, outputTokens: null, totalTokens: null },
    turnAverageSpeed: { state, source: sources.turnAverageSpeed ?? 'none', reason, outputTokensPerSecond: null, completedAt: null, includesToolsAndWait: true },
  };
}
function counters(v) {
  if (!validCounters(v)) return null;
  return { inputTokens: v.input_tokens, outputTokens: v.output_tokens, totalTokens: v.total_tokens };
}
// Association data only; payload text is never retained.
export function parseTelemetryLine(line, now = Date.now()) {
  let e;
  try { e = JSON.parse(line); } catch { throw Error('read_failed'); }
  if (!e || typeof e !== 'object' || Array.isArray(e)) throw Error('read_failed');
  const p = e.payload;
  const type = e.type === 'event_msg' ? p?.type : e.type;
  if (!['session_meta', 'turn_context', 'task_started', 'task_complete', 'token_usage_record'].includes(type)) return null;
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw Error('read_failed');
  const timestamp = isoTime(e.timestamp, now);
  if (timestamp === null) throw Error('timestamp_invalid');
  if (type === 'session_meta') return { type, timestamp, id: p.id, sessionId: p.session_id,
    subagent: p.thread_source === 'subagent' || p.source === 'subagent' || (p.source && typeof p.source === 'object' && !Array.isArray(p.source)
      && (Object.hasOwn(p.source, 'subagent') || p.source.type === 'subagent' || p.source.kind === 'subagent')) };
  const rootPresent = Object.hasOwn(p, 'root_turn_id');
  return { type, timestamp, turn: validId(p.turn_id) ? p.turn_id : null, root: validId(p.root_turn_id) ? p.root_turn_id : null,
    rootPresent, rootInvalid: rootPresent && !validId(p.root_turn_id),
    ...(type === 'turn_context' ? { model: validModel(p.model) ? p.model : null, effort: validEffort(p.effort) ? p.effort : null, contextReason: p.model == null || p.effort == null ? 'context_missing' : 'context_invalid' } : {}),
    ...(type === 'token_usage_record' ? { thread: p.thread_id, sessionId: p.session_id, response: validId(p.response_id) ? p.response_id : null, usage: counters(p.turn_token_usage), cumulative: counters(p.thread_token_usage), cumulativeInvalid: p.thread_token_usage != null && !counters(p.thread_token_usage) } : {}),
  };
}
export function createTurnState() {
  return { meta: false, metaSession: false, proof: false, identityReason: null, current: null, context: null, completed: null, cumulative: null, latest: null, reason: 'turn_start_missing', lastTime: null, usageSeen: false,
    completedIds: new Set(), supersededIds: new Set(), saturated: false, interleaved: false };
}
const FAILURE_ORDER = ['identity_unverified', 'identity_conflict', 'read_gap', 'file_changed', 'budget_exceeded', 'read_failed', 'timestamp_invalid', 'turn_ambiguous', 'counter_regression', 'usage_invalid', 'usage_conflict', 'usage_missing'];
function failTurn(turn, reason) {
  if (!turn.error || FAILURE_ORDER.indexOf(reason) < FAILURE_ORDER.indexOf(turn.error)) turn.error = reason;
}
function saturate(s) {
  s.saturated = true;
  s.reason = 'budget_exceeded';
  s.completed = null;
  s.context = null;
  if (s.current) failTurn(s.current, 'budget_exceeded');
}
function rememberSuperseded(s, turn) {
  if (s.supersededIds.has(turn)) return true;
  if (s.supersededIds.size >= 4096) { saturate(s); return false; }
  s.supersededIds.add(turn);
  return true;
}
// A gap discards unverified working data, but never erases same-file evidence.
export function isolateTurnState(s) {
  if (s.current?.acceptedRoot) rememberSuperseded(s, s.current.turn);
  return Object.assign(createTurnState(), {
    meta: s.meta, metaSession: s.metaSession, identityReason: s.identityReason,
    completedIds: s.completedIds, supersededIds: s.supersededIds,
    saturated: s.saturated, interleaved: s.interleaved, reason: 'read_gap',
  });
}
export function observeTelemetry(s, e, id) {
  if (!e) return 'ignored';
  if (e.type === 'session_meta') {
    if (e.id !== id || (e.sessionId != null && e.sessionId !== id)) s.identityReason = 'identity_conflict';
    else { s.meta = true; s.metaSession = e.sessionId === id; }
    if (s.identityReason) return 'rejected';
    s.latest = Math.max(s.latest ?? 0, e.timestamp);
    return 'accepted';
  }
  if (e.type === 'token_usage_record') {
    if ((e.thread != null && e.thread !== id) || (e.sessionId != null && e.sessionId !== id)) s.identityReason = 'identity_conflict';
    if (s.identityReason) return 'rejected';
    if (e.thread !== id || e.sessionId !== id) {
      if (s.current) failTurn(s.current, 'identity_unverified');
      s.reason = 'identity_unverified'; s.completed = null; s.context = null;
      return 'rejected';
    }
    if (!s.supersededIds.has(e.turn) && !s.interleaved && !s.saturated) s.proof = true;
  }
  if (s.identityReason) return 'rejected';
  const timeRegressed = s.lastTime !== null && e.timestamp < s.lastTime;
  if (!Number.isFinite(e.timestamp) || timeRegressed) {
    s.reason = 'timestamp_invalid'; s.context = null; s.completed = null;
    if (s.current) failTurn(s.current, 'timestamp_invalid');
    return 'rejected';
  }
  const completeRoot = !e.rootPresent || (!e.rootInvalid && e.root === e.turn);
  const ownRoot = Boolean(e.turn && (e.type === 'task_complete' ? completeRoot : !e.rootInvalid && e.root === e.turn));
  if (s.supersededIds.has(e.turn) && ['turn_context', 'token_usage_record', 'task_complete'].includes(e.type)) {
    if (ownRoot) {
      s.interleaved = true; s.context = null; s.completed = null; s.proof = false;
      if (s.reason !== 'timestamp_invalid') s.reason = 'turn_ambiguous';
      return 'superseded';
    }
    if (s.current) failTurn(s.current, 'turn_ambiguous');
    s.reason = 'turn_ambiguous'; s.completed = null; s.context = null;
    return 'rejected';
  }
  if (s.saturated) return 'rejected';
  if (s.interleaved) return 'rejected';
  s.latest = Math.max(s.latest ?? 0, e.timestamp);
  s.lastTime = e.timestamp;
  if (e.type === 'task_started') {
    s.context = null;
    const fresh = s.meta && ownRoot && !s.completedIds.has(e.turn) && !s.supersededIds.has(e.turn);
    if (s.current && fresh && s.current.acceptedRoot && !s.current.error && s.current.turn !== e.turn) {
      if (!rememberSuperseded(s, s.current.turn)) return 'rejected';
      s.cumulative = null;
      s.current = null;
    }
    if (s.current || !fresh) {
      if (!s.current) s.current = { turn: e.turn, start: e.timestamp, responses: new Map() };
      failTurn(s.current, 'turn_ambiguous'); s.reason = 'turn_ambiguous'; return 'accepted';
    }
    s.current = { turn: e.turn, acceptedRoot: true, start: e.timestamp, before: s.cumulative, responses: new Map(), usage: null, cumulative: null, error: null };
    s.reason = 'turn_incomplete';
    return 'accepted';
  }
  const t = s.current;
  if (e.type === 'turn_context') {
    if (e.turn && e.root === e.turn && (!t || e.turn === t.turn)) s.context = e.model && e.effort
      ? { state: 'available', source: 'turn_context', reason: 'none', model: e.model, reasoningEffort: e.effort, observedAt: new Date(e.timestamp).toISOString() }
      : { ...unavailableTelemetry(e.contextReason).conversationContext, source: 'turn_context' };
    return 'accepted';
  }
  if (e.type === 'token_usage_record') {
    s.usageSeen = true;
    if (t) {
      if (!e.turn || !e.root || e.turn !== t.turn || e.root !== t.turn) failTurn(t, 'turn_ambiguous');
      else if (e.thread !== id || e.sessionId !== id) failTurn(t, 'identity_unverified');
      else if (!e.response || !e.usage || e.cumulativeInvalid) failTurn(t, 'usage_invalid');
      else {
        const signature = JSON.stringify([e.usage, e.cumulative]);
        const prior = t.responses.get(e.response);
        if (prior && prior !== signature) failTurn(t, 'usage_conflict');
        if (!prior && t.responses.size >= 4096) { saturate(s); return 'rejected'; }
        if (!prior && t.responses.size < 4096) { t.responses.set(e.response, signature); t.usage = e.usage; t.cumulative = e.cumulative; }
      }
    }
    s.proof = true;
    if (e.cumulative && e.thread === id && e.sessionId === id) {
      if (s.cumulative && Object.keys(e.cumulative).some((k) => e.cumulative[k] < s.cumulative[k])) {
        if (t) failTurn(t, 'counter_regression'); else { s.reason = 'counter_regression'; s.completed = null; }
      }
      s.cumulative = e.cumulative;
    }
    return 'accepted';
  }
  if (e.type === 'task_complete') {
    if (!t || !e.turn || !completeRoot || e.turn !== t.turn || s.completedIds.has(e.turn)) { s.reason = t || s.completedIds.has(e.turn) || !completeRoot ? 'turn_ambiguous' : 'turn_start_missing'; s.completed = null; if (t) failTurn(t, 'turn_ambiguous'); return 'accepted'; }
    if (!s.completedIds.has(e.turn) && s.completedIds.size >= 4096) { saturate(s); return 'rejected'; }
    let reason = t.error;
    const elapsed = (e.timestamp - t.start) / 1000;
    if (!(elapsed > 0) || !Number.isFinite(elapsed)) reason = 'timestamp_invalid';
    if (!reason && !t.usage) reason = 'usage_missing';
    if (!reason && t.before && t.cumulative) {
      const keys = Object.keys(t.usage);
      if (keys.some((k) => t.cumulative[k] < t.before[k])) reason = 'counter_regression';
      else if (keys.some((k) => t.cumulative[k] - t.before[k] !== t.usage[k])) reason = 'usage_conflict';
    }
    s.completed = reason ? null : { state: 'available', source: 'turn_token_usage', reason: 'none', startedAt: new Date(t.start).toISOString(), completedAt: new Date(e.timestamp).toISOString(), elapsedSeconds: elapsed, ...t.usage };
    s.reason = reason ?? 'none';
    s.completedIds.add(e.turn);
    s.current = null;
    return 'accepted';
  }
}
export function projectTelemetry(s, dual = false) {
  const identity = s.identityReason ?? (!s.meta || (dual && !s.metaSession) ? 'identity_unverified' : null);
  if (identity) return unavailableTelemetry(identity);
  const reason = s.current?.error ?? s.reason;
  const sources = s.usageSeen ? { lastCompletedTurn: 'turn_token_usage', turnAverageSpeed: 'none' } : {};
  if (reason === 'identity_unverified') return unavailableTelemetry(reason, 'unavailable', sources);
  if (reason === 'timestamp_invalid') return unavailableTelemetry(reason, 'unavailable', sources);
  if (s.saturated) return unavailableTelemetry('budget_exceeded', 'unavailable', sources);
  if (s.interleaved) return unavailableTelemetry('turn_ambiguous', 'unavailable', sources);
  if (dual && !s.proof) return unavailableTelemetry('identity_unverified');
  const result = unavailableTelemetry(reason, 'unavailable', sources);
  result.conversationContext = s.context ?? unavailableTelemetry('context_missing').conversationContext;
  if (s.completed) {
    result.lastCompletedTurn = { ...s.completed };
    result.turnAverageSpeed = { state: 'available', source: 'completed_turn', reason: 'none', outputTokensPerSecond: s.completed.outputTokens / s.completed.elapsedSeconds, completedAt: s.completed.completedAt, includesToolsAndWait: true };
  }
  return result;
}

// --- Task monitor additions (additive; legacy contracts above are unchanged) ---

const TASK_TYPES = new Set(['session_meta', 'turn_context', 'task_started', 'task_complete', 'turn_aborted', 'token_usage_record']);
const ROLE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

// Incomplete snapshots retain unknown fields. A contradictory complete
// snapshot is rejected as a whole rather than exposing a partial total.
export function usageAllowlist(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
  if (invalidCompleteCounters(source)) return taskUsageEmpty();
  const pick = (key) => (source && safeInt(source[key]) ? source[key] : null);
  return {
    inputTokens: pick('input_tokens'),
    cachedInputTokens: pick('cached_input_tokens'),
    outputTokens: pick('output_tokens'),
    reasoningOutputTokens: pick('reasoning_output_tokens'),
    totalTokens: pick('total_tokens'),
  };
}

export function taskUsageEmpty() {
  return { inputTokens: null, cachedInputTokens: null, outputTokens: null, reasoningOutputTokens: null, totalTokens: null };
}

export const taskValidId = (v) => validId(v);

// Association-only task parser: identity is deliberately not verified against
// the filename here because the caller resolves grouping from session_meta.
export function parseTaskLine(line, now = Date.now()) {
  let event;
  try { event = JSON.parse(line); } catch { throw Error('read_failed'); }
  if (!event || typeof event !== 'object' || Array.isArray(event)) throw Error('read_failed');
  const payload = event.payload;
  const type = event.type === 'event_msg' ? payload?.type : event.type;
  if (!TASK_TYPES.has(type)) return null;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw Error('read_failed');
  const timestamp = isoTime(event.timestamp, now);
  if (timestamp === null) throw Error('timestamp_invalid');
  if (type === 'session_meta') {
    const spawn = payload.source && typeof payload.source === 'object' && !Array.isArray(payload.source)
      ? payload.source.subagent?.thread_spawn : null;
    const parent = validId(payload.parent_thread_id) ? payload.parent_thread_id
      : validId(spawn?.parent_thread_id) ? spawn.parent_thread_id : null;
    return { type, timestamp, id: validId(payload.id) ? payload.id : null,
      sessionId: validId(payload.session_id) ? payload.session_id : null, parentId: parent,
      role: typeof payload.agent_role === 'string' && ROLE.test(payload.agent_role) ? payload.agent_role : null };
  }
  const base = { type, timestamp, turn: validId(payload.turn_id) ? payload.turn_id : null,
    root: validId(payload.root_turn_id) ? payload.root_turn_id : null };
  if (type === 'turn_context') {
    return { ...base, model: validModel(payload.model) ? payload.model : null,
      effort: validEffort(payload.effort) ? payload.effort : null };
  }
  if (type === 'token_usage_record') {
    const turnUsage = payload.turn_token_usage;
    const source = turnUsage && typeof turnUsage === 'object' && !Array.isArray(turnUsage) ? turnUsage : null;
    const usageInvalid = invalidCompleteCounters(source);
    return { ...base, thread: validId(payload.thread_id) ? payload.thread_id : null,
      sessionId: validId(payload.session_id) ? payload.session_id : null,
      response: validId(payload.response_id) ? payload.response_id : null,
      usage: source && !usageInvalid ? usageAllowlist(source) : null, usageInvalid };
  }
  return base;
}
