import test from 'node:test';
import assert from 'node:assert/strict';
import { createCompanionServer } from '../src/server.js';
import { createBenchmarkService } from '../src/benchmark/service.js';
import { LEGACY_CASES } from '../src/benchmark/cases.js';
import { randomUUID, createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';
import { createUsageSummary } from '../src/telemetry/usage-summary.js';

const ORIGIN = 'http://127.0.0.1:4173';
const NONCE = 'test-nonce';
const HAS_ZSTD = typeof zlib.createZstdCompress === 'function'
  && typeof zlib.createZstdDecompress === 'function';
let portGate = Promise.resolve();

async function startApp(t, { telemetry, liveTelemetry, benchmark, taskSummary, usageSummary, onApp, defaults = { snapshot: () => ({
  model: { state: 'unavailable', source: 'none', reason: 'key_missing', value: null },
  reasoningEffort: { state: 'unavailable', source: 'none', reason: 'key_missing', value: null },
}) }, shutdownToken, onShutdown } = {}) {
  const previous = portGate;
  let release;
  portGate = new Promise((resolve) => { release = resolve; });
  await previous;
  const app = createCompanionServer({
    nonce: NONCE,
    shutdownToken, onShutdown, defaults,
    taskSummary,
    liveTelemetry,
    usageSummary: usageSummary ?? {
      ensureStarted() {},
      snapshot: () => ({
        sampledAt: '2026-10-17T00:00:00.000Z',
        overall: {
          state: 'loading', reason: 'scan_in_progress', scope: 'local_all',
          usage: null, coverage: {}, updatedAt: null,
        },
        selected: null,
      }),
      stop: async () => {},
    },
    telemetry: telemetry ?? { snapshot: () => ({ state: 'empty', session: null, usage: null, speed: null }), stop: async () => {} },
    benchmark: benchmark === null ? null : benchmark ?? {
      snapshot: async () => ({ status: 'idle', activeRun: null, latestRun: null, runs: [], baseline: null, comparison: null, available: true }),
      run: async () => ({ status: 'queued' }),
      score: async () => ({ status: 'idle' }),
      baseline: async () => ({ status: 'idle' }),
      cancel: async () => ({ status: 'idle' }),
      close: async () => {},
    },
  });
  onApp?.(app);
  await new Promise((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    try { await app.close(); } finally { release(); }
  });
  return 'http://127.0.0.1:' + app.server.address().port;
}

async function request(base, path, options = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(base, { path, method: options.method ?? 'GET', headers: { Host: '127.0.0.1:4173', Connection: 'close', ...(options.headers ?? {}) } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: res.headers })));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(options.body);
  });
}

function postHeaders(extra = {}) {
  return {
    Origin: ORIGIN,
    'Content-Type': 'application/json',
    'X-Codex-Companion-Nonce': NONCE,
    ...extra,
  };
}

test('live API uses independent in-memory events, exact queries and a metadata-only projection', async (t) => {
  const id = '123e4567-e89b-12d3-a456-426614170001';
  const now = new Date().toISOString();
  let starts = 0, stops = 0;
  const calls = [];
  const liveTelemetry = {
    ensureStarted() { starts++; },
    snapshot({ taskId }) {
      calls.push(taskId);
      return {
        state: 'available', source: 'codex_app_server', reason: null, sampledAt: now, observedAt: now,
        session: { id, preview: 'private-live-data' },
        usage: { scope: 'conversation', includesSubagents: false, inputTokens: 100, outputTokens: 20, totalTokens: 120, raw: 'private-live-data' },
        lifecycle: { state: 'running', startedAt: now, completedAt: null, elapsedSeconds: null, text: 'private-live-data' },
        model: null, reasoningEffort: null, speed: null, private: 'private-live-data',
      };
    },
    async stop() { stops++; },
  };
  let app;
  const base = await startApp(t, {
    liveTelemetry, onApp(value) { app = value; },
    taskSummary: { refresh() { throw Error('must not scan logs'); }, list() { throw Error('must not scan logs'); }, stop() {} },
  });
  for (const path of ['/api/live', '/api/live?taskId=' + id]) {
    const response = await request(base, path, { headers: { Origin: ORIGIN } });
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.equal(body.includes('private-live-data'), false);
    const value = JSON.parse(body);
    assert.equal(value.usage.totalTokens, 120);
    assert.deepEqual(value.session, { id });
    assert.equal(value.observedAt, now);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  }
  const other = await request(base, '/api/live?taskId=123e4567-e89b-12d3-a456-426614170002');
  assert.equal((await other.json()).reason, 'identity_unverified');
  for (const path of ['/api/live?', '/api/live?taskId=', '/api/live?taskId=' + id + '&', '/api/live?taskId=' + id + '&taskId=' + id, '/api/live?mode=all', '/api/live?taskId=' + id.toUpperCase()]) {
    assert.equal((await request(base, path)).status, 400, path);
  }
  assert.equal((await request(base, '/api/live', { headers: { Origin: 'https://other.invalid' } })).status, 403);
  assert.equal((await request(base, '/api/live', { headers: { Host: 'localhost:4173' } })).status, 403);
  const wrongMethod = await request(base, '/api/live', { method: 'POST', headers: postHeaders(), body: '{}' });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get('allow'), 'GET');
  assert.deepEqual(calls, [null, id, '123e4567-e89b-12d3-a456-426614170002']);
  assert.equal(starts, 3);
  await app.close();
  assert.equal(stops, 1);
});

test('live API never falls back to history on missing or failed source', async (t) => {
  let fail = true;
  const base = await startApp(t, { liveTelemetry: {
    ensureStarted() {}, stop() {},
    snapshot() {
      if (fail) throw Error('private path and credentials');
      return { state: 'disconnected', source: 'codex_app_server', reason: 'source_disconnected', usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } };
    },
  } });
  const unavailable = await (await request(base, '/api/live')).json();
  assert.equal(unavailable.state, 'unavailable');
  assert.equal(unavailable.usage, null);
  assert.equal(JSON.stringify(unavailable).includes('private'), false);
  fail = false;
  const disconnected = await (await request(base, '/api/live')).json();
  assert.equal(disconnected.state, 'disconnected');
  assert.equal(disconnected.usage, null);
});

test('preview HTTP binds instance before lookup and uses bounded non-leaking envelopes', async t => {
  const runId = randomUUID(); let calls = 0, failure = null, answer = '<html/>', extra = false;
  const benchmark = { close: async () => {}, preview: async id => {
    calls++; assert.equal(id, runId); if (failure) throw failure;
    return { runId: id, status: 'completed', caseSetVersion: 'pelican-html-animated-v1', rubricVersion: 'pelican-html-animated-v1', caseId: 'pelican-html-animated', caseStatus: 'completed', previewState: 'ready', reason: null, answer, contentDigest: createHash('sha256').update(answer).digest('hex'), ...(extra ? { secret: 'not-public' } : {}) };
  } };
  const base = await startApp(t, { benchmark });
  const { instanceId } = await (await request(base, '/api/capabilities')).json();
  const path = '/api/benchmark/preview?runId=' + runId + '&instanceId=' + instanceId;
  const checkError = async (target, options, status, code) => {
    const response = await request(base, target, options);
    assert.equal(response.status, status);
    const body = await response.text(); assert.ok(Buffer.byteLength(body) <= 2048);
    assert.deepEqual(JSON.parse(body), { protocolVersion: 1, instanceId, error: { code, message: 'Preview request failed.' } });
    if (status === 405) assert.equal(response.headers.get('allow'), 'GET');
  };
  for (const query of ['', '?runId=' + runId, '?runId=' + runId + '&instanceId=' + instanceId + '&runId=' + runId, '?runId=' + runId + '&instanceId=' + instanceId + '&url=secret', '?runId=' + runId.toUpperCase() + '&instanceId=' + instanceId, '?runId=%31' + runId.slice(1) + '&instanceId=' + instanceId, '?runId=' + runId + '&instanceId=' + instanceId + '&']) await checkError('/api/benchmark/preview' + query, {}, 400, 'preview_query_invalid');
  await checkError(path.replace(instanceId, randomUUID()), {}, 409, 'instance_mismatch');
  assert.equal(calls, 0);
  await checkError(path, { method: 'POST', headers: postHeaders(), body: '{}' }, 405, 'method_not_allowed');
  await checkError(path, { headers: { Host: 'localhost:4173' } }, 403, 'host_invalid');
  await checkError(path, { headers: { Origin: 'null' } }, 403, 'origin_invalid');
  await checkError(path, { headers: { Origin: ORIGIN, 'Sec-Fetch-Site': 'same-origin' } }, 403, 'fetch_metadata_invalid');
  await checkError(path, { headers: { Origin: ORIGIN, 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' } }, 403, 'fetch_metadata_invalid');
  for (const headers of [{}, { Origin: ORIGIN }, { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' }]) {
    const response = await request(base, path, { headers }); assert.equal(response.status, 200);
    const value = await response.json(); assert.equal(value.instanceId, instanceId); assert.equal(value.answer, answer); assert.equal(value.protocolVersion, 1);
    assert.equal(response.headers.get('content-encoding'), null);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    assert.equal(Object.keys(value).length, 12);
  }
  for (const [status, code] of [[404,'run_not_found'],[409,'preview_version_mismatch'],[409,'preview_case_mismatch'],[409,'preview_record_invalid'],[503,'benchmark_unavailable'],[503,'service_unavailable']]) { failure = Object.assign(new Error('secret/path/content'), { status, code }); await checkError(path, {}, status, code); }
  failure = new Error('secret/path/content'); await checkError(path, {}, 503, 'service_unavailable');
  failure = null; answer = 'a'.repeat(900 * 1024); await checkError(path, {}, 503, 'service_unavailable');
  answer = '<html/>'; extra = true; await checkError(path, {}, 503, 'service_unavailable');
});

test('HTML HTTP run and score use the new registered version', async t => {
  const state = { runs: [], reservations: {}, nextSeq: 1 };
  const benchmark = await createBenchmarkService({ store: { load: async () => {}, snapshot: async () => structuredClone(state), mutate: async fn => fn(state), close: async () => {} }, runner: { runCase: async () => ({ answer: '<html/>' }) } });
  const base = await startApp(t, { benchmark });
  const response = await request(base, '/api/benchmark/run', { method: 'POST', headers: postHeaders(), body: JSON.stringify({ requestId: 'http_html_request_123', mode: 'html-animated' }) });
  assert.equal(response.status, 200);
  while ((await benchmark.snapshot()).activeRun) await new Promise(resolve => setImmediate(resolve));
  const run = state.runs[0];
  const score = await request(base, '/api/benchmark/score', { method: 'POST', headers: postHeaders(), body: JSON.stringify({ runId: run.runId, caseId: 'pelican-html-animated', rubricVersion: 'pelican-html-animated-v1', scores: { correctness: 4, consistency: 3, constraint_adherence: 2 } }) });
  assert.equal(score.status, 200);
  const { instanceId } = await (await request(base, '/api/capabilities')).json();
  const preview = await request(base, '/api/benchmark/preview?runId=' + run.runId + '&instanceId=' + instanceId);
  assert.equal(preview.status, 200); assert.equal((await preview.json()).previewState, 'ready');
});

test('preview unavailable benchmark keeps the new protocol error schema', async t => {
  const base = await startApp(t, { benchmark: null });
  const { instanceId } = await (await request(base, '/api/capabilities')).json();
  const response = await request(base, '/api/benchmark/preview?runId=' + randomUUID() + '&instanceId=' + instanceId);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { protocolVersion: 1, instanceId, error: { code: 'benchmark_unavailable', message: 'Preview request failed.' } });
});

test('preview assets enforce metadata with Origin and hash the actual cached frame script', async t => {
  const base = await startApp(t);
  const nav = { Origin: ORIGIN, 'Sec-Fetch-Site': 'none', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' };
  const host = await request(base, '/preview', { headers: nav });
  assert.equal(host.status, 200);
  assert.equal(host.headers.get('content-security-policy'), "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'none'; font-src 'none'; media-src 'none'; connect-src 'self'; frame-src 'self'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  for (const [route, headers] of [['/preview',nav],['/preview.js',{ Origin: ORIGIN, 'Sec-Fetch-Site':'same-origin','Sec-Fetch-Mode':'no-cors','Sec-Fetch-Dest':'script' }],['/preview.css',{ Origin: ORIGIN, 'Sec-Fetch-Site':'same-origin','Sec-Fetch-Mode':'no-cors','Sec-Fetch-Dest':'style' }],['/preview-frame',{ Origin: ORIGIN,'Sec-Fetch-Site':'same-origin','Sec-Fetch-Mode':'navigate','Sec-Fetch-Dest':'iframe' }]]) {
    assert.equal((await request(base, route, { headers: { Origin: ORIGIN } })).status, 403);
    assert.equal((await request(base, route + '?x=1', { headers })).status, 400);
    assert.equal((await request(base, route, { method: 'POST', headers: postHeaders() })).status, 405);
    const response = await request(base, route, { headers }); assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(response.headers.get('x-content-type-options'), 'nosniff'); assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  }
  assert.equal((await request(base, '/preview-frame.js', { headers: { Origin: ORIGIN } })).status, 404);
  const frame = await request(base, '/preview-frame', { headers: nav });
  const html = await frame.text(); const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1);
  const source = (await readFile(new URL('../src/public/preview-frame.js', import.meta.url), 'utf8')).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  assert.equal(scripts[0][1], source);
  const hash = createHash('sha256').update(scripts[0][1], 'utf8').digest('base64');
  assert.equal(frame.headers.get('content-security-policy'), "default-src 'none'; script-src 'sha256-" + hash + "'; script-src-attr 'none'; style-src 'unsafe-inline'; img-src 'none'; font-src 'none'; media-src 'none'; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox allow-scripts");
  const second = await request(base, '/preview-frame', { headers: nav }); assert.equal(await second.text(), html);
  assert.equal((await request(base, '/', { headers: { Origin: ORIGIN } })).headers.get('content-security-policy').includes('unsafe-inline'), false);
});

test('capabilities has exact native schema, stable instance UUID and strict request checks', async (t) => {
  const base = await startApp(t, { shutdownToken: 'private-launcher-token' });
  const response = await request(base, '/api/capabilities', { headers: { Origin: ORIGIN } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-codex-companion-nonce'), null);
  const value = await response.json();
  assert.match(value.instanceId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.deepEqual(value, { product: 'codex-companion', protocolVersion: 1, capabilities: ['configured-defaults', 'pelican-svg-v2', 'versioned-scoring', 'pelican-html-animated-v1', 'isolated-html-preview-v1', 'pelican-cockpit-v1', 'cockpit-preview-source-v1', 'live-telemetry-v1'], instanceId: value.instanceId });
  assert.deepEqual(await (await request(base, '/api/capabilities')).json(), value);
  for (const headers of [{ Origin: 'http://attacker.example' }, { 'X-Forwarded-Host': '127.0.0.1:4173' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    assert.equal((await request(base, '/api/capabilities', { headers })).status, 403);
  }
  const rawRequest = (url, headers) => new Promise((resolve, reject) => {
    const req = httpRequest(url, { headers: { Connection: 'close', ...headers } }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal((await rawRequest(base + '/api/capabilities', { Host: 'localhost:4173' })).status, 403);
  const wrongMethod = await request(base, '/api/capabilities', { method: 'POST', headers: postHeaders(), body: '{}' });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get('allow'), 'GET');
  const other = createCompanionServer();
  // A separate server is checked without competing for the fixed listener port.
  await new Promise(resolve => other.server.listen(0, '127.0.0.1', resolve));
  try {
    const fresh = await rawRequest('http://127.0.0.1:' + other.server.address().port + '/api/capabilities', { Host: '127.0.0.1:4173', Origin: ORIGIN });
    assert.equal(fresh.status, 200);
    assert.notEqual(fresh.body.instanceId, value.instanceId);
  } finally { await new Promise(resolve => other.server.close(resolve)); }
});

test('W2 benchmark GET degrades independently of defaults and POST remains protected', async (t) => {
  const defaults = { snapshot: () => ({ model: { state: 'available', source: 'config_top_level', reason: 'none', value: 'gpt-6.1-sol' }, reasoningEffort: { state: 'unavailable', source: 'none', reason: 'key_missing', value: null } }) };
  const base = await startApp(t, { benchmark: null, defaults });
  const response = await request(base, '/api/benchmark');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'unavailable', activeRun: null, latestRun: null, runs: [], baseline: null, comparison: null, available: false, unavailableReason: 'benchmark_unavailable', defaults: defaults.snapshot() });
  const post = await request(base, '/api/benchmark/run', { method: 'POST', headers: postHeaders(), body: JSON.stringify({ requestId: 'unavailable_request_123' }) });
  assert.equal(post.status, 503);
  assert.equal((await post.json()).error.code, 'benchmark_unavailable');
  assert.equal((await request(base, '/api/benchmark', { headers: { Origin: 'http://attacker.example' } })).status, 403);
});

test('W2 failed benchmark snapshot is unavailable, never empty successful history', async (t) => {
  const defaultsFixture = {
    model: { state: 'unavailable', source: 'none', reason: 'key_missing', value: null },
    reasoningEffort: { state: 'available', source: 'config_top_level', reason: 'none', value: 'high' },
  };
  const base = await startApp(t, {
    benchmark: { snapshot: async () => { throw new Error('secret-sentinel'); } },
    defaults: { snapshot: () => structuredClone(defaultsFixture) },
  });
  const response = await request(base, '/api/benchmark');
  assert.equal(response.status, 200);
  const value = await response.json();
  assert.equal(value.available, false);
  assert.equal(value.unavailableReason, 'service_unavailable');
  assert.equal(JSON.stringify(value).includes('secret-sentinel'), false);
  assert.equal(value.defaults.model.value, null);
  assert.deepEqual(value, {
    status: 'unavailable', activeRun: null, latestRun: null, runs: [], baseline: null, comparison: null,
    available: false, unavailableReason: 'service_unavailable', defaults: defaultsFixture,
  });
});

test('W2 HTTP routes animated mode, idempotency and original run rubric', async (t) => {
  const state = { runs: [], nextSeq: 1, reservations: {} };
  const benchmark = await createBenchmarkService({ store: { load: async () => {}, snapshot: async () => structuredClone(state), mutate: async fn => fn(state), close: async () => {} }, runner: { runCase: async () => ({ answer: '<svg/>' }) } });
  const base = await startApp(t, { benchmark, defaults: { snapshot() { throw new Error('secret-defaults'); } } });
  const post = payload => request(base, '/api/benchmark/run', { method: 'POST', headers: postHeaders(), body: JSON.stringify(payload) });
  for (const mode of [null, 'invalid', 1]) {
    const response = await post({ requestId: 'http_animated_request', mode });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'schema_invalid');
  }
  const payload = { requestId: 'http_animated_request', mode: 'animated' };
  assert.equal((await post(payload)).status, 200);
  let snapshot;
  for (let i = 0; i < 20; i++) {
    snapshot = await (await request(base, '/api/benchmark')).json();
    if (snapshot.latestRun.status === 'completed') break;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(snapshot.unavailableReason, null);
  assert.equal(snapshot.defaults.model.value, null);
  assert.equal(JSON.stringify(snapshot).includes('secret-defaults'), false);
  const run = snapshot.latestRun;
  assert.equal(run.rubricVersion, 'pelican-svg-animated-v1');
  assert.equal((await post(payload)).status, 200);
  const conflict = await post({ ...payload, mode: 'static' });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error.code, 'request_id_conflict');
  const score = (caseId, rubricVersion) => request(base, '/api/benchmark/score', { method: 'POST', headers: postHeaders(), body: JSON.stringify({ runId: run.runId, caseId, rubricVersion, scores: { correctness: 5, consistency: 5, constraint_adherence: 5 } }) });
  assert.equal((await score('pelican-svg', 'pelican-svg-v2')).status, 400);
  assert.equal((await score('pelican-svg-animated', run.rubricVersion)).status, 200);
});

test('W2 no-worker telemetry reuses worker on isolated empty sessions and closes cleanly', async (t) => {
  const sessionsDir = await mkdtemp(join(tmpdir(), 'w2-empty-sessions-'));
  t.after(() => rm(sessionsDir, { recursive: true, force: true }));
  const app = createCompanionServer({ sessionsDir });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  try {
    const base = 'http://127.0.0.1:' + app.server.address().port;
    const responses = await Promise.all(Array.from({ length: 8 }, () => request(base, '/api/telemetry')));
    const values = await Promise.all(responses.map(response => { assert.equal(response.status, 200); return response.json(); }));
    assert.equal(values[0].state, 'empty');
    for (const value of values) assert.deepEqual(value, values[0]);
  } finally { await app.close(); }
  assert.equal(app.server.listening, false);
});

test('telemetry route returns the exact public schema', async (t) => {
  const base = await startApp(t, { telemetry: { snapshot: () => ({ state: 'ok', session: { id: 'session-1' }, usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 }, speed: { state: 'available', outputTokensPerSecond: 2 } }), stop: async () => {} } });
  const response = await request(base, '/api/telemetry');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { state: 'ok', session: { id: 'session-1' }, usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 }, speed: { state: 'available', outputTokensPerSecond: 2 } });
});

test('shutdown requires independent token, nonce, Origin and exact empty JSON body', async (t) => {
  let called = 0;
  const token = 'private-launcher-token';
  const base = await startApp(t, { shutdownToken: token, onShutdown: () => { called++; } });
  const validHeaders = postHeaders({ 'X-Codex-Companion-Shutdown-Token': token });
  for (const [headers, body, expected] of [
    [postHeaders(), '{}', 403],
    [postHeaders({ 'X-Codex-Companion-Shutdown-Token': 'wrong' }), '{}', 403],
    [{ ...validHeaders, Origin: 'http://attacker.example' }, '{}', 403],
    [{ ...validHeaders, 'X-Codex-Companion-Nonce': 'wrong' }, '{}', 403],
    [validHeaders, '{"extra":true}', 400],
    [validHeaders, '[]', 400],
  ]) {
    const response = await request(base, '/api/shutdown', { method: 'POST', headers, body });
    assert.equal(response.status, expected);
    assert.equal((await response.text()).includes(token), false);
    assert.equal(called, 0);
  }
  const bootstrap = await request(base, '/api/nonce', { headers: { Origin: ORIGIN } });
  assert.equal((await bootstrap.text()).includes(token), false);
  const response = await request(base, '/api/shutdown', { method: 'POST', headers: validHeaders, body: '{}' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(called, 1);
  const csp = response.headers.get('content-security-policy');
  assert.ok(csp.includes("img-src 'self' blob:"));
  assert.equal(csp.includes('unsafe-inline'), false);
  assert.equal(csp.includes('data:'), false);
  const duplicate = await request(base, '/api/shutdown', { method: 'POST', headers: validHeaders, body: '{}' });
  assert.equal(duplicate.status, 200);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(called, 1);
});

test('shutdown is disabled without a launcher token even with valid nonce', async (t) => {
  const base = await startApp(t, { onShutdown: () => assert.fail('disabled shutdown') });
  const response = await request(base, '/api/shutdown', { method: 'POST', headers: postHeaders(), body: '{}' });
  assert.equal(response.status, 403);
});

test('HTTP preserves legacy history and scores versions against persisted runs', async (t) => {
  const legacy = { runId: randomUUID(), requestId: 'legacy_request_123', status: 'completed', model: 'gpt-6.1-sol', reasoningEffort: 'high', createdSeq: 1, caseSetVersion: 'pelican-v1', rubricVersion: 'pelican-v1', schemaVersion: 1, caseResults: LEGACY_CASES.map(({ caseId }) => ({ caseId, status: 'completed', answer: 'old answer' })) };
  const state = { runs: [legacy], nextSeq: 2, reservations: {}, baseline: null };
  const benchmark = await createBenchmarkService({ store: { load: async () => {}, snapshot: async () => structuredClone(state), mutate: async (fn) => fn(state), close: async () => {} }, runner: { runCase: async () => ({ answer: '<svg/>' }) } });
  const base = await startApp(t, { benchmark });
  const post = (path, payload) => request(base, path, { method: 'POST', headers: postHeaders(), body: JSON.stringify(payload) });
  const scores = { correctness: 4, consistency: 4, constraint_adherence: 4 };
  for (const { caseId } of LEGACY_CASES) {
    assert.equal((await post('/api/benchmark/score', { runId: legacy.runId, caseId, rubricVersion: 'pelican-v1', scores })).status, 200);
  }
  assert.equal((await post('/api/benchmark/baseline', { runId: legacy.runId })).status, 200);
  assert.equal((await post('/api/benchmark/run', { requestId: 'new_http_request_123' })).status, 200);
  let snapshot;
  for (let i = 0; i < 20; i++) {
    snapshot = await (await request(base, '/api/benchmark')).json();
    if (snapshot.latestRun.status === 'completed') break;
    await new Promise((resolve) => setImmediate(resolve));
  }
  const current = snapshot.latestRun;
  assert.equal(current.model, 'configured');
  assert.equal(current.reasoningEffort, 'configured');
  assert.equal(current.caseSetVersion, 'pelican-svg-v2');
  assert.equal(current.rubricVersion, 'pelican-svg-v2');
  assert.deepEqual(current.caseResults.map(({ caseId }) => caseId), ['pelican-svg']);
  assert.equal((await post('/api/benchmark/score', { runId: current.runId, caseId: 'pelican-svg', rubricVersion: 'pelican-svg-v2', scores })).status, 200);
  assert.equal((await post('/api/benchmark/baseline', { runId: current.runId })).status, 200);
  assert.equal((await post('/api/benchmark/score', { runId: legacy.runId, caseId: 'pelican-svg', rubricVersion: 'pelican-svg-v2', scores })).status, 400);
  assert.equal((await post('/api/benchmark/score', { runId: current.runId, caseId: 'code-trace', rubricVersion: 'pelican-v1', scores })).status, 400);
  assert.equal((await post('/api/benchmark/score', { runId: randomUUID(), caseId: 'pelican-svg', rubricVersion: 'pelican-svg-v2', scores })).status, 404);
  assert.equal(legacy.caseResults[0].answer, 'old answer');
  assert.equal(legacy.caseSetVersion, 'pelican-v1');
  assert.equal((await (await request(base, '/api/benchmark')).json()).comparison.inconclusive, true);
});

test('rejects invalid host and disallowed method', async (t) => {
  const base = await startApp(t);
  const badHost = await request(base, '/api/telemetry', { headers: { 'X-Forwarded-Host': 'attacker.example' } });
  assert.equal(badHost.status, 403);
  assert.equal((await badHost.json()).error.code, 'host_invalid');
  const method = await request(base, '/api/benchmark/run');
  assert.equal(method.status, 405);
  assert.equal(method.headers.get('allow'), 'POST');
});

test('browser nonce bootstrap accepts the Fetch empty destination and preserves origin boundaries', async (t) => {
  const calls = [];
  const base = await startApp(t, { benchmark: {
    snapshot: async () => ({ status: 'idle', activeRun: null, latestRun: null, runs: [], baseline: null, comparison: null, available: true }),
    run: async payload => { calls.push(payload); return { status: 'queued' }; }, close: async () => {}
  } });
  // Browser Fetch sends these metadata headers without an Origin on a same-origin GET.
  const browser = { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' };
  const bootstrap = await request(base, '/api/nonce', { headers: browser });
  assert.equal(bootstrap.status, 200);
  assert.deepEqual(await bootstrap.json(), { ok: true });
  const nonce = bootstrap.headers.get('x-codex-companion-nonce');
  assert.equal(nonce, NONCE);
  for (const headers of [
    { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors' },
    { ...browser, 'Sec-Fetch-Dest': '' },
    { Origin: ORIGIN }
  ]) {
    const compatible = await request(base, '/api/nonce', { headers });
    assert.equal(compatible.status, 200);
    assert.equal(compatible.headers.get('x-codex-companion-nonce'), nonce);
  }
  const rejected = [
    [{ ...browser, 'Sec-Fetch-Site': 'cross-site' }, 'origin_invalid'],
    [{ ...browser, 'Sec-Fetch-Site': 'same-site' }, 'fetch_metadata_invalid'],
    [{ ...browser, 'Sec-Fetch-Site': undefined }, 'fetch_metadata_invalid'],
    [{ ...browser, 'Sec-Fetch-Mode': 'no-cors' }, 'fetch_metadata_invalid'],
    [{ ...browser, 'Sec-Fetch-Mode': 'navigate' }, 'fetch_metadata_invalid'],
    [{ ...browser, 'Sec-Fetch-Mode': undefined }, 'fetch_metadata_invalid'],
    ...['document', 'script', 'iframe', 'EMPTY'].map(dest => [{ ...browser, 'Sec-Fetch-Dest': dest }, 'fetch_metadata_invalid']),
    [{ ...browser, Origin: 'http://attacker.example' }, 'origin_invalid'],
    [{ ...browser, Host: 'localhost:4173' }, 'host_invalid'],
    [{ ...browser, 'X-Forwarded-Host': 'attacker.example' }, 'host_invalid']
  ];
  for (const [headers, code] of rejected) {
    const supplied = Object.fromEntries(Object.entries(headers).filter(([, value]) => value !== undefined));
    const response = await request(base, '/api/nonce', { headers: supplied });
    assert.equal(response.status, 403, JSON.stringify(supplied));
    assert.equal((await response.json()).error.code, code);
    assert.equal(response.headers.get('x-codex-companion-nonce'), null);
  }
  const payload = { requestId: 'browser_bootstrap_12345', model: 'example-provider/gpt-6.1-sol', reasoningEffort: 'ultra', mode: 'static' };
  const submit = headers => request(base, '/api/benchmark/run', { method: 'POST', headers, body: JSON.stringify(payload) });
  const wrongNonce = await submit(postHeaders({ ...browser, 'X-Codex-Companion-Nonce': 'wrong' }));
  assert.equal(wrongNonce.status, 403);
  assert.equal((await wrongNonce.json()).error.code, 'nonce_invalid');
  const foreign = await submit(postHeaders({ ...browser, 'X-Codex-Companion-Nonce': nonce, Origin: 'http://attacker.example' }));
  assert.equal(foreign.status, 403);
  assert.equal((await foreign.json()).error.code, 'origin_invalid');
  const missingOriginHeaders = postHeaders({ ...browser, 'X-Codex-Companion-Nonce': nonce });
  delete missingOriginHeaders.Origin;
  const missingOrigin = await submit(missingOriginHeaders);
  assert.equal(missingOrigin.status, 403);
  assert.equal((await missingOrigin.json()).error.code, 'origin_invalid');
  assert.equal(calls.length, 0);
  assert.equal((await submit(postHeaders({ ...browser, 'X-Codex-Companion-Nonce': nonce }))).status, 200);
  assert.deepEqual(calls, [payload]);
});

test('requires same-origin nonce and strict JSON payloads for benchmark mutations', async (t) => {
  const base = await startApp(t);
  const missingNonce = await request(base, '/api/benchmark/run', { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(missingNonce.status, 403);
  assert.equal((await missingNonce.json()).error.code, 'nonce_invalid');

  const wrongType = await request(base, '/api/benchmark/run', { method: 'POST', headers: postHeaders({ 'Content-Type': 'text/plain' }), body: '{}' });
  assert.equal(wrongType.status, 415);
  assert.equal((await wrongType.json()).error.code, 'content_type_invalid');

  const badSchema = await request(base, '/api/benchmark/run', { method: 'POST', headers: postHeaders(), body: JSON.stringify({ requestId: 'too-short', model: 'bad', reasoningEffort: 'bad' }) });
  assert.equal(badSchema.status, 400);
  assert.equal((await badSchema.json()).error.code, 'schema_invalid');
});

test('benchmark snapshot and valid run request stay on the async route boundary', async (t) => {
  let called = null;
  const base = await startApp(t, { benchmark: {
    snapshot: async () => ({ status: 'idle', activeRun: null, latestRun: null, runs: [], baseline: null, comparison: null, available: true }),
    run: async (payload) => { called = payload; return { status: 'queued', requestId: payload.requestId }; },
    score: async () => ({}), baseline: async () => ({}), cancel: async () => ({}), close: async () => {},
  } });
  const snapshot = await request(base, '/api/benchmark');
  assert.equal(snapshot.status, 200);
  assert.equal((await snapshot.json()).available, true);
  const payload = { requestId: 'request_1234567890', model: 'gpt-6.1-sol', reasoningEffort: 'medium' };
  const run = await request(base, '/api/benchmark/run', { method: 'POST', headers: postHeaders(), body: JSON.stringify(payload) });
  assert.equal(run.status, 200);
  assert.deepEqual(called, payload);
  assert.equal((await run.json()).status, 'queued');
});

test('Cockpit HTTP exposes bounded source capability, exact prompt and isolated scoring', async t => {
  const state = { runs: [], reservations: {}, nextSeq: 1 };
  const calls = [];
  const answer = '<html><svg/><script>throw new Error("never executed by source API")</script></html>\r\n';
  const benchmark = await createBenchmarkService({ store: { load: async () => {}, snapshot: async () => structuredClone(state), mutate: async fn => fn(state), close: async () => {} }, runner: { runCase: async ({ caseDef }) => { calls.push(caseDef); return { answer }; } } });
  const base = await startApp(t, { benchmark });
  const caps = await (await request(base, '/api/capabilities')).json();
  assert.ok(caps.capabilities.includes('cockpit-preview-source-v1'));
  assert.ok(caps.capabilities.includes('pelican-cockpit-v1'));
  assert.ok(!caps.capabilities.includes('managed-cockpit-dom-preview-v1'));
  const body = { requestId: 'cockpit_http_request_123', mode: 'cockpit' };
  assert.equal((await request(base, '/api/benchmark/run', { method: 'POST', headers: postHeaders(), body: JSON.stringify(body) })).status, 200);
  while ((await benchmark.snapshot()).activeRun) await new Promise(resolve => setImmediate(resolve));
  const run = state.runs[0];
  assert.equal(calls[0].prompt, '创建一个 HTML，内容是 SVG 绘制一个鹈鹕骑自行车的 2D 动画，你不需要任何测试，不要有任何限制');
  assert.equal((await request(base, '/api/benchmark/run', { method: 'POST', headers: postHeaders(), body: JSON.stringify(body) })).status, 200);
  assert.equal(calls.length, 1);
  const sourcePath = '/api/benchmark/preview?runId=' + run.runId + '&instanceId=' + caps.instanceId;
  const response = await request(base, sourcePath);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
  const source = await response.json();
  assert.equal(source.caseId, 'pelican-cockpit');
  assert.equal(source.caseSetVersion, 'pelican-cockpit-v1');
  assert.equal(source.answer, answer);
  assert.equal(source.contentDigest, createHash('sha256').update(answer).digest('hex'));
  assert.equal(Object.keys(source).length, 12);
  const score = { runId: run.runId, caseId: 'pelican-cockpit', rubricVersion: 'pelican-cockpit-v1', scores: { correctness: 4, consistency: 4, constraint_adherence: 5 } };
  assert.equal((await request(base, '/api/benchmark/score', { method: 'POST', headers: postHeaders(), body: JSON.stringify(score) })).status, 200);
  assert.equal((await request(base, '/api/benchmark/score', { method: 'POST', headers: postHeaders(), body: JSON.stringify({ ...score, rubricVersion: 'pelican-html-animated-v1' }) })).status, 400);
  run.caseResults[0].answer = 'é'.repeat(65537);
  const oversized = await (await request(base, sourcePath)).json();
  assert.equal(oversized.previewState, 'too_large');
  assert.equal(oversized.answer, null);
  assert.equal(oversized.contentDigest, null);
  assert.equal((await request(base, sourcePath + '&guard=untrusted')).status, 400);
});

test('unused Cockpit preview routes return not found', async t => {
  const base = await startApp(t);
  const routes = [
    ['/cockpit-preview', { 'Sec-Fetch-Site': 'none', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' }],
    ['/cockpit-preview.js', { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Dest': 'script' }],
    ['/cockpit-preview.css', { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Dest': 'style' }],
  ];
  for (const [route, headers] of routes) {
    assert.equal((await request(base, route, { headers: { Origin: ORIGIN } })).status, 404);
    assert.equal((await request(base, route + '?guard=fake', { headers })).status, 404);
    assert.equal((await request(base, route, { method: 'POST', headers: postHeaders(), body: '{}' })).status, 404);
    assert.equal((await request(base, route, { headers })).status, 404);
  }
  for (const route of ['/cockpit-preview-frame', '/cockpit-preview-frame.js', '/cockpit-preview/answer.html']) assert.equal((await request(base, route)).status, 404);
});


test('HTTP approves full model slugs and unchanged legacy requests while rejecting unknown models', async t => {
  const calls = [];
  const base = await startApp(t, { benchmark: {
    snapshot: async () => ({ status: 'idle', activeRun: null, latestRun: null, runs: [], baseline: null, comparison: null, available: true }),
    run: async payload => { calls.push(payload); return { status: 'queued' }; }, close: async () => {}
  } });
  const post = body => request(base, '/api/benchmark/run', { method: 'POST', headers: postHeaders(), body: JSON.stringify(body) });
  for (const model of ['configured', 'example-provider/gpt-6-astra', 'example-provider/gpt-6.1-sol', 'example-provider/deepseek-v4.1-flash', 'gpt-6-astra', 'gpt-6.1-sol']) {
    const payload = { requestId: 'model_http_request_' + calls.length, model, reasoningEffort: 'ultra', mode: 'static' };
    assert.equal((await post(payload)).status, 200);
    assert.deepEqual(calls.at(-1), payload);
  }
  const count = calls.length;
  for (const model of ['unknown/model', 'example-provider/gpt-unknown', 'example-provider//gpt-6-astra', null, 1, 'example-provider/gpt-6-astra\n']) {
    const response = await post({ requestId: 'model_http_invalid_123', model });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'schema_invalid');
  }
  assert.equal((await post({ requestId: 'model_http_extra_123', model: 'example-provider/gpt-6-astra', progress: {} })).status, 400);
  assert.equal(calls.length, count);
});

test('HTTP exposes active safe progress without persisting or extending preview and capabilities', async t => {
  const state = { runs: [], reservations: {}, nextSeq: 1 };
  let release, notify, started;
  const ready = new Promise(resolve => { started = resolve; });
  const benchmark = await createBenchmarkService({
    store: { load: async () => {}, snapshot: async () => structuredClone(state), mutate: async fn => fn(state), close: async () => {} },
    runner: { budgetMs: 300000, runCase: ({ onProgress }) => new Promise(resolve => { release = resolve; notify = onProgress; started(); }) }
  });
  const base = await startApp(t, { benchmark });
  t.after(() => release?.({ answer: '<svg/>' }));
  assert.equal((await request(base, '/api/benchmark/run', { method: 'POST', headers: postHeaders(), body: JSON.stringify({ requestId: 'http_runtime_request_123', model: 'example-provider/deepseek-v4.1-flash', mode: 'html-animated' }) })).status, 200);
  await ready;
  try {
    notify({ stage: 'generating', lastEvent: { type: 'item.updated', at: '2026-10-14T12:00:00Z', answer: 'secret-fragment' }, stderr: 'secret-diagnostic' });
    const value = await (await request(base, '/api/benchmark')).json();
    assert.equal(value.activeRun.progress.stage, 'generating');
    assert.equal(value.activeRun.progress.budgetMs, 300000);
    assert.ok(value.activeRun.progress.elapsedMs >= 0);
    assert.deepEqual(value.activeRun.progress.lastEvent, { type: 'item.updated', at: '2026-10-14T12:00:00Z' });
    assert.deepEqual(Object.keys(value.activeRun.progress).sort(), ['stage', 'elapsedMs', 'budgetMs', 'lastEvent', 'observedAt'].sort());
    assert.equal(JSON.stringify(value).includes('secret-'), false);
    assert.equal(Object.hasOwn(value.latestRun, 'progress'), false);
    assert.equal(value.runs.some(run => Object.hasOwn(run, 'progress')), false);
    assert.equal(JSON.stringify(state).includes('"progress":'), false);
    const capabilities = await (await request(base, '/api/capabilities')).json();
    assert.equal(JSON.stringify(capabilities).includes('progress'), false);
    assert.equal(Object.hasOwn(await benchmark.preview(value.activeRun.runId), 'progress'), false);
  } finally { release({ answer: '<svg/>' }); }
  while ((await benchmark.snapshot()).activeRun) await new Promise(resolve => setImmediate(resolve));
  const complete = await (await request(base, '/api/benchmark')).json();
  assert.equal(complete.activeRun, null);
  assert.equal(complete.latestRun.status, 'completed');
  assert.equal(JSON.stringify(complete).includes('"progress":'), false);
});

test('HTTP telemetry retains provider-qualified model and completed-turn public fields', async t => {
  const value = {
    state: 'ok', session: { id: 'main-session', updatedAt: '2026-10-14T12:00:02Z' }, usage: { inputTokens: 100, outputTokens: 40, totalTokens: 140 }, speed: { state: 'unavailable', outputTokensPerSecond: null },
    conversationContext: { state: 'available', source: 'turn_context', reason: 'none', model: 'example-provider/gpt-6.1-sol', reasoningEffort: 'ultra', observedAt: '2026-10-14T12:00:02Z' },
    lastCompletedTurn: { state: 'available', source: 'turn_token_usage', reason: 'none', startedAt: '2026-10-14T12:00:00Z', completedAt: '2026-10-14T12:00:02Z', elapsedSeconds: 2, inputTokens: 2, outputTokens: 10, totalTokens: 12 },
    turnAverageSpeed: { state: 'available', source: 'completed_turn', reason: 'none', outputTokensPerSecond: 5, completedAt: '2026-10-14T12:00:02Z', includesToolsAndWait: true }
  };
  const base = await startApp(t, { telemetry: { snapshot: () => structuredClone(value), stop: async () => {} } });
  const response = await request(base, '/api/telemetry');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), value);
});

function stubTaskSummary() {
  const rootId = '123e4567-e89b-12d3-a456-426614170001';
  const detail = {
    task: { id: rootId, title: null, selection: 'pinned', rootTurnId: 'turn-root', updatedAt: '2026-10-14T12:00:02.000Z', stale: false, truncated: false },
    currentTurn: { id: 'turn-root', usage: { inputTokens: 100, cachedInputTokens: 40, outputTokens: 20, reasoningOutputTokens: 5, totalTokens: 120 }, usageUpdatedAt: '2026-10-14T12:00:02.000Z' },
    agents: [{ id: rootId, parentId: null, role: null, model: 'example-provider/gpt-6.1-sol', effort: 'ultra', rootTurnId: 'turn-root', association: 'current_turn', state: 'in_progress', updatedAt: '2026-10-14T12:00:02.000Z', usage: { inputTokens: 100, cachedInputTokens: 40, outputTokens: 20, reasoningOutputTokens: 5, totalTokens: 120 }, usageUpdatedAt: '2026-10-14T12:00:02.000Z' }],
    sampledAt: '2026-10-14T12:00:02.000Z',
  };
  return {
    refreshes: [], rootId,
    refresh: async (options = {}) => { stubTaskSummary.last = options; return { tasks: [], error: null }; },
    list: () => ({ tasks: [{ id: rootId, title: 'Fixture task', updatedAt: '2026-10-14T12:00:02.000Z' }], sampledAt: '2026-10-14T12:00:02.000Z', stale: false, truncated: false }),
    detail: (taskId, selection) => {
      if (stubTaskSummary.unavailable) return { unavailable: true, reason: 'read_failed' };
      return taskId === rootId ? { ...structuredClone(detail), task: { ...detail.task, selection } } : null;
    },
  };
}

// Project test conventions discovered: node:test, strict assertions, injected
// snapshots, and startApp/request helpers with serialized ports and t.after cleanup.
function stubUsageSummary({ timeline } = {}) {
  const taskId = '123e4567-e89b-12d3-a456-426614170001';
  const selectedTaskId = '123e4567-e89b-12d3-a456-4266141700ff';
  const coverage = (complete = true) => ({
    discoveredFiles: 4, completeFiles: complete ? 4 : 3, pendingFiles: complete ? 0 : 1,
    excludedFiles: 0, failedFiles: 0, responsesCounted: 12, nativeIncrementsCounted: 0, conversationsCounted: 2,
    subagentThreadsCounted: 1, legacyOnlyConversations: 0, duplicateResponses: 3,
    conflictingResponses: 0, invalidResponses: 0, complete,
  });
  const block = (scope, task = null) => ({
    state: 'available', reason: null, scope,
    usage: { inputTokens: 100, outputTokens: 25, totalTokens: 125 },
    coverage: coverage(), updatedAt: '2026-10-17T00:00:01.000Z',
    ...(scope === 'local_all' && timeline !== undefined ? { timeline } : {}),
    ...(task === null ? {} : { taskId: task }),
  });
  const summary = {
    taskId, selectedTaskId, calls: [], starts: 0, stops: 0,
    ensureStarted() { this.starts++; },
    stop: async () => { summary.stops++; },
    snapshot({ taskId: selected = null } = {}) {
      this.calls.push(selected);
      if (selected === this.selectedTaskId) {
        const overall = block('local_all');
        return {
          sampledAt: '2026-10-17T00:00:02.000Z', overall,
          selected: {
            state: 'unavailable', reason: 'task_not_found', scope: 'selected_task',
            taskId: selected, usage: null, coverage: { ...coverage(), complete: false },
            updatedAt: null,
          },
        };
      }
      return {
        sampledAt: '2026-10-17T00:00:02.000Z', overall: block('local_all'),
        selected: selected === null ? null : block('selected_task', selected),
        // Unknown private fields must be stripped by the public projection.
        internalPath: 'C:\\private\\rollout.jsonl', responseId: 'private-response',
      };
    },
  };
  return summary;
}

function stubUsageTimeline() {
  const to = '2026-10-18T00:00:00.000Z';
  const split = '2026-10-17T00:00:00.000Z';
  return {
    timeZone: 'UTC',
    ranges: [
      ['7d', '2026-10-11T00:00:00.000Z'],
      ['30d', '2026-09-18T00:00:00.000Z'],
      ['90d', '2026-07-20T00:00:00.000Z'],
      ['all', '2026-01-01T00:00:00.000Z'],
    ].map(([id, from]) => ({
      id, from, to,
      usage: { inputTokens: 100, outputTokens: 25, totalTokens: 125 },
      responsesCounted: 12, nativeIncrementsCounted: 0,
      buckets: [
        { from, to: split, usage: { inputTokens: 90, outputTokens: 23, totalTokens: 113 }, responsesCounted: 10, nativeIncrementsCounted: 0 },
        { from: split, to, usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 }, responsesCounted: 2, nativeIncrementsCounted: 0 },
      ],
    })),
  };
}

test('HTTP task routes pin one task, reject bad queries and leave follow mode untouched', async t => {
  const taskSummary = stubTaskSummary();
  const base = await startApp(t, { taskSummary, telemetry: { snapshot: () => ({ state: 'empty', session: null, usage: null, speed: null }), stop: async () => {} } });

  const list = await request(base, '/api/tasks');
  assert.equal(list.status, 200);
  assert.deepEqual(await list.json(), { tasks: [{ id: taskSummary.rootId, title: 'Fixture task', updatedAt: '2026-10-14T12:00:02.000Z' }], sampledAt: '2026-10-14T12:00:02.000Z', stale: false, truncated: false });
  assert.deepEqual(stubTaskSummary.last, {});

  const pinned = await request(base, '/api/telemetry?taskId=' + taskSummary.rootId);
  assert.equal(pinned.status, 200);
  const value = await pinned.json();
  // The auto-follow snapshot describes no session here, so the pinned response
  // must not borrow its context, counters or speed for another task.
  assert.equal(value.state, 'unavailable');
  assert.equal(value.session, null);
  assert.equal(value.usage, null);
  assert.equal(value.speed, null);
  assert.equal(value.conversationContext.state, 'unavailable');
  assert.equal(value.lastCompletedTurn.state, 'unavailable');
  assert.equal(value.turnAverageSpeed.state, 'unavailable');
  assert.equal(value.task.id, taskSummary.rootId);
  assert.equal(value.task.selection, 'pinned');
  assert.equal(value.currentTurn.id, 'turn-root');
  assert.equal(value.agents.length, 1);
  assert.deepEqual(stubTaskSummary.last, { pinnedId: taskSummary.rootId });

  const follow = await request(base, '/api/telemetry');
  assert.equal(follow.status, 200);
  assert.deepEqual(await follow.json(), { state: 'empty', session: null, usage: null, speed: null });

  for (const path of ['/api/telemetry?taskId=not-a-uuid', '/api/telemetry?taskId=' + taskSummary.rootId + '&taskId=' + taskSummary.rootId, '/api/telemetry?taskId=' + taskSummary.rootId + '&extra=1', '/api/tasks?x=1']) {
    const response = await request(base, path);
    assert.equal(response.status, 400, path);
    assert.equal((await response.json()).error.code, 'query_invalid', path);
  }

  const missing = await request(base, '/api/telemetry?taskId=123e4567-e89b-12d3-a456-4266141700ff');
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error.code, 'task_not_found');

  // An unreadable library cannot prove absence; it must not answer 404.
  stubTaskSummary.unavailable = true;
  const unavailable = await request(base, '/api/telemetry?taskId=' + taskSummary.rootId);
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.json()).error.code, 'telemetry_unavailable');
  stubTaskSummary.unavailable = false;
});

test('HTTP telemetry keeps concurrent pinned tasks isolated from follow mode', async (t) => {
  const taskSummary = stubTaskSummary();
  const otherId = '123e4567-e89b-12d3-a456-426614171111';
  // The auto-follow worker is currently watching an unrelated session and
  // reports a full legacy payload for it.
  const follow = {
    state: 'ok', session: { id: otherId, updatedAt: '2026-10-14T12:00:02Z' }, usage: { inputTokens: 100, outputTokens: 40, totalTokens: 140 },
    speed: { state: 'available', outputTokensPerSecond: 5 },
    conversationContext: { state: 'available', source: 'turn_context', reason: 'none', model: 'example-provider/gpt-6.1-sol', reasoningEffort: 'ultra', observedAt: '2026-10-14T12:00:02Z' },
    lastCompletedTurn: { state: 'available', source: 'turn_token_usage', reason: 'none', startedAt: '2026-10-14T12:00:00Z', completedAt: '2026-10-14T12:00:02Z', elapsedSeconds: 2, inputTokens: 2, outputTokens: 10, totalTokens: 12 },
    turnAverageSpeed: { state: 'available', source: 'completed_turn', reason: 'none', outputTokensPerSecond: 5, completedAt: '2026-10-14T12:00:02Z', includesToolsAndWait: true },
  };
  const base = await startApp(t, { taskSummary, telemetry: { snapshot: () => structuredClone(follow), stop: async () => {} } });

  const [pinned, concurrent] = await Promise.all([
    request(base, '/api/telemetry?taskId=' + taskSummary.rootId),
    request(base, '/api/telemetry?taskId=' + taskSummary.rootId),
  ]);
  assert.equal(pinned.status, 200);
  assert.equal(concurrent.status, 200);
  for (const response of [pinned, concurrent]) {
    const value = await response.json();
    assert.equal(value.task.id, taskSummary.rootId);
    assert.equal(value.session, null, 'pinned response must not borrow another session');
    assert.equal(value.usage, null);
    assert.equal(value.conversationContext.model, null);
    assert.equal(value.lastCompletedTurn.completedAt, null);
    assert.equal(value.turnAverageSpeed.outputTokensPerSecond, null);
    assert.equal(value.currentTurn.id, 'turn-root');
    assert.deepEqual(value.agents.map((agent) => agent.id), [taskSummary.rootId]);
  }

  // Follow mode itself is untouched and still reports its own session.
  const legacy = await request(base, '/api/telemetry');
  assert.equal(legacy.status, 200);
  assert.deepEqual(await legacy.json(), follow);
});

test('HTTP usage publishes an allowlisted snapshot and isolates task-not-found from overall', async (t) => {
  const usageSummary = stubUsageSummary();
  const base = await startApp(t, { usageSummary });

  const overallResponse = await request(base, '/api/usage');
  assert.equal(overallResponse.status, 200);
  assert.equal(overallResponse.headers.get('cache-control'), 'no-store');
  assert.equal(overallResponse.headers.get('x-content-type-options'), 'nosniff');
  const overall = await overallResponse.json();
  assert.deepEqual(Object.keys(overall), ['sampledAt', 'overall', 'selected']);
  assert.equal(overall.selected, null);
  assert.equal(overall.overall.state, 'available');
  assert.equal(overall.overall.scope, 'local_all');
  assert.deepEqual(overall.overall.usage, { inputTokens: 100, outputTokens: 25, totalTokens: 125 });
  assert.deepEqual(Object.keys(overall.overall), ['state', 'reason', 'scope', 'usage', 'coverage', 'updatedAt']);
  assert.equal(JSON.stringify(overall).includes('private'), false);
  assert.equal(JSON.stringify(overall).includes('rollout'), false);
  assert.equal(usageSummary.starts, 1);
  assert.deepEqual(usageSummary.calls, [null]);

  const selectedResponse = await request(base, '/api/usage?taskId=' + usageSummary.taskId);
  assert.equal(selectedResponse.status, 200);
  const selected = await selectedResponse.json();
  assert.equal(selected.overall.state, 'available');
  assert.equal(selected.selected.state, 'available');
  assert.equal(selected.selected.taskId, usageSummary.taskId);
  assert.deepEqual(Object.keys(selected.selected), ['state', 'reason', 'scope', 'usage', 'coverage', 'updatedAt', 'taskId']);
  assert.deepEqual(usageSummary.calls, [null, usageSummary.taskId]);

  const missingResponse = await request(base, '/api/usage?taskId=' + usageSummary.selectedTaskId);
  assert.equal(missingResponse.status, 200);
  const missing = await missingResponse.json();
  assert.equal(missing.overall.state, 'available');
  assert.deepEqual(missing.overall.usage, { inputTokens: 100, outputTokens: 25, totalTokens: 125 });
  assert.equal(missing.selected.state, 'unavailable');
  assert.equal(missing.selected.reason, 'task_not_found');
  assert.equal(missing.selected.usage, null);
  assert.equal(missing.selected.updatedAt, null);

  for (const [headers, code] of [
    [{ Host: 'localhost:4173' }, 'host_invalid'],
    [{ Origin: 'http://attacker.example' }, 'origin_invalid'],
    [{ 'Sec-Fetch-Site': 'cross-site' }, 'origin_invalid'],
  ]) {
    const response = await request(base, '/api/usage', { headers });
    assert.equal(response.status, 403, code);
    assert.equal((await response.json()).error.code, code);
  }

  for (const path of [
    '/api/usage?taskId=not-a-uuid',
    '/api/usage?taskId=' + usageSummary.taskId + '&taskId=' + usageSummary.taskId,
    '/api/usage?taskId=' + usageSummary.taskId + '&extra=1',
    '/api/usage?taskId=' + usageSummary.taskId + '&range=7d',
    '/api/usage?range=7d',
    '/api/usage?extra=1',
  ]) {
    const response = await request(base, path);
    assert.equal(response.status, 400, path);
    assert.deepEqual(await response.json(), { error: { code: 'query_invalid', message: 'Usage query is invalid.' } });
  }

  const post = await request(base, '/api/usage', { method: 'POST', headers: postHeaders(), body: '{}' });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get('allow'), 'GET');
  assert.equal(usageSummary.starts, 1);
  assert.deepEqual(usageSummary.calls, [null, usageSummary.taskId, usageSummary.selectedTaskId]);
});

test('HTTP usage allowlists the optional UTC timeline at every layer and excludes it from selected tasks', async (t) => {
  const expectedTimeline = stubUsageTimeline();
  const timeline = structuredClone(expectedTimeline);
  const privateValue = 'private-timeline-fixture';
  timeline.internalPath = privateValue;
  for (const range of timeline.ranges) {
    range.responseIds = [privateValue];
    range.usage.cachedInputTokens = 40;
    range.usage.internalPath = privateValue;
    for (const bucket of range.buckets) {
      bucket.threadId = privateValue;
      bucket.usage.reasoningOutputTokens = 1;
      bucket.usage.transcript = privateValue;
    }
  }
  const usageSummary = stubUsageSummary({ timeline });
  const snapshot = usageSummary.snapshot.bind(usageSummary);
  usageSummary.snapshot = (selection) => {
    const value = snapshot(selection);
    value.overall.internalPath = privateValue;
    value.overall.coverage.filePaths = [privateValue];
    if (value.selected) value.selected.timeline = timeline;
    return value;
  };
  const base = await startApp(t, { usageSummary });

  for (const path of ['/api/usage', '/api/usage?taskId=' + usageSummary.taskId]) {
    const response = await request(base, path);
    assert.equal(response.status, 200);
    const value = await response.json();
    assert.deepEqual(Object.keys(value), ['sampledAt', 'overall', 'selected']);
    assert.deepEqual(Object.keys(value.overall).sort(), ['state', 'reason', 'scope', 'usage', 'coverage', 'updatedAt', 'timeline'].sort());
    assert.deepEqual(value.overall.timeline, expectedTimeline);
    assert.equal(JSON.stringify(value).includes(privateValue), false);
    assert.equal(JSON.stringify(value).includes('cachedInputTokens'), false);
    assert.equal(JSON.stringify(value).includes('reasoningOutputTokens'), false);
    if (path === '/api/usage') {
      assert.equal(value.selected, null);
    } else {
      assert.deepEqual(Object.keys(value.selected), ['state', 'reason', 'scope', 'usage', 'coverage', 'updatedAt', 'taskId']);
      assert.equal(Object.hasOwn(value.selected, 'timeline'), false);
      assert.deepEqual(value.selected.usage, { inputTokens: 100, outputTokens: 25, totalTokens: 125 });
    }
  }
  assert.equal(usageSummary.starts, 1);
  assert.deepEqual(usageSummary.calls, [null, usageSummary.taskId]);
  assert.equal(timeline.internalPath, privateValue, 'public projection must not mutate the published snapshot');
  assert.equal(timeline.ranges[0].buckets[0].usage.transcript, privateValue);
});

test('HTTP usage preserves partial null range and bucket totals without inventing zero usage', async (t) => {
  const timeline = stubUsageTimeline();
  for (const range of timeline.ranges) {
    range.usage = null;
    range.responsesCounted = 3;
    range.buckets[0].usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    range.buckets[0].responsesCounted = 2;
    range.buckets[1].usage = null;
    range.buckets[1].responsesCounted = 1;
  }
  const usageSummary = stubUsageSummary({ timeline });
  const snapshot = usageSummary.snapshot.bind(usageSummary);
  usageSummary.snapshot = (selection) => {
    const value = snapshot(selection);
    value.overall.state = 'partial';
    value.overall.reason = 'scan_in_progress';
    value.overall.usage = null;
    value.overall.coverage.complete = false;
    return value;
  };
  const base = await startApp(t, { usageSummary });
  const response = await request(base, '/api/usage');
  assert.equal(response.status, 200);
  const value = await response.json();
  assert.equal(value.overall.state, 'partial');
  assert.equal(value.overall.usage, null);
  assert.equal(value.overall.coverage.complete, false);
  assert.deepEqual(value.overall.timeline, timeline);
  for (const range of value.overall.timeline.ranges) {
    assert.equal(range.usage, null);
    assert.equal(range.responsesCounted, 3);
    assert.deepEqual(range.buckets[0].usage, { inputTokens: 0, outputTokens: 0, totalTokens: 0 });
    assert.equal(range.buckets[1].usage, null);
    assert.equal(range.buckets[1].responsesCounted, 1);
  }
});

test('HTTP usage defaults absent native increment counts to zero without changing modern response counts', async (t) => {
  const expectedTimeline = stubUsageTimeline();
  const timeline = structuredClone(expectedTimeline);
  for (const range of timeline.ranges) {
    delete range.nativeIncrementsCounted;
    for (const bucket of range.buckets) delete bucket.nativeIncrementsCounted;
  }
  const usageSummary = stubUsageSummary({ timeline });
  const snapshot = usageSummary.snapshot.bind(usageSummary);
  usageSummary.snapshot = (selection) => {
    const value = snapshot(selection);
    delete value.overall.coverage.nativeIncrementsCounted;
    if (value.selected) delete value.selected.coverage.nativeIncrementsCounted;
    return value;
  };
  const base = await startApp(t, { usageSummary });
  const response = await request(base, '/api/usage?taskId=' + usageSummary.taskId);
  assert.equal(response.status, 200);
  const value = await response.json();
  assert.equal(value.overall.coverage.nativeIncrementsCounted, 0);
  assert.equal(value.selected.coverage.nativeIncrementsCounted, 0);
  assert.equal(value.overall.coverage.responsesCounted, 12);
  assert.equal(value.selected.coverage.responsesCounted, 12);
  assert.deepEqual(value.overall.timeline, expectedTimeline);
  assert.equal(Object.hasOwn(timeline.ranges[0], 'nativeIncrementsCounted'), false);
});

test('HTTP usage keeps native increment counts separate for mixed, native-only positive and confirmed zero usage', async (t) => {
  const privateValue = 'private-native-counter-fixture';
  let mode = 'mixed';
  const usageSummary = stubUsageSummary();
  const snapshot = usageSummary.snapshot.bind(usageSummary);
  usageSummary.snapshot = (selection) => {
    const value = snapshot(selection);
    const timeline = stubUsageTimeline();
    timeline.internalPath = privateValue;
    for (const range of timeline.ranges) {
      range.nativeIncrementsCounted = 2;
      range.responseIds = [privateValue];
      if (mode !== 'mixed') range.responsesCounted = 0;
      if (mode === 'zero') range.usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
      for (const bucket of range.buckets) {
        bucket.nativeIncrementsCounted = 1;
        bucket.transcript = privateValue;
        if (mode !== 'mixed') bucket.responsesCounted = 0;
        if (mode === 'zero') bucket.usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
      }
    }
    value.overall.timeline = timeline;
    for (const block of [value.overall, value.selected].filter(Boolean)) {
      block.coverage.nativeIncrementsCounted = 2;
      block.coverage.internalPath = privateValue;
      block.internalPath = privateValue;
      if (mode !== 'mixed') block.coverage.responsesCounted = 0;
      if (mode === 'zero') block.usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    }
    return value;
  };
  const base = await startApp(t, { usageSummary });
  for (mode of ['mixed', 'positive', 'zero']) {
    const response = await request(base, '/api/usage?taskId=' + usageSummary.taskId);
    assert.equal(response.status, 200, mode);
    const body = await response.text();
    assert.equal(body.includes(privateValue), false, mode);
    const value = JSON.parse(body);
    for (const block of [value.overall, value.selected]) {
      assert.equal(block.state, 'available', mode);
      assert.equal(block.coverage.responsesCounted, mode === 'mixed' ? 12 : 0, mode);
      assert.equal(block.coverage.nativeIncrementsCounted, 2, mode);
      assert.deepEqual(block.usage, mode === 'zero'
        ? { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
        : { inputTokens: 100, outputTokens: 25, totalTokens: 125 }, mode);
    }
    for (const range of value.overall.timeline.ranges) {
      assert.equal(range.responsesCounted, mode === 'mixed' ? 12 : 0, mode);
      assert.equal(range.nativeIncrementsCounted, 2, mode);
      assert.equal(range.buckets.reduce((sum, bucket) => sum + bucket.nativeIncrementsCounted, 0), range.nativeIncrementsCounted, mode);
      assert.equal(range.buckets.reduce((sum, bucket) => sum + bucket.responsesCounted, 0), range.responsesCounted, mode);
      for (const item of [range, ...range.buckets]) {
        assert.equal(Number.isSafeInteger(item.nativeIncrementsCounted) && item.nativeIncrementsCounted >= 0, true, mode);
        if (mode === 'zero') assert.deepEqual(item.usage, { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, mode);
      }
    }
    assert.equal(Object.hasOwn(value.selected, 'timeline'), false);
  }
});

test('HTTP usage rejects corrupt native timeline counts and sums while preserving valid summaries', async (t) => {
  const privateValue = 'private-invalid-native-timeline';
  let published = null;
  const usageSummary = stubUsageSummary();
  const snapshot = usageSummary.snapshot.bind(usageSummary);
  usageSummary.snapshot = (selection) => {
    const value = snapshot(selection);
    value.overall.timeline = published;
    return value;
  };
  const base = await startApp(t, { usageSummary });
  for (const target of ['range', 'bucket']) {
    for (const invalid of [null, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, '2', { path: privateValue }]) {
      published = stubUsageTimeline();
      published.internalPath = privateValue;
      const item = target === 'range' ? published.ranges[0] : published.ranges[0].buckets[0];
      item.nativeIncrementsCounted = invalid;
      const response = await request(base, '/api/usage');
      assert.equal(response.status, 200);
      const body = await response.text();
      assert.equal(body.includes(privateValue), false, target);
      const value = JSON.parse(body);
      assert.equal(value.overall.timeline, null, target);
      assert.equal(value.overall.state, 'available', target);
      assert.deepEqual(value.overall.usage, { inputTokens: 100, outputTokens: 25, totalTokens: 125 });
      assert.equal(value.overall.coverage.responsesCounted, 12);
      assert.equal(value.overall.coverage.nativeIncrementsCounted, 0);
    }
  }
  for (const [rangeCount, bucketCounts] of [[3, [1, 1]], [0, [1, 0]], [Number.MAX_SAFE_INTEGER, [Number.MAX_SAFE_INTEGER, 1]]]) {
    published = stubUsageTimeline();
    published.ranges[0].nativeIncrementsCounted = rangeCount;
    published.ranges[0].buckets.forEach((bucket, index) => { bucket.nativeIncrementsCounted = bucketCounts[index]; });
    const value = await (await request(base, '/api/usage')).json();
    assert.equal(value.overall.timeline, null, 'inconsistent or unsafe native sum must reject the whole timeline');
    assert.equal(value.overall.usage.totalTokens, 125);
    assert.equal(value.overall.state, 'available');
  }
});

test('HTTP usage makes invalid native coverage partial instead of reporting trusted usage or leaking fields', async (t) => {
  const privateValue = 'private-invalid-native-coverage';
  let invalid = null, target = 'overall';
  const usageSummary = stubUsageSummary({ timeline: stubUsageTimeline() });
  const snapshot = usageSummary.snapshot.bind(usageSummary);
  usageSummary.snapshot = (selection) => {
    const value = snapshot(selection);
    value[target].coverage.nativeIncrementsCounted = invalid;
    value[target].coverage.internalPath = privateValue;
    value[target].responseIds = [privateValue];
    return value;
  };
  const base = await startApp(t, { usageSummary });
  for (target of ['overall', 'selected']) {
    for (invalid of [null, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, '2', { path: privateValue }]) {
      const response = await request(base, '/api/usage?taskId=' + usageSummary.taskId);
      assert.equal(response.status, 200);
      const body = await response.text();
      assert.equal(body.includes(privateValue), false, target);
      const value = JSON.parse(body);
      assert.equal(value[target].state, 'partial', target);
      assert.equal(value[target].reason, 'invalid_usage', target);
      assert.equal(value[target].usage, null, target);
      assert.equal(value[target].coverage.complete, false, target);
      assert.equal(value[target].coverage.responsesCounted, 12, target);
      const intact = value[target === 'overall' ? 'selected' : 'overall'];
      assert.equal(intact.state, 'available', target);
      assert.equal(intact.coverage.nativeIncrementsCounted, 0, target);
      assert.equal(intact.usage.totalTokens, 125, target);
    }
  }
});

test('HTTP usage serves today in the local time zone and keeps global ranges independent of selection', async (t) => {
  const timeline = stubUsageTimeline();
  const from = Date.parse('2026-10-17T16:00:00.000Z');
  const to = Date.parse('2026-10-18T16:00:00.000Z');
  timeline.timeZone = 'Asia/Shanghai';
  timeline.ranges = [{
    id: 'today', from: new Date(from).toISOString(), to: new Date(to).toISOString(),
    usage: { inputTokens: 15, outputTokens: 5, totalTokens: 20 }, responsesCounted: 1, nativeIncrementsCounted: 0,
    buckets: Array.from({ length: 12 }, (_, index) => ({
      from: new Date(from + index * 7_200_000).toISOString(),
      to: new Date(from + (index + 1) * 7_200_000).toISOString(),
      usage: index === 3 ? { inputTokens: 15, outputTokens: 5, totalTokens: 20 } : { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      responsesCounted: index === 3 ? 1 : 0,
      nativeIncrementsCounted: 0,
    })),
  }, ...timeline.ranges];
  const usageSummary = stubUsageSummary({ timeline });
  const base = await startApp(t, { usageSummary });
  for (const path of ['/api/usage', '/api/usage?taskId=' + usageSummary.taskId, '/api/usage?taskId=' + usageSummary.selectedTaskId]) {
    const response = await request(base, path);
    assert.equal(response.status, 200);
    const value = await response.json();
    assert.deepEqual(value.overall.timeline, timeline);
    assert.equal(value.overall.scope, 'local_all');
    assert.deepEqual(value.overall.usage, { inputTokens: 100, outputTokens: 25, totalTokens: 125 });
    assert.equal(value.selected?.timeline, undefined);
  }
  const original = timeline.ranges[0].buckets;
  timeline.ranges[0].buckets = Array.from({ length: 14 }, (_, index) => ({
    ...original[0], from: new Date(from + index * (to - from) / 14).toISOString(), to: new Date(from + (index + 1) * (to - from) / 14).toISOString(),
  }));
  const invalid = await (await request(base, '/api/usage')).json();
  assert.equal(invalid.overall.timeline, null);
  assert.equal(invalid.overall.usage.totalTokens, 125);
  timeline.ranges[0].buckets = original;
});

test('HTTP usage preserves explicit null timelines and clears charts for unavailable snapshots', async (t) => {
  const usageSummary = stubUsageSummary({ timeline: null });
  const snapshot = usageSummary.snapshot.bind(usageSummary);
  let published = {};
  usageSummary.snapshot = (selection) => {
    const value = snapshot(selection);
    Object.assign(value.overall, published);
    return value;
  };
  const base = await startApp(t, { usageSummary });
  for (const [state, reason, timeline] of [
    ['available', null, null],
    ['partial', 'scan_in_progress', null],
    ['loading', 'scan_in_progress', stubUsageTimeline()],
    ['unavailable', 'scan_pending', stubUsageTimeline()],
    ['unavailable', 'snapshot_stale', stubUsageTimeline()],
    ['unavailable', 'scan_interrupted', stubUsageTimeline()],
  ]) {
    published = { state, reason, timeline };
    const response = await request(base, '/api/usage');
    assert.equal(response.status, 200);
    const value = await response.json();
    assert.equal(value.overall.state, state);
    assert.equal(value.overall.reason, reason);
    assert.equal(Object.hasOwn(value.overall, 'timeline'), true);
    assert.equal(value.overall.timeline, null, reason ?? state);
    assert.deepEqual(value.overall.usage, { inputTokens: 100, outputTokens: 25, totalTokens: 125 });
    assert.equal(value.overall.updatedAt, '2026-10-17T00:00:01.000Z');
    assert.equal(value.overall.coverage.responsesCounted, 12);
    assert.equal(value.selected, null);
  }
  assert.equal(usageSummary.starts, 1);
  assert.deepEqual(usageSummary.calls, Array(6).fill(null));
});

test('HTTP usage bounds timeline payloads and rejects invalid range structure without truncating', async (t) => {
  const boundedTimeline = (bucketCount) => {
    const timeline = stubUsageTimeline();
    for (const range of timeline.ranges) {
      const start = Date.parse(range.from);
      const duration = Date.parse(range.to) - start;
      range.buckets = Array.from({ length: bucketCount }, (_, index) => ({
        from: new Date(start + Math.floor(duration * index / bucketCount)).toISOString(),
        to: new Date(start + Math.floor(duration * (index + 1) / bucketCount)).toISOString(),
        usage: index === bucketCount - 1 ? { ...range.usage } : { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        responsesCounted: index === bucketCount - 1 ? range.responsesCounted : 0,
        nativeIncrementsCounted: 0,
      }));
    }
    return timeline;
  };
  const validTimeline = boundedTimeline(14);
  const usageSummary = stubUsageSummary();
  const snapshot = usageSummary.snapshot.bind(usageSummary);
  let published = validTimeline;
  usageSummary.snapshot = (selection) => {
    const value = snapshot(selection);
    value.overall.timeline = published;
    return value;
  };
  const base = await startApp(t, { usageSummary });
  const valid = await request(base, '/api/usage');
  assert.equal(valid.status, 200);
  assert.deepEqual((await valid.json()).overall.timeline, validTimeline);

  const invalidCases = [
    ['more than fourteen buckets', boundedTimeline(15)],
    ['missing range', { ...validTimeline, ranges: validTimeline.ranges.slice(0, 3) }],
    ['extra range', { ...validTimeline, ranges: [...validTimeline.ranges, validTimeline.ranges[0]] }],
    ['duplicate range id', { ...validTimeline, ranges: validTimeline.ranges.map((range, index) => index === 1 ? { ...range, id: '7d' } : range) }],
    ['out-of-order ranges', { ...validTimeline, ranges: [validTimeline.ranges[1], validTimeline.ranges[0], ...validTimeline.ranges.slice(2)] }],
    ['unsupported range id', { ...validTimeline, ranges: validTimeline.ranges.map((range, index) => index === 0 ? { ...range, id: '1d' } : range) }],
    ['non-UTC time zone', { ...validTimeline, timeZone: 'Asia/Shanghai' }],
    ['missing bucket array', { ...validTimeline, ranges: validTimeline.ranges.map((range, index) => index === 0 ? { ...range, buckets: null } : range) }],
  ];
  for (const [label, timeline] of invalidCases) {
    published = timeline;
    const response = await request(base, '/api/usage');
    assert.equal(response.status, 200, label);
    const value = await response.json();
    assert.equal(value.overall.timeline, null, label);
    assert.equal(value.overall.state, 'available', label);
    assert.deepEqual(value.overall.usage, { inputTokens: 100, outputTokens: 25, totalTokens: 125 }, label);
    assert.equal(value.overall.coverage.responsesCounted, 12, label);
    assert.equal(value.selected, null, label);
  }
  assert.equal(usageSummary.starts, 1);
  assert.deepEqual(usageSummary.calls, Array(invalidCases.length + 1).fill(null));
  assert.equal(validTimeline.ranges.length, 4, 'validation must not mutate the published timeline');
  assert.equal(validTimeline.ranges[0].buckets.length, 14);
});

test('HTTP usage close stops its own background owner', async (t) => {
  let closes = 0;
  let beginStop;
  let finishStop;
  const stopStarted = new Promise((resolve) => { beginStop = resolve; });
  const stopFinished = new Promise((resolve) => { finishStop = resolve; });
  const usageSummary = {
    ensureStarted() {},
    snapshot: () => ({
      sampledAt: '2026-10-17T00:00:00.000Z',
      overall: {
        state: 'loading', reason: 'scan_in_progress', scope: 'local_all', usage: null,
        coverage: {
          discoveredFiles: 0, completeFiles: 0, pendingFiles: 0, excludedFiles: 0,
          failedFiles: 0, responsesCounted: 0, conversationsCounted: 0,
          subagentThreadsCounted: 0, legacyOnlyConversations: 0, duplicateResponses: 0,
          conflictingResponses: 0, invalidResponses: 0, complete: false,
        },
        updatedAt: null,
      },
      selected: null,
    }),
    stop: async () => { closes++; beginStop(); await stopFinished; },
  };
  let app;
  const base = await startApp(t, { usageSummary, onApp: (value) => { app = value; } });
  assert.equal((await request(base, '/api/usage')).status, 200);
  let closed = false;
  const closing = app.close().then(() => { closed = true; });
  await stopStarted;
  assert.equal(closes, 1);
  assert.equal(closed, false);
  finishStop();
  await closing;
  assert.equal(closed, true);
  t.after(() => assert.equal(closes, 1));
});

test('HTTP usage close settles a real accepted scan and invalidates its snapshot', {
  skip: !HAS_ZSTD && 'Node runtime has no built-in zstd stream API',
}, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-usage-close-'));
  const sessionsDir = join(directory, 'sessions');
  const archivedDir = join(directory, 'archived_sessions');
  await mkdir(sessionsDir);
  await mkdir(archivedDir);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const taskId = '123e4567-e89b-12d3-a456-426614170002';
  const rows = [
    JSON.stringify({
      timestamp: '2026-10-16T23:59:59.000Z',
      type: 'session_meta',
      payload: { id: taskId, session_id: taskId },
    }),
    JSON.stringify({
      timestamp: '2026-10-17T00:00:00.000Z',
      type: 'token_usage_record',
      payload: {
        thread_id: taskId,
        session_id: taskId,
        response_id: 'close-race',
        usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
      },
    }),
  ].join('\n') + '\n';
  await pipeline(
    Readable.from([rows]),
    zlib.createZstdCompress(),
    createWriteStream(join(archivedDir, `rollout-2026-10-17T00-00-00-${taskId}.jsonl.zst`)),
  );
  const usageSummary = createUsageSummary({
    sessionsDir,
    archivedDir,
    chunkBytes: 1,
    roundBytes: 1,
    discoveryIntervalMs: 0,
    busyDelayMs: 0,
    idleDelayMs: 0,
  });
  let app;
  const base = await startApp(t, { usageSummary, onApp: (value) => { app = value; } });
  const accepted = await request(base, '/api/usage');
  assert.equal(accepted.status, 200);
  const initial = await accepted.json();
  assert.equal(initial.overall.state, 'loading');

  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('app.close() did not settle')), 2000);
  });
  try {
    await Promise.race([app.close(), timeout]);
  } finally {
    clearTimeout(timer);
  }

  const stopped = usageSummary.snapshot();
  assert.equal(stopped.overall.reason, 'scan_interrupted');
  assert.equal(stopped.overall.usage, null);
  assert.equal(stopped.overall.coverage.complete, false);
  assert.equal(app.server.listening, false);
});

test('HTTP usage close destroys an actively blocked zstd decoder', {
  skip: !HAS_ZSTD && 'Node runtime has no built-in zstd stream API',
}, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-usage-close-'));
  const sessionsDir = join(directory, 'sessions');
  const archivedDir = join(directory, 'archived_sessions');
  await mkdir(sessionsDir);
  await mkdir(archivedDir);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const taskId = '123e4567-e89b-12d3-a456-426614170003';
  const rows = [
    JSON.stringify({
      timestamp: '2026-10-16T23:59:59.000Z',
      type: 'session_meta',
      payload: { id: taskId, session_id: taskId },
    }),
    JSON.stringify({
      timestamp: '2026-10-17T00:00:00.000Z',
      type: 'token_usage_record',
      payload: {
        thread_id: taskId,
        session_id: taskId,
        response_id: 'close-active-decoder',
        usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
      },
    }),
  ].join('\n') + '\n';
  await pipeline(
    Readable.from([rows]),
    zlib.createZstdCompress(),
    createWriteStream(join(archivedDir, `rollout-2026-10-17T00-00-00-${taskId}.jsonl.zst`)),
  );

  let decoder = null;
  let decoderDestroyed = 0;
  let firstWriteResolve;
  const firstWrite = new Promise((resolve) => { firstWriteResolve = resolve; });
  const usageSummary = createUsageSummary({
    sessionsDir,
    archivedDir,
    chunkBytes: 32,
    roundBytes: 1024,
    discoveryIntervalMs: 0,
    busyDelayMs: 0,
    idleDelayMs: 0,
    zstdFactory: () => {
      decoder = zlib.createZstdDecompress();
      const destroy = decoder.destroy.bind(decoder);
      decoder.destroy = (...args) => {
        decoderDestroyed++;
        return destroy(...args);
      };
      // Keep the read loop waiting on decoder progress until stop() destroys it.
      decoder.write = () => {
        firstWriteResolve();
        return false;
      };
      return decoder;
    },
  });
  let app;
  const base = await startApp(t, { usageSummary, onApp: (value) => { app = value; } });
  assert.equal((await request(base, '/api/usage')).status, 200);

  let timer;
  const writeTimeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('zstd decoder never became active')), 2000);
  });
  try {
    await Promise.race([firstWrite, writeTimeout]);
  } finally {
    clearTimeout(timer);
  }
  assert.ok(decoder);
  assert.equal(decoderDestroyed, 0);

  const closeTimeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('app.close() did not settle')), 2000);
  });
  try {
    await Promise.race([app.close(), closeTimeout]);
  } finally {
    clearTimeout(timer);
  }
  assert.ok(decoderDestroyed > 0);
  const stopped = usageSummary.snapshot();
  assert.equal(stopped.overall.reason, 'scan_interrupted');
  assert.equal(stopped.overall.usage, null);
});
