import test from 'node:test';
import assert from 'node:assert/strict';
import { createObservedSpeedTracker } from '../src/telemetry/speed.js';

const NOW = Date.parse('2026-10-18T04:00:00.000Z');
const usage = (outputTokens, inputTokens = 100) => ({ inputTokens, outputTokens, totalTokens: inputTokens + outputTokens });

function setup() {
  let mono = 0, wall = NOW;
  const tracker = createObservedSpeedTracker({ monotonicClock: () => mono });
  return {
    tracker,
    observe: (output, id = 'thread', input = 100) => tracker.observe(id, usage(output, input), new Date(wall).toISOString()),
    advance(ms, wallMs = ms) { mono += ms; wall += wallMs; },
  };
}

test('observed speed covers slow confirmed updates rather than a five-second polling window', () => {
  const s = setup();
  assert.equal(s.observe(10), null);
  s.advance(23_298);
  const rate = s.observe(110);
  assert.equal(rate.outputTokens, 100);
  assert.equal(rate.elapsedSeconds, 23.298);
  assert.equal(rate.outputTokensPerSecond, 100 / 23.298);
  s.advance(5_000); assert.deepEqual(s.observe(110), rate);
  s.advance(55_001); assert.equal(s.tracker.current(), null);
});

test('observed speed does not bridge long pauses, identity changes, counter regression or wall-clock jumps', () => {
  for (const mode of ['pause', 'identity', 'counter', 'clock', 'invalid']) {
    const s = setup(); s.observe(10); s.advance(10_000); assert.ok(s.observe(30));
    if (mode === 'pause') { s.advance(60_001); assert.equal(s.observe(50), null); }
    if (mode === 'identity') assert.equal(s.observe(50, 'other'), null);
    if (mode === 'counter') assert.equal(s.observe(5), null);
    if (mode === 'clock') { s.advance(10_000, 11_001); assert.equal(s.observe(50), null); }
    if (mode === 'invalid') assert.equal(s.tracker.observe('thread', { ...usage(50), totalTokens: 999 }, new Date(NOW).toISOString()), null);
    assert.equal(s.tracker.current(), null, mode);
    s.advance(10_000);
    const next = s.observe(60, mode === 'identity' ? 'other' : 'thread');
    if (mode === 'invalid') {
      assert.equal(next, null, 'invalid counters discard the entire baseline');
      s.advance(10_000); assert.ok(s.observe(70));
    } else assert.ok(next, mode);
  }
});

test('observed speed uses a bounded rolling window and only confirms zero with a new counter update', () => {
  const s = setup(); s.observe(0);
  s.advance(10_000); assert.equal(s.observe(0), null);
  const zero = s.observe(0, 'thread', 200);
  assert.equal(zero.outputTokensPerSecond, 0);
  for (let i = 1; i <= 20; i++) { s.advance(10_000); s.observe(i * 20, 'thread', 200 + i); }
  const rate = s.tracker.current();
  assert.equal(rate.elapsedSeconds, 120);
  assert.equal(rate.outputTokens, 240);
  assert.equal(rate.outputTokensPerSecond, 2);
  s.tracker.reset(); assert.equal(s.tracker.current(), null);
});
