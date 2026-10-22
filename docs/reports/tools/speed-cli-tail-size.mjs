// Does the codex CLI's shutdown tail scale with answer size?
// The benchmark's real runs show a ~10s gap between turn.completed and run
// completion, but a trivial turn exits in ~3.5s. This asks the same CLI for a
// large answer so the two are comparable.
// Usage: node output/speed-cli-tail-size.mjs <label> <targetLines>
import { spawn } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { resolveExecutable } from '../src/benchmark/runner.js';

const label = process.argv[2] ?? 'big';
const targetLines = Number(process.argv[3] ?? 400);
const logPath = `output/speed-cli-tail-size-${label}.log`;
writeFileSync(logPath, '');
const executable = process.env.CODEX_EXE ?? resolveExecutable();

const args = [
  'exec', '--json', '--ephemeral', '--skip-git-repo-check',
  '--sandbox', 'read-only',
  '--disable', 'shell_tool', '--disable', 'multi_agent',
  '--disable', 'apps', '--disable', 'plugins',
  '-c', 'mcp_servers={}',
  '-c', 'web_search="disabled"',
  '-',
];
const PROMPT = `Write a plain ASCII filler document of exactly about ${targetLines} lines. Each line is 60 characters of lowercase letters. Output only the lines, no code fences, no commentary.`;

const started = Date.now();
const log = (what, extra = '') => {
  const line = `[+${String(Date.now() - started).padStart(6)}ms]\t${what}${extra ? '\t' + extra : ''}`;
  appendFileSync(logPath, line + '\n');
  console.log(line);
};

log('SPAWN', `label=${label} targetLines=${targetLines}`);
const child = spawn(executable, args, { shell: false, windowsHide: true });

let buffer = '';
const events = [];
let answerBytes = 0;

child.stdout.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let parsed = null;
    try { parsed = JSON.parse(line); } catch { continue; }
    const type = parsed.type ?? 'unknown';
    if (type === 'item.completed' && parsed.item?.type === 'agent_message') {
      answerBytes = Buffer.byteLength(parsed.item.text ?? '', 'utf8');
    }
    events.push({ type, at: Date.now() - started });
    log(`EVENT ${type}`, answerBytes ? `answerBytes=${answerBytes}` : '');
  }
});

child.stderr.on('data', (chunk) => {
  const text = chunk.toString('utf8').trim();
  if (text) log('STDERR', text.slice(0, 140).replace(/\s+/g, ' '));
});

child.stdin.end(PROMPT);

let exitMs = null;
child.on('exit', (code) => { exitMs = Date.now() - started; log('EXIT', `code=${code}`); });
child.on('close', (code) => {
  log('CLOSE', `code=${code}`);
  const turnCompleted = events.find((e) => e.type === 'turn.completed');
  const closeMs = Date.now() - started;
  const summary = {
    label, targetLines, answerBytes,
    firstEventMs: events[0]?.at ?? null,
    turnCompletedMs: turnCompleted?.at ?? null,
    exitMs, closeMs,
    tailFromTurnCompletedMs: turnCompleted ? closeMs - turnCompleted.at : null,
  };
  appendFileSync(logPath, 'SUMMARY\t' + JSON.stringify(summary) + '\n');
  console.log('SUMMARY\t' + JSON.stringify(summary));
});
