import { createServer as httpServer } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createTelemetryWorker } from './telemetry/speed-worker.js';
import { createConfigDefaultsReader } from './telemetry/config-defaults.js';
import { createTaskSummary } from './telemetry/task-summary.js';
import { createUsageSummary, publicUsageSnapshot } from './telemetry/usage-summary.js';
import { createLiveTelemetry, publicLiveSnapshot, unavailableLiveSnapshot } from './telemetry/live-telemetry.js';
import { createDesktopLiveConnector } from './telemetry/desktop-live.js';
import { unavailableTelemetry } from './telemetry/usage.js';
import { APPROVED_MODELS } from './benchmark/runner.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const ORIGIN = 'http://127.0.0.1:4173';
const HOST = '127.0.0.1:4173';
const MAX_BODY = 16 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{16,64}$/;
const PREVIEW_API = '/api/benchmark/preview';
const PREVIEW_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'none'; font-src 'none'; media-src 'none'; connect-src 'self'; frame-src 'self'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const PREVIEW_ASSETS = { '/preview': 'preview.html', '/preview.js': 'preview.js', '/preview.css': 'preview.css', '/preview-frame': 'preview-frame.html' };
const NO_CACHE = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'", 'Referrer-Policy': 'no-referrer' };

class HttpError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
const json = (res, status, data, extra = {}) => { res.writeHead(status, { ...NO_CACHE, 'Content-Type': 'application/json; charset=utf-8', ...extra }); res.end(JSON.stringify(data)); };
const fail = (status, code, message) => { throw new HttpError(status, code, message); };

function validateHost(req) {
  const hostValues = [];
  for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i].toLowerCase() === 'host') hostValues.push(req.rawHeaders[i + 1]);
  if (hostValues.length !== 1 || hostValues[0] !== HOST || req.headers['x-forwarded-host'] !== undefined) fail(403, 'host_invalid', 'Host is not allowed.');
}
function validateMetadata(req, pathname, method) {
  if (req.headers['sec-fetch-site'] === 'cross-site') fail(403, 'origin_invalid', 'Request origin is not allowed.');
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== ORIGIN) fail(403, 'origin_invalid', 'Request origin is not allowed.');
  if (Object.hasOwn(PREVIEW_ASSETS, pathname) || pathname === PREVIEW_API) {
    const site = req.headers['sec-fetch-site'], mode = req.headers['sec-fetch-mode'], dest = req.headers['sec-fetch-dest'];
    const valid = pathname === PREVIEW_API
      ? (site === undefined && mode === undefined && dest === undefined) || (site === 'same-origin' && mode === 'cors' && dest === 'empty')
      : pathname === '/preview' ? ['none', 'same-origin'].includes(site) && mode === 'navigate' && dest === 'document'
      : pathname === '/preview-frame' ? mode === 'navigate' && ((site === 'same-origin' && dest === 'iframe') || (['none', 'same-origin'].includes(site) && dest === 'document'))
      : site === 'same-origin' && mode === 'no-cors' && dest === (pathname.endsWith('.js') ? 'script' : 'style');
    // Browsers send the literal 'empty' destination for fetch requests.
    if (!valid) fail(403, 'fetch_metadata_invalid', 'Preview metadata is invalid.');
    return;
  }
  if (method === 'POST') {
    if (origin !== ORIGIN) fail(403, 'origin_invalid', 'Request origin is required.');
    return;
  }
  if (origin !== undefined) return;
  if (pathname === '/') {
    if (!['none', 'same-origin'].includes(req.headers['sec-fetch-site']) || req.headers['sec-fetch-mode'] !== 'navigate') fail(403, 'fetch_metadata_invalid', 'Navigation metadata is required.');
  } else if (pathname === '/app.js' || pathname === '/styles.css') {
    const dest = pathname.endsWith('.js') ? 'script' : 'style';
    if (req.headers['sec-fetch-site'] !== 'same-origin' || req.headers['sec-fetch-mode'] !== 'no-cors' || req.headers['sec-fetch-dest'] !== dest) fail(403, 'fetch_metadata_invalid', 'Asset metadata is required.');
  } else if (pathname === '/api/nonce') {
    if (req.headers['sec-fetch-site'] !== 'same-origin' || req.headers['sec-fetch-mode'] !== 'cors' || !['', 'empty'].includes(req.headers['sec-fetch-dest'] ?? '')) fail(403, 'fetch_metadata_invalid', 'Bootstrap metadata is required.');
  } else if (req.headers['sec-fetch-site'] !== undefined || req.headers['sec-fetch-mode'] !== undefined || req.headers['sec-fetch-dest'] !== undefined) {
    if (req.headers['sec-fetch-site'] !== undefined && req.headers['sec-fetch-site'] !== 'same-origin') fail(403, 'origin_invalid', 'Request origin is not allowed.');
  }
}
function checkNonce(req, nonce) {
  const supplied = req.headers['x-codex-companion-nonce'];
  const a = Buffer.from(typeof supplied === 'string' ? supplied : '');
  const b = Buffer.from(nonce);
  if (a.length !== b.length || !timingSafeEqual(a, b)) fail(403, 'nonce_invalid', 'Request nonce is invalid.');
}
async function bodyJson(req) {
  const type = req.headers['content-type']?.split(';', 1)[0].trim().toLowerCase();
  const encoding = req.headers['content-encoding'];
  if (type !== 'application/json' || (encoding !== undefined && encoding !== 'identity')) fail(415, 'content_type_invalid', 'JSON with identity encoding is required.');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) { req.destroy(); fail(413, 'body_too_large', 'Request body is too large.'); }
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail(400, 'json_invalid', 'Request JSON is invalid.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'schema_invalid', 'Request body schema is invalid.');
  return value;
}
function exactKeys(value, keys) { return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)); }
function validatePayload(path, value) {
  if (path === '/api/benchmark/run') {
    if (!['static', 'animated', 'html-animated', 'cockpit'].includes(value.mode === undefined ? 'static' : value.mode) || !(Object.hasOwn(value, 'requestId') && Object.keys(value).every((key) => ['requestId', 'model', 'reasoningEffort', 'mode'].includes(key))) || !REQUEST_ID.test(value.requestId ?? '') || !APPROVED_MODELS.has(value.model === undefined ? 'configured' : value.model) || !['configured', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(value.reasoningEffort === undefined ? 'configured' : value.reasoningEffort)) fail(400, 'schema_invalid', 'Benchmark request schema is invalid.');
  } else if (path === '/api/benchmark/score') {
    if (!exactKeys(value, ['runId', 'caseId', 'rubricVersion', 'scores']) || !UUID.test(value.runId ?? '') || !((value.rubricVersion === 'pelican-v1' && ['instruction-following', 'logic-grid', 'code-trace'].includes(value.caseId)) || (value.rubricVersion === 'pelican-svg-v2' && value.caseId === 'pelican-svg') || (value.rubricVersion === 'pelican-svg-animated-v1' && value.caseId === 'pelican-svg-animated') || (value.rubricVersion === 'pelican-html-animated-v1' && value.caseId === 'pelican-html-animated') || (value.rubricVersion === 'pelican-cockpit-v1' && value.caseId === 'pelican-cockpit')) || !value.scores || typeof value.scores !== 'object' || Array.isArray(value.scores) || !exactKeys(value.scores, ['correctness', 'consistency', 'constraint_adherence']) || !Object.values(value.scores).every((x) => Number.isInteger(x) && x >= 1 && x <= 5)) fail(400, 'schema_invalid', 'Score request schema is invalid.');
  } else if (path === '/api/benchmark/baseline') {
    if (!exactKeys(value, ['runId']) || !UUID.test(value.runId ?? '')) fail(400, 'schema_invalid', 'Baseline request schema is invalid.');
  } else if (path === '/api/shutdown') {
    if (!exactKeys(value, [])) fail(400, 'schema_invalid', 'Shutdown request schema is invalid.');
  } else if (path === '/api/benchmark/cancel') {
    if (!exactKeys(value, ['requestId']) || !REQUEST_ID.test(value.requestId ?? '')) fail(400, 'schema_invalid', 'Cancel request schema is invalid.');
  }
}

export function createCompanionServer({ telemetry, liveTelemetry, benchmark = null, defaults = null, taskSummary, usageSummary, sessionsDir = join(process.env.CODEX_HOME ?? join(process.env.USERPROFILE ?? '', '.codex'), 'sessions'), nonce = randomBytes(32).toString('hex'), shutdownToken, onShutdown } = {}) {
  const instanceId = randomUUID();
  // Document and CSP share a single startup read; missing resources fail closed.
  const previewFrame = Promise.all([readFile(join(ROOT, 'public/preview-frame.html'), 'utf8'), readFile(join(ROOT, 'public/preview-frame.js'), 'utf8')]).then(([template, source]) => {
    const script = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    const marker = '/*PREVIEW_FRAME_SCRIPT*/';
    if (/<\/script/i.test(script) || template.split(marker).length !== 2 || (template.match(/<script\b/gi) ?? []).length !== 1 || !template.includes('<script>' + marker + '</script>')) throw new Error('Invalid frame assets.');
    const hash = createHash('sha256').update(script, 'utf8').digest('base64');
    return { html: template.replace(marker, () => script), csp: "default-src 'none'; script-src 'sha256-" + hash + "'; script-src-attr 'none'; style-src 'unsafe-inline'; img-src 'none'; font-src 'none'; media-src 'none'; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox allow-scripts" };
  }).catch(() => null);
  const worker = telemetry ?? createTelemetryWorker({ sessionsDir });
  const tasks = taskSummary ?? createTaskSummary({ sessionsDir });
  const usage = usageSummary ?? createUsageSummary({ sessionsDir });
  const live = liveTelemetry ?? createLiveTelemetry();
  const defaultsReader = defaults ?? createConfigDefaultsReader({ codexHome: process.env.CODEX_HOME ?? join(process.env.USERPROFILE ?? '', '.codex') });
  let fallbackRefresh = null;
  let defaultsRefresh = null;
  const unknownDefaults = () => ({
    model: { state: 'unavailable', source: 'none', reason: 'read_failed', value: null },
    reasoningEffort: { state: 'unavailable', source: 'none', reason: 'read_failed', value: null },
  });
  const defaultsSnapshot = async () => {
    try {
      defaultsRefresh ??= Promise.resolve().then(() => defaultsReader.refresh?.()).finally(() => { defaultsRefresh = null; });
      await defaultsRefresh;
      return await defaultsReader.snapshot?.() ?? unknownDefaults();
    } catch { return unknownDefaults(); }
  };
  const unavailableBenchmark = (reason) => ({ status: 'unavailable', activeRun: null, latestRun: null, runs: [], baseline: null, comparison: null, available: false, unavailableReason: reason });
  let closePromise;
  let shutdownScheduled = false;
  let usageStarted = false;
  const server = httpServer(async (req, res) => {
    const isPreviewApi = req.url?.split('?', 1)[0] === PREVIEW_API;
    const previewJson = (status, data, extra = {}) => {
      const body = JSON.stringify(data);
      if (Buffer.byteLength(body, 'utf8') > (status === 200 ? 800 * 1024 : 2 * 1024)) fail(503, 'service_unavailable', 'Preview request failed.');
      res.writeHead(status, { ...NO_CACHE, 'Content-Type': 'application/json; charset=utf-8', ...extra }); res.end(body);
    };
    try {
      validateHost(req);
      if (isPreviewApi && /[%\\]/.test(req.url)) fail(400, 'preview_query_invalid', 'Preview request failed.');
      if (!isPreviewApi && (req.url?.includes('%') || req.url?.includes('\\') || req.url?.includes('..'))) fail(404, 'not_found', 'Route was not found.');
      const url = new URL(req.url, ORIGIN);
      if (url.search && req.method === 'POST' && !isPreviewApi) fail(400, 'query_not_allowed', 'Query strings are not allowed.');
      const path = url.pathname;
      const methods = { '/': 'GET', '/app.js': 'GET', '/styles.css': 'GET', '/api/capabilities': 'GET', '/api/nonce': 'GET', '/api/telemetry': 'GET', '/api/live': 'GET', '/api/tasks': 'GET', '/api/usage': 'GET', '/api/benchmark': 'GET', '/api/benchmark/run': 'POST', '/api/benchmark/score': 'POST', '/api/benchmark/baseline': 'POST', '/api/benchmark/cancel': 'POST', '/api/shutdown': 'POST' };
      for (const route of [...Object.keys(PREVIEW_ASSETS), PREVIEW_API]) methods[route] = 'GET';
      if (!Object.hasOwn(methods, path)) fail(404, 'not_found', 'Route was not found.');
      if (methods[path] !== req.method) { res.setHeader('Allow', methods[path]); fail(405, 'method_not_allowed', 'Method is not allowed.'); }
      validateMetadata(req, path, req.method);
      if (Object.hasOwn(PREVIEW_ASSETS, path)) {
        if (url.search) fail(400, 'preview_query_invalid', 'Preview request failed.');
        const frame = path === '/preview-frame' ? await previewFrame : null;
        if (path === '/preview-frame' && !frame) fail(503, 'service_unavailable', 'Preview request failed.');
        let content;
        try { content = frame ? frame.html : await readFile(join(ROOT, 'public', PREVIEW_ASSETS[path])); }
        catch { fail(503, 'service_unavailable', 'Preview request failed.'); }
        res.writeHead(200, { ...NO_CACHE, 'Content-Security-Policy': frame ? frame.csp : PREVIEW_CSP, 'Content-Type': path.endsWith('.js') ? 'text/javascript; charset=utf-8' : path.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/html; charset=utf-8' }); res.end(content); return;
      }
      if (path === PREVIEW_API) {
        const pairs = [...url.searchParams];
        if (pairs.length !== 2 || url.searchParams.getAll('runId').length !== 1 || url.searchParams.getAll('instanceId').length !== 1 || !pairs.every(([key, value]) => ['runId', 'instanceId'].includes(key) && UUID.test(value)) || url.search !== '?' + pairs.map(([key, value]) => key + '=' + value).join('&')) fail(400, 'preview_query_invalid', 'Preview request failed.');
        if (url.searchParams.get('instanceId') !== instanceId) fail(409, 'instance_mismatch', 'Preview request failed.');
        if (!benchmark) fail(503, 'benchmark_unavailable', 'Preview request failed.');
        const value = await benchmark.preview(url.searchParams.get('runId'));
        const keys = ['runId', 'status', 'caseSetVersion', 'rubricVersion', 'caseId', 'caseStatus', 'previewState', 'reason', 'answer', 'contentDigest'];
        if (!value || typeof value !== 'object' || !exactKeys(value, keys) || value.runId !== url.searchParams.get('runId') || (value.answer !== null && (typeof value.answer !== 'string' || value.answer.length > 131072 || Buffer.byteLength(value.answer, 'utf8') > 131072))) fail(503, 'service_unavailable', 'Preview request failed.');
        previewJson(200, { protocolVersion: 1, instanceId, ...value }); return;
      }
      if (path === '/') {
        const html = await readFile(join(ROOT, 'public/index.html'));
        res.writeHead(200, { ...NO_CACHE, 'Content-Type': 'text/html; charset=utf-8', 'X-Codex-Companion-Nonce': nonce }); res.end(html); return;
      }
      if (path === '/app.js' || path === '/styles.css') {
        const file = path === '/app.js' ? 'public/app.js' : 'public/styles.css';
        const content = await readFile(join(ROOT, file));
        res.writeHead(200, { ...NO_CACHE, 'Content-Type': path.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8' }); res.end(content); return;
      }
      if (path === '/api/capabilities') { json(res, 200, { product: 'codex-companion', protocolVersion: 1, capabilities: ['configured-defaults', 'pelican-svg-v2', 'versioned-scoring', 'pelican-html-animated-v1', 'isolated-html-preview-v1', 'pelican-cockpit-v1', 'cockpit-preview-source-v1', 'live-telemetry-v1'], instanceId }); return; }
      if (path === '/api/nonce') { json(res, 200, { ok: true }, { 'X-Codex-Companion-Nonce': nonce }); return; }
      if (req.method === 'POST') checkNonce(req, nonce);
      if (path === '/api/live') {
        let taskId = null;
        if (req.url.endsWith('?')) fail(400, 'query_invalid', 'Live query is invalid.');
        if (url.search) {
          const pairs = [...url.searchParams];
          if (pairs.length !== 1 || pairs[0][0] !== 'taskId' || !UUID.test(pairs[0][1])
            || url.search !== '?taskId=' + pairs[0][1]) fail(400, 'query_invalid', 'Live query is invalid.');
          taskId = pairs[0][1];
        }
        try {
          live.ensureStarted?.();
          json(res, 200, publicLiveSnapshot(live.snapshot({ taskId }), { taskId }));
        } catch { json(res, 200, unavailableLiveSnapshot('source_unavailable')); }
        return;
      }
      if (path === '/api/tasks') {
        if (url.search) fail(400, 'query_invalid', 'Query strings are not allowed.');
        await tasks.refresh();
        json(res, 200, tasks.list());
        return;
      }
      if (path === '/api/usage') {
        if (req.url.endsWith('?')) fail(400, 'query_invalid', 'Usage query is invalid.');
        let taskId = null;
        if (url.search) {
          const pairs = [...url.searchParams];
          if (pairs.length !== 1 || pairs[0][0] !== 'taskId' || url.searchParams.getAll('taskId').length !== 1
            || !UUID.test(pairs[0][1]) || url.search !== '?taskId=' + pairs[0][1]) {
            fail(400, 'query_invalid', 'Usage query is invalid.');
          }
          taskId = pairs[0][1];
        }
        if (!usageStarted) {
          usage.ensureStarted?.();
          usageStarted = true;
        }
        // GET reads the already-published in-memory view. Discovery and
        // bounded reads continue in the background and never block this route.
        json(res, 200, publicUsageSnapshot(usage.snapshot({ taskId })));
        return;
      }
      if (path === '/api/telemetry') {
        // Additive task selection: no query keeps the legacy follow-mode shape.
        let taskId = null;
        if (url.search) {
          const pairs = [...url.searchParams];
          if (pairs.length !== 1 || url.searchParams.getAll('taskId').length !== 1 || pairs[0][0] !== 'taskId' || !UUID.test(pairs[0][1])) fail(400, 'query_invalid', 'Task query is invalid.');
          taskId = pairs[0][1];
        }
        if (!telemetry) {
          fallbackRefresh ??= worker.refresh().finally(() => { fallbackRefresh = null; });
          await fallbackRefresh;
        }
        if (taskId === null) { json(res, 200, worker.snapshot()); return; }
        await tasks.refresh({ pinnedId: taskId });
        const detail = tasks.detail(taskId, 'pinned');
        // An unreadable library cannot prove absence; only a completed scan may.
        if (detail?.unavailable) fail(503, 'telemetry_unavailable', 'Task telemetry is temporarily unavailable.');
        if (!detail) fail(404, 'task_not_found', 'Task was not found.');
        // The follow-mode snapshot only describes its own auto-selected session.
        // Reusing those fields for a pinned task would publish another task's
        // session, context and counters, so unrelated values stay unavailable.
        const follow = worker.snapshot();
        const sameSession = follow?.session?.id === taskId;
        json(res, 200, {
          ...(sameSession ? follow : { ...follow, state: 'unavailable', session: null, usage: null, speed: null, ...unavailableTelemetry('pinned_task') }),
          ...detail,
        });
        return;
      }
      if (path === '/api/shutdown') {
        const supplied = req.headers['x-codex-companion-shutdown-token'];
        const a = Buffer.from(typeof supplied === 'string' ? supplied : '');
        const b = Buffer.from(typeof shutdownToken === 'string' ? shutdownToken : '');
        if (!b.length || a.length !== b.length || !timingSafeEqual(a, b) || typeof onShutdown !== 'function') fail(403, 'shutdown_forbidden', 'Shutdown is not authorized.');
        validatePayload(path, await bodyJson(req));
        if (!shutdownScheduled) {
          shutdownScheduled = true;
          res.once('finish', () => { setImmediate(() => { Promise.resolve().then(onShutdown).catch(() => {}); }); });
        }
        json(res, 200, { ok: true }); return;
      }
      if (path === '/api/benchmark') {
        let snapshot;
        if (!benchmark) snapshot = unavailableBenchmark('benchmark_unavailable');
        else {
          try { snapshot = { ...await benchmark.snapshot(), unavailableReason: null }; }
          catch { snapshot = unavailableBenchmark('service_unavailable'); }
        }
        json(res, 200, { ...snapshot, defaults: await defaultsSnapshot() }); return;
      }
      if (!benchmark) fail(503, 'benchmark_unavailable', 'Benchmark feature is unavailable.');
      const body = await bodyJson(req); validatePayload(path, body);
      const result = path.endsWith('/run') ? await benchmark.run(body)
        : path.endsWith('/score') ? await benchmark.score(body)
        : path.endsWith('/baseline') ? await benchmark.baseline(body)
        : await benchmark.cancel(body);
      json(res, 200, result ?? await benchmark.snapshot());
    } catch (error) {
      if (isPreviewApi) {
        const codes = { preview_query_invalid: 400, host_invalid: 403, origin_invalid: 403, fetch_metadata_invalid: 403, run_not_found: 404, method_not_allowed: 405, instance_mismatch: 409, preview_version_mismatch: 409, preview_case_mismatch: 409, preview_record_invalid: 409, benchmark_unavailable: 503, service_unavailable: 503 };
        const code = Object.hasOwn(codes, error?.code) ? error.code : 'service_unavailable';
        previewJson(codes[code], { protocolVersion: 1, instanceId, error: { code, message: 'Preview request failed.' } }, code === 'method_not_allowed' ? { Allow: 'GET' } : {}); return;
      }
      if (error instanceof HttpError) json(res, error.status, { error: { code: error.code, message: error.message } }, error.status === 405 ? { Allow: res.getHeader('Allow') ?? 'GET' } : {});
      else if (Number.isInteger(error?.status) && error.status >= 400 && error.status < 600) json(res, error.status, { error: { code: error.code ?? 'benchmark_error', message: error.message ?? 'Request failed.' } });
      else json(res, 503, { error: { code: 'service_unavailable', message: 'Service is temporarily unavailable.' } });
    }
  });
  return { server, nonce, close() {
    closePromise ??= (async () => {
      const stopped = new Promise((resolve, reject) => server.close((e) => e && e.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(e) : resolve()));
      await Promise.all([stopped, fallbackRefresh, defaultsRefresh, worker?.stop?.(), live?.stop?.(), benchmark?.close?.(), defaultsReader.stop?.(), usage?.stop?.()]);
    })();
    return closePromise;
  } };
}

export async function startServer() {
  const sessionsDir = join(process.env.CODEX_HOME ?? join(process.env.USERPROFILE ?? '', '.codex'), 'sessions');
  const telemetry = createTelemetryWorker({ sessionsDir });
  const liveTelemetry = createLiveTelemetry({ connector: createDesktopLiveConnector() });
  const defaults = createConfigDefaultsReader({ codexHome: process.env.CODEX_HOME ?? join(process.env.USERPROFILE ?? '', '.codex') });
  await defaults.refresh();
  await telemetry.start();
  let benchmark = null;
  try { const module = await import('./benchmark/service.js'); benchmark = await module.createBenchmarkService(); } catch { benchmark = null; }
  let app;
  const shutdown = async () => { try { await app.close(); } finally { process.exit(0); } };
  app = createCompanionServer({ telemetry, liveTelemetry, benchmark, defaults, shutdownToken: process.env.CODEX_COMPANION_SHUTDOWN_TOKEN, onShutdown: shutdown });
  await new Promise((resolve, reject) => {
    const onError = (error) => { app.server.off('listening', onListening); reject(error); };
    const onListening = () => { app.server.off('error', onError); resolve(); };
    app.server.once('error', onError);
    app.server.once('listening', onListening);
    app.server.listen(4173, '127.0.0.1');
  }).catch(async (error) => { await app.close(); throw error; });
  process.stdout.write('http://127.0.0.1:4173\n');
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  startServer().catch((error) => { process.stderr.write(error?.code === 'EADDRINUSE' ? 'Port 4173 is already in use.\n' : 'Server startup failed.\n'); process.exitCode = 1; });
}
