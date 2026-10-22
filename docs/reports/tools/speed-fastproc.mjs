// Fast process watcher for the local tail attribution.
// The runner only observes child 'close' (all stdio pipes closed). On Windows a
// grandchild that inherited a pipe keeps it open, so the gap between "process
// graph gone" and "run marked complete" is the local tail we want to measure.
// Get-Process is used instead of Get-CimInstance: CIM costs ~2s per sample,
// which is useless for a 10s tail.
// Usage: node output/speed-fastproc.mjs <logPath> [intervalMs]
import { appendFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const logPath = process.argv[2] ?? 'output/speed-fastproc.log';
const interval = Number(process.argv[3] ?? 100);
const PS = 'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const NAMES = ['codex', 'node_repl', 'codex-computer-use'];

writeFileSync(logPath, '');
const started = Date.now();
let last = null;

const script = `
$r = @()
foreach ($n in @(${NAMES.map((n) => `'${n}'`).join(',')})) {
  $p = @(Get-Process -Name $n -ErrorAction SilentlyContinue)
  foreach ($x in $p) { $r += "$($x.Id)|$($n)" }
}
if ($r.Count -eq 0) { '-' } else { $r -join ',' }
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sample() {
  const at = Date.now();
  const r = spawnSync(PS, ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5000,
  });
  const text = (r.stdout ?? '').trim() || '-';
  if (text === last) return;
  last = text;
  appendFileSync(logPath, [
    new Date(at).toISOString(),
    at - started,
    `sample_ms=${Date.now() - at}`,
    text,
  ].join('\t') + '\n');
}

console.log(`watching ${NAMES.join(',')} every ${interval}ms -> ${logPath}`);
const budget = Number(process.env.WATCH_MS ?? 1200000);
while (Date.now() - started < budget) {
  sample();
  await sleep(interval);
}
sample();
appendFileSync(logPath, `${new Date().toISOString()}\t${Date.now() - started}\tSTOP\n`);
console.log('stop');
