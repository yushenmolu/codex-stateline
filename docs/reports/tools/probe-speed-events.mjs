// Read-only probe: log every conversation event the connector publishes and run the
// observed-speed tracker against it, so we can see why the widget never shows a rate.
import { createDesktopLiveConnector } from '../src/telemetry/desktop-live.js';
import { createObservedSpeedTracker } from '../src/telemetry/speed.js';

const tracker = createObservedSpeedTracker();
const connector = createDesktopLiveConnector();
let conversations = 0;
const started = performance.now();

const connection = connector({
  status: (s) => process.stdout.write(`STATUS ${JSON.stringify(s)} @${Math.round(performance.now() - started)}ms\n`),
  observe: (e) => {
    if (e.type === 'heartbeat') return;
    if (e.type !== 'conversation') {
      process.stdout.write(`EVT ${e.type} ${e.threadId ?? ''} @${Math.round(performance.now() - started)}ms\n`);
      return;
    }
    conversations += 1;
    const now = performance.now();
    const rate = tracker.observe(e.threadId, e.usage, e.observedAt, now);
    process.stdout.write(`CONV ${e.observedAt} state=${e.state} out=${e.usage?.outputTokens ?? 'null'} in=${e.usage?.inputTokens ?? 'null'} speed=${rate ? JSON.stringify(rate) : 'null'} @${Math.round(now - started)}ms\n`);
  },
});

connection.start();
const timer = setInterval(() => connection.select(null), 1000);

setTimeout(async () => {
  clearInterval(timer);
  await connection.stop();
  process.stdout.write(`total conversations=${conversations}\n`);
  process.exit(0);
}, Number(process.argv[2] ?? 90) * 1000);
