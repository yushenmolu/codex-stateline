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
