// Read-only probe: runs the real pelican-cockpit case through the production
// runner, teeing every raw JSON line to disk so transient provider errors keep
// their exact message. Nothing in src/ is modified.
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { createRunner } from '../src/benchmark/runner.js';
import { COCKPIT_CASES } from '../src/benchmark/cases.js';

const model = process.argv[2] ?? 'example-provider/gpt-6.1-sol';
const effort = process.argv[3] ?? 'max';
const logPath = join(process.cwd(), 'output', `pelican-raw-${model.replace(/[^\w.-]/g, '_')}-${effort}.log`);
const log = createWriteStream(logPath, { flags: 'w' });

const spawnImpl = (executable, args, options) => {
  log.write(`# exe=${executable}\n# args=${JSON.stringify(args)}\n`);
  const child = spawn(executable, args, options);
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk) => { log.write(chunk); });
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk) => { log.write(`# STDERR ${chunk}`); });
  return child;
};

// The UI supplies the discovered catalog; the probe mirrors that so the same
// identifier policy applies instead of the static fallback allowlist.
const runner = createRunner({ spawnImpl, modelPolicy: [model], effortPolicy: [effort] });
const started = Date.now();
console.log(`RUN model=${model} effort=${effort} log=${logPath}`);
const result = await runner.runCase({
  model,
  reasoningEffort: effort,
  caseDef: COCKPIT_CASES[0],
  onProgress: ({ stage, lastEvent }) => {
    console.log(`[T+${Math.round((Date.now() - started) / 1000)}s] ${stage} ${lastEvent?.type ?? ''}`);
  }
});
log.end();
console.log(`RESULT ok=${result.ok} code=${result.code ?? ''} answerBytes=${Buffer.byteLength(result.answer ?? '')}`);
console.log(`DIAG ${JSON.stringify(result.diagnostics)}`);
