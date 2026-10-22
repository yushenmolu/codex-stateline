// Wrapper: runs the existing read-only driver as a child process and stamps
// every output line with an elapsed-ms offset, so wall-clock timing is exact.
// Usage: node output/speed-wrap.mjs <model> <effort> <logPath>
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';

const model = process.argv[2] ?? 'example-provider/deepseek-v4.1-flash';
const effort = process.argv[3] ?? 'low';
const logPath = process.argv[4] ?? `output/speed-run-${Date.now()}.log`;

const out = createWriteStream(logPath, { flags: 'w' });
const t0 = Date.now();
const stamp = () => String(Date.now() - t0).padStart(7, ' ');

function emit(line) {
  const text = `[+${stamp()}ms] ${line}`;
  console.log(text);
  out.write(text + '\n');
}

emit(`SPAWN model=${model} effort=${effort} at ${new Date(t0).toISOString()}`);
const child = spawn(process.execPath, ['output/run-pelican-cockpit.mjs', model, effort], {
  cwd: process.cwd(),
  stdio: ['ignore', 'pipe', 'pipe'],
});

let buf = '';
child.stdout.on('data', (chunk) => {
  buf += chunk.toString();
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    emit(buf.slice(0, idx));
    buf = buf.slice(idx + 1);
  }
});
child.stderr.on('data', (chunk) => emit(`[stderr] ${chunk.toString().trimEnd()}`));
child.on('close', (code, signal) => {
  if (buf.trim()) emit(buf.trimEnd());
  const total = Date.now() - t0;
  emit(`EXIT code=${code} signal=${signal} wallMs=${total} wallSec=${(total / 1000).toFixed(1)}`);
  out.end();
});
