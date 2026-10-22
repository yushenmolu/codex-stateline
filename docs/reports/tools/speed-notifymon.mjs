// Watches the processes that can delay the codex CLI's stdio close, and writes
// every appearance/disappearance with an ISO timestamp. The runner only sees
// child 'close' (all stdio pipes closed), and on Windows a grandchild that
// inherited a pipe keeps it open, so the gap between "graph gone" and "run
// marked complete" is the local tail we are trying to attribute.
// Usage: node output/speed-notifymon.mjs <logPath> [intervalMs] [parentPid]
import { appendFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const logPath = process.argv[2] ?? 'output/speed-notifymon.log';
const interval = Number(process.argv[3] ?? 200);
const parentPid = Number(process.argv[4] ?? 42172);
const PS = 'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const NAMES = ['codex.exe', 'node_repl.exe', 'codex-computer-use.exe'];

writeFileSync(logPath, '');
const started = Date.now();
let last = '';

// One PowerShell invocation returns every interesting process as one line per
// hit; spawning pwsh per sample would cost more than the sample interval.
const script = `
$out = @()
Get-CimInstance Win32_Process -Filter "Name='codex.exe' OR Name='node_repl.exe' OR Name='codex-computer-use.exe'" -ErrorAction SilentlyContinue | ForEach-Object {
  $p = $null
  try { $p = $_.ParentProcessId } catch {}
  $out += "$($_.ProcessId)|$p|$($_.Name)|$($_.CreationDate.Ticks)"
}
if ($out.Count -eq 0) { '' } else { $out -join ";" }
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sample() {
  const at = Date.now();
  const r = spawnSync(PS, ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
  });
  const text = (r.stdout ?? '').trim();
  if (!text || text === last) return;
  last = text;
  const rows = text.split(';').filter(Boolean);
  const interesting = rows.filter((row) => {
    const [, ppid, name] = row.split('|');
    return name === 'codex.exe' || name === 'codex-computer-use.exe' || Number(ppid) === parentPid || name === 'node_repl.exe';
  });
  appendFileSync(logPath, [
    new Date(at).toISOString(),
    at - started,
    `n=${interesting.length}`,
    `sample_ms=${Date.now() - at}`,
    interesting.join(';') || '-',
  ].join('\t') + '\n');
}

console.log(`watching ${NAMES.join(',')} every ${interval}ms -> ${logPath}`);
const budget = Number(process.env.WATCH_MS ?? 900000);
while (Date.now() - started < budget) {
  sample();
  await sleep(interval);
}
sample();
appendFileSync(logPath, `${new Date().toISOString()}\t${Date.now() - started}\tSTOP\n`);
console.log('stop');
