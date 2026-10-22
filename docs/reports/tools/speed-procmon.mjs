// Read-only process-tree sampler. Logs, per sample, which codex/helper processes
// are alive under the service pid, so we can compare "codex.exe gone" against
// "benchmark run marked complete" and attribute the local tail.
// Usage: node output/speed-procmon.mjs <logPath> [intervalMs]
import { writeFileSync, appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const logPath = process.argv[2] ?? 'output/speed-procmon.log';
const interval = Number(process.argv[3] ?? 500);
const PARENT = Number(process.env.WATCH_PARENT ?? 42172);
const PS = 'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
writeFileSync(logPath, '');

const script = `$all = Get-CimInstance Win32_Process -Filter "Name='codex.exe' or Name='node_repl.exe'"; `
  + `foreach ($p in $all) { if ($p.ParentProcessId -eq ${PARENT} -or $p.Name -eq 'node_repl.exe') { `
  + `Write-Output ($p.ProcessId.ToString() + '|' + $p.ParentProcessId.ToString() + '|' + $p.Name) } }`;

function sample() {
  let out = '';
  try {
    out = execFileSync(PS, ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true });
  } catch (error) {
    appendFileSync(logPath, `${new Date().toISOString()}\tERROR\t${String(error.message).split('\n')[0]}\n`);
    return;
  }
  const live = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  appendFileSync(logPath, `${new Date().toISOString()}\t${live.length}\t${live.join(',')}\n`);
}

console.log(`watching parent=${PARENT} interval=${interval}ms log=${logPath}`);
sample();
const timer = setInterval(sample, interval);
setTimeout(() => { clearInterval(timer); sample(); console.log('done'); process.exit(0); }, Number(process.env.WATCH_MS ?? 900000));
