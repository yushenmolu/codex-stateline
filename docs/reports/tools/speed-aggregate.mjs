// Read-only aggregate: every pelican-cockpit run with its tail decomposition.
// Usage: node output/speed-aggregate.mjs [--all]
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const BENCH = join(process.env.LOCALAPPDATA, 'codex-companion', 'benchmark.json');
const data = JSON.parse(await readFile(BENCH, 'utf8'));

const rows = [];
for (const r of data.runs ?? []) {
  if (r.caseSetVersion !== 'pelican-cockpit-v1') continue;
  const c = (r.caseResults ?? [])[0] ?? {};
  const g = c.diagnostics ?? null;
  const bytes = typeof c.answer === 'string' ? Buffer.byteLength(c.answer, 'utf8') : 0;
  rows.push({
    seq: r.createdSeq,
    model: r.model,
    eff: r.reasoningEffort,
    status: r.status,
    errorCode: c.errorCode ?? null,
    elapsedMs: g?.elapsedMs ?? null,
    firstEventMs: g?.firstEventElapsedMs ?? null,
    lastEventMs: g?.lastEventElapsedMs ?? null,
    tailMs: g && Number.isFinite(g.elapsedMs) && Number.isFinite(g.lastEventElapsedMs) ? g.elapsedMs - g.lastEventElapsedMs : null,
    errorEventCount: g?.errorEventCount ?? null,
    turnFailed: g?.turnFailedEventCount ?? null,
    lastErrorClass: g?.lastErrorClass ?? null,
    exitCode: g?.exitCode ?? null,
    term: g?.terminationReason ?? null,
    cleanup: g?.cleanupStatus ?? null,
    answerBytes: bytes,
  });
}

const fmt = (n) => (n === null ? '-' : String(n));
console.log('seq\tmodel\teff\tstatus\telapsed\tfirst\tlast\ttail\terrs\ttf\tclass\texit\tterm\tbytes');
for (const r of rows) {
  console.log([r.seq, r.model, r.eff, r.status, fmt(r.elapsedMs), fmt(r.firstEventMs), fmt(r.lastEventMs), fmt(r.tailMs), fmt(r.errorEventCount), fmt(r.turnFailed), r.lastErrorClass ?? '-', fmt(r.exitCode), r.term ?? '-', r.answerBytes].join('\t'));
}

// Tail distribution across completed runs that have diagnostics.
const tails = rows.filter((r) => r.status === 'completed' && Number.isFinite(r.tailMs)).map((r) => r.tailMs).sort((a, b) => a - b);
const bucket = (lo, hi) => tails.filter((t) => t >= lo && t < hi).length;
console.log('\n# tail (elapsedMs - lastEventElapsedMs) over completed runs with diagnostics');
console.log(JSON.stringify({ n: tails.length, min: tails[0], median: tails[Math.floor(tails.length / 2)], max: tails.at(-1), under1s: bucket(0, 1000), s1to5: bucket(1000, 5000), s5to9: bucket(5000, 9000), s9to11: bucket(9000, 11000), over11: bucket(11000, Infinity) }, null, 2));

// firstEvent distribution
const firsts = rows.filter((r) => Number.isFinite(r.firstEventMs)).map((r) => r.firstEventMs).sort((a, b) => a - b);
console.log('\n# firstEventElapsedMs (spawn -> first JSON event)');
console.log(JSON.stringify({ n: firsts.length, min: firsts[0], median: firsts[Math.floor(firsts.length / 2)], max: firsts.at(-1) }, null, 2));
