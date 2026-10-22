// Read-only end-to-end verification: drives the real telemetry stack against the
// live Codex IPC pipe and prints the published snapshots so we can see whether
// optional cache counters survive and whether the observed timestamps advance.
import { createDesktopLiveConnector } from '../src/telemetry/desktop-live.js';
import { createLiveTelemetry, publicLiveSnapshot } from '../src/telemetry/live-telemetry.js';

const seconds = Number(process.argv[2] ?? 20);
const events = [];
const connector = createDesktopLiveConnector();
const live = createLiveTelemetry({ connector });
live.ensureStarted();

const startedAt = Date.now();
const timer = setInterval(() => {
  const raw = live.snapshot({ taskId: null });
  const projected = publicLiveSnapshot(raw, { taskId: null });
  events.push({
    t: ((Date.now() - startedAt) / 1000).toFixed(1),
    sampledAt: projected.sampledAt,
    observedAt: projected.observedAt,
    state: projected.state,
    reason: projected.reason,
    input: projected.usage?.inputTokens ?? null,
    cached: projected.usage?.cachedInputTokens ?? null,
    output: projected.usage?.outputTokens ?? null,
    reasoning: projected.usage?.reasoningOutputTokens ?? null,
    speed: projected.speed ? Number(projected.speed.outputTokensPerSecond.toFixed(1)) : null,
    lifecycle: projected.lifecycle ? `${projected.lifecycle.state}:${projected.lifecycle.startedAt ?? '-'}:${projected.lifecycle.elapsedSeconds ?? '-'}` : null,
  });
}, 1000);

setTimeout(async () => {
  clearInterval(timer);
  await live.stop();
  const first = events[0], last = events.at(-1);
  process.stdout.write(`samples=${events.length}\n`);
  process.stdout.write(`first=${JSON.stringify(first)}\n`);
  process.stdout.write(`last =${JSON.stringify(last)}\n`);
  const observedAdvanced = new Set(events.map((e) => e.observedAt)).size;
  const distinctInputs = new Set(events.map((e) => e.input)).size;
  process.stdout.write(`distinct observedAt=${observedAdvanced} distinct input=${distinctInputs}\n`);
  process.stdout.write(`cache present in ${events.filter((e) => e.cached !== null).length}/${events.length} samples\n`);
  const withCache = events.find((e) => e.cached !== null);
  process.stdout.write(`first cached sample=${withCache ? JSON.stringify(withCache) : 'none'}\n`);
  process.exit(0);
}, seconds * 1000);
