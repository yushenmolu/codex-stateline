// Reproduces the benchmark runner's own tail in isolation.
// The four real pelican-cockpit runs all show elapsedMs - lastEventElapsedMs
// clustered at ~10.0s, while a bare `codex exec` call exits ~3.5s after
// turn.completed and a 234KB-answer turn exits in 0.5s. This drives the SAME
// createRunner the service uses (temp cwd, --skip-git-repo-check, publish
// machinery, stderr capture) but with a short registered case, so the runner's
// own overhead is separated from upstream generation cost.
// Usage: node output/speed-runner-tail.mjs [label] [caseId] [model] [effort]
import { appendFileSync, writeFileSync } from 'node:fs';
import { createRunner } from '../src/benchmark/runner.js';
import { CASES, COCKPIT_CASES, LEGACY_CASES } from '../src/benchmark/cases.js';

const label = process.argv[2] ?? 'probe';
const caseId = process.argv[3] ?? 'code-trace';
const model = process.argv[4] ?? 'configured';
const effort = process.argv[5] ?? 'low';
const logPath = `output/speed-runner-tail-${label}.log`;
writeFileSync(logPath, '');
const started = Date.now();
const log = (what, extra = '') => {
  const line = `[+${String(Date.now() - started).padStart(6)}ms]\t${what}${extra ? '\t' + extra : ''}`;
  appendFileSync(logPath, line + '\n');
  console.log(line);
};

const caseDef = [...CASES, ...COCKPIT_CASES, ...LEGACY_CASES].find((item) => item.caseId === caseId);
if (!caseDef) throw new Error(`unknown case ${caseId}`);

log('RUNNER_CREATE', `label=${label} caseId=${caseId}`);
const runner = createRunner({ timeoutMs: 600000 });
log('RUNNER_CREATED', `budgetMs=${runner.budgetMs}`);

let outcome = null;
let thrown = null;
const marks = [];
try {
  outcome = await runner.runCase({
    model,
    reasoningEffort: effort,
    caseDef,
    signal: new AbortController().signal,
    onProgress: (progress) => {
      const at = Date.now() - started;
      marks.push({ at, stage: progress?.stage ?? null, lastEventType: progress?.lastEventType ?? null });
      log('PROGRESS', `${progress?.stage ?? '-'} ${progress?.lastEventType ?? '-'} elapsed=${progress?.elapsedMs ?? '-'}`);
    },
  });
} catch (error) {
  thrown = { code: error?.code ?? null, message: String(error?.message ?? error) };
  log('THREW', JSON.stringify(thrown));
}

const wallMs = Date.now() - started;
const d = outcome?.diagnostics ?? null;
const answerText = outcome?.answer ?? outcome?.result?.answer ?? '';
const summary = {
  label,
  caseId,
  model,
  effort,
  wallMs,
  thrown,
  elapsedMs: d?.elapsedMs ?? null,
  firstEventElapsedMs: d?.firstEventElapsedMs ?? null,
  lastEventElapsedMs: d?.lastEventElapsedMs ?? null,
  tailMs: d && d.elapsedMs != null && d.lastEventElapsedMs != null ? d.elapsedMs - d.lastEventElapsedMs : null,
  cleanupStatus: d?.cleanupStatus ?? null,
  exitCode: d?.exitCode ?? null,
  terminationReason: d?.terminationReason ?? null,
  errorEventCount: d?.errorEventCount ?? null,
  answerBytes: Buffer.byteLength(outcome?.answer ?? outcome?.result?.answer ?? '', 'utf8'),
};
log('SUMMARY', JSON.stringify(summary));
appendFileSync(logPath, 'SUMMARY\t' + JSON.stringify(summary) + '\n');
