// Isolates the codex CLI's own shutdown cost.
// The benchmark's diagnostics stop at the last JSON event, and elapsedMs keeps
// running until child 'close'. This script timestamps every stdout line and the
// process exit, so the gap "turn.completed -> exit" is measured directly.
// Usage: node output/speed-cli-tail.mjs [label] [--no-notify]
import { spawn } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { resolveExecutable } from '../src/benchmark/runner.js';

const label = process.argv[2] ?? 'default';
const noNotify = process.argv.includes('--no-notify');
const executable = process.env.CODEX_EXE ?? resolveExecutable();
const logPath = `output/speed-cli-tail-${label}.log`;
writeFileSync(logPath, '');

const args = [
  'exec', '--json', '--ephemeral', '--skip-git-repo-check',
  '--sandbox', 'read-only',
  '--disable', 'shell_tool', '--disable', 'multi_agent',
  '--disable', 'apps', '--disable', 'plugins',
  '-c', 'mcp_servers={}',
  '-c', 'web_search="disabled"',
];
if (noNotify) args.push('-c', 'notify=[]');
// The prompt goes over stdin (args end with '-'), exactly as the benchmark
// runner does, so no shell quoting can mangle it.
args.push('-');
const PROMPT = 'reply with the single word OK and nothing else';

const started = Date.now();
const marks = [];
const log = (what, extra = '') => {
  const line = `[+${String(Date.now() - started).padStart(6)}ms]\t${what}${extra ? '\t' + extra : ''}`;
  marks.push({ at: Date.now() - started, what });
  appendFileSync(logPath, line + '\n');
  console.log(line);
};

log('SPAWN', `label=${label} noNotify=${noNotify}`);

const child = spawn(executable, args, { shell: false, windowsHide: true });
let buffer = '';
const events = [];

child.stdout.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let type = 'unparsed';
    try { type = JSON.parse(line).type ?? 'unknown'; } catch { /* keep as unparsed */ }
    events.push({ type, at: Date.now() - started });
    log(`EVENT ${type}`);
  }
});

child.stderr.on('data', (chunk) => {
  const text = chunk.toString('utf8').trim();
  if (text) log('STDERR', text.slice(0, 160).replace(/\s+/g, ' '));
});

child.stdin.end(PROMPT);

let exitMs = null;
child.on('exit', (code) => {
  exitMs = Date.now() - started;
  log('EXIT', `code=${code}`);
});

child.on('close', (code) => {
  log('CLOSE', `code=${code}`);
  const turnCompleted = events.find((e) => e.type === 'turn.completed');
  const firstEvent = events[0];
  const summary = {
    label,
    noNotify,
    firstEventMs: firstEvent?.at ?? null,
    turnCompletedMs: turnCompleted?.at ?? null,
    exitMs,
    closeMs: Date.now() - started,
    exitToCloseMs: exitMs != null ? (Date.now() - started) - exitMs : null,
    tailFromTurnCompletedMs: turnCompleted ? (Date.now() - started) - turnCompleted.at : null,
    eventTypes: [...new Set(events.map((e) => e.type))],
  };
  appendFileSync(logPath, 'SUMMARY\t' + JSON.stringify(summary) + '\n');
  console.log('SUMMARY\t' + JSON.stringify(summary));
});
