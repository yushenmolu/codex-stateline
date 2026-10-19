export function createSpeedTracker({ monotonicClock = () => performance.now() } = {}) {
  let sessionId = null;
  let last = null;
  let estimate = null;

  function reset(nextSessionId = null) {
    sessionId = nextSessionId;
    last = null;
    estimate = null;
  }

  function observe(id, usage, now = monotonicClock()) {
    if (!usage || !id) { reset(); return unavailable(); }
    if (id !== sessionId) reset(id);
    if (!last) { last = { ...usage, at: now }; return unavailable(); }
    const delta = now - last.at;
    const outputDelta = usage.outputTokens - last.outputTokens;
    const decrease = usage.inputTokens < last.inputTokens || usage.outputTokens < last.outputTokens || usage.totalTokens < last.totalTokens;
    if (decrease) { last = { ...usage, at: now }; estimate = null; return unavailable(); }
    if (usage.inputTokens === last.inputTokens && usage.outputTokens === last.outputTokens && usage.totalTokens === last.totalTokens) {
      return current(now);
    }
    if (delta >= 500 && delta <= 5000 && outputDelta > 0) {
      estimate = { value: outputDelta * 1000 / delta, at: now };
    } else estimate = null;
    last = { ...usage, at: now };
    return current(now);
  }

  function unavailable() { return { outputTokensPerSecond: null, state: 'unavailable' }; }
  function current(now = monotonicClock()) {
    if (!estimate || now < estimate.at || now - estimate.at > 5000) return unavailable();
    return { outputTokensPerSecond: Math.round(estimate.value * 10) / 10, state: 'available' };
  }
  return { observe, current, reset };
}

export function createObservedSpeedTracker({ monotonicClock = () => performance.now() } = {}) {
  const windowMs = 120_000, maxGapMs = 60_000;
  let sessionId = null, points = [], estimate = null;
  const validUsage = (usage) => usage && ['inputTokens', 'outputTokens', 'totalTokens'].every((key) => Number.isSafeInteger(usage[key]) && usage[key] >= 0)
    && Number.isSafeInteger(usage.inputTokens + usage.outputTokens) && usage.totalTokens === usage.inputTokens + usage.outputTokens;

  function reset() { sessionId = null; points = []; estimate = null; }
  function current(now = monotonicClock()) {
    const last = points.at(-1);
    return estimate && last && now >= last.at && now - last.at <= maxGapMs ? { ...estimate } : null;
  }
  function observe(id, usage, observedAt, now = monotonicClock()) {
    const wall = typeof observedAt === 'string' ? Date.parse(observedAt) : NaN;
    if (!id || !validUsage(usage) || !Number.isFinite(wall) || !Number.isFinite(now)) { reset(); return null; }
    const last = points.at(-1);
    const gap = last ? now - last.at : 0, wallGap = last ? wall - last.wall : 0;
    if (id !== sessionId || (last && (gap < 0 || gap > maxGapMs || wallGap < 0 || Math.abs(wallGap - gap) > 1_000
      || ['inputTokens', 'outputTokens', 'totalTokens'].some((key) => usage[key] < last[key])))) reset();
    sessionId = id;
    const previous = points.at(-1);
    // Unchanged IPC patches are not new usage samples and cannot renew a rate.
    if (previous && ['inputTokens', 'outputTokens', 'totalTokens'].every((key) => usage[key] === previous[key])) return current(now);
    points.push({ ...usage, at: now, wall, observedAt });
    while (points.length > 128 || points.length > 1 && (now - points[0].at > windowMs || wall - points[0].wall > windowMs)) points.shift();
    const first = points[0], elapsedSeconds = (wall - first.wall) / 1000;
    if (points.length < 2 || elapsedSeconds < 1 || elapsedSeconds > 120 || now - first.at < 1_000) { estimate = null; return null; }
    const outputTokens = usage.outputTokens - first.outputTokens;
    estimate = {
      source: 'observed_window', outputTokensPerSecond: outputTokens / elapsedSeconds,
      outputTokens, elapsedSeconds, startedAt: first.observedAt, observedAt, includesToolsAndWait: true,
    };
    return current(now);
  }
  return { observe, current, reset };
}
