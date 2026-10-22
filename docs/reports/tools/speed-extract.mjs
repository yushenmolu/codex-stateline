// Read-only extractor: dumps one run's diagnostics + answer size from
// benchmark.json without loading the whole file into PowerShell.
// Usage: node output/speed-extract.mjs <requestIdPrefixOrRunId> [...more]
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const BENCH = join(process.env.LOCALAPPDATA, 'codex-companion', 'benchmark.json');
const needles = process.argv.slice(2);

const raw = await readFile(BENCH, 'utf8');
const data = JSON.parse(raw);
const runs = data.runs ?? [];
console.log(`fileBytes=${raw.length} runs=${runs.length} nextSeq=${data.nextSeq}`);

const matches = runs.filter((r) =>
  needles.some((n) => (r.requestId ?? '').startsWith(n) || (r.runId ?? '').startsWith(n) || String(r.createdSeq) === n));

for (const r of matches) {
  const cases = (r.caseResults ?? []).map((c) => ({
    caseId: c.caseId,
    status: c.status,
    errorCode: c.errorCode ?? null,
    answerChars: typeof c.answer === 'string' ? c.answer.length : 0,
    answerBytes: typeof c.answer === 'string' ? Buffer.byteLength(c.answer, 'utf8') : 0,
    cleanupState: c.cleanupState ?? null,
    diagnostics: c.diagnostics ?? null,
  }));
  console.log(JSON.stringify({
    createdSeq: r.createdSeq,
    runId: r.runId,
    requestId: r.requestId,
    createdAt: r.createdAt,
    model: r.model,
    effort: r.reasoningEffort,
    status: r.status,
    caseSetVersion: r.caseSetVersion,
    cliVersion: r.cliVersion,
    cases,
  }, null, 2));
}
if (!matches.length) console.log('NO_MATCH for ' + JSON.stringify(needles));
