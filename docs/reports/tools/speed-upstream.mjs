// Read-only: locate the magpie upstream rows that belong to one benchmark run.
// Usage: node output/speed-magpie.mjs <startISO> <endISO> [modelSubstring]
//   startISO/endISO are UTC ISO strings bracketing the run (e.g. the
//   diagnostics.startedAt / finishedAt of a case).
// Pages the usage API (limit 500) and keeps rows whose `t` falls in the
// window and whose agent is codex.
const BASE = 'http://127.0.0.1:3425/v1/magpie/usage/requests';

const [startISO, endISO, modelFilter] = process.argv.slice(2);
if (!startISO || !endISO) {
  console.error('usage: node output/speed-magpie.mjs <startISO> <endISO> [modelSubstring]');
  process.exit(2);
}
const startMs = Date.parse(startISO);
const endMs = Date.parse(endISO);
if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
  console.error('bad ISO');
  process.exit(2);
}

async function fetchPage(page) {
  const url = `${BASE}?period=30d&limit=500&page=${page}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for page ${page}`);
  return res.json();
}

const seen = [];
let total = null;
for (let page = 1; page <= 60; page += 1) {
  const body = await fetchPage(page);
  if (total === null) total = body.total;
  const rows = body.rows ?? [];
  if (!rows.length) break;
  let oldest = Infinity;
  for (const r of rows) {
    const t = Date.parse(r.t);
    if (Number.isFinite(t)) oldest = Math.min(oldest, t);
    if (t >= startMs && t <= endMs + 5000) seen.push(r);
  }
  // Rows are newest-first; once a page is entirely older than the window, stop.
  if (oldest < startMs - 120000) break;
}

const codex = seen.filter((r) => r.agent === 'codex' || (r.req ?? '').toLowerCase().includes('codex'));
const pool = codex.length ? codex : seen;
const matches = modelFilter
  ? pool.filter((r) => (r.model ?? '').includes(modelFilter) || (r.req ?? '').includes(modelFilter))
  : pool;

console.log(`# total rows in period: ${total}; rows in window: ${seen.length}; agent=codex: ${codex.length}; after model filter: ${matches.length}`);
matches.sort((a, b) => Date.parse(a.t) - Date.parse(b.t));

const pick = (r) => ({
  t: r.t,
  agent: r.agent,
  req: r.req,
  model: r.model,
  served: r.served,
  effort: r.effort,
  in: r.in,
  out: r.out,
  cache_read: r.cache_read,
  cache_write: r.cache_write,
  reasoning: r.reasoning,
  ms: r.ms,
  ttft_ms: r.ttft_ms,
  first_reasoning_ms: r.first_reasoning_ms,
  sent_ms: r.sent_ms,
  own_ms: r.own_ms,
  flow_ms: r.flow_ms,
  status: r.status,
  stop: r.stop,
  session: r.session,
  ep: r.ep,
  cost: r.cost,
});

for (const r of matches) console.log(JSON.stringify(pick(r)));

// Aggregate summary
const sum = (k) => matches.reduce((a, r) => a + (Number(r[k]) || 0), 0);
if (matches.length) {
  console.log('---');
  console.log(JSON.stringify({
    rows: matches.length,
    sum_in: sum('in'),
    sum_cache_read: sum('cache_read'),
    sum_out: sum('out'),
    sum_reasoning: sum('reasoning'),
    sum_ms: sum('ms'),
    sum_ttft_ms: sum('ttft_ms'),
    statuses: [...new Set(matches.map((r) => r.status))],
    stops: [...new Set(matches.map((r) => r.stop))],
    sessions: [...new Set(matches.map((r) => r.session))],
    first_t: matches[0].t,
    last_t: matches[matches.length - 1].t,
    wall_span_ms: Date.parse(matches[matches.length - 1].t) - Date.parse(matches[0].t),
  }, null, 2));
} else {
  console.log('NO_MATCH');
}
