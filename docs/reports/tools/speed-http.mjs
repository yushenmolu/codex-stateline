// Read-only measurement: how heavy is the polling payload the panel pulls every
// 1.5s, and how does a single cockpit preview request behave?
// Usage: node output/speed-http.mjs
const BASE = 'http://127.0.0.1:4173';

async function timed(path, headers = {}) {
  const t0 = performance.now();
  const res = await fetch(BASE + path, { headers });
  const body = await res.text();
  const ms = performance.now() - t0;
  return { path, status: res.status, ms: Number(ms.toFixed(1)), bytes: Buffer.byteLength(body), body };
}

const h = { Origin: BASE, 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' };

// Warm up once so the first (cold) sample does not skew the numbers.
await timed('/api/benchmark', h);

const samples = [];
for (let i = 0; i < 6; i += 1) samples.push(await timed('/api/benchmark', h));
const ms = samples.map((s) => s.ms).sort((a, b) => a - b);
console.log(JSON.stringify({
  what: '/api/benchmark (panel polls this every 1500ms)',
  bytesEach: samples[0].bytes,
  msMin: ms[0],
  msMedian: ms[Math.floor(ms.length / 2)],
  msMax: ms.at(-1),
  runsInPayload: JSON.parse(samples[0].body).runs?.length,
  answerCharsInPayload: (JSON.parse(samples[0].body).runs ?? []).reduce((a, r) => a + (r.caseResults ?? []).reduce((b, c) => b + (typeof c.answer === 'string' ? c.answer.length : 0), 0), 0),
}, null, 2));

// A cockpit preview: the service supports the version, so measure the real cost.
const snap = JSON.parse(samples[0].body);
const completed = (snap.runs ?? []).filter((r) => r.status === 'completed' && r.caseSetVersion === 'pelican-cockpit-v1').at(-1);
if (completed) {
  const cap = await (await fetch(BASE + '/api/capabilities', { headers: h })).json();
  const instanceId = cap.instanceId;
  const p = await timed(`/api/benchmark/preview?runId=${completed.runId}&instanceId=${instanceId}`, { ...h, Referer: BASE + '/preview', 'Sec-Fetch-Dest': 'empty' });
  const parsed = JSON.parse(p.body);
  console.log(JSON.stringify({
    what: '/api/benchmark/preview (cockpit source preview)',
    runId: completed.runId,
    status: p.status,
    ms: p.ms,
    bytes: p.bytes,
    previewState: parsed.previewState,
    reason: parsed.reason,
    answerBytesInResponse: typeof parsed.answer === 'string' ? Buffer.byteLength(parsed.answer) : 0,
  }, null, 2));
} else {
  console.log('no completed cockpit run in payload yet');
}
