import { validEffort, validModel } from './usage.js';
import { createObservedSpeedTracker } from './speed.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STATES = new Set(['available', 'waiting', 'unavailable', 'disconnected', 'ambiguous']);
const SOURCES = new Set(['codex_app_server', 'magpie_gateway', 'none']);
const REASONS = new Set(['connecting', 'source_unavailable', 'source_disconnected', 'no_active_thread', 'identity_unverified', 'usage_unconfirmed', 'multiple_active_threads', 'thread_not_observed', 'source_invalid', 'source_stale', 'capacity_exceeded']);
const RETAINABLE_REASONS = new Set(['source_unavailable', 'source_disconnected']);
const LIFECYCLES = new Set(['running', 'completed', 'failed', 'cancelled']);
const MAX_THREADS = 128;
const safeInt = (value) => Number.isSafeInteger(value) && value >= 0;
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const time = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
// 'configured' is a request sentinel, never evidence of the model that ran.
const liveModel = (value) => validModel(value) && value !== 'configured' ? value : null;

function counters(value) {
  if (!object(value) || !['inputTokens', 'outputTokens', 'totalTokens'].every((key) => safeInt(value[key]))
    || !Number.isSafeInteger(value.inputTokens + value.outputTokens)
    || value.inputTokens + value.outputTokens !== value.totalTokens) return null;
  const confirmed = { inputTokens: value.inputTokens, outputTokens: value.outputTokens, totalTokens: value.totalTokens };
  // Cache counters are optional: an unusable one stays absent rather than voiding the usage.
  if (safeInt(value.cachedInputTokens) && value.cachedInputTokens <= value.inputTokens) confirmed.cachedInputTokens = value.cachedInputTokens;
  if (safeInt(value.reasoningOutputTokens)) confirmed.reasoningOutputTokens = value.reasoningOutputTokens;
  return confirmed;
}

// The most recent request is optional: it is absent, not fatal, when its counters disagree.
function usage(value) {
  const confirmed = counters(value);
  if (!confirmed) return null;
  const last = counters(value.last);
  return last ? { ...confirmed, last } : confirmed;
}

function gatewaySnapshot(source, taskId, now) {
  let value;
  try { value = source?.snapshot({ taskId }) ?? null; } catch { return null; }
  const confirmed = counters(value?.usage);
  if (!object(value) || !['available', 'partial'].includes(value.state) || !confirmed
    || !time(value.observedAt) || Date.parse(value.observedAt) > now + 5_000
    || !safeInt(value.matchedRequests) || !safeInt(value.countedRequests) || value.countedRequests > value.matchedRequests) return null;
  return {
    state: value.state, observedAt: value.observedAt,
    matchedRequests: value.matchedRequests, countedRequests: value.countedRequests, usage: confirmed,
  };
}

function gatewayUsage(value, last) {
  return {
    scope: 'conversation', includesSubagents: false, ...value.usage,
    ...(last?.last ? { last: last.last } : {}),
  };
}

export function unavailableLiveSnapshot(reason = 'source_unavailable', now = Date.now(), state = 'unavailable', source = 'none') {
  return {
    sampledAt: new Date(now).toISOString(), state, source, reason,
    observedAt: null, session: null, usage: null, model: null, reasoningEffort: null, lifecycle: null, speed: null,
  };
}

// Neither transport-specific metadata nor transcript fields cross the HTTP boundary.
export function publicLiveSnapshot(value, { taskId = null, now = Date.now() } = {}) {
  if (!object(value) || !STATES.has(value.state) || !SOURCES.has(value.source)) return unavailableLiveSnapshot('source_invalid', now);
  const result = unavailableLiveSnapshot(REASONS.has(value.reason) ? value.reason : null, now, value.state, value.source);
  result.sampledAt = time(value.sampledAt) ?? result.sampledAt;
  if (!['available', 'waiting'].includes(value.state)) return result;
  const id = value.session?.id;
  if (!UUID.test(id ?? '') || (taskId !== null && id !== taskId) || value.source === 'none') {
    return unavailableLiveSnapshot('identity_unverified', now, 'unavailable', value.source);
  }
  const observedAt = time(value.observedAt);
  if (observedAt === null || Date.parse(observedAt) > now + 5_000) return unavailableLiveSnapshot('source_invalid', now);
  result.session = { id };
  result.observedAt = observedAt;
  const gateway = value.gateway;
  if (value.source === 'magpie_gateway' && object(gateway) && ['available', 'partial'].includes(gateway.state)
    && gateway.observedAt === observedAt && safeInt(gateway.matchedRequests) && safeInt(gateway.countedRequests)
    && gateway.countedRequests <= gateway.matchedRequests) {
    result.gateway = { state: gateway.state, observedAt, matchedRequests: gateway.matchedRequests, countedRequests: gateway.countedRequests };
  }
  const confirmed = usage(value.usage);
  if (confirmed && ['conversation', 'turn', 'request'].includes(value.usage.scope) && typeof value.usage.includesSubagents === 'boolean') {
    result.usage = { scope: value.usage.scope, includesSubagents: value.usage.includesSubagents, ...confirmed };
  }
  result.model = liveModel(value.model);
  result.reasoningEffort = validEffort(value.reasoningEffort) ? value.reasoningEffort : null;
  const lifecycle = value.lifecycle;
  if (object(lifecycle) && LIFECYCLES.has(lifecycle.state)) {
    const startedAt = time(lifecycle.startedAt), completedAt = time(lifecycle.completedAt);
    const elapsedSeconds = Number.isFinite(lifecycle.elapsedSeconds) && lifecycle.elapsedSeconds >= 0 ? lifecycle.elapsedSeconds : null;
    result.lifecycle = { state: lifecycle.state, startedAt, completedAt, elapsedSeconds };
  }
  const speed = value.speed;
  if (object(speed) && speed.source === 'confirmed_request' && Number.isFinite(speed.outputTokensPerSecond)
    && speed.outputTokensPerSecond >= 0 && time(speed.observedAt) && Date.parse(speed.observedAt) <= Date.parse(observedAt)
    && Date.parse(speed.observedAt) <= now) {
    result.speed = { source: 'confirmed_request', outputTokensPerSecond: speed.outputTokensPerSecond, observedAt: speed.observedAt };
  }
  if (object(speed) && speed.source === 'observed_window' && result.usage?.scope === 'conversation'
    && safeInt(speed.outputTokens) && speed.outputTokens <= result.usage.outputTokens
    && Number.isFinite(speed.elapsedSeconds) && speed.elapsedSeconds >= 1 && speed.elapsedSeconds <= 120
    && Number.isFinite(speed.outputTokensPerSecond) && speed.outputTokensPerSecond >= 0
    && speed.includesToolsAndWait === true && time(speed.startedAt) && time(speed.observedAt)) {
    const started = Date.parse(speed.startedAt), observed = Date.parse(speed.observedAt), expected = speed.outputTokens / speed.elapsedSeconds;
    if (Math.abs(observed - started - speed.elapsedSeconds * 1000) <= 1
      && (observed <= Date.parse(observedAt) || value.source === 'magpie_gateway')
      && observed <= Date.parse(result.sampledAt) && observed <= now && now - observed <= 60_000
      && Math.abs(speed.outputTokensPerSecond - expected) <= 1e-9 * Math.max(1, expected)) {
      result.speed = { source: 'observed_window', outputTokensPerSecond: speed.outputTokensPerSecond,
        outputTokens: speed.outputTokens, elapsedSeconds: speed.elapsedSeconds,
        startedAt: speed.startedAt, observedAt: speed.observedAt, includesToolsAndWait: true };
    }
  }
  if (result.usage === null) {
    result.state = 'waiting';
    result.reason ??= 'usage_unconfirmed';
  }
  return result;
}

export function createLiveTelemetry({ connector = null, usageSource = null, wallClock = () => Date.now(), monotonicClock = () => performance.now(), maxThreads = MAX_THREADS, staleMs = 15_000, idleRetentionMs = 300_000 } = {}) {
  const threads = new Map();
  let connected = false, stopped = false, started = false, connection = null, lastContact = null;
  let source = 'none', reason = 'source_unavailable';
  let retained = null, disconnectedAt = null;
  const gatewaySpeed = createObservedSpeedTracker({ monotonicClock });

  function clearRetained() {
    retained = null;
    disconnectedAt = null;
    gatewaySpeed.reset();
  }

  function status(next) {
    if (stopped) return;
    connected = next.connected === true && SOURCES.has(next.source) && next.source !== 'none';
    source = SOURCES.has(next.source) ? next.source : 'none';
    reason = connected ? null : REASONS.has(next.reason) ? next.reason : 'source_disconnected';
    lastContact = monotonicClock();
    if (!connected) {
      threads.clear();
      disconnectedAt ??= monotonicClock();
      gatewaySpeed.reset();
      if (!RETAINABLE_REASONS.has(reason)) clearRetained();
    }
  }

  function observe(event) {
    if (stopped || !connected || !object(event)) return;
    lastContact = monotonicClock();
    if (event.type === 'heartbeat') return;
    if (!UUID.test(event.threadId ?? '')) return;
    if (event.type === 'removed') {
      threads.delete(event.threadId);
      if (retained?.session?.id === event.threadId) clearRetained();
      return;
    }
    const observedAt = time(event.observedAt);
    if (!observedAt || Date.parse(observedAt) > wallClock() + 5_000) return;
    let thread = threads.get(event.threadId);
    if (!thread) {
      if (!['thread', 'conversation'].includes(event.type) || ![true, false, null].includes(event.primary)) return;
      if (threads.size >= maxThreads) { reason = 'capacity_exceeded'; return; }
      thread = { id: event.threadId, primary: event.primary, observedAt, state: 'idle', usage: null, lifecycle: null, model: null, reasoningEffort: null, speedTracker: createObservedSpeedTracker({ monotonicClock }), turnId: null, lastUsageAt: null };
      threads.set(event.threadId, thread);
    }
    if (Date.parse(observedAt) < Date.parse(thread.observedAt)) return;
    if (event.type === 'conversation') {
      if (![true, false, null].includes(event.primary) || !['active', 'idle', 'failed'].includes(event.state)) return;
      thread.primary = event.primary;
      thread.state = event.state;
      thread.usage = null;
      const total = usage(event.usage);
      if (total) thread.usage = { scope: 'conversation', includesSubagents: false, ...total };
      thread.lifecycle = event.state === 'active'
        ? { state: 'running', startedAt: null, completedAt: null, elapsedSeconds: null }
        : event.state === 'idle' ? { state: 'completed', startedAt: null, completedAt: null, elapsedSeconds: null } : null;
      // A reported level that fails validation says nothing about the level that
      // is actually running, so the confirmed one stays rather than blinking out.
      if (Object.hasOwn(event, 'model')) thread.model = liveModel(event.model) ?? thread.model;
      if (Object.hasOwn(event, 'reasoningEffort')) thread.reasoningEffort = validEffort(event.reasoningEffort) ? event.reasoningEffort : thread.reasoningEffort;
      if (event.state === 'active') thread.speedTracker.observe(thread.id, total, observedAt);
      else thread.speedTracker.reset();
    } else if (event.type === 'thread') {
      thread.primary = event.primary;
      if (['active', 'idle', 'failed'].includes(event.state)) thread.state = event.state;
      if (thread.state !== 'active') thread.speedTracker.reset();
    } else if (event.type === 'turn_started') {
      if (!UUID.test(event.turnId ?? '')) return;
      thread.turnId = event.turnId;
      thread.state = 'active';
      thread.lifecycle = { state: 'running', startedAt: time(event.startedAt), completedAt: null, elapsedSeconds: null };
      // The model is thread state reported by the runtime snapshot, not turn configuration.
      thread.speedTracker.reset();
    } else if (event.type === 'turn_completed') {
      if (event.turnId !== thread.turnId || !LIFECYCLES.has(event.state) || event.state === 'running') return;
      thread.state = event.state === 'failed' ? 'failed' : 'idle';
      thread.speedTracker.reset();
      thread.lifecycle = { state: event.state, startedAt: thread.lifecycle?.startedAt ?? time(event.startedAt), completedAt: time(event.completedAt), elapsedSeconds: Number.isFinite(event.elapsedSeconds) && event.elapsedSeconds >= 0 ? event.elapsedSeconds : null };
    } else if (event.type === 'usage') {
      if (event.turnId !== thread.turnId) return;
      if (thread.lastUsageAt && Date.parse(observedAt) < Date.parse(thread.lastUsageAt)) return;
      const total = usage(event.usage);
      thread.usage = total ? { scope: 'conversation', includesSubagents: false, ...total } : null;
      thread.lastUsageAt = observedAt;
      if (thread.state === 'active') thread.speedTracker.observe(thread.id, total, observedAt);
    } else return;
    thread.observedAt = observedAt;
    if (retained) {
      if (thread.id === retained.session.id && thread.primary !== true) clearRetained();
      else if (thread.id !== retained.session.id && thread.primary !== false
        && (thread.state === 'active' || retained.lifecycle?.state !== 'running')) clearRetained();
    }
  }

  function ensureStarted() {
    if (started || stopped) return;
    started = true;
    try { usageSource?.start?.(); } catch { /* An unavailable gateway must not stop Codex lifecycle telemetry. */ }
    if (!connector) return;
    reason = 'connecting';
    try {
      connection = connector({ status, observe });
      Promise.resolve(connection?.start?.()).catch(() => status({ connected: false, source: 'codex_app_server', reason: 'source_unavailable' }));
    } catch { status({ connected: false, source: 'none', reason: 'source_unavailable' }); }
  }

  function snapshot({ taskId = null } = {}) {
    connection?.select?.(taskId);
    const now = wallClock();
    const unavailable = !connected || stopped;
    const stale = !unavailable && (lastContact === null || monotonicClock() - lastContact > staleMs);
    if (retained && taskId !== null && retained.session?.id !== taskId) clearRetained();
    if ((unavailable || stale) && !stopped) {
      disconnectedAt ??= monotonicClock();
      // Keep the last exact session identity for a bounded period. The gateway
      // still refreshes its per-request totals, while Codex-only lifecycle,
      // speed and last-request freshness are explicitly treated as retained.
      const canRetain = stale || RETAINABLE_REASONS.has(reason);
      if (canRetain && retained && monotonicClock() - disconnectedAt <= idleRetentionMs
        && (taskId === null || retained.session?.id === taskId)) {
        const gateway = gatewaySnapshot(usageSource, retained.session.id, now);
        if (gateway) {
          return publicLiveSnapshot({
            ...retained, sampledAt: new Date(now).toISOString(), state: 'available',
            source: 'magpie_gateway', reason: stale ? 'source_stale' : reason, observedAt: gateway.observedAt,
            usage: gatewayUsage(gateway, retained.usage), lifecycle: null, speed: null,
            gateway: { state: gateway.state, observedAt: gateway.observedAt, matchedRequests: gateway.matchedRequests, countedRequests: gateway.countedRequests },
          }, { taskId, now });
        }
      }
      if (stale || !RETAINABLE_REASONS.has(reason)) clearRetained();
    }
    if (unavailable) return unavailableLiveSnapshot(reason ?? 'source_disconnected', now, source === 'none' ? 'unavailable' : 'disconnected', source);
    if (stale) return unavailableLiveSnapshot('source_stale', now, 'disconnected', source);
    let thread;
    if (taskId !== null) thread = threads.get(taskId);
    else {
      const active = [...threads.values()].filter((entry) => entry.primary !== false && entry.state === 'active');
      if (active.length > 1) { clearRetained(); return unavailableLiveSnapshot('multiple_active_threads', now, 'ambiguous', source); }
      thread = active[0];
      if (thread?.primary === null) { clearRetained(); return unavailableLiveSnapshot('identity_unverified', now, 'unavailable', source); }
      // A finished conversation keeps its last confirmed data for a short while instead of blanking out.
      if (!thread) {
        const idle = [...threads.values()].filter((entry) => entry.primary !== false && entry.state === 'idle'
          && now - Date.parse(entry.observedAt) <= idleRetentionMs);
        thread = idle.reduce((best, entry) => (!best || Date.parse(entry.observedAt) > Date.parse(best.observedAt) ? entry : best), null);
        if (thread?.primary === null) { clearRetained(); return unavailableLiveSnapshot('identity_unverified', now, 'unavailable', source); }
      }
      // A conversation whose last turn failed is still the conversation the card
      // should describe: its counters and model are confirmed history, and the
      // runtime reports `systemError` for a session that merely ended badly. Leaving
      // it out of the fallback made an unpinned card report "no active thread" for a
      // conversation it had just received a full snapshot of, which is exactly the
      // blank card that made the source look dead while the socket was healthy.
      if (!thread) {
        const settled = [...threads.values()].filter((entry) => entry.primary !== false && entry.state === 'failed'
          && now - Date.parse(entry.observedAt) <= idleRetentionMs);
        thread = settled.reduce((best, entry) => (!best || Date.parse(entry.observedAt) > Date.parse(best.observedAt) ? entry : best), null);
        if (thread?.primary === null) { clearRetained(); return unavailableLiveSnapshot('identity_unverified', now, 'unavailable', source); }
      }
    }
    if (!thread || (taskId === null ? thread.primary !== true : thread.primary === false)) {
      clearRetained();
      return unavailableLiveSnapshot(taskId ? 'thread_not_observed' : 'no_active_thread', now, 'unavailable', source);
    }
    // Codex reports its own session counter, which can omit requests. The main
    // card uses the gateway's per-request sum for the same exact thread instead.
    // `last` still comes from Codex and has already matched the gateway request.
    const gateway = gatewaySnapshot(usageSource, thread.id, now);
    const reconciled = Boolean(gateway);
    const displaySource = reconciled ? 'magpie_gateway' : source;
    const displayObservedAt = reconciled ? gateway.observedAt : thread.observedAt;
    let displaySpeed;
    if (reconciled && thread.state === 'active') {
      // Magpie writes completed request usage, not Codex's token events. Measure
      // between local observations so stale or mixed log timestamp zones cannot
      // distort the rate; each newly appended request still updates it every second.
      displaySpeed = gatewaySpeed.observe(thread.id, gateway.usage, new Date(now).toISOString(), monotonicClock());
    } else if (reconciled) {
      gatewaySpeed.reset();
      displaySpeed = null;
    } else {
      gatewaySpeed.reset();
      displaySpeed = thread.speedTracker.current();
    }
    const projected = publicLiveSnapshot({
      sampledAt: new Date(now).toISOString(), state: reconciled || thread.usage ? 'available' : 'waiting', source: displaySource, reason: reconciled || thread.usage ? null : 'usage_unconfirmed',
      observedAt: displayObservedAt, session: { id: thread.id }, usage: reconciled ? gatewayUsage(gateway, thread.usage) : thread.usage, model: thread.model, reasoningEffort: thread.reasoningEffort,
      lifecycle: thread.lifecycle, speed: displaySpeed,
      gateway: reconciled ? { state: gateway.state, observedAt: gateway.observedAt, matchedRequests: gateway.matchedRequests, countedRequests: gateway.countedRequests } : null,
    }, { taskId, now });
    disconnectedAt = null;
    if (projected.state === 'available' && projected.source === 'magpie_gateway' && projected.session && projected.usage) retained = projected;
    else retained = null;
    return projected;
  }

  async function refresh({ taskId = null } = {}) {
    if (stopped) return;
    connection?.select?.(taskId);
    try { connection?.refresh?.(); } catch { /* The next poll retains the old source state. */ }
    if (usageSource?.refresh) await usageSource.refresh({ force: true });
  }

  async function stop() {
    if (stopped) return;
    stopped = true; connected = false; threads.clear(); retained = null; disconnectedAt = null; gatewaySpeed.reset(); reason = 'source_disconnected';
    await Promise.all([connection?.stop?.(), usageSource?.stop?.()]);
  }
  return { ensureStarted, snapshot, refresh, stop };
}
