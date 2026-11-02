import { Buffer } from 'node:buffer';

const base = 'http://127.0.0.1:4173';
const requestId = process.argv[2];
if (!requestId || !/^[A-Za-z0-9_-]{8,128}$/.test(requestId)) {
  throw new Error('Usage: node docs/reports/tools/run-cockpit-benchmark.mjs <requestId>');
}
const json = async (path, options) => {
  const response = await fetch(base + path, options);
  const value = await response.json();
  if (path === '/api/nonce') value.nonce = response.headers.get('x-codex-companion-nonce');
  if (!response.ok) throw new Error(`${path}: ${response.status} ${value?.error?.code ?? 'request_failed'}`);
  return value;
};
const current = await json('/api/benchmark');
if (current.activeRun) throw new Error(`A benchmark is already active: ${current.activeRun.runId}`);
const { nonce } = await json('/api/nonce', { headers: { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' } });
const started = await json('/api/benchmark/run', {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: base, 'x-codex-companion-nonce': nonce },
  body: JSON.stringify({ requestId, model: 'configured', reasoningEffort: 'configured', mode: 'cockpit' }),
});
const runId = started.activeRun?.runId;
if (!runId) throw new Error('The benchmark did not start.');
console.log(JSON.stringify({ event: 'started', requestId, runId }));
let phase = null;
const deadline = Date.now() + 25 * 60 * 1000;
let run;
while (Date.now() < deadline) {
  await new Promise(resolve => setTimeout(resolve, 2000));
  const snapshot = await json('/api/benchmark');
  const active = snapshot.activeRun?.runId === runId ? snapshot.activeRun : null;
  if (active && active.progress?.stage !== phase) {
    phase = active.progress?.stage;
    console.log(JSON.stringify({ event: 'phase', phase, elapsedMs: active.progress.elapsedMs }));
  }
  if (!active) {
    run = [snapshot.latestRun, ...snapshot.runs].find(item => item?.runId === runId);
    if (run) break;
  }
}
if (!run) throw new Error('The benchmark did not reach a terminal state within the observation window.');
const result = run.caseResults?.[0] ?? {};
const summary = {
  event: 'completed', requestId, runId, status: run.status,
  model: run.model, reasoningEffort: run.reasoningEffort,
  elapsedMs: result.elapsedMs ?? result.diagnostics?.elapsedMs ?? null,
  attempts: result.attempts ?? run.attempts ?? null,
  failureCode: result.failureCode ?? null,
};
if (run.status === 'completed') {
  const { instanceId } = await json('/api/capabilities');
  const preview = await json(`/api/benchmark/preview?runId=${encodeURIComponent(runId)}&instanceId=${encodeURIComponent(instanceId)}`, { headers: { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' } });
  const answer = preview.answer ?? '';
  Object.assign(summary, {
    previewState: preview.previewState,
    answerBytes: Buffer.byteLength(answer),
    svgElements: (answer.match(/<(?:path|rect|circle|ellipse|line|polygon|polyline)\b/g) ?? []).length,
    animateTransform: (answer.match(/<animateTransform\b/g) ?? []).length,
    keyframes: (answer.match(/@keyframes\b/g) ?? []).length,
    scriptTags: (answer.match(/<script\b/g) ?? []).length,
    canvas: /<canvas\b/i.test(answer),
    playPauseControl: /播放|暂停|play|pause/i.test(answer),
  });
}
console.log(JSON.stringify(summary, null, 2));
if (run.status !== 'completed') process.exitCode = 1;
