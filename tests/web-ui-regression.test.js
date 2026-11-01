import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import {
  capabilities, completedBenchmark, createWebFixture, defaults, emptyTasks, event, fire,
  flushPromises, hangingResponse, idleBenchmark, jsonResponse, syntheticIds,
  vmModulesAvailable, vmModulesSkipReason,
} from './helpers/web-ui-fixture.js';

const vmTest = { skip: vmModulesAvailable ? false : vmModulesSkipReason };
const indexUrl = new URL('../src/public/index.html', import.meta.url);
const stylesUrl = new URL('../src/public/styles.css', import.meta.url);
const basicRoutes = benchmark => request => {
  if (request.url === '/api/tasks') return jsonResponse(emptyTasks);
  if (request.url === '/api/capabilities') return jsonResponse(capabilities);
  if (request.url === '/api/nonce') return jsonResponse({});
  if (request.url === '/api/benchmark') {
    const result = typeof benchmark === 'function' ? benchmark(request) : benchmark;
    if (result && typeof result.then === 'function') return result;
    return jsonResponse({ defaults: defaults(), ...result });
  }
  throw new Error('unexpected synthetic route: ' + request.method + ' ' + request.url);
};
async function flushUntil(predicate, message) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (predicate()) return;
    await flushPromises(1);
  }
  assert.ok(predicate(), message);
}
const visibleText = node => node.textContent || node.children?.map(visibleText).join(' ') || '';
const optionLabels = select => select.options.map(option => option.textContent || option.value);

async function boot(benchmark = idleBenchmark, options) {
  return createWebFixture(basicRoutes(benchmark), options);
}

async function submit(fixture, { requireEnabled = true } = {}) {
  const button = fixture.$('run');
  if (requireEnabled) assert.equal(button.disabled, false, 'the synthetic click must target an enabled run control');
  fire(button, 'click');
  await flushPromises(20);
}

test('GET defaults dynamically populates catalogs and retains valid independent drafts', vmTest, async () => {
  let snapshot = { ...idleBenchmark, defaults: defaults() };
  const fixture = await boot(() => snapshot);
  const model = fixture.$('model');
  const effort = fixture.$('effort');
  assert.deepEqual(model.options.map(option => option.value), ['configured', 'synthetic/model-a', 'synthetic/model-b']);
  assert.deepEqual(effort.options.map(option => option.value), ['configured', 'low', 'high']);
  assert.match(optionLabels(model).join(' '), /合成模型 A/);

  model.value = 'synthetic/model-b';
  effort.value = 'low';
  fire(model, 'change');
  fire(effort, 'change');
  const originalOptions = [...model.options];
  snapshot = { ...snapshot, defaults: { ...defaults(), availableEfforts: [...defaults().availableEfforts, { value: 'none', label: 'none' }] } };
  await fixture.pollBenchmark();
  assert.equal(model.value, 'synthetic/model-b', 'catalog refresh must not erase a still-valid model draft');
  assert.equal(effort.value, 'low');
  assert.equal(effort.options.some(option => option.value === 'none'), true);
  assert.ok(originalOptions.every(option => option.isConnected), 'unchanged model option nodes must not be rebuilt');

  snapshot = { ...snapshot, defaults: defaults({ availableModels: [{ slug: 'configured', displayName: '沿用配置' }, { slug: 'synthetic/model-c', displayName: '合成模型 C' }] }) };
  await fixture.pollBenchmark();
  assert.equal(model.value, 'configured', 'a draft removed by the server catalog must fall back safely');
  assert.equal(effort.value, 'low', 'model changes must not reset an independent effort draft');
  assert.equal(model.options.some(option => option.value === 'synthetic/model-c'), true);
});

test('unknown submission outcome reconciles before starting another run', vmTest, async () => {
  let acceptedRequestId = null;
  const running = { ...idleBenchmark, defaults: defaults(), status: 'running', activeRun: { runId: syntheticIds.run, requestId: 'synthetic-request', status: 'running', model: 'configured', reasoningEffort: 'configured', caseSetVersion: 'pelican-svg-v2', rubricVersion: 'pelican-svg-v2', caseResults: [] } };
  const fixture = await createWebFixture(request => {
    if (request.url === '/api/benchmark/run') { acceptedRequestId = request.body.requestId; throw new TypeError('synthetic response connection lost'); }
    if (request.url === '/api/benchmark') {
      const accepted = acceptedRequestId !== null;
      return jsonResponse(accepted ? { ...running, activeRun: { ...running.activeRun, requestId: acceptedRequestId } } : idleBenchmark);
    }
    return basicRoutes(idleBenchmark)(request);
  });
  await submit(fixture);
  const postsAfterLoss = fixture.requestsTo('/api/benchmark/run');
  assert.equal(postsAfterLoss.length, 1);
  assert.ok(acceptedRequestId, 'the synthetic server accepted the request before its response was lost');
  const firstPostIndex = fixture.requests.indexOf(postsAfterLoss[0]);
  const reconciliationIndex = fixture.requests.findIndex((request, index) => index > firstPostIndex && request.url === '/api/benchmark');
  assert.ok(reconciliationIndex > firstPostIndex, 'an ambiguous result must be followed by an authoritative GET before another POST');
  assert.equal(fixture.$('benchmark-state').textContent, '运行中');

  await submit(fixture, { requireEnabled: false });
  assert.equal(fixture.requestsTo('/api/benchmark/run').length, postsAfterLoss.length, 'the reconciled active run must not be duplicated');
  assert.equal(fixture.$('benchmark-state').textContent, '运行中');
  assert.equal(fixture.requestsTo('/api/benchmark/run')[0].body.requestId, acceptedRequestId);
});

test('retry after an unknown outcome reuses the request identity when reconciliation finds no run', vmTest, async () => {
  let first = true;
  const fixture = await createWebFixture(request => {
    if (request.url === '/api/benchmark/run') {
      if (first) { first = false; throw new TypeError('synthetic unknown outcome'); }
      return jsonResponse({ ...idleBenchmark, defaults: defaults(), status: 'queued', activeRun: { ...idleBenchmark.activeRun, requestId: request.body.requestId, runId: syntheticIds.run, status: 'queued', model: request.body.model, reasoningEffort: request.body.reasoningEffort, caseSetVersion: 'pelican-svg-v2', rubricVersion: 'pelican-svg-v2', caseResults: [] } });
    }
    return basicRoutes(idleBenchmark)(request);
  });
  await submit(fixture);
  const beforeRetry = fixture.requestsTo('/api/benchmark').length;
  fixture.$('model').value = 'synthetic/model-b';
  fixture.$('effort').value = 'low';
  await submit(fixture);
  const posts = fixture.requestsTo('/api/benchmark/run');
  assert.equal(posts.length, 2, 'an idle reconciled snapshot should permit the retry');
  assert.ok(fixture.requestsTo('/api/benchmark').length > beforeRetry, 'retry must reconcile first');
  assert.equal(posts[1].body.requestId, posts[0].body.requestId);
  assert.equal(posts[1].body.model, posts[0].body.model);
  assert.equal(posts[1].body.reasoningEffort, posts[0].body.reasoningEffort);
  assert.equal(posts[1].body.mode, posts[0].body.mode);
});

test('an explicit HTTP rejection is not classified as an unknown submission', vmTest, async () => {
  const fixture = await createWebFixture(request => {
    if (request.url === '/api/benchmark/run') return jsonResponse({ error: { code: 'run_active' } }, 409);
    return basicRoutes(idleBenchmark)(request);
  });
  await submit(fixture);
  assert.equal(fixture.requestsTo('/api/benchmark/run').length, 1);
  assert.doesNotMatch(fixture.$('benchmark-message').textContent, /未知/);
  const beforeRetry = fixture.requestsTo('/api/benchmark').length;
  await submit(fixture);
  assert.equal(fixture.requestsTo('/api/benchmark/run').length, 2, 'a definite rejection is a separate explicit submission');
  assert.equal(fixture.requestsTo('/api/benchmark').length, beforeRetry, 'definite HTTP errors do not need unknown-outcome reconciliation');
  assert.notEqual(fixture.requestsTo('/api/benchmark/run')[1].body.requestId, fixture.requestsTo('/api/benchmark/run')[0].body.requestId);
});

test('a failed reconciliation GET preserves the unknown outcome and releases the flight', vmTest, async () => {
  let failed = false;
  const fixtureRef = { allowSuccessfulRetry: false };
  const fixture = await createWebFixture(request => {
    if (request.url === '/api/benchmark/run') {
      if (fixtureRef?.allowSuccessfulRetry) {
        return jsonResponse({ ...idleBenchmark, defaults: defaults(), status: 'queued', activeRun: { runId: syntheticIds.run, requestId: request.body.requestId, status: 'queued', model: request.body.model, reasoningEffort: request.body.reasoningEffort, caseSetVersion: 'pelican-svg-v2', rubricVersion: 'pelican-svg-v2', caseResults: [] } });
      }
      throw new TypeError('synthetic response connection lost');
    }
    if (request.url === '/api/benchmark' && failed) throw new TypeError('synthetic GET connection lost');
    return basicRoutes(idleBenchmark)(request);
  });
  failed = true;
  await submit(fixture);
  assert.equal(failed, true, 'the first reconciliation GET must actually fail');
  assert.match(fixture.$('benchmark-message').textContent, /未知/);
  assert.equal(fixture.$('run').disabled, false, 'a failed GET must release reconciliation and permit the retry attempt');
  await fixture.pollBenchmark();
  await submit(fixture);
  const posts = fixture.requestsTo('/api/benchmark/run');
  assert.equal(posts.length, 1, 'the failed manual reconciliation GET must not issue another POST');
  assert.ok(posts[0].body.requestId, 'the original request identity must remain available');
  assert.match(fixture.$('benchmark-message').textContent, /未知/, 'a failed retry GET must not erase the unknown submission state');
  assert.equal(fixture.$('run').disabled, false, 'the failed retry GET must release the flight');
  const beforeRetry = fixture.requestsTo('/api/benchmark').length;
  failed = false;
  fixtureRef.allowSuccessfulRetry = true;
  await fixture.pollBenchmark();
  await submit(fixture);
  const retries = fixture.requestsTo('/api/benchmark/run');
  assert.equal(retries.length, 2, 'a recovered idle snapshot must allow the same request to retry');
  assert.ok(fixture.requestsTo('/api/benchmark').length > beforeRetry, 'retry must perform a fresh reconciliation GET');
  assert.equal(retries[1].body.requestId, retries[0].body.requestId);
});

test('an older GET rejection cannot overwrite a newer confirmed submission', vmTest, async () => {
  let rejectOldGet;
  let accepted = false;
  let holdGet = false;
  const active = { runId: syntheticIds.run, requestId: null, status: 'running', model: 'configured', reasoningEffort: 'configured', caseSetVersion: 'pelican-svg-v2', rubricVersion: 'pelican-svg-v2', caseResults: [] };
  const fixture = await createWebFixture(request => {
    if (request.url === '/api/benchmark/run') {
      accepted = true;
      return jsonResponse({ ...idleBenchmark, defaults: defaults(), status: 'running', activeRun: { ...active, requestId: request.body.requestId } });
    }
    if (request.url === '/api/benchmark' && holdGet && !accepted) return new Promise((_, reject) => { rejectOldGet = reject; });
    if (request.url === '/api/benchmark') return jsonResponse({ ...idleBenchmark, defaults: defaults(), status: accepted ? 'running' : 'idle', activeRun: accepted ? active : null });
    return basicRoutes(idleBenchmark)(request);
  });
  holdGet = true;
  const stalePoll = fixture.pollBenchmark();
  await flushUntil(() => Boolean(rejectOldGet), 'the superseded benchmark GET must start');
  assert.equal(fixture.$('run').disabled, false, 'a read-only refresh must not disable a new explicit submission');
  await submit(fixture);
  assert.equal(fixture.$('benchmark-state').textContent, '运行中');
  rejectOldGet(new TypeError('late failure from the superseded GET'));
  await stalePoll;
  assert.equal(fixture.$('benchmark-state').textContent, '运行中', 'the confirmed submission must survive the stale failure');
  assert.equal(fixture.$('cancel').classList.contains('hidden'), false, 'the active run must keep its cancellation control');
});

test('a hung benchmark GET aborts on the injected clock and a later poll recovers', vmTest, async () => {
  let gets = 0;
  let sawAbortSignal = false;
  let timedOut = false;
  const running = { ...idleBenchmark, defaults: defaults(), status: 'running', activeRun: { runId: syntheticIds.run, requestId: 'synthetic-request', status: 'running', model: 'configured', reasoningEffort: 'configured', caseSetVersion: 'pelican-svg-v2', rubricVersion: 'pelican-svg-v2', caseResults: [] } };
  const fixture = await boot(request => {
    gets++;
    if (gets === 2) {
      sawAbortSignal = Boolean(request.signal);
      return hangingResponse(request.signal).finally(() => { timedOut = true; });
    }
    return running;
  });
  const hungPoll = fixture.pollBenchmark();
  await flushUntil(() => sawAbortSignal, 'the hung benchmark GET must start with an AbortSignal');
  await fixture.advance(10_000);
  await hungPoll;
  assert.equal(timedOut, true, 'the hanging request must reject when its timeout aborts');
  assert.match(fixture.$('benchmark-message').textContent, /不可用|超时|过期/);
  await fixture.pollBenchmark();
  assert.equal(gets, 3, 'the next poll must not remain blocked by the aborted flight');
  assert.equal(fixture.$('benchmark-state').textContent, '运行中');
});

test('a valid task with unavailable session telemetry remains connected', vmTest, async () => {
  const task = { id: syntheticIds.taskA, title: '合成任务', updatedAt: '2026-10-26T00:00:00.000Z', stale: false };
  const fixture = await createWebFixture(request => {
    if (request.url === '/api/tasks') return jsonResponse({ ...emptyTasks, tasks: [task] });
    if (request.url === '/api/telemetry?taskId=' + syntheticIds.taskA) return jsonResponse({ state: 'unavailable', sampledAt: '2026-10-26T00:00:00.000Z', task, currentTurn: null, agents: [] });
    return basicRoutes(idleBenchmark)(request);
  });
  assert.equal(fixture.$('task-title').textContent.includes('合成任务'), true, 'valid task metadata must still be rendered');
  assert.match(fixture.$('connection').lastElementChild.textContent, /已连接/);
  assert.doesNotMatch(fixture.$('connection').lastElementChild.textContent, /不可用/);
});

test('same-name and same-short-ID options receive distinct visible disambiguation and exact-ID duplicates collapse', vmTest, async () => {
  const tasks = [
    { id: syntheticIds.taskA, title: '相同的合成任务标题', updatedAt: '2026-10-26T00:00:00.000Z' },
    { id: syntheticIds.taskB, title: '相同的合成任务标题', updatedAt: '2026-10-26T00:01:00.000Z' },
    { id: syntheticIds.taskA, title: '相同的合成任务标题', updatedAt: '2026-10-26T00:00:00.000Z' },
  ];
  const fixture = await createWebFixture(request => {
    if (request.url === '/api/tasks') return jsonResponse({ ...emptyTasks, tasks });
    if (request.url.startsWith('/api/telemetry?taskId=')) return jsonResponse({ state: 'unavailable', task: tasks.find(task => request.url.endsWith(task.id)), agents: [] });
    return basicRoutes(idleBenchmark)(request);
  });
  const options = fixture.$('task-select').options;
  assert.equal(options.length, 2);
  assert.notEqual(options[0].textContent, options[1].textContent, 'both task options must be distinguishable by visible text alone');
  const labels = options.map(option => option.textContent);
  await fixture.pollTelemetry();
  assert.deepEqual(fixture.$('task-select').options.map(option => option.textContent), labels, 'disambiguation must be stable across refreshes');
});

test('agent details use native summary toggling and retain focus/open across telemetry', vmTest, async () => {
  const task = { id: syntheticIds.taskA, title: '合成代理任务', updatedAt: '2026-10-26T00:00:00.000Z' };
  const telemetry = { state: 'unavailable', sampledAt: '2026-10-26T00:00:00.000Z', task, agents: [{ id: 'agent-a', role: '探索代理', model: 'synthetic/agent-model-with-a-long-name', effort: 'high', state: 'in_progress', association: 'current_turn', updatedAt: '2026-10-26T00:00:00.000Z' }] };
  const fixture = await createWebFixture(request => {
    if (request.url === '/api/tasks') return jsonResponse({ ...emptyTasks, tasks: [task] });
    if (request.url.startsWith('/api/telemetry?taskId=')) return jsonResponse(telemetry);
    return basicRoutes(idleBenchmark)(request);
  });
  const row = fixture.$('agents').querySelector('details.agent-row');
  assert.ok(row, 'agent details must be an expandable details.agent-row');
  const summary = row.querySelector('summary.agent-summary');
  const detail = row.querySelector('.agent-detail');
  assert.ok(summary && detail, 'native summary and separately readable agent-detail are required');
  assert.match(visibleText(detail), /synthetic\/agent-model-with-a-long-name/);
  assert.match(visibleText(detail), /high/);
  assert.equal(row.open, false);
  summary.focus();
  fire(summary, 'click');
  assert.equal(row.open, true);
  await fixture.pollTelemetry();
  const currentRow = fixture.$('agents').querySelector('details.agent-row');
  assert.equal(currentRow.open, true, 'polling must not collapse an open agent');
  assert.equal(fixture.document.activeElement, currentRow.querySelector('summary.agent-summary'), 'polling must preserve logical focus on the summary');
});

test('non-progress snapshot preserves a score draft and its logical focus', vmTest, async () => {
  let snapshot = completedBenchmark();
  const fixture = await boot(() => snapshot);
  const score = fixture.$('cases').querySelector('select[data-score="correctness"]');
  assert.ok(score, 'completed synthetic case should expose a score select');
  score.value = '5';
  score.focus();
  fire(score, 'change');
  const runId = score.dataset.run;
  const caseId = score.dataset.case;
  snapshot = completedBenchmark({ defaults: defaults() });
  await fixture.pollBenchmark();
  assert.equal(fixture.document.activeElement?.dataset.run, runId);
  assert.equal(fixture.document.activeElement?.dataset.case, caseId);
  assert.equal(fixture.document.activeElement?.dataset.score, 'correctness');
  assert.equal(fixture.document.activeElement?.value, '5');
  assert.equal(fixture.requests.some(request => request.method === 'POST' && request.url !== '/api/benchmark/run'), false);
});

test('main telemetry is not a live region; only concise states are polite', async () => {
  const html = await readFile(indexUrl, 'utf8');
  const section = html.match(/<section\b[^>]*aria-label="对话消耗"[^>]*>[\s\S]*?<\/section>/i)?.[0];
  assert.ok(section, 'main telemetry section must remain identifiable');
  const sectionTag = section.match(/^<section\b[^>]*>/i)?.[0];
  assert.doesNotMatch(sectionTag, /\baria-live\s*=/i);
  const telemetryLiveTags = section.match(/<[^>]+(?:aria-live\s*=\s*["']polite["']|role\s*=\s*["']status["'])[^>]*>/gi) ?? [];
  const telemetryLiveIds = telemetryLiveTags.map(tag => tag.match(/\bid\s*=\s*["']([^"']+)["']/i)?.[1] ?? null);
  assert.deepEqual(telemetryLiveIds, ['session-state'], 'the telemetry section must expose only its concise session state');

  const connectionTag = html.match(/<[^>]+\bid="connection"[^>]*>/i)?.[0];
  const sessionStateTag = section.match(/<[^>]+\bid="session-state"[^>]*>/i)?.[0];
  const progressTag = html.match(/<[^>]+\bid="benchmark-progress"[^>]*>/i)?.[0];
  assert.match(connectionTag, /\baria-live="polite"/i);
  assert.match(sessionStateTag, /\baria-live="polite"/i);
  assert.ok(progressTag, 'benchmark progress must remain identifiable');
  assert.doesNotMatch(progressTag, /\brole="status"|\baria-live\s*=/i, 'progress must not be an explicit or implicit status region');
});

test('app follows system light/dark preference and change events without another asset route', vmTest, async () => {
  const html = await readFile(indexUrl, 'utf8');
  assert.doesNotMatch(html, /<script\b[^>]*src=\/theme\.js/, 'the deployed app.js must not depend on a newly routed script');
  const fixture = await boot();
  assert.equal(fixture.document.documentElement.dataset.theme, 'dark');
  fixture.media.matches = true;
  for (const listener of fixture.mediaListeners) listener.call(fixture.media, event('change'));
  assert.equal(fixture.document.documentElement.dataset.theme, 'light');
  fixture.media.matches = false;
  for (const listener of fixture.mediaListeners) listener.call(fixture.media, event('change'));
  assert.equal(fixture.document.documentElement.dataset.theme, 'dark');
  assert.ok(fixture.mediaListeners.size > 0, 'system preference changes must be observed');
});

test('controls buttons align to the end of their grid row', async () => {
  const css = (await readFile(stylesUrl, 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find(match => match[1].split(',').some(selector => /^\s*\.controls\s*>\s*button\s*$/.test(selector)));
  assert.ok(rule, 'expected a .controls > button rule');
  assert.match(rule[2], /(?:^|;)\s*align-self\s*:\s*end\s*(?:;|$)/);
  const tokens = await readFile(new URL('../src/public/tokens.css', import.meta.url), 'utf8');
  assert.match(tokens, /--control-h-touch\s*:\s*44px\s*;/);
  assert.match(css, /@media\s*\(pointer\s*:\s*coarse\)[\s\S]*?\.task-bar button,\s*\.controls\s*>\s*button\s*\{[^}]*min-height\s*:\s*var\(--control-h-touch\)/);
});

test('expanded agent details can grow without a nested height cap', async () => {
  const css = (await readFile(stylesUrl, 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find(match => /^\s*\.agents\s*$/.test(match[1]));
  assert.ok(rule, 'expected an .agents rule');
  assert.doesNotMatch(rule[2], /(?:max-)?height\s*:|overflow\s*:/, 'details must participate in normal page flow');
});
