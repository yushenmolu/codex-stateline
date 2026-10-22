// Read-only driver: starts one real pelican-cockpit benchmark run against the
// local companion server and reports the classified outcome. It never scores,
// never edits, and stops polling as soon as the run reaches a terminal status.
import { randomUUID } from 'node:crypto';

const BASE = 'http://127.0.0.1:4173';
const ORIGIN = 'http://127.0.0.1:4173';
const model = process.argv[2] ?? 'example-provider/deepseek-v4.1-flash';
const effort = process.argv[3] ?? 'low';

const bootstrapHeaders = {
  Origin: ORIGIN,
  'Sec-Fetch-Site': 'same-origin',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Dest': 'empty',
};

const nonceResponse = await fetch(`${BASE}/api/nonce`, { headers: bootstrapHeaders });
if (!nonceResponse.ok) {
  console.log(`NONCE_FAILED status=${nonceResponse.status} body=${await nonceResponse.text()}`);
  process.exit(2);
}
const nonce = nonceResponse.headers.get('x-codex-companion-nonce');
console.log(`NONCE_OK len=${nonce?.length ?? 0}`);

const requestId = randomUUID();
const started = Date.now();
const runResponse = await fetch(`${BASE}/api/benchmark/run`, {
  method: 'POST',
  headers: {
    ...bootstrapHeaders,
    'Content-Type': 'application/json',
    'X-Codex-Companion-Nonce': nonce,
  },
  body: JSON.stringify({ requestId, model, reasoningEffort: effort, mode: 'cockpit' }),
});
const runBody = await runResponse.text();
console.log(`RUN_HTTP=${runResponse.status} body=${runBody.slice(0, 400)}`);
if (!runResponse.ok) process.exit(3);

const terminal = new Set(['completed', 'failed', 'cancelled']);
let last = null;
for (;;) {
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const snapshot = await (await fetch(`${BASE}/api/benchmark`, { headers: bootstrapHeaders })).json();
  const run = snapshot.runs?.find((entry) => entry.requestId === requestId) ?? snapshot.activeRun;
  const status = run?.status ?? 'unknown';
  const progress = snapshot.activeRun?.progress;
  if (status !== last) {
    console.log(`T+${Math.round((Date.now() - started) / 1000)}s status=${status} stage=${progress?.stage ?? '-'} elapsed=${run?.elapsedMs ?? '-'}`);
    last = status;
  }
  if (terminal.has(status)) {
    console.log(`TERMINAL status=${status}`);
    console.log(`RESULT ${JSON.stringify(run?.caseResults ?? [], null, 2).slice(0, 4000)}`);
    break;
  }
  if (Date.now() - started > 20 * 60 * 1000) {
    console.log('TIMEOUT waiting for terminal status');
    process.exit(4);
  }
}
