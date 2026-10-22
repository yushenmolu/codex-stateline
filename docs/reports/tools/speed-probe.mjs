// Read-only probe: inspects benchmark.json structure and magpie usage rows.
// Usage: node output/speed-probe.mjs bench|magpie [args]
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const BENCH = join(process.env.LOCALAPPDATA, 'codex-companion', 'benchmark.json');
const MODE = process.argv[2] ?? 'bench';

async function loadBench() {
  const raw = await readFile(BENCH, 'utf8');
  return { raw, data: JSON.parse(raw) };
}

if (MODE === 'bench') {
  const { raw, data } = await loadBench();
  console.log('bytes=' + raw.length);
  console.log('topkeys=' + JSON.stringify(Object.keys(data)));
  const runs = data.runs ?? [];
  console.log('runs=' + runs.length);
  for (const r of runs.slice(-8)) {
    const cr = (r.caseResults ?? []).map((c) => ({
      caseId: c.caseId ?? c.id,
      status: c.status,
      errorCode: c.errorCode,
      bytes: c.answerBytes ?? c.answerLength ?? (typeof c.answer === 'string' ? c.answer.length : null),
      diag: c.diagnostics,
      keys: c.errorCode ? Object.keys(c) : undefined,
    }));
    console.log(JSON.stringify({
      seq: r.createdSeq ?? r.seq,
      requestId: r.requestId,
      model: r.model,
      effort: r.reasoningEffort,
      status: r.status,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      elapsedMs: r.elapsedMs,
      createdAt: r.createdAt,
      caseResults: cr,
    }, null, 2));
  }
} else if (MODE === 'magpie') {
  const url = process.argv[3] ?? 'http://127.0.0.1:3425/v1/magpie/usage/requests?period=30d&limit=500&page=1';
  const res = await fetch(url);
  const json = await res.json();
  console.log('status=' + res.status);
  console.log('topkeys=' + JSON.stringify(Object.keys(json)));
  for (const [k, v] of Object.entries(json)) {
    if (Array.isArray(v)) {
      console.log(`array ${k} len=${v.length}`);
      if (v.length) console.log('sample=' + JSON.stringify(v[0]));
    } else if (v && typeof v === 'object') {
      console.log(`object ${k} keys=${JSON.stringify(Object.keys(v)).slice(0, 400)}`);
    } else {
      console.log(`value ${k}=${JSON.stringify(v)}`);
    }
  }
}
