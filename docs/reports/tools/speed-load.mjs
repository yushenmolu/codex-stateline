import { request } from 'node:http';

const durationMs = Number(process.argv[2] ?? 300000);
const intervalMs = Number(process.argv[3] ?? 250);
const url = new URL('http://127.0.0.1:4173/api/benchmark');
const headers = { Origin: 'http://127.0.0.1:4173', 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' };

function one() {
  return new Promise((resolve) => {
    const started = Date.now();
    const req = request({ ...url, method: 'GET', headers }, (res) => {
      let bytes = 0;
      res.on('data', (c) => { bytes += c.length; });
      res.on('end', () => resolve({ ms: Date.now() - started, bytes }));
    });
    req.on('error', () => resolve({ ms: Date.now() - started, bytes: 0 }));
    req.end();
  });
}

const startedAt = Date.now();
let n = 0, totalMs = 0, totalBytes = 0, maxMs = 0;
while (Date.now() - startedAt < durationMs) {
  const r = await one();
  n += 1; totalMs += r.ms; totalBytes += r.bytes; if (r.ms > maxMs) maxMs = r.ms;
  const wait = intervalMs - r.ms;
  if (wait > 0) await new Promise((res) => setTimeout(res, wait));
}
console.log(`LOAD requests=${n} spanMs=${Date.now() - startedAt} avgMs=${(totalMs / n).toFixed(2)} maxMs=${maxMs} totalMB=${(totalBytes / 1048576).toFixed(1)} avgKB=${(totalBytes / n / 1024).toFixed(1)}`);
