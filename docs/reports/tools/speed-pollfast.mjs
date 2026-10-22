// Fine-grained status poller: records the exact wall-clock moment the active
// benchmark run leaves "running". The 3s driver poll is far too coarse to
// attribute the local tail, so this samples at 200ms and logs every change.
// Usage: node output/speed-pollfast.mjs <logPath> [intervalMs]
import { writeFileSync, appendFileSync } from 'node:fs';

const logPath = process.argv[2] ?? 'output/speed-pollfast.log';
const interval = Number(process.argv[3] ?? 200);
const BASE = 'http://127.0.0.1:4173';
const HEADERS = {
  Origin: BASE,
  'Sec-Fetch-Site': 'same-origin',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Dest': 'empty',
};

writeFileSync(logPath, '');
const started = Date.now();
let lastKey = null;
let done = false;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function tick() {
  const at = Date.now();
  let text;
  try {
    const res = await fetch(`${BASE}/api/benchmark`, { headers: HEADERS, cache: 'no-store' });
    text = await res.text();
  } catch (error) {
    appendFileSync(logPath, `${new Date(at).toISOString()}\t${at - started}\tFETCH_ERROR\t${String(error.message).slice(0, 80)}\n`);
    return;
  }
  let data;
  try { data = JSON.parse(text); } catch {
    appendFileSync(logPath, `${new Date(at).toISOString()}\t${at - started}\tPARSE_ERROR\t${text.length}\n`);
    return;
  }
  const key = JSON.stringify([
    data.status,
    data.activeRun?.runId ?? null,
    data.activeRun?.progress?.stage ?? null,
    data.activeRun?.progress?.lastEvent?.type ?? null,
    data.latestRun?.runId ?? null,
    data.latestRun?.status ?? null,
  ]);
  if (key !== lastKey) {
    lastKey = key;
    appendFileSync(logPath, [
      new Date(at).toISOString(),
      at - started,
      'CHANGE',
      data.status,
      data.activeRun?.runId ?? '-',
      data.activeRun?.progress?.stage ?? '-',
      data.activeRun?.progress?.elapsedMs != null ? Math.round(data.activeRun.progress.elapsedMs) : '-',
      data.activeRun?.progress?.lastEvent?.type ?? '-',
      data.latestRun?.status ?? '-',
      `payloadBytes=${Buffer.byteLength(text)}`,
      `ms=${Date.now() - at}`,
    ].join('\t') + '\n');
  }
  if (data.status !== 'running') done = true;
}

console.log(`polling ${BASE}/api/benchmark every ${interval}ms -> ${logPath}`);
while (!done && Date.now() - started < Number(process.env.POLL_MS ?? 1200000)) {
  await tick();
  await sleep(interval);
}
// One last sample after the flip so the log always ends on a terminal state.
await tick();
appendFileSync(logPath, `${new Date().toISOString()}\t${Date.now() - started}\tSTOP\n`);
console.log('stop');
