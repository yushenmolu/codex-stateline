import { createSessionReader } from './session-reader.js';
import { createSpeedTracker } from './speed.js';
import { publicUsage, unavailableTelemetry } from './usage.js';

function canSampleSpeed(scan) {
  if (scan.state !== 'ok') return false;
  const keys = ['conversationContext', 'lastCompletedTurn', 'turnAverageSpeed'];
  // Injected legacy readers have no telemetry contract. Once any contract
  // field is present, require complete verified evidence before sampling.
  if (!keys.some((key) => Object.hasOwn(scan, key))) return true;
  return keys.every((key) => scan[key]?.state === 'available' && scan[key]?.reason === 'none');
}

export function createTelemetryWorker({ sessionsDir, wallClock = () => Date.now(), monotonicClock = () => performance.now(), scheduler = globalThis, reader = createSessionReader({ sessionsDir, wallClock }) } = {}) {
  const tracker = createSpeedTracker({ monotonicClock });
  let current = publicUsage('unavailable', null, null, null);
  let refreshedAt = null, lastWall = null, timer = null, running = null;
  let stopped = true, queued = false;
  let speedEligible = false;
  async function collect() {
    const wall = wallClock();
    if (lastWall !== null && wall < lastWall) { tracker.reset(); reader.reset?.(); }
    lastWall = wall;
    try {
      const scan = await reader.read();
      speedEligible = canSampleSpeed(scan);
      const speed = speedEligible ? tracker.observe(scan.session.id, scan.usage, monotonicClock()) : (tracker.reset(), null);
      current = publicUsage(scan.state, scan.session, scan.usage, speed, scan.conversationContext ? scan : unavailableTelemetry('read_failed'));
      refreshedAt = monotonicClock();
    } catch {
      speedEligible = false;
      tracker.reset(); reader.reset?.();
      current = publicUsage('unavailable', null, null, null, unavailableTelemetry('read_failed'));
    }
  }
  function refresh() {
    if (running) { queued = true; return running; }
    running = (async () => {
      do { queued = false; await collect(); } while (queued && !stopped);
    })().finally(() => { running = null; });
    return running;
  }
  async function start() {
    stopped = false; await refresh();
    if (!stopped && timer === null) timer = scheduler.setInterval(() => { void refresh(); }, 1000);
    return snapshot();
  }
  function snapshot() {
    if (refreshedAt === null || monotonicClock() - refreshedAt > 3000) {
      const sources = Object.fromEntries(['conversationContext', 'lastCompletedTurn', 'turnAverageSpeed'].map((key) => [key, current[key].source]));
      return publicUsage('unavailable', null, null, null, unavailableTelemetry('snapshot_stale', 'stale', sources));
    }
    return publicUsage(current.state, current.session, current.usage, speedEligible ? tracker.current(monotonicClock()) : null, current);
  }
  async function stop() {
    stopped = true; queued = false;
    if (timer !== null) scheduler.clearInterval(timer);
    timer = null; await running; tracker.reset(); reader.reset?.();
  }
  return { start, snapshot, stop, refresh };
}
