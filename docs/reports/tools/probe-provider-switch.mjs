// Read-only probe: runs the same `codex exec --json` invocation the benchmark
// runner builds, but dumps every raw JSON line so the failure reason is visible.
// It never scores, never writes to the repo, and uses a temp cwd.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveExecutable } from '../src/benchmark/runner.js';

const model = process.argv[2] ?? 'example-provider/gpt-6.1-sol';
const effort = process.argv[3] ?? 'max';
const prompt = process.argv[4] ?? 'Reply with exactly: OK';
const executable = resolveExecutable();
console.log(`EXE=${executable}`);
console.log(`MODEL=${model} EFFORT=${effort}`);

const cwd = await mkdtemp(join(tmpdir(), 'probe-provider-'));
const args = ['exec', '--json', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only',
  '--disable', 'shell_tool', '--disable', 'multi_agent', '--disable', 'apps', '--disable', 'plugins',
  '-c', 'mcp_servers={}',
  '-c', 'web_search="disabled"'];
if (model !== 'configured') args.push('--model', model);
if (effort !== 'configured') args.push('-c', 'model_reasoning_effort=' + effort);
args.push('-');

const started = Date.now();
const child = spawn(executable, args, { cwd, shell: false, windowsHide: true, env: { ...process.env } });
child.stdin.end(prompt + '\n');

let buffer = '';
let count = 0;
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    count += 1;
    const elapsed = Math.round((Date.now() - started) / 1000);
    let parsed = null;
    try { parsed = JSON.parse(line); } catch { /* keep raw */ }
    const type = parsed?.type ?? 'unparsable';
    if (type === 'error' || type === 'turn.failed') {
      console.log(`[T+${elapsed}s] #${count} ${type} ${line.slice(0, 1200)}`);
    } else if (type === 'item.completed' && parsed?.item?.type === 'agent_message') {
      console.log(`[T+${elapsed}s] #${count} agent_message bytes=${Buffer.byteLength(parsed.item.text ?? '')}`);
    } else {
      console.log(`[T+${elapsed}s] #${count} ${type}`);
    }
  }
});
let stderr = '';
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => { stderr += chunk; if (stderr.length > 8000) stderr = stderr.slice(-8000); });
child.once('close', async (code) => {
  console.log(`CLOSE code=${code} lines=${count} elapsedMs=${Date.now() - started}`);
  if (stderr.trim()) console.log(`STDERR=${stderr.trim().slice(0, 2000)}`);
  await rm(cwd, { recursive: true, force: true });
});
