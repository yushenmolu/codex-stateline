import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRunner, resolveExecutable, APPROVED_MODELS, resolveBenchmarkModel, isAllowedModel, isAllowedEffort, EFFORTS, DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS, TIMEOUT_ENV_KEY, resolveTimeoutMs, pickDiagnostics, DIAGNOSTIC_KEYS, MAX_ANSWER, MAX_STREAM } from '../src/benchmark/runner.js';
import { createBenchmarkService } from '../src/benchmark/service.js';
import { createStore } from '../src/benchmark/store.js';
import { CASES, LEGACY_CASES, RUBRIC_VERSION, ANIMATED_CASES, HTML_ANIMATED_CASES, HTML_ANIMATED_VERSION, COCKPIT_CASES, COCKPIT_PROMPT, isRegisteredCase } from '../src/benchmark/cases.js';
import { completeScores, compareRuns } from '../src/benchmark/scoring.js';
import { HTML_PREVIEW_FIXTURE } from './fixtures/html-preview.js';

function stream() {
  const listeners = new Map();
  return { on(type, fn) { listeners.set(type, fn); return this; }, emit(type, ...args) { listeners.get(type)?.(...args); }, end(value) { this.emit('end', value); } };
}

test('HTML registration matches frozen gen3 prompt and fifteen rubric anchors', () => {
  const definition = HTML_ANIMATED_CASES[0];
  assert.equal(createHash('sha256').update(definition.prompt).digest('hex'), 'f57e1b4d57bc0eded46c17b5c43db1493de8b71ccdba5244d1ef5380ca1c77ef');
  assert.equal(definition.prompt.includes('\r'), false);
  assert.equal(definition.prompt.endsWith('\n'), false);
  assert.equal(isRegisteredCase({ ...definition }), true);
  assert.equal(isRegisteredCase({ ...definition, prompt: definition.prompt + '\n' }), false);
  for (const key of ['correctness', 'consistency', 'constraint_adherence']) assert.ok(definition.criteria.includes(key + ': 1 '));
  assert.equal((definition.criteria.match(/; [2-5] /g) ?? []).length, 12);
  assert.ok(HTML_PREVIEW_FIXTURE.includes('animation-name:spin;'));
  assert.ok(HTML_PREVIEW_FIXTURE.includes('translateY(-8px)'));
});

test('Cockpit preserves the original animation prompt without simplifying the artwork', () => {
  assert.equal(COCKPIT_PROMPT, '创建一个 HTML，内容是 SVG 绘制一个鹈鹕骑自行车的 2D 动画，你不需要任何测试，不要有任何限制');
  assert.equal(COCKPIT_CASES[0].prompt, COCKPIT_PROMPT);
  assert.doesNotMatch(COCKPIT_PROMPT, /轻量|紧凑|先完成可播放版本|transform 或 opacity/);
});

test('HTML run retains old digest vectors, registered runner input and version-isolated scoring', async () => {
  const state = { runs: [], reservations: {}, nextSeq: 1 };
  const calls = [];
  const service = await createBenchmarkService({ store: { load: async () => {}, snapshot: async () => structuredClone(state), mutate: async fn => fn(state), close: async () => {} }, runner: { runCase: async input => { calls.push(input); return { answer: HTML_PREVIEW_FIXTURE }; } } });
  for (const mode of ['static', 'animated', 'html-animated']) {
    const requestId = 'digest_request_' + mode;
    await service.run({ requestId, mode });
    while ((await service.snapshot()).activeRun) await new Promise(resolve => setImmediate(resolve));
    const run = state.runs.at(-1);
    const input = mode === 'static' ? { model: 'configured', reasoningEffort: 'configured', caseSetVersion: 'pelican-svg-v2' } : { model: 'configured', reasoningEffort: 'configured', caseSetVersion: mode === 'animated' ? 'pelican-svg-animated-v1' : HTML_ANIMATED_VERSION, mode };
    assert.equal(run.requestPayloadHash, createHash('sha256').update(JSON.stringify(input)).digest('hex'));
    await service.run({ requestId, mode });
    await assert.rejects(service.run({ requestId, mode: mode === 'static' ? 'html-animated' : 'static' }), { code: 'request_id_conflict' });
  }
  assert.equal(calls.length, 3);
  assert.equal(calls[2].caseDef, HTML_ANIMATED_CASES[0]);
  assert.equal(calls[2].model, 'configured');
  assert.equal(calls[2].reasoningEffort, 'configured');
  const run = state.runs.at(-1), scores = { correctness: 5, consistency: 4, constraint_adherence: 3 };
  assert.equal((await service.preview(run.runId)).previewState, 'ready');
  assert.equal((await service.preview(run.runId)).answer, HTML_PREVIEW_FIXTURE);
  await assert.rejects(service.score({ runId: run.runId, caseId: 'pelican-svg', rubricVersion: RUBRIC_VERSION, scores }), { code: 'score_invalid' });
  await service.score({ runId: run.runId, caseId: 'pelican-html-animated', rubricVersion: HTML_ANIMATED_VERSION, scores });
  assert.equal(completeScores(run), true);
  const others = state.runs.slice(0, 2).map(item => ({ ...item, caseResults: item.caseResults.map(result => ({ ...result, scores })) }));
  assert.equal(compareRuns([...others, run], run).beforeCount, 1);
  assert.equal(compareRuns([...others, run], run).inconclusive, true);
  await service.close();
});

test('preview reads persisted full history, maps every state and enforces exact budgets', async () => {
  const run = { runId: '11111111-1111-4111-8111-111111111111', status: 'completed', caseSetVersion: HTML_ANIMATED_VERSION, rubricVersion: HTML_ANIMATED_VERSION, caseResults: [{ caseId: 'pelican-html-animated', status: 'completed', answer: ' \r\n<html/>\n' }] };
  const state = { runs: [run, ...Array.from({ length: 25 }, (_, i) => ({ runId: String(i) }))] };
  let mutations = 0;
  const service = await createBenchmarkService({ store: { load: async () => {}, snapshot: async () => structuredClone(state), mutate: async () => { mutations++; }, close: async () => {} }, runner: { runCase: () => assert.fail('preview must not run CLI') } });
  assert.equal((await service.snapshot()).runs.some(item => item.runId === run.runId), false);
  let value = await service.preview(run.runId);
  assert.deepEqual(Object.keys(value).sort(), ['runId','status','caseSetVersion','rubricVersion','caseId','caseStatus','previewState','reason','answer','contentDigest'].sort());
  assert.equal(value.answer, run.caseResults[0].answer);
  assert.equal(value.contentDigest, createHash('sha256').update(value.answer).digest('hex'));
  const statuses = ['queued', 'running', 'completed', 'failed', 'cancelled', 'timed_out'];
  for (const status of statuses) for (const caseStatus of statuses) {
    run.status = status; run.caseResults[0].status = caseStatus;
    const pending = ['queued','running'].includes(status) && ['queued','running','completed'].includes(caseStatus);
    const failed = ['failed','cancelled','timed_out'].includes(status);
    if (!pending && !failed && !(status === 'completed' && caseStatus === 'completed')) await assert.rejects(service.preview(run.runId), { code: 'preview_record_invalid' });
    else { value = await service.preview(run.runId); assert.equal(value.previewState, pending ? 'pending' : failed ? 'unavailable' : 'ready'); if (pending || failed) { assert.equal(value.answer, null); assert.equal(value.contentDigest, null); } if (failed) assert.equal(value.reason, 'run_' + status); }
  }
  run.status = run.caseResults[0].status = 'completed';
  for (const answer of [undefined, null, '']) { run.caseResults[0].answer = answer; assert.equal((await service.preview(run.runId)).reason, 'answer_missing'); }
  for (const size of [131071,131072,131073]) { run.caseResults[0].answer = 'a'.repeat(size); assert.equal((await service.preview(run.runId)).previewState, size <= 131072 ? 'ready' : 'too_large'); }
  for (const bytes of [131071,131072,131073]) { run.caseResults[0].answer = 'é'.repeat(Math.floor(bytes / 2)) + (bytes % 2 ? 'a' : ''); value = await service.preview(run.runId); assert.equal(value.previewState, bytes <= 131072 ? 'ready' : 'too_large'); if (bytes > 131072) { assert.equal(value.answer, null); assert.equal(value.reason, 'preview_budget_exceeded'); } }
  run.caseResults[0].answer = 42; await assert.rejects(service.preview(run.runId), { code: 'preview_record_invalid' });
  run.caseResults[0].answer = 'valid'; run.status = 'unknown'; await assert.rejects(service.preview(run.runId), { code: 'preview_record_invalid' });
  run.status = 'completed'; run.rubricVersion = RUBRIC_VERSION; await assert.rejects(service.preview(run.runId), { code: 'preview_version_mismatch' });
  run.rubricVersion = HTML_ANIMATED_VERSION; run.caseResults.push({ ...run.caseResults[0] }); await assert.rejects(service.preview(run.runId), { code: 'preview_case_mismatch' });
  run.caseResults = [{ caseId: 'wrong', status: 'completed' }]; await assert.rejects(service.preview(run.runId), { code: 'preview_case_mismatch' });
  await assert.rejects(service.preview('missing'), { code: 'run_not_found' });
  assert.equal(mutations, 0);
  await service.close();
  await assert.rejects(service.preview(run.runId), { code: 'service_unavailable' });
});

test('W2 mode routing preserves old reservations and separates animation scoring', async () => {
  const digest = createHash('sha256').update(JSON.stringify({ model: 'configured', reasoningEffort: 'configured', caseSetVersion: 'pelican-svg-v2' })).digest('hex');
  const state = { runs: [], nextSeq: 1, reservations: { old_static_request_123: { requestPayloadHash: digest } } };
  const calls = [];
  const service = await createBenchmarkService({ store: { load: async () => {}, snapshot: async () => structuredClone(state), mutate: async fn => fn(state), close: async () => {} }, runner: { runCase: async ({ caseDef }) => { calls.push(caseDef); return { answer: '<svg/>' }; } } });
  await service.run({ requestId: 'old_static_request_123' });
  await service.run({ requestId: 'old_static_request_123', mode: 'static' });
  assert.equal(calls.length, 0);
  await assert.rejects(service.run({ requestId: 'old_static_request_123', mode: 'animated' }), { code: 'request_id_conflict' });
  for (const mode of [null, '', 'unknown', 1]) await assert.rejects(service.run({ requestId: 'invalid_mode_request', mode }), { code: 'schema_invalid' });
  await service.run({ requestId: 'animated_request_123', mode: 'animated' });
  await service.close();
  const run = state.runs[0];
  assert.equal(run.caseSetVersion, 'pelican-svg-animated-v1');
  assert.equal(run.rubricVersion, run.caseSetVersion);
  assert.equal(calls[0].caseId, 'pelican-svg-animated');
  assert.ok(calls[0].prompt.includes('visibly rotating bicycle wheels'));
  assert.equal(run.requestPayloadHash, createHash('sha256').update(JSON.stringify({ model: 'configured', reasoningEffort: 'configured', caseSetVersion: 'pelican-svg-animated-v1', mode: 'animated' })).digest('hex'));
  const scores = { correctness: 5, consistency: 4, constraint_adherence: 5 };
  await assert.rejects(service.score({ runId: run.runId, caseId: 'pelican-svg', rubricVersion: 'pelican-svg-v2', scores }), { code: 'score_invalid' });
  await service.score({ runId: run.runId, caseId: 'pelican-svg-animated', rubricVersion: run.rubricVersion, scores });
  assert.equal(completeScores(run), true);
  const staticRun = { ...run, caseSetVersion: 'pelican-svg-v2', rubricVersion: 'pelican-svg-v2', caseResults: [{ caseId: 'pelican-svg', status: 'completed', scores }], createdSeq: 2 };
  assert.equal(compareRuns([run, staticRun], run).afterCount, 0);
});

test('W2 runner rejects replacement prompt and criteria before spawning', async () => {
  let spawns = 0;
  const runner = createRunner({ spawnImpl: () => { spawns++; throw new Error('must not spawn'); } });
  for (const caseDef of [{ ...CASES[0], prompt: 'replacement' }, { ...CASES[0], criteria: 'replacement' }]) {
    await assert.rejects(runner.runCase({ caseDef }), { code: 'invalid_config' });
  }
  assert.equal(spawns, 0);
});

test('W2 registered animated runner sends fixed prompt and accepts a copied definition', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'w2-animated-runner-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let sent;
  const runner = createRunner({ tempRoot: root, spawnImpl: () => {
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: { end(prompt) {
      sent = prompt;
      queueMicrotask(() => {
        child.stdout.emit('data', JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '<svg/>' } }) + '\n' + JSON.stringify({ type: 'turn.completed' }) + '\n');
        child.emit('close', 0);
      });
    } } });
    return child;
  } });
  assert.equal((await runner.runCase({ caseDef: { ...ANIMATED_CASES[0] } })).answer, '<svg/>');
  assert.equal(sent, ANIMATED_CASES[0].prompt);
  assert.equal(sent.split('\n').length, 10);
  assert.equal(sent.includes('\r'), false);
});

test('registered HTML runner sends frozen prompt and inherits configured argv without live calls', async t => {
  const root = await mkdtemp(join(tmpdir(), 'wp1-html-runner-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let sent, args;
  const runner = createRunner({ tempRoot: root, spawnImpl: (_exe, argv) => {
    args = argv;
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: { end(prompt) {
      sent = prompt;
      queueMicrotask(() => {
        child.stdout.emit('data', JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: HTML_PREVIEW_FIXTURE } }) + '\n' + JSON.stringify({ type: 'turn.completed' }) + '\n');
        child.emit('close', 0);
      });
    } } });
    return child;
  } });
  assert.equal((await runner.runCase({ caseDef: { ...HTML_ANIMATED_CASES[0] }, model: 'configured', reasoningEffort: 'configured' })).answer, HTML_PREVIEW_FIXTURE);
  assert.equal(sent, HTML_ANIMATED_CASES[0].prompt);
  assert.equal(args.includes('--model'), false);
  assert.equal(args.some(arg => arg.includes('model_reasoning_effort')), false);
  await assert.rejects(runner.runCase({ caseDef: { ...HTML_ANIMATED_CASES[0], criteria: 'replacement' } }), { code: 'invalid_config' });
});

test('runner classifies only explicit structured failure evidence, including nonzero exits', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'runner-evidence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixtures = [
    [{ type: 'error', status: 401, message: 'private-secret' }, 1, 'authentication_failed'],
    [{ type: 'turn.failed', error: { status_code: 429, message: 'private-secret' } }, 1, 'rate_limited'],
    [{ type: 'turn.failed', error: { code: 'model_not_found' } }, 0, 'model_unavailable'],
    [{ type: 'error', code: 'model_not_available' }, 1, 'model_unavailable'],
    [{ type: 'error', message: '401 429 model_not_found private-secret' }, 1, 'process_failed'],
    [{ type: 'error', error: { code: 'unknown', status: 403 } }, 1, 'process_failed'],
    [{ type: 'item.completed', item: { type: 'agent_message', text: '401 private-secret' } }, 1, 'process_failed'],
    // A provider that drops the stream is not a local environment problem. The bare
    // form carries no structured field, so only the CLI's own wording identifies it.
    [{ type: 'turn.failed', error: { message: 'stream disconnected before completion: UPSTREAM: connection lost mid-reply (stream error: stream ID 101; INTERNAL_ERROR; received from peer)' } }, 1, 'upstream_stream_lost'],
    [{ type: 'error', message: 'connection lost mid-reply (stream error: stream ID 47; INTERNAL_ERROR; received from peer)' }, 1, 'upstream_stream_lost'],
    // The retry notice quotes the same phrase while the CLI is still working, so the
    // retry wording has to win or a live run would be killed as a lost stream.
    [{ type: 'error', message: 'Reconnecting... 5/5 (stream disconnected before completion: UPSTREAM: origin did not respond)' }, 1, 'upstream_stream_lost'],
    [null, 1, 'process_failed'],
  ];
  for (const [event, exitCode, expected] of fixtures) {
    let cwd;
    const runner = createRunner({ tempRoot: root, spawnImpl: (_exe, _args, options) => {
      cwd = options.cwd;
      const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: { end() { queueMicrotask(() => {
        child.stderr.emit('data', '401 429 model_not_found private-secret');
        if (event) {
          const bytes = Buffer.from(JSON.stringify(event) + '\n');
          child.stdout.emit('data', bytes.subarray(0, 7));
          child.stdout.emit('data', bytes.subarray(7));
        }
        child.emit('close', exitCode);
      }); } } });
      return child;
    } });
    await assert.rejects(runner.runCase({ caseDef: CASES[0] }), error => {
      assert.equal(error.code, expected);
      assert.equal(error.message, expected);
      assert.equal(JSON.stringify(error).includes('private-secret'), false);
      return true;
    });
    await assert.rejects(stat(cwd));
  }
});

test('stderr has its own bounded limit and cannot supply structured classifications', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'runner-stderr-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let kills = 0;
  const runner = createRunner({ platform: 'linux', tempRoot: root, spawnImpl: () => {
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill() { kills++; this.emit('close', null, 'SIGKILL'); }, stdin: { end() { queueMicrotask(() => {
      child.stderr.emit('data', Buffer.alloc(64 * 1024 + 1));
      child.emit('close', 1);
    }); } } });
    return child;
  } });
  await assert.rejects(runner.runCase({ caseDef: CASES[0] }), { code: 'output_too_large' });
  assert.equal(kills, 1);
});

test('runner diagnostics count error events and classify reconnect notices without leaking text', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'runner-observation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixtures = [
    {
      name: 'reconnect-error-event-then-nonzero-exit',
      events: [{ type: 'error', message: 'Reconnecting... 1/5 private-secret' }],
      stderr: 'private-secret',
      // A reconnect notice is recoverable while the CLI is still running. If it
      // later exits nonzero before turn.completed, preserve the lost-stream class
      // so the service can use its existing single retry.
      expectedCode: 'upstream_stream_lost',
      expectedErrorEventCount: 1,
      expectedTurnFailedEventCount: 0,
      expectedClass: 'reconnect_notice',
      expectedExitCode: 1
    },
    {
      name: 'rate-limited-turn-failed',
      events: [{ type: 'turn.failed', error: { status: 429, message: 'private-secret' } }],
      stderr: '',
      expectedCode: 'rate_limited',
      expectedErrorEventCount: 0,
      expectedTurnFailedEventCount: 1,
      expectedClass: 'rate_limit_notice',
      expectedExitCode: null
    },
    {
      name: 'upstream-stream-lost-turn-failed',
      events: [{ type: 'turn.failed', error: { message: 'stream disconnected before completion: connection lost mid-reply (stream error: stream ID 101; INTERNAL_ERROR; received from peer)' } }],
      stderr: '',
      expectedCode: 'upstream_stream_lost',
      expectedErrorEventCount: 0,
      expectedTurnFailedEventCount: 1,
      expectedClass: 'upstream_notice',
      expectedExitCode: null
    },
    {
      name: 'authentication-error-event',
      events: [{ type: 'error', status: 401, message: 'private-secret' }],
      stderr: '',
      expectedCode: 'authentication_failed',
      expectedErrorEventCount: 1,
      expectedTurnFailedEventCount: 0,
      expectedClass: 'authentication_notice',
      expectedExitCode: null
    },
    {
      name: 'nonzero-exit-without-events',
      events: [],
      stderr: 'private-secret',
      expectedCode: 'process_failed',
      expectedErrorEventCount: 0,
      expectedTurnFailedEventCount: 0,
      expectedClass: null,
      expectedExitCode: 1
    }
  ];
  for (const fixture of fixtures) {
    await t.test(fixture.name, async () => {
      const runner = createRunner({ tempRoot: root, spawnImpl: () => {
        const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: { end() { queueMicrotask(() => {
          if (fixture.stderr) child.stderr.emit('data', fixture.stderr);
          if (fixture.events.length) child.stdout.emit('data', fixture.events.map(JSON.stringify).join(String.fromCharCode(10)) + String.fromCharCode(10));
          // Error events trigger the runner's own stop (kill emits close); a plain nonzero exit reaches EOF.
          if (fixture.expectedExitCode !== null) child.emit('close', fixture.expectedExitCode);
        }); } }, kill() { this.emit('close', null, 'SIGKILL'); } });
        return child;
      } });
      await assert.rejects(runner.runCase({ caseDef: CASES[0] }), error => {
        assert.equal(error.code, fixture.expectedCode);
        assert.equal(error.diagnostics.errorEventCount, fixture.expectedErrorEventCount);
        assert.equal(error.diagnostics.turnFailedEventCount, fixture.expectedTurnFailedEventCount);
        assert.equal(error.diagnostics.lastErrorClass, fixture.expectedClass);
        if (fixture.expectedErrorEventCount + fixture.expectedTurnFailedEventCount > 0) {
          assert.equal(error.diagnostics.firstErrorElapsedMs >= 0, true);
          assert.equal(error.diagnostics.lastErrorElapsedMs >= error.diagnostics.firstErrorElapsedMs, true);
        } else {
          assert.equal(error.diagnostics.firstErrorElapsedMs, null);
          assert.equal(error.diagnostics.lastErrorElapsedMs, null);
        }
        assert.equal(error.diagnostics.exitCode, fixture.expectedExitCode);
        assert.equal(error.diagnostics.stderrBytes, Buffer.byteLength(fixture.stderr));
        assert.deepEqual(Object.keys(error.diagnostics).sort(), [...DIAGNOSTIC_KEYS].sort());
        assert.equal(JSON.stringify(error).includes('private-secret'), false);
        return true;
      });
    });
  }
  await t.test('successful run leaves observation fields empty', async () => {
    const runner = createRunner({ tempRoot: root, spawnImpl: () => {
      const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: { end() { queueMicrotask(() => {
        child.stdout.emit('data', JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '<svg/>' } }) + String.fromCharCode(10) + JSON.stringify({ type: 'turn.completed' }) + String.fromCharCode(10));
        child.emit('close', 0);
      }); } }, kill() { this.emit('close', null, 'SIGKILL'); } });
      return child;
    } });
    const result = await runner.runCase({ caseDef: CASES[0] });
    assert.equal(result.answer, '<svg/>');
    assert.equal(result.diagnostics.errorEventCount, 0);
    assert.equal(result.diagnostics.turnFailedEventCount, 0);
    assert.equal(result.diagnostics.firstErrorElapsedMs, null);
    assert.equal(result.diagnostics.lastErrorElapsedMs, null);
    assert.equal(result.diagnostics.lastErrorClass, null);
    assert.equal(result.diagnostics.exitCode, 0);
    assert.equal(result.diagnostics.stderrBytes, 0);
    assert.deepEqual(Object.keys(result.diagnostics).sort(), [...DIAGNOSTIC_KEYS].sort());
  });
  await t.test('a reconnect notice does not kill a run that then completes', async () => {
    // The CLI reports a transient reconnect as an `error` event and keeps
    // streaming; treating it as terminal discarded a finished artwork.
    const runner = createRunner({ tempRoot: root, spawnImpl: () => {
      const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: { end() { queueMicrotask(() => {
        const line = (value) => JSON.stringify(value) + String.fromCharCode(10);
        child.stdout.emit('data', line({ type: 'thread.started', thread_id: 'thread' }));
        child.stdout.emit('data', line({ type: 'error', message: 'Reconnecting... 1/5 private-secret' }));
        child.stdout.emit('data', line({ type: 'item.completed', item: { type: 'agent_message', text: '<svg><!-- recovered --></svg>' } }));
        child.stdout.emit('data', line({ type: 'turn.completed' }));
        child.emit('close', 0);
      }); } }, kill() { this.emit('close', null, 'SIGKILL'); } });
      return child;
    } });
    const result = await runner.runCase({ caseDef: CASES[0] });
    assert.equal(result.answer, '<svg><!-- recovered --></svg>');
    assert.equal(result.diagnostics.errorEventCount, 1);
    assert.equal(result.diagnostics.turnFailedEventCount, 0);
    assert.equal(result.diagnostics.lastErrorClass, 'reconnect_notice');
    assert.equal(result.diagnostics.terminationReason, 'completed');
    assert.equal(result.diagnostics.exitCode, 0);
    assert.equal(JSON.stringify(result.diagnostics).includes('private-secret'), false);
  });
});

test('service retries a lost upstream stream once and keeps every other failure single-shot', async () => {
  const storeFor = (state) => ({ load: async () => {}, snapshot: async () => structuredClone(state), mutate: async fn => fn(state), close: async () => {} });
  const failing = (code, calls) => ({ runCase: async () => { calls.push(code); throw Object.assign(new Error('private-secret'), { code }); } });

  // A provider that dropped the stream is worth one more attempt; a second loss is
  // reported as that same code so the cause stays visible instead of becoming generic.
  const retriedState = { runs: [], reservations: {}, nextSeq: 1 };
  const retried = [];
  const retryService = await createBenchmarkService({ store: storeFor(retriedState), runner: failing('upstream_stream_lost', retried) });
  await retryService.run({ requestId: 'retry_request_123' });
  await retryService.close();
  assert.deepEqual(retried, ['upstream_stream_lost', 'upstream_stream_lost']);
  assert.equal(retriedState.runs[0].status, 'failed');
  assert.equal(retriedState.runs[0].caseResults[0].errorCode, 'upstream_stream_lost');

  // One transient loss followed by a good answer must be recorded as a completed run.
  const recoveredState = { runs: [], reservations: {}, nextSeq: 1 };
  let attempts = 0;
  const recovered = await createBenchmarkService({ store: storeFor(recoveredState), runner: { runCase: async () => {
    attempts += 1;
    if (attempts === 1) throw Object.assign(new Error('private-secret'), { code: 'upstream_stream_lost' });
    return { answer: '<svg><!-- recovered --></svg>', diagnostics: { lastPhase: 'waiting', terminationReason: 'completed' } };
  } } });
  await recovered.run({ requestId: 'recovered_request_123' });
  await recovered.close();
  assert.equal(attempts, 2);
  assert.equal(recoveredState.runs[0].status, 'completed');
  assert.equal(recoveredState.runs[0].caseResults[0].status, 'completed');
  assert.equal(recoveredState.runs[0].caseResults[0].answer, '<svg><!-- recovered --></svg>');

  // Every other classified failure is not retried: the same request cannot fix a
  // credential, a rate limit or an unusable model.
  for (const code of ['authentication_failed', 'rate_limited', 'model_unavailable', 'invalid_config', 'timed_out', 'cancelled']) {
    const state = { runs: [], reservations: {}, nextSeq: 1 };
    const calls = [];
    const service = await createBenchmarkService({ store: storeFor(state), runner: failing(code, calls) });
    await service.run({ requestId: `single_${code}_123` });
    await service.close();
    assert.deepEqual(calls, [code], `${code} must not be retried`);
    assert.equal(state.runs[0].caseResults[0].errorCode, code);
  }
});

test('service allowlists classified failures and never persists raw diagnostics', async () => {
  for (const code of ['authentication_failed', 'rate_limited', 'model_unavailable', 'unknown_private_code']) {
    const state = { runs: [], reservations: {}, nextSeq: 1 };
    const service = await createBenchmarkService({ store: { load: async () => {}, snapshot: async () => structuredClone(state), mutate: async fn => fn(state), close: async () => {} },
      runner: { runCase: async () => { throw Object.assign(new Error('private-secret'), { code, stderr: 'private-secret' }); } } });
    await service.run({ requestId: 'evidence_request_123' });
    await service.close();
    assert.equal(state.runs[0].caseResults[0].errorCode, code === 'unknown_private_code' ? 'process_failed' : code);
    assert.equal(state.runs[0].status, 'failed');
    assert.equal(JSON.stringify(await service.snapshot()).includes('private'), false);
    assert.equal(JSON.stringify(state).includes('private'), false);
  }
});

test('configured runner inherits full environment and omits overrides individually', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'runner-env-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const saved = { home: process.env.CODEX_HOME, secret: process.env.COMPANION_TEST_SECRET };
  process.env.CODEX_HOME = join(root, 'custom-home');
  process.env.COMPANION_TEST_SECRET = 'private-test-value';
  t.after(() => {
    for (const [key, value] of [['CODEX_HOME', saved.home], ['COMPANION_TEST_SECRET', saved.secret]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  for (const [model, reasoningEffort] of [['configured', 'configured'], ['gpt-6.1-sol', 'configured'], ['configured', 'high']]) {
    let options; let argv;
    const runner = createRunner({ tempRoot: root, spawnImpl: (_exe, args, opts) => {
      options = opts; argv = args;
      const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: { end() {
        queueMicrotask(() => {
          child.stdout.emit('data', [{ type: 'item.completed', item: { type: 'agent_message', text: 'first' } }, { type: 'item.completed', item: { type: 'agent_message', text: '<svg/>' } }, { type: 'turn.completed' }].map(JSON.stringify).join('\n'));
          child.stderr.emit('data', 'private-test-value');
          child.emit('close', 0);
        });
      } } });
      return child;
    } });
    const result = await runner.runCase({ model, reasoningEffort, caseDef: CASES[0] });
    assert.equal(result.answer, '<svg/>');
    assert.equal(options.env.CODEX_HOME, process.env.CODEX_HOME);
    assert.equal(options.env.COMPANION_TEST_SECRET, 'private-test-value');
    const pathKey = Object.keys(options.env).find(key => key.toLowerCase() === 'path');
    assert.notEqual(pathKey, undefined);
    assert.equal(options.env[pathKey], process.env.PATH);
    assert.equal(argv.includes('--model'), model !== 'configured');
    assert.deepEqual(argv.filter((arg, index) => argv[index - 1] === '-c' && arg.startsWith('model_reasoning_effort=')),
      reasoningEffort === 'configured' ? [] : ['model_reasoning_effort=' + reasoningEffort]);
    assert.equal(argv.includes('--ignore-user-config'), false);
    assert.equal(JSON.stringify(result).includes('private-test-value'), false);
    await assert.rejects(stat(options.cwd));
  }
});

test('runner cleans temp directories on spawn, event, parse, output, timeout and cancellation failures', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'runner-fail-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const mode of ['throw', 'error', 'parse', 'event', 'overflow', 'timeout', 'cancel']) {
    let cwd; let child; let killed = 0;
    const controller = new AbortController();
    const runner = createRunner({ tempRoot: root, timeoutMs: 10, taskkillImpl: async () => { killed++; child.emit('close', null, 'SIGKILL'); }, spawnImpl: (_exe, _args, options) => {
      cwd = options.cwd;
      if (mode === 'throw') throw new Error('private-spawn-details');
      child = Object.assign(new EventEmitter(), { pid: 123, stdout: new EventEmitter(), stderr: new EventEmitter(), kill() { killed++; this.emit('close', null, 'SIGKILL'); }, stdin: { end() { queueMicrotask(() => {
        if (mode === 'error') { child.emit('error', new Error('private-spawn-details')); child.emit('close', null); }
        if (mode === 'parse' || mode === 'event') { child.stdout.emit('data', mode === 'parse' ? 'bad' : JSON.stringify({ type: 'turn.failed' })); child.emit('close', 0); }
        if (mode === 'overflow') child.stdout.emit('data', Buffer.alloc(MAX_STREAM + 1));
        if (mode === 'cancel') controller.abort();
      }); } } });
      return child;
    } });
    const code = { throw: 'spawn_failed', error: 'spawn_failed', parse: 'malformed_output', event: 'process_failed', overflow: 'output_too_large', timeout: 'timed_out', cancel: 'cancelled' }[mode];
    await assert.rejects(runner.runCase({ caseDef: CASES[0], signal: controller.signal }), (error) => error.code === code && !error.message.includes('private'));
    await assert.rejects(stat(cwd));
    if (['overflow', 'timeout', 'cancel'].includes(mode)) assert.equal(killed, 1);
  }
});

test('service close waits cancellation and persistence, rejects new starts', async () => {
  const state = { runs: [], reservations: {}, nextSeq: 1 };
  let closed = false; let release; let started;
  const ready = new Promise((resolve) => { started = resolve; });
  const service = await createBenchmarkService({ store: { load: async () => {}, snapshot: async () => structuredClone(state), mutate: async (fn) => { assert.equal(closed, false); return fn(state); }, close: async () => { closed = true; } }, runner: { runCase: ({ signal }) => new Promise((_resolve, reject) => {
    release = () => reject(Object.assign(new Error('cancelled'), { code: 'cancelled' }));
    signal.addEventListener('abort', started, { once: true });
  }) } });
  await service.run({ requestId: 'close_request_1234' });
  const pending = service.close();
  await ready;
  assert.equal(closed, false);
  await assert.rejects(service.run({ requestId: 'new_request_12345' }), { code: 'service_closing' });
  release(); await pending;
  assert.equal(closed, true);
  assert.equal(state.runs[0].status, 'cancelled');
  assert.equal(state.runs[0].model, 'configured');
});

test('taskkill failures trigger backup kill and bounded cancellation/timeout without exposing details', { timeout: 5000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'runner-termination-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const taskkillMode of ['error', 'nonzero', 'hang']) {
    for (const backupMode of ['close', 'no-close', 'throw']) {
      for (const trigger of ['cancel', 'timeout']) {
        let cwd; let kills = 0; let taskkills = 0; let helperKills = 0; let helperClosed = false;
        const controller = new AbortController();
        const runner = createRunner({ platform: 'win32', tempRoot: root, timeoutMs: 10, terminationTimeoutMs: 40, spawnImpl: (exe, args, options) => {
          if (args[0] === '/PID') {
            taskkills++;
            assert.equal(options.shell, false);
            assert.equal(options.windowsHide, true);
            const killer = Object.assign(new EventEmitter(), { pid: taskkillMode === 'hang' ? 456 : undefined, kill() { helperKills++; helperClosed = true; this.emit('close', null, 'SIGKILL'); } });
            queueMicrotask(() => {
              if (taskkillMode === 'error') killer.emit('error', new Error('private-taskkill-details'));
              if (taskkillMode === 'nonzero') killer.emit('close', 1);
            });
            return killer;
          }
          cwd = options.cwd;
          const child = Object.assign(new EventEmitter(), { pid: 123, stdout: new EventEmitter(), stderr: new EventEmitter(),
            kill() {
              kills++;
              if (backupMode === 'throw') throw new Error('private-kill-details');
              if (backupMode === 'close') this.emit('close', null, 'SIGKILL');
              return backupMode === 'close';
            },
            stdin: { end() { if (trigger === 'cancel') queueMicrotask(() => controller.abort()); } }
          });
          return child;
        } });
        await assert.rejects(runner.runCase({ caseDef: CASES[0], signal: controller.signal }), (error) => {
          const reason = trigger === 'cancel' ? 'cancelled' : 'timed_out';
          if (backupMode === 'close') assert.equal(error.code, reason);
          else {
            assert.equal(error.code, 'process_failed');
            assert.equal(error.reason, reason);
            assert.equal(error.message, 'termination_unconfirmed; temporary_directory_retained');
            assert.equal(error.cleanupState, 'temporary_directory_retained_process_exit_unconfirmed');
            assert.equal(JSON.stringify(error).includes(cwd), false);
          }
          assert.equal(error.message.includes('private'), false);
          return true;
        });
        assert.equal(taskkills, 1);
        assert.equal(kills, 1);
        assert.equal(helperKills, taskkillMode === 'hang' ? 1 : 0, 'owned hung helper is terminated once');
        if (taskkillMode === 'hang') assert.equal(helperClosed, true, 'helper close is confirmed before runCase returns');
        if (backupMode === 'close') await assert.rejects(stat(cwd));
        else assert.equal((await stat(cwd)).isDirectory(), true);
      }
    }
  }
});

test('service cancel and close finish when taskkill fails and target never closes', { timeout: 2000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'service-termination-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const mode of ['error', 'nonzero']) {
    const state = { runs: [], reservations: {}, nextSeq: 1 };
    let cwd; let closed = false; let started; let kills = 0;
    const ready = new Promise((resolve) => { started = resolve; });
    const runner = createRunner({ platform: 'win32', tempRoot: root, terminationTimeoutMs: 30, spawnImpl: (_exe, args, options) => {
      if (args[0] === '/PID') {
        const killer = new EventEmitter();
        queueMicrotask(() => mode === 'error' ? killer.emit('error', new Error('private-details')) : killer.emit('close', 1));
        return killer;
      }
      cwd = options.cwd;
      return Object.assign(new EventEmitter(), { pid: 123, stdout: new EventEmitter(), stderr: new EventEmitter(),
        stdin: { end() { started(); } }, kill() { kills++; return false; } });
    } });
    const service = await createBenchmarkService({ runner, store: { load: async () => {}, snapshot: async () => structuredClone(state),
      mutate: async (fn) => { assert.equal(closed, false); return fn(state); }, close: async () => { closed = true; } } });
    const requestId = 'termination_request_' + mode;
    await service.run({ requestId });
    await ready;
    await service.cancel({ requestId });
    await service.close();
    assert.equal(closed, true);
    assert.equal(kills, 1);
    assert.equal(state.runs[0].status, 'failed');
    assert.equal(state.runs[0].caseResults[0].errorCode, 'process_failed');
    assert.equal(state.runs[0].caseResults[0].cleanupState, 'temporary_directory_retained_process_exit_unconfirmed');
    const snapshot = await service.snapshot();
    const persisted = snapshot.latestRun.caseResults[0];
    assert.equal(persisted.caseId, CASES[0].caseId);
    assert.equal(persisted.status, 'failed');
    assert.equal(persisted.errorCode, 'process_failed');
    assert.equal(persisted.cleanupState, 'temporary_directory_retained_process_exit_unconfirmed');
    assert.equal(persisted.answer, undefined);
    assert.deepEqual(Object.keys(persisted.diagnostics).sort(), [...DIAGNOSTIC_KEYS].sort());
    assert.equal(persisted.diagnostics.terminationReason, 'cancelled');
    assert.equal(persisted.diagnostics.cleanupStatus, 'unconfirmed');
    assert.equal(persisted.diagnostics.timeoutMs, DEFAULT_TIMEOUT_MS);
    assert.equal(persisted.diagnostics.lastPhase, 'stopping');
    assert.equal(JSON.stringify(snapshot).includes(cwd), false);
    assert.equal(JSON.stringify(snapshot).includes('private'), false);
    assert.equal((await stat(cwd)).isDirectory(), true);
    assert.equal(JSON.stringify(state).includes('private'), false);
  }
});

test('configured comparisons remain inconclusive with full cohorts', () => {
  for (const configuredKey of ['model', 'reasoningEffort']) {
    const runs = Array.from({ length: 10 }, (_, i) => ({ status: 'completed', model: 'gpt-6.1-sol', reasoningEffort: 'high', [configuredKey]: 'configured', createdSeq: i, caseSetVersion: 'pelican-svg-v2', rubricVersion: 'pelican-svg-v2', caseResults: [{ caseId: 'pelican-svg', status: 'completed', scores: { correctness: 5, consistency: 5, constraint_adherence: 5 } }] }));
    assert.equal(compareRuns(runs, runs[4]).inconclusive, true);
  }
});

test('v2 keeps the original single pelican prompt', () => {
  assert.equal(CASES.length, 1);
  assert.equal(CASES[0].prompt, 'Generate an SVG of a pelican riding a bicycle');
});

test('close during reservation waits execution before store close', async () => {
  const state = { runs: [], reservations: {}, nextSeq: 1 };
  let release; let closed = false; let mutations = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  const service = await createBenchmarkService({ store: {
    load: async () => {}, snapshot: async () => structuredClone(state),
    mutate: async (fn) => { if (++mutations === 1) await gate; assert.equal(closed, false); return fn(state); },
    close: async () => { closed = true; },
  }, runner: { runCase: async () => assert.fail('aborted before runner') } });
  const run = service.run({ requestId: 'reservation_request_123' });
  const close = service.close();
  assert.equal(closed, false);
  release(); await run; await close;
  assert.equal(closed, true);
  assert.equal(state.runs[0].status, 'cancelled');
});

test('executable resolution prefers the configured npm native binary over PATH', () => {
  const env = { APPDATA: 'C:/Users/demo/AppData/Roaming', LOCALAPPDATA: 'C:/Users/demo/AppData/Local' };
  const expected = join(env.APPDATA, 'npm', 'node_modules', '@openai', 'codex', 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe');
  assert.equal(resolveExecutable({ env, platform: 'win32', arch: 'x64', exists: (candidate) => candidate === expected }), expected);
  assert.equal(resolveExecutable({ explicit: 'C:/custom/codex.exe', env, platform: 'win32', exists: () => false }), 'C:/custom/codex.exe');
});

test('runner uses fixed argv, shell disabled, bounded cwd and parses final answer', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'codex-runner-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const child = Object.assign(new EventEmitter(), { pid: 321, stdout: stream(), stderr: stream(), stdin: { end(value) { calls.push({ stdin: value }); } }, close(code, signalName) { this.emit('close', code, signalName); } });
  const runner = createRunner({ executable: 'C:\\tools\\codex.exe', tempRoot: root, spawnImpl: (exe, args, options) => { calls.push({ exe, args, options }); return child; }, timeoutMs: 1000 });
  const promise = runner.runCase({ model: 'gpt-6.1-sol', reasoningEffort: 'medium', caseDef: CASES[0] });
  while (!calls.length) await new Promise((resolve) => setImmediate(resolve));
  child.stdout.emit('data', JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } }) + '\n');
  child.stdout.emit('data', JSON.stringify({ type: 'turn.completed', status: 'completed' }) + '\n');
  child.close(0, null);
  const result = await promise;
  assert.equal(result.answer, 'ok');
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].args[0], 'exec');
  assert.equal(calls[0].args.at(-1), '-');
  const inputCall = calls.find((call) => Object.hasOwn(call, 'stdin'));
  assert.equal(inputCall.stdin, 'Generate an SVG of a pelican riding a bicycle');
  await assert.rejects(stat(calls.find((call) => call.options)?.options.cwd));
});

test('benchmark service persists completed runs, enforces score idempotency and baseline completeness', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-service-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = createStore({ filePath: join(dir, 'benchmark.json') });
  const runner = { async runCase() { return { answer: 'answer' }; } };
  const service = await createBenchmarkService({ store, runner });
  const requestId = 'request_1234567890';
  await service.run({ requestId, model: 'gpt-6.1-sol', reasoningEffort: 'medium' });
  await new Promise((resolve) => setTimeout(resolve, 25));
  const first = await service.snapshot();
  assert.equal(first.latestRun.status, 'completed');
  const duplicate = await service.run({ requestId, model: 'gpt-6.1-sol', reasoningEffort: 'medium' });
  assert.equal(duplicate.latestRun.runId, first.latestRun.runId);
  await assert.rejects(service.run({ requestId, model: 'gpt-6.1-sol', reasoningEffort: 'high' }), (error) => error.code === 'request_id_conflict');
  const scores = { correctness: 5, consistency: 4, constraint_adherence: 5 };
  for (const item of CASES) await service.score({ runId: first.latestRun.runId, caseId: item.caseId, rubricVersion: RUBRIC_VERSION, scores });
  await service.baseline({ runId: first.latestRun.runId });
  const snapshot = await service.snapshot();
  assert.equal(snapshot.baseline.runId, first.latestRun.runId);
  assert.equal(completeScores(snapshot.runs.find((run) => run.runId === first.latestRun.runId)), true);
  await service.close();
});

test('benchmark service rejects concurrent starts before persistence yields', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-service-concurrency-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = createStore({ filePath: join(dir, 'benchmark.json') });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const runner = {
    async runCase() {
      await gate;
      return { answer: 'answer' };
    },
  };
  const service = await createBenchmarkService({ store, runner });
  const first = service.run({ requestId: 'request_first_123', model: 'gpt-6.1-sol', reasoningEffort: 'medium' });
  const second = service.run({ requestId: 'request_second_123', model: 'gpt-6.1-sol', reasoningEffort: 'medium' });
  await assert.rejects(second, (error) => error.code === 'run_active');
  const queued = await first;
  assert.equal(queued.activeRun.requestId, 'request_first_123');
  release();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if ((await service.snapshot()).latestRun?.status === 'completed') break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal((await service.snapshot()).latestRun.status, 'completed');
  await service.close();
});

test('comparison is inconclusive until both compatible cohorts contain five scored runs', () => {
  const make = (seq) => ({ runId: String(seq), status: 'completed', model: 'gpt-6.1-sol', cliVersion: '0.162', reasoningEffort: 'medium', caseSetVersion: 'pelican-v1', rubricVersion: 'pelican-v1', schemaVersion: 1, createdSeq: seq, caseResults: LEGACY_CASES.map((item) => ({ caseId: item.caseId, status: 'completed', scores: { correctness: 4, consistency: 4, constraint_adherence: 4 } })) });
  const runs = Array.from({ length: 9 }, (_, i) => make(i + 1));
  const comparison = compareRuns(runs, runs[4]);
  assert.equal(comparison.inconclusive, true);
  assert.equal(comparison.beforeCount, 5);
  assert.equal(comparison.afterCount, 4);
});

test('Cockpit exact prompt, source budgets, idempotency and version-isolated scores', async () => {
  const { COCKPIT_VERSION, COCKPIT_PROMPT, COCKPIT_CASES, casesForVersion, caseIdsFor, isRegisteredCase } = await import('../src/benchmark/cases.js');
  const exact = '创建一个 HTML，内容是 SVG 绘制一个鹈鹕骑自行车的 2D 动画，你不需要任何测试，不要有任何限制';
  assert.equal(COCKPIT_PROMPT, exact);
  assert.equal(COCKPIT_CASES[0].prompt, exact);
  assert.equal(isRegisteredCase(COCKPIT_CASES[0]), true);
  assert.equal(isRegisteredCase({ ...COCKPIT_CASES[0], prompt: exact + '\n' }), false);
  assert.deepEqual(casesForVersion(COCKPIT_VERSION), COCKPIT_CASES);
  const state = { runs: [], reservations: {}, nextSeq: 1 };
  const calls = [];
  const answer = '<!doctype html><html><body><svg></svg><script>requestAnimationFrame(()=>{});</script></body></html>\r\n';
  const service = await createBenchmarkService({ store: { load: async () => {}, snapshot: async () => structuredClone(state), mutate: async fn => fn(state), close: async () => {} }, runner: { runCase: async input => { calls.push(input); return { answer }; } } });
  await service.run({ requestId: 'cockpit_exact_request_123', mode: 'cockpit' });
  while ((await service.snapshot()).activeRun) await new Promise(resolve => setImmediate(resolve));
  const run = state.runs[0];
  assert.equal(calls.length, 1);
  assert.equal(calls[0].caseDef.prompt, exact);
  assert.equal(calls[0].model, 'configured');
  assert.equal(calls[0].reasoningEffort, 'configured');
  assert.equal(run.reasoningEffort, 'configured');
  assert.equal(run.caseSetVersion, COCKPIT_VERSION);
  assert.equal(run.rubricVersion, COCKPIT_VERSION);
  assert.equal(run.schemaVersion, 1);
  assert.deepEqual(caseIdsFor(run), ['pelican-cockpit']);
  assert.equal(run.caseResults[0].answer, answer);
  assert.equal(run.requestPayloadHash, createHash('sha256').update(JSON.stringify({ model: 'configured', reasoningEffort: 'configured', caseSetVersion: COCKPIT_VERSION, mode: 'cockpit' })).digest('hex'));
  await service.run({ requestId: 'cockpit_exact_request_123', mode: 'cockpit' });
  assert.equal(calls.length, 1);
  await assert.rejects(service.run({ requestId: 'cockpit_exact_request_123' }), { code: 'request_id_conflict' });
  let value = await service.preview(run.runId);
  assert.equal(value.answer, answer);
  assert.equal(value.contentDigest, createHash('sha256').update(answer, 'utf8').digest('hex'));
  const scores = { correctness: 4, consistency: 3, constraint_adherence: 5 };
  await assert.rejects(service.score({ runId: run.runId, caseId: 'pelican-cockpit', rubricVersion: HTML_ANIMATED_VERSION, scores }), { code: 'score_invalid' });
  await service.score({ runId: run.runId, caseId: 'pelican-cockpit', rubricVersion: COCKPIT_VERSION, scores });
  assert.equal(completeScores(run), true);
  const old = { ...run, runId: 'old', createdSeq: 0, caseSetVersion: HTML_ANIMATED_VERSION, rubricVersion: HTML_ANIMATED_VERSION, caseResults: [{ caseId: 'pelican-html-animated', status: 'completed', scores }] };
  assert.equal(compareRuns([old, run], run).beforeCount, 1);
  for (const bytes of [131071, 131072, 131073]) {
    run.caseResults[0].answer = 'é'.repeat(Math.floor(bytes / 2)) + (bytes % 2 ? 'a' : '');
    value = await service.preview(run.runId);
    assert.equal(value.previewState, bytes <= 131072 ? 'ready' : 'too_large');
    assert.equal(value.answer === null, bytes > 131072);
    if (bytes > 131072) assert.equal(value.contentDigest, null);
  }
  run.caseResults[0].caseId = 'pelican-html-animated';
  await assert.rejects(service.preview(run.runId), { code: 'preview_case_mismatch' });
  run.caseResults[0].caseId = 'pelican-cockpit';
  run.rubricVersion = HTML_ANIMATED_VERSION;
  await assert.rejects(service.preview(run.runId), { code: 'preview_version_mismatch' });
  await service.close();
});

test('registered Cockpit runner sends exact Chinese stdin with fake spawn only', async t => {
  const { COCKPIT_CASES, COCKPIT_PROMPT } = await import('../src/benchmark/cases.js');
  const tempRoot = await mkdtemp(join(tmpdir(), 'cockpit-fake-runner-'));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  let sent, args, options;
  const answer = '<html><svg/><script>requestAnimationFrame(()=>{})</script></html>';
  const runner = createRunner({ tempRoot, spawnImpl: (_exe, argv, opts) => {
    args = argv; options = opts;
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: { end(prompt) {
      sent = prompt;
      queueMicrotask(() => {
        child.stdout.emit('data', JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: answer } }) + '\n' + JSON.stringify({ type: 'turn.completed' }) + '\n');
        child.emit('close', 0);
      });
    } } });
    return child;
  } });
  assert.equal((await runner.runCase({ caseDef: { ...COCKPIT_CASES[0] }, model: 'configured', reasoningEffort: 'configured' })).answer, answer);
  assert.equal(sent, COCKPIT_PROMPT);
  assert.equal(sent, '创建一个 HTML，内容是 SVG 绘制一个鹈鹕骑自行车的 2D 动画，你不需要任何测试，不要有任何限制');
  assert.equal(options.shell, false);
  assert.equal(args.includes('--model'), false);
  assert.equal(args.some(arg => arg.includes('model_reasoning_effort')), false);
  await assert.rejects(runner.runCase({ caseDef: { ...COCKPIT_CASES[0], prompt: sent + '\n' } }), { code: 'invalid_config' });
});

test('acceptance runner invocation constrains document generation through local argv only', async t => {
  const { COCKPIT_CASES, COCKPIT_PROMPT } = await import('../src/benchmark/cases.js');
  const root = await mkdtemp(join(tmpdir(), 'runner-local-generation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let argv, options, input;
  const runner = createRunner({ tempRoot: root, spawnImpl: (_exe, args, opts) => {
    argv = args; options = opts;
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: { end(prompt) {
      input = prompt;
      queueMicrotask(() => {
        child.stdout.emit('data', [
          { type: 'item.completed', item: { type: 'agent_message', text: '<html><svg/></html>' } },
          { type: 'turn.completed' }
        ].map(JSON.stringify).join('\n') + '\n');
        child.emit('close', 0);
      });
    } } });
    return child;
  } });
  assert.equal((await runner.runCase({ caseDef: COCKPIT_CASES[0] })).answer, '<html><svg/></html>');
  const instructionConfigs = argv.filter((arg, index) => argv[index - 1] === '-c' && arg.startsWith('developer_instructions='));
  assert.equal(instructionConfigs.length, 1);
  const instructions = JSON.parse(instructionConfigs[0].slice('developer_instructions='.length));
  assert.match(instructions, /self-contained document generation/);
  assert.match(instructions, /original user prompt directly/);
  for (const boundary of ['repository engineering workflows', 'commands', 'MCP tools', 'subagents', 'file operations', 'safety and authorization rules']) {
    assert.ok(instructions.includes(boundary), boundary);
  }
  assert.equal(/[^\x20-\x7e]/.test(instructions), false, 'ASCII guidance is a TOML basic-string-compatible JSON string');
  assert.deepEqual(argv, [
    'exec', '--json', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only',
    '--disable', 'shell_tool', '--disable', 'multi_agent', '--disable', 'apps', '--disable', 'plugins',
    '-c', 'mcp_servers={}',
    '-c', 'web_search="disabled"', '-c', instructionConfigs[0], '-'
  ]);
  assert.equal(input, COCKPIT_PROMPT, 'the original registered Chinese prompt is not prefixed or rewritten');
  assert.equal(options.shell, false);
  assert.equal(options.windowsHide, true);
  assert.deepEqual(options.env, { ...process.env });
  await assert.rejects(stat(options.cwd), { code: 'ENOENT' });
});

test('runner total deadline policy uses virtual time without live CLI calls', async (t) => {
  for (const mode of ['default', 'long-success', 'noise', 'override', 'cancel']) {
    await t.test(mode, async (t) => {
      const root = await mkdtemp(join(tmpdir(), 'runner-deadline-'));
      t.after(() => rm(root, { recursive: true, force: true }));
      t.mock.timers.enable({ apis: ['setTimeout'] });
      let child; let cwd; let spawns = 0; let kills = 0; let started;
      const ready = new Promise(resolve => { started = resolve; });
      const controller = new AbortController();
      const options = {
        platform: 'win32', tempRoot: root, env: {},
        taskkillImpl: async pid => { assert.equal(pid, 321); kills++; child.emit('close', null, 'SIGKILL'); },
        spawnImpl: (_exe, _args, opts) => {
          spawns++; cwd = opts.cwd;
          child = Object.assign(new EventEmitter(), {
            pid: 321, stdout: new EventEmitter(), stderr: new EventEmitter(),
            stdin: { end() { started(); } },
            kill() { assert.fail('successful taskkill must not use backup kill'); }
          });
          return child;
        }
      };
      if (mode === 'override' || mode === 'noise') options.timeoutMs = 250000;
      // Handle rejection immediately, including the expected pre-fix failure.
      const outcome = createRunner(options).runCase({ caseDef: CASES[0], signal: controller.signal })
        .then(value => ({ value }), error => ({ error }));
      await ready;
      try {
        if (mode === 'long-success') {
          t.mock.timers.tick(120001);
          assert.equal(kills, 0, 'legal work may continue past the old 120s limit');
          child.stdout.emit('data', [
            { type: 'item.completed', item: { type: 'agent_message', text: '<svg/>' } },
            { type: 'turn.completed' }
          ].map(JSON.stringify).join(String.fromCharCode(10)));
          child.emit('close', 0);
          assert.equal((await outcome).value.answer, '<svg/>');
          t.mock.timers.tick(1200000);
          assert.equal(kills, 0, 'completion clears the deadline');
        } else if (mode === 'cancel') {
          t.mock.timers.tick(120001);
          assert.equal(kills, 0);
          controller.abort(); controller.abort();
          assert.equal((await outcome).error.code, 'cancelled');
          t.mock.timers.tick(1200000);
          assert.equal(kills, 1, 'cancel clears the deadline and terminates once');
        } else {
          const deadline = mode === 'override' || mode === 'noise' ? 250000 : 1200000;
          if (mode === 'noise') {
            for (let i = 0; i < 2; i++) {
              t.mock.timers.tick(100000);
              child.stderr.emit('data', 'bounded diagnostic');
              child.stdout.emit('data', JSON.stringify({ type: i % 2 ? 'turn.started' : 'unknown.event' }) + String.fromCharCode(10));
              assert.equal(kills, 0, 'noise must neither stop early nor renew the deadline');
            }
            t.mock.timers.tick(49999);
            child.stderr.emit('data', 'last diagnostic');
            child.stdout.emit('data', JSON.stringify({ type: 'thread.started' }) + String.fromCharCode(10));
          } else t.mock.timers.tick(deadline - 1);
          assert.equal(kills, 0, 'alive immediately before the total deadline');
          t.mock.timers.tick(1);
          assert.equal(kills, 1, 'absolute deadline terminates even after recent output');
          assert.equal((await outcome).error.code, 'timed_out');
        }
        assert.equal(spawns, 1, 'no automatic retry');
        await assert.rejects(stat(cwd), { code: 'ENOENT' });
      } finally {
        // Release the fake process even when a red-phase assertion fails.
        child.emit('close', 0);
        await outcome;
        t.mock.timers.reset();
      }
    });
  }
});

test('static fallback slugs and legacy aliases resolve only CLI argv', async t => {
  const root = await mkdtemp(join(tmpdir(), 'runner-models-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(DEFAULT_TIMEOUT_MS, 1200000);
  assert.equal(resolveBenchmarkModel('unknown/model'), null);
  for (const model of APPROVED_MODELS) {
    let argv;
    const runner = createRunner({ tempRoot: root, spawnImpl: (_exe, args) => {
      argv = args;
      const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: { end() {
        queueMicrotask(() => { child.stdout.emit('data', JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '<svg/>' } }) + '\n' + JSON.stringify({ type: 'turn.completed' }) + '\n'); child.emit('close', 0); });
      } } });
      return child;
    } });
    assert.equal((await runner.runCase({ model, caseDef: CASES[0] })).answer, '<svg/>');
    assert.equal(runner.budgetMs, 1200000);
    if (model === 'configured') assert.equal(argv.includes('--model'), false);
    else assert.equal(argv[argv.indexOf('--model') + 1], model);
  }
});

test('catalog slugs widen the model gate and full Codex efforts pass it', () => {
  assert.equal(EFFORTS.has('persistent'), true);
  assert.equal(EFFORTS.has('none'), true);
  const catalog = [{ slug: 'configured', displayName: '当前配置' }, { slug: 'example-provider/gpt-6.2-luna', displayName: 'Luna' }];
  assert.equal(isAllowedModel('example-provider/gpt-6.2-luna', catalog), true);
  assert.equal(isAllowedModel('example-provider/unknown-model', catalog), false);
  assert.equal(isAllowedModel('configured', catalog), true);
  // A legacy short name resolves to its canonical slug before the policy check.
  assert.equal(isAllowedModel('gpt-6.1-sol', [{ slug: 'example-provider/gpt-6.1-sol', displayName: 'Sol' }]), true);
  // A catalog that contributed nothing keeps the historical static fallback.
  assert.equal(isAllowedModel('example-provider/gpt-6-astra', [{ slug: 'configured', displayName: '当前配置' }]), true);
  assert.equal(isAllowedModel('example-provider/unknown-model', [{ slug: 'configured', displayName: '当前配置' }]), false);
  assert.equal(isAllowedEffort('configured', [{ value: 'configured', label: '当前配置' }]), true);
  assert.equal(isAllowedEffort('persistent', [{ value: 'configured', label: '当前配置' }, { value: 'low', label: '低' }]), false);
  assert.equal(isAllowedEffort('none', [{ value: 'configured', label: '当前配置' }, { value: 'none', label: '无' }]), true);
  // Undefined policy keeps the historical static set plus the identifier guard.
  assert.equal(isAllowedModel('example-provider/anything-not-policed'), false);
  assert.equal(isAllowedModel('example-provider/gpt-6.1-sol'), true);
});

test('a catalog-approved slug reaches the CLI verbatim instead of null', async t => {
  const root = await mkdtemp(join(tmpdir(), 'runner-catalog-argv-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const catalog = ['example-provider2/gpt-6-astra', 'example-provider2/gpt-6.1-sol', 'example-provider/kimi-k3'].map(slug => ({ slug, displayName: slug }));
  for (const model of ['example-provider2/gpt-6-astra', 'example-provider2/gpt-6.1-sol', 'example-provider/kimi-k3']) {
    let argv;
    const runner = createRunner({ tempRoot: root, modelPolicy: catalog, spawnImpl: (_exe, args) => {
      argv = args;
      const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: { end() {
        queueMicrotask(() => { child.stdout.emit('data', JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '<svg/>' } }) + String.fromCharCode(10) + JSON.stringify({ type: 'turn.completed' }) + String.fromCharCode(10)); child.emit('close', 0); });
      } } });
      return child;
    } });
    assert.equal((await runner.runCase({ model, caseDef: CASES[0] })).answer, '<svg/>');
    assert.equal(argv[argv.indexOf('--model') + 1], model, 'a catalog slug must never be stringified from null');
  }
  // A slug outside the catalog policy is rejected before spawn, never passed as null.
  const rejecting = createRunner({ tempRoot: root, modelPolicy: catalog, spawnImpl: () => assert.fail('an unknown model must not spawn') });
  await assert.rejects(rejecting.runCase({ model: 'unknown/vendor-model', caseDef: CASES[0] }), { code: 'invalid_config' });
});

test('bounded incremental progress publishes safe event names and local times only', async t => {
  const root = await mkdtemp(join(tmpdir(), 'runner-progress-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const progress = []; let child; let ready;
  const started = new Promise(resolve => { ready = resolve; });
  const runner = createRunner({ tempRoot: root, wallClock: () => 1000, spawnImpl: () => {
    child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: { end() { ready(); } } }); return child;
  } });
  const result = runner.runCase({ caseDef: CASES[0], onProgress: value => progress.push(value) });
  await started;
  const line = JSON.stringify({ type: 'item.started', timestamp: 'PRIVATE_TIMESTAMP', item: { type: 'reasoning', text: 'PRIVATE_BODY', path: 'PRIVATE_PATH' } }) + '\n';
  child.stdout.emit('data', line.slice(0, 17));
  assert.equal(progress.at(-1).stage, 'waiting');
  assert.equal(progress.at(-1).lastEvent, null);
  child.stdout.emit('data', line.slice(17));
  assert.equal(progress.at(-1).stage, 'generating');
  assert.deepEqual(progress.at(-1).lastEvent, { type: 'item.started', at: new Date(1000).toISOString() });
  child.stdout.emit('data', JSON.stringify({ type: 'unknown.PRIVATE_EVENT', answer: 'PRIVATE_BODY' }) + '\n');
  assert.equal(progress.at(-1).lastEvent.type, 'item.started');
  child.stderr.emit('data', 'PRIVATE_STDERR');
  child.stdout.emit('data', JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '<svg/>' } }) + '\n' + JSON.stringify({ type: 'turn.completed' }) + '\n');
  child.emit('close', 0);
  assert.equal((await result).answer, '<svg/>');
  for (const value of progress) assert.deepEqual(Object.keys(value).sort(), ['stage', 'budgetMs', 'lastEvent', 'observedAt'].sort());
  assert.equal(JSON.stringify(progress).includes('PRIVATE'), false);
});

for (const outputType of ['reasoning', 'agent_message']) {
  test(`acceptance runner progress waits for ${outputType} output and never returns to waiting`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'runner-output-progress-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const progress = []; let child, ready, kills = 0;
    const started = new Promise(resolve => { ready = resolve; });
    const runner = createRunner({ tempRoot: root, wallClock: () => 2000, spawnImpl: () => {
      child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(), stderr: new EventEmitter(),
        stdin: { end() { ready(); } }, kill() { kills++; child.emit('close', null, 'SIGKILL'); }
      });
      return child;
    } });
    const outcome = runner.runCase({ caseDef: CASES[0], onProgress: value => progress.push(value) })
      .then(value => ({ value }), error => ({ error }));
    await started;
    const emit = event => child.stdout.emit('data', JSON.stringify(event) + '\n');
    const nonOutputEvents = [
      { type: 'thread.started' }, { type: 'turn.started' },
      ...['started', 'updated', 'completed'].flatMap(status => ['command_execution', 'collab_tool_call', 'error', 'unknown'].map(type => ({
        type: 'item.' + status, item: { type, text: 'PRIVATE_BODY', path: 'PRIVATE_PATH', status: 401 }
      }))),
      { type: 'item.updated' }, { type: 'turn.completed' }
    ];
    try {
      assert.equal(progress.at(-1).stage, 'waiting');
      for (const event of nonOutputEvents) {
        emit(event);
        assert.equal(progress.at(-1).stage, 'waiting', `${event.type}/${event.item?.type} is not output`);
      }
      const output = JSON.stringify({ type: 'item.started', item: { type: outputType, text: 'PRIVATE_BODY' } }) + '\n';
      child.stdout.emit('data', output.slice(0, 21));
      assert.equal(progress.at(-1).stage, 'waiting', 'partial JSON cannot establish output start');
      child.stdout.emit('data', output.slice(21));
      assert.equal(progress.at(-1).stage, 'generating');
      assert.deepEqual(progress.at(-1).lastEvent, { type: 'item.started', at: new Date(2000).toISOString() });
      for (const event of nonOutputEvents) {
        emit(event);
        assert.equal(progress.at(-1).stage, 'generating', `${event.type}/${event.item?.type} cannot reset output progress`);
      }
      emit({ type: 'item.completed', item: { type: 'agent_message', text: '<svg/>' } });
      child.stdout.emit('data', JSON.stringify({ type: 'turn.completed' }));
      child.emit('close', 0);
      assert.equal((await outcome).value?.answer, '<svg/>', 'recoverable item errors never stop a successful turn');
      assert.equal(progress.at(-1).stage, 'generating', 'the EOF event preserves output progress');
      assert.equal(kills, 0);
      assert.equal(JSON.stringify(progress).includes('PRIVATE'), false);
      for (const value of progress) assert.deepEqual(Object.keys(value).sort(), ['stage', 'budgetMs', 'lastEvent', 'observedAt'].sort());
    } finally {
      child.emit('close', 0);
      await outcome;
    }
  });
}

for (const outputStarted of [false, true]) {
  for (const failureType of ['error', 'turn.failed']) {
    test(`acceptance runner progress stops on ${failureType} with outputStarted=${outputStarted}`, async t => {
      const root = await mkdtemp(join(tmpdir(), 'runner-output-failure-'));
      t.after(() => rm(root, { recursive: true, force: true }));
      const progress = []; let child, ready, kills = 0;
      const started = new Promise(resolve => { ready = resolve; });
      const runner = createRunner({ platform: 'linux', tempRoot: root, spawnImpl: () => {
        child = Object.assign(new EventEmitter(), {
          stdout: new EventEmitter(), stderr: new EventEmitter(),
          stdin: { end() { ready(); } }, kill() { kills++; child.emit('close', null, 'SIGKILL'); }
        });
        return child;
      } });
      const outcome = runner.runCase({ caseDef: CASES[0], onProgress: value => progress.push(value) })
        .then(value => ({ value }), error => ({ error }));
      await started;
      try {
        if (outputStarted) child.stdout.emit('data', JSON.stringify({ type: 'item.updated', item: { type: 'reasoning' } }) + '\n');
        assert.equal(progress.at(-1).stage, outputStarted ? 'generating' : 'waiting');
        child.stdout.emit('data', [
          { type: failureType, error: { status: 429, message: 'PRIVATE_DIAGNOSTIC' } },
          { type: 'item.started', item: { type: 'agent_message', text: 'PRIVATE_BODY' } },
          { type: 'thread.started' }
        ].map(JSON.stringify).join('\n') + '\n');
        assert.equal((await outcome).error?.code, 'rate_limited');
        assert.equal(kills, 1);
        const stopIndex = progress.findIndex(value => value.stage === 'stopping');
        assert.ok(stopIndex >= 0);
        assert.ok(progress.slice(stopIndex).every(value => value.stage === 'stopping'));
        assert.equal(JSON.stringify(progress).includes('PRIVATE'), false);
      } finally {
        child.emit('close', 0);
        await outcome;
      }
    });
  }
}

test('structured incremental failures terminate promptly without waiting for deadline', async t => {
  const root = await mkdtemp(join(tmpdir(), 'runner-progress-fail-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let kills = 0;
  const runner = createRunner({ platform: 'linux', tempRoot: root, spawnImpl: () => {
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill() { kills++; this.emit('close', null, 'SIGKILL'); }, stdin: { end() {
      queueMicrotask(() => child.stdout.emit('data', JSON.stringify({ type: 'turn.failed', error: { code: 'model_not_found', message: 'PRIVATE_BODY' } }) + '\n'));
    } } }); return child;
  } });
  await assert.rejects(runner.runCase({ caseDef: CASES[0] }), { code: 'model_unavailable' });
  assert.equal(kills, 1);
});

test('runtime progress refreshes quiet elapsed time and never changes persistence or request hashes', async () => {
  const state = { runs: [], reservations: {}, nextSeq: 1 };
  let clock = 0, publish, rejectRun;
  const service = await createBenchmarkService({ monotonicClock: () => clock, wallClock: () => 1000 + clock,
    store: { load: async () => {}, snapshot: async () => structuredClone(state), mutate: async fn => fn(state), close: async () => {} },
    runner: { budgetMs: 300000, runCase: input => { publish = input.onProgress; return new Promise((_resolve, reject) => { rejectRun = reject; input.signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'cancelled' }))); }); } }
  });
  await service.run({ requestId: 'progress_request_123', model: 'gpt-6.1-sol', mode: 'html-animated' });
  publish({ stage: 'waiting', lastEvent: { type: 'thread.started', at: new Date(1000).toISOString(), answer: 'PRIVATE_BODY' }, raw: 'PRIVATE_BODY' });
  clock = 150001;
  const first = await service.snapshot();
  assert.deepEqual(first.activeRun.progress, { stage: 'waiting', elapsedMs: 150001, budgetMs: 300000, lastEvent: { type: 'thread.started', at: new Date(1000).toISOString() }, observedAt: new Date(151001).toISOString() });
  clock = 180001;
  assert.equal((await service.snapshot()).activeRun.progress.elapsedMs, 180001);
  assert.equal(state.runs[0].model, 'gpt-6.1-sol');
  assert.equal(state.runs[0].requestPayloadHash, createHash('sha256').update(JSON.stringify({ model: 'gpt-6.1-sol', reasoningEffort: 'configured', caseSetVersion: HTML_ANIMATED_VERSION, mode: 'html-animated' })).digest('hex'));
  assert.equal(JSON.stringify(state).includes('"progress":'), false);
  assert.equal(JSON.stringify(first.latestRun).includes('"progress":'), false);
  assert.equal(JSON.stringify(await service.preview(first.activeRun.runId)).includes('"progress":'), false);
  assert.equal(JSON.stringify(first).includes('PRIVATE'), false);
  const cancelled = await service.cancel({ requestId: 'progress_request_123' });
  if (cancelled.activeRun) assert.equal(cancelled.activeRun.progress.stage, 'stopping');
  await service.close();
  assert.equal((await service.snapshot()).activeRun, null);
  assert.equal(JSON.stringify(state).includes('"progress":'), false);
});


test('EOF structured failure after confirmed close never kills an exited Windows PID', async t => {
  const root = await mkdtemp(join(tmpdir(), 'runner-eof-failure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let taskkills = 0, backupKills = 0, cwd;
  const runner = createRunner({ platform: 'win32', tempRoot: root, spawnImpl: (_exe, args, options) => {
    if (args[0] === '/PID') {
      taskkills++;
      const helper = new EventEmitter(); queueMicrotask(() => helper.emit('close', 0)); return helper;
    }
    cwd = options.cwd;
    const child = Object.assign(new EventEmitter(), { pid: 321, stdout: new EventEmitter(), stderr: new EventEmitter(), kill() { backupKills++; }, stdin: { end() { queueMicrotask(() => {
      child.stdout.emit('data', JSON.stringify({ type: 'turn.failed', error: { code: 'model_not_found' } }));
      child.emit('close', 1);
    }); } } });
    return child;
  } });
  await assert.rejects(runner.runCase({ caseDef: CASES[0] }), { code: 'model_unavailable' });
  assert.equal(taskkills, 0);
  assert.equal(backupKills, 0);
  await assert.rejects(stat(cwd), { code: 'ENOENT' });
});

test('unconfirmed taskkill helper exit retains cleanup evidence even when the target closed', async t => {
  const root = await mkdtemp(join(tmpdir(), 'runner-helper-unconfirmed-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let helperKills = 0, targetKills = 0, cwd;
  const runner = createRunner({ platform: 'win32', tempRoot: root, timeoutMs: 10, terminationTimeoutMs: 40, spawnImpl: (_exe, args, options) => {
    if (args[0] === '/PID') return Object.assign(new EventEmitter(), { pid: 456, kill() { helperKills++; return false; } });
    cwd = options.cwd;
    return Object.assign(new EventEmitter(), { pid: 321, stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: { end() {} }, kill() { targetKills++; this.emit('close', null, 'SIGKILL'); } });
  } });
  await assert.rejects(runner.runCase({ caseDef: CASES[0] }), error => {
    assert.equal(error.code, 'process_failed');
    assert.equal(error.reason, 'timed_out');
    assert.equal(error.cleanupState, 'temporary_directory_retained_process_exit_unconfirmed');
    assert.equal(JSON.stringify(error).includes(cwd), false);
    return true;
  });
  assert.equal(helperKills, 1);
  assert.equal(targetKills, 1);
  assert.equal((await stat(cwd)).isDirectory(), true);
});

for (const mode of ['timeout', 'structured failure']) {
  test(`v8 stopping remains locked after ${mode} with delayed close and late normal events`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'runner-stopping-lock-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const progress = [];
    let child, cwd, ready, finishKill;
    let spawns = 0, kills = 0, helperCleanups = 0, backupKills = 0, settled = false;
    const started = new Promise(resolve => { ready = resolve; });
    const helperResult = new Promise(resolve => { finishKill = resolve; });
    const runner = createRunner({
      platform: 'win32', tempRoot: root, timeoutMs: 1000, terminationTimeoutMs: 4000,
      taskkillImpl: pid => {
        assert.equal(pid, 654);
        kills++;
        return { result: helperResult, cleanup: async () => { helperCleanups++; return true; } };
      },
      spawnImpl: (_exe, _args, options) => {
        spawns++; cwd = options.cwd;
        child = Object.assign(new EventEmitter(), {
          pid: 654, stdout: new EventEmitter(), stderr: new EventEmitter(),
          stdin: { end() { ready(); } },
          kill() { backupKills++; child.emit('close', null, 'SIGKILL'); }
        });
        return child;
      }
    });
    const outcome = runner.runCase({ caseDef: CASES[0], onProgress: value => progress.push(value) })
      .then(value => { settled = true; return { value }; }, error => { settled = true; return { error }; });
    await started;
    const emit = event => child.stdout.emit('data', JSON.stringify(event) + '\n');
    try {
      t.mock.timers.tick(999);
      assert.equal(kills, 0, 'the absolute deadline has not arrived');
      if (mode === 'timeout') t.mock.timers.tick(1);
      else emit({ type: 'turn.failed', error: { status: 429 } });
      assert.equal(kills, 1, 'stopping starts once while close remains pending');
      assert.equal(settled, false);
      const stopIndex = progress.findIndex(value => value.stage === 'stopping');
      assert.ok(stopIndex >= 0);
      for (const type of ['thread.started', 'item.updated']) {
        emit({ type });
        assert.equal(progress.at(-1).stage, 'stopping', `${type} cannot resume active progress`);
        assert.equal(progress.at(-1).budgetMs, 1000, 'late output cannot renew the budget');
      }
      emit({ type: 'error', error: { status: 401 } });
      // The original case deadline still fires during structured-failure cleanup.
      // Neither it nor a later failure may replace the first failure or retry.
      t.mock.timers.tick(mode === 'timeout' ? 1000 : 1);
      assert.equal(kills, 1);
      assert.equal(spawns, 1);
      assert.ok(progress.slice(stopIndex).every(value => value.stage === 'stopping'));
      assert.equal(settled, false, 'a kill request alone does not confirm process exit');
      finishKill();
      child.emit('close', null, 'SIGKILL');
      const result = await outcome;
      assert.equal(result.error?.code, mode === 'timeout' ? 'timed_out' : 'rate_limited');
      assert.equal(result.error?.cleanupState, undefined);
      assert.equal(helperCleanups, 1);
      assert.equal(backupKills, 0);
      await assert.rejects(stat(cwd), { code: 'ENOENT' });
      t.mock.timers.tick(1200000);
      assert.equal(kills, 1, 'completion clears all remaining deadlines');
      assert.equal(spawns, 1, 'no automatic retry after a late event');
    } finally {
      // Also release the delayed fake helper/process after expected red failures.
      finishKill();
      child.emit('close', null, 'SIGKILL');
      await outcome;
      t.mock.timers.reset();
    }
  });
}

test('v8 actual runner keeps service active progress stopping until delayed close', async t => {
  const root = await mkdtemp(join(tmpdir(), 'runner-service-stopping-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const state = { runs: [], reservations: {}, nextSeq: 1 };
  let child, cwd, ready, finishKill;
  let spawns = 0, kills = 0, helperCleanups = 0;
  const started = new Promise(resolve => { ready = resolve; });
  const helperResult = new Promise(resolve => { finishKill = resolve; });
  const runner = createRunner({
    platform: 'win32', tempRoot: root, timeoutMs: 1000, terminationTimeoutMs: 4000,
    taskkillImpl: pid => {
      assert.equal(pid, 987); kills++;
      return { result: helperResult, cleanup: async () => { helperCleanups++; return true; } };
    },
    spawnImpl: (_exe, _args, options) => {
      spawns++; cwd = options.cwd;
      child = Object.assign(new EventEmitter(), {
        pid: 987, stdout: new EventEmitter(), stderr: new EventEmitter(),
        stdin: { end() { ready(); } },
        kill() { assert.fail('the successful tree helper does not need a backup kill'); }
      });
      return child;
    }
  });
  const service = await createBenchmarkService({ runner,
    store: { load: async () => {}, snapshot: async () => structuredClone(state), mutate: async fn => fn(state), close: async () => {} }
  });
  try {
    await service.run({ requestId: 'v8_stopping_integration', mode: 'html-animated' });
    await started;
    child.stdout.emit('data', [
      { type: 'turn.failed', error: { status: 429 } },
      { type: 'thread.started' },
      { type: 'item.updated' }
    ].map(JSON.stringify).join('\n') + '\n');
    assert.equal((await service.snapshot()).activeRun.progress.stage, 'stopping', 'same-chunk normal events cannot resume service progress');
    assert.equal(kills, 1);
    child.stdout.emit('data', JSON.stringify({ type: 'error', error: { status: 401 } }) + '\n');
    t.mock.timers.tick(1000);
    assert.equal((await service.snapshot()).activeRun.progress.stage, 'stopping');
    child.stdout.emit('data', JSON.stringify({ type: 'thread.started' }) + '\n');
    assert.equal((await service.snapshot()).activeRun.progress.stage, 'stopping');
    child.stdout.emit('data', JSON.stringify({ type: 'item.updated' }));
    assert.equal((await service.snapshot()).activeRun.progress.stage, 'stopping');
    assert.equal(JSON.stringify(state).includes('"progress":'), false);
    assert.equal(kills, 1, 'later failure and original deadline reuse the same stop');
    assert.equal(spawns, 1);
    finishKill();
    child.emit('close', null, 'SIGKILL');
    // Drain real runner file cleanup and service persistence without a polling timer.
    // A fixed iteration count can be exhausted under machine load, so bound it by time.
    const drainDeadline = Date.now() + 5000;
    while ((await service.snapshot()).activeRun && Date.now() < drainDeadline) await new Promise(resolve => setImmediate(resolve));
    const terminal = await service.snapshot();
    assert.equal(terminal.activeRun, null);
    assert.equal(terminal.latestRun.status, 'failed');
    assert.equal(terminal.latestRun.caseResults[0].errorCode, 'rate_limited', 'the first failure survives late errors, timeout and EOF normal event');
    assert.equal(JSON.stringify(terminal.latestRun).includes('"progress":'), false);
    assert.equal(JSON.stringify(state).includes('"progress":'), false);
    assert.equal(helperCleanups, 1);
    assert.equal(kills, 1);
    assert.equal(spawns, 1, 'the service never retries the failed case');
    await assert.rejects(stat(cwd), { code: 'ENOENT' });
  } finally {
    finishKill();
    child?.emit('close', null, 'SIGKILL');
    await service.close();
    t.mock.timers.reset();
  }
});

test('pelican budget defaults to 1200000 with strict env boundaries and safe invalid reason', () => {
  assert.equal(DEFAULT_TIMEOUT_MS, 1200000);
  assert.equal(MIN_TIMEOUT_MS, 60000);
  assert.equal(MAX_TIMEOUT_MS, 1800000);
  assert.equal(TIMEOUT_ENV_KEY, 'CODEX_STATELINE_PELICAN_TIMEOUT_MS');
  assert.deepEqual(resolveTimeoutMs({ explicit: undefined, env: {} }), { timeoutMs: 1200000, configWarning: null });
  assert.deepEqual(resolveTimeoutMs({ explicit: 250000, env: { [TIMEOUT_ENV_KEY]: '600000' } }), { timeoutMs: 250000, configWarning: null });
  for (const raw of ['60000', '600001', '1200000', '1800000']) {
    const resolved = resolveTimeoutMs({ env: { [TIMEOUT_ENV_KEY]: raw } });
    assert.deepEqual(resolved, { timeoutMs: Number(raw), configWarning: null });
    assert.equal(createRunner({ env: { [TIMEOUT_ENV_KEY]: raw }, spawnImpl: () => assert.fail('no spawn') }).budgetMs, Number(raw));
  }
  for (const raw of ['', undefined, null]) {
    const env = raw === undefined ? {} : { [TIMEOUT_ENV_KEY]: raw };
    assert.deepEqual(resolveTimeoutMs({ env }), { timeoutMs: 1200000, configWarning: null }, 'absent or empty env keeps the silent default');
  }
  for (const raw of ['59999', '1800001', '0', '-1', '1.5', ' 60000', '60000 ', '6e5', '0x1', '+60000', '060000', 'NaN', 'Infinity', 'private-secret', '60000ms', ['60000'], 60000, {}]) {
    const env = raw === undefined ? {} : { [TIMEOUT_ENV_KEY]: raw };
    assert.deepEqual(resolveTimeoutMs({ env }), { timeoutMs: 1200000, configWarning: 'timeout_config_invalid' }, `raw=${String(raw)}`);
  }
  assert.deepEqual(resolveTimeoutMs({ env: {} }), { timeoutMs: 1200000, configWarning: null });
  assert.equal(createRunner({ env: { [TIMEOUT_ENV_KEY]: 'private-secret' }, spawnImpl: () => assert.fail('no spawn') }).budgetMs, 1200000);
  const safe = pickDiagnostics({ startedAt: new Date(0).toISOString(), finishedAt: new Date(1).toISOString(), timeoutMs: 1200000, elapsedMs: 1, firstEventElapsedMs: 0, lastEventElapsedMs: 1, lastPhase: 'waiting', terminationReason: 'completed', cleanupStatus: 'confirmed', configWarning: 'timeout_config_invalid', raw: 'private-secret' });
  assert.deepEqual(Object.keys(safe).sort(), [...DIAGNOSTIC_KEYS].sort());
  assert.equal(safe.configWarning, 'timeout_config_invalid');
  assert.equal(JSON.stringify(safe).includes('private'), false);
  assert.equal(pickDiagnostics({ ...safe, configWarning: 'private-secret' }).configWarning, null);
  assert.equal(pickDiagnostics(null), null);
  assert.equal(pickDiagnostics('private-secret'), null);
});

test('pelican runner succeeds on quiet long output and terminates only at the absolute deadline', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pelican-budget-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const mode of ['quiet-success', 'output-beyond-deadline']) {
    await t.test(mode, async (t) => {
      const caseRoot = await mkdtemp(join(root, 'case-'));
      t.after(() => rm(caseRoot, { recursive: true, force: true }));
      t.mock.timers.enable({ apis: ['setTimeout'] });
      let child, cwd, ready, kills = 0, spawns = 0, clock = 0;
      const tick = (ms) => { clock += ms; t.mock.timers.tick(ms); };
      const started = new Promise(resolve => { ready = resolve; });
      const runner = createRunner({
        platform: 'win32', tempRoot: caseRoot, timeoutMs: 120000, terminationTimeoutMs: 4000, env: {},
        wallClock: () => clock,
        taskkillImpl: async pid => { assert.equal(pid, 42); kills++; child.emit('close', null, 'SIGKILL'); },
        spawnImpl: (_exe, _args, options) => {
          spawns++; cwd = options.cwd;
          child = Object.assign(new EventEmitter(), {
            pid: 42, stdout: new EventEmitter(), stderr: new EventEmitter(),
            stdin: { end() { ready(); } }, kill() { assert.fail('successful taskkill must not use backup kill'); }
          });
          return child;
        }
      });
      const outcome = runner.runCase({ caseDef: CASES[0] }).then(value => ({ value }), error => ({ error }));
      await started;
      try {
        tick(119999);
        assert.equal(kills, 0, 'quiet output keeps the full budget');
        if (mode === 'quiet-success') {
          child.stdout.emit('data', [
            { type: 'item.completed', item: { type: 'agent_message', text: '<svg/>' } },
            { type: 'turn.completed' }
          ].map(JSON.stringify).join(String.fromCharCode(10)));
          child.emit('close', 0);
          const result = await outcome;
          assert.equal(result.value.answer, '<svg/>');
          assert.equal(result.value.diagnostics.terminationReason, 'completed');
          assert.equal(result.value.diagnostics.cleanupStatus, 'confirmed');
          assert.equal(result.value.diagnostics.timeoutMs, 120000);
          assert.equal(result.value.diagnostics.lastPhase, 'generating', 'the EOF event preserves output progress');
          assert.equal(result.value.diagnostics.firstEventElapsedMs, 119999);
          assert.equal(result.value.diagnostics.elapsedMs, 119999);
          assert.deepEqual(Object.keys(result.value.diagnostics).sort(), [...DIAGNOSTIC_KEYS].sort());
          tick(1200000);
          assert.equal(kills, 0, 'completion clears the deadline');
        } else {
          child.stdout.emit('data', JSON.stringify({ type: 'thread.started' }) + String.fromCharCode(10));
          tick(1);
          assert.equal(kills, 1, 'output never renews the absolute deadline');
          const result = await outcome;
          assert.equal(result.error.code, 'timed_out');
          assert.equal(result.error.diagnostics.terminationReason, 'budget_exhausted');
          assert.equal(result.error.diagnostics.cleanupStatus, 'confirmed');
          assert.equal(result.error.diagnostics.firstEventElapsedMs, 119999);
          assert.equal(result.error.diagnostics.lastEventElapsedMs, 119999);
          assert.equal(result.error.diagnostics.lastPhase, 'stopping');
        }
        assert.equal(spawns, 1, 'no automatic retry');
        await assert.rejects(stat(cwd), { code: 'ENOENT' });
      } finally {
        child.emit('close', 0);
        await outcome;
        t.mock.timers.reset();
      }
    });
  }
});

test('pelican runner budgets the answer separately from the reasoning stream', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pelican-stream-budget-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  // A reasoning-heavy run re-emits full summaries and legitimately streams far
  // more than the answer it produces. Only the retained answer is bounded.
  const answer = '<html>' + 'x'.repeat(MAX_ANSWER - 512) + '</html>';
  const reasoning = 'r'.repeat(1024 * 1024);
  let child;
  const runner = createRunner({ tempRoot: root, spawnImpl: () => {
    child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: { end() {
      queueMicrotask(() => {
        const lines = [
          { type: 'thread.started' },
          { type: 'turn.started' },
          ...Array.from({ length: 6 }, () => ({ type: 'item.completed', item: { type: 'reasoning', text: reasoning } })),
          { type: 'item.completed', item: { type: 'agent_message', text: answer } },
          { type: 'turn.completed' }
        ].map(JSON.stringify).join(String.fromCharCode(10)) + String.fromCharCode(10);
        assert.ok(Buffer.byteLength(lines) > MAX_ANSWER, 'the fixture must exceed the old whole-stream cap');
        assert.ok(Buffer.byteLength(lines) < MAX_STREAM, 'the fixture stays inside the runaway guard');
        child.stdout.emit('data', lines);
        child.emit('close', 0);
      });
    } } });
    return child;
  } });
  const result = await runner.runCase({ caseDef: CASES[0] });
  assert.equal(result.answer, answer);
  assert.equal(result.diagnostics.terminationReason, 'completed');
});

test('pelican runner classifies cancellation, invalid output and unconfirmed cleanup safely', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pelican-failure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixtures = [
    ['invalid-output', 'malformed_output', 'invalid_output', null, null],
    ['incomplete-output', 'incomplete_output', 'invalid_output', null, null],
    ['oversized-output', 'answer_too_large', 'invalid_output', null, null],
    ['cleanup-unconfirmed', 'process_failed', 'budget_exhausted', 'temporary_directory_retained_process_exit_unconfirmed', 'unconfirmed'],
    ['cancelled', 'cancelled', 'cancelled', null, 'confirmed']
  ];
  for (const [mode, expectedCode, expectedReason, expectedCleanupState, expectedCleanupStatus] of fixtures) {
    await t.test(mode, async (t) => {
      const caseRoot = await mkdtemp(join(root, 'case-'));
      t.after(() => rm(caseRoot, { recursive: true, force: true }));
      let child, cwd, ready, kills = 0;
      const controller = new AbortController();
      const started = new Promise(resolve => { ready = resolve; });
      const runner = createRunner({
        platform: 'win32', tempRoot: caseRoot, timeoutMs: 10, terminationTimeoutMs: 40, env: {},
        taskkillImpl: async () => { kills++; if (mode !== 'cleanup-unconfirmed') child.emit('close', null, 'SIGKILL'); },
        spawnImpl: (_exe, _args, options) => {
          cwd = options.cwd;
          child = Object.assign(new EventEmitter(), {
            pid: 77, stdout: new EventEmitter(), stderr: new EventEmitter(),
            stdin: { end() { ready(); queueMicrotask(() => {
              if (mode === 'invalid-output') { child.stdout.emit('data', 'not-json'); child.emit('close', 0); }
              if (mode === 'incomplete-output') { child.stdout.emit('data', JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '<svg/>' } })); child.emit('close', 0); }
              // A complete JSONL line is required before the answer budget can be judged,
              // so the fixture terminates its line the way the real CLI does.
              if (mode === 'oversized-output') { child.stdout.emit('data', JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'a'.repeat(MAX_ANSWER + 1) } }) + String.fromCharCode(10)); child.emit('close', 0); }
              if (mode === 'cancelled') controller.abort();
            }); } },
            kill() { kills++; this.emit('close', null, 'SIGKILL'); }
          });
          return child;
        }
      });
      await assert.rejects(runner.runCase({ caseDef: CASES[0], signal: controller.signal }), error => {
        assert.equal(error.code, expectedCode);
        assert.equal(error.diagnostics.terminationReason, expectedReason);
        assert.equal(error.diagnostics.timeoutMs, 10);
        assert.equal(error.diagnostics.cleanupStatus, expectedCleanupStatus ?? 'confirmed');
        assert.equal(JSON.stringify(error.diagnostics).includes('private'), false);
        assert.deepEqual(Object.keys(error.diagnostics).sort(), [...DIAGNOSTIC_KEYS].sort());
        if (expectedCleanupState) assert.equal(error.cleanupState, expectedCleanupState);
        return true;
      });
      const expectedKills = ['cleanup-unconfirmed', 'cancelled', 'oversized-output'].includes(mode) ? 1 : 0;
      assert.equal(kills, expectedKills, 'only self-terminating fixtures avoid a kill');
      if (expectedCleanupStatus === 'unconfirmed') assert.equal((await stat(cwd)).isDirectory(), true);
      else await assert.rejects(stat(cwd), { code: 'ENOENT' });
    });
  }
});

test('pelican service persists allowlisted diagnostics and stays compatible with old records', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pelican-service-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = { runs: [], reservations: {}, nextSeq: 1 };
  let child;
  const runner = createRunner({
    platform: 'win32', tempRoot: root, timeoutMs: 10, terminationTimeoutMs: 40, env: {},
    taskkillImpl: async () => { child.emit('close', null, 'SIGKILL'); },
    spawnImpl: (_exe, _args) => {
      child = Object.assign(new EventEmitter(), {
        pid: 55, stdout: new EventEmitter(), stderr: new EventEmitter(),
        stdin: { end() { queueMicrotask(() => child.stdout.emit('data', JSON.stringify({ type: 'turn.failed', error: { status: 429, message: 'private-secret' } }) + String.fromCharCode(10))); child.emit('close', 1); } },
        kill() { this.emit('close', null, 'SIGKILL'); }
      });
      return child;
    }
  });
  const service = await createBenchmarkService({ runner, store: { load: async () => {}, snapshot: async () => structuredClone(state), mutate: async fn => fn(state), close: async () => {} } });
  await service.run({ requestId: 'diagnostics_request_123' });
  // Drain the real runner to a terminal state before closing the service. A fixed iteration
  // count can be exhausted under machine load, and close() would then abort the in-flight run
  // so the first recorded failure becomes 'cancelled' instead of the runner's own classification.
  const terminalStatuses = new Set(['completed', 'failed', 'cancelled', 'timed_out']);
  const drainDeadline = Date.now() + 5000;
  while (!terminalStatuses.has(state.runs[0]?.status) && Date.now() < drainDeadline) await new Promise(resolve => setImmediate(resolve));
  assert.ok(terminalStatuses.has(state.runs[0]?.status), 'runner must reach a terminal state before the service closes');
  await service.close();
  const persisted = state.runs[0].caseResults[0];
  assert.equal(persisted.errorCode, 'rate_limited');
  assert.deepEqual(Object.keys(persisted.diagnostics).sort(), [...DIAGNOSTIC_KEYS].sort());
  assert.equal(persisted.diagnostics.terminationReason, 'process_error');
  assert.equal(persisted.diagnostics.timeoutMs, 10);
  assert.equal(JSON.stringify(state).includes('private'), false);
  assert.equal(JSON.stringify(state).includes('raw'), false);
  const snapshot = await service.snapshot();
  assert.equal(snapshot.latestRun.caseResults[0].diagnostics.terminationReason, 'process_error');
  const legacy = { runId: 'legacy-run', requestId: 'legacy_request_123', status: 'timed_out', model: 'configured', reasoningEffort: 'configured', caseSetVersion: CASES[0].caseId === 'pelican-svg' ? 'pelican-svg-v2' : 'pelican-svg-v2', rubricVersion: 'pelican-svg-v2', schemaVersion: 1, caseResults: [{ caseId: 'pelican-svg', status: 'timed_out', errorCode: 'timed_out' }] };
  const legacyState = { runs: [legacy], reservations: {}, nextSeq: 2 };
  const legacyService = await createBenchmarkService({ runner: { runCase: () => assert.fail('legacy record must not rerun') }, store: { load: async () => {}, snapshot: async () => structuredClone(legacyState), mutate: async fn => fn(legacyState), close: async () => {} } });
  const legacySnapshot = await legacyService.snapshot();
  assert.equal(legacySnapshot.latestRun.caseResults[0].diagnostics, undefined);
  assert.equal(legacySnapshot.latestRun.status, 'timed_out');
  await legacyService.close();
});

test('pelican service copies only allowlisted diagnostics from arbitrary runner objects', async () => {
  const state = { runs: [], reservations: {}, nextSeq: 1 };
  const service = await createBenchmarkService({ store: { load: async () => {}, snapshot: async () => structuredClone(state), mutate: async fn => fn(state), close: async () => {} },
    runner: { budgetMs: 1200000, runCase: async () => ({ answer: '<svg/>', diagnostics: { startedAt: new Date(0).toISOString(), finishedAt: new Date(1).toISOString(), timeoutMs: 1200000, elapsedMs: 1, firstEventElapsedMs: 0, lastEventElapsedMs: 1, lastPhase: 'generating', terminationReason: 'completed', cleanupStatus: 'confirmed', configWarning: 'timeout_config_invalid', secret: 'private-secret', nested: { raw: 'private-secret' } } }) } });
  await service.run({ requestId: 'allowlist_request_123' });
  await service.close();
  const item = state.runs[0].caseResults[0];
  assert.equal(item.answer, '<svg/>');
  assert.deepEqual(Object.keys(item.diagnostics).sort(), [...DIAGNOSTIC_KEYS].sort());
  assert.equal(item.diagnostics.configWarning, 'timeout_config_invalid');
  assert.equal(JSON.stringify(state).includes('private-secret'), false);
  assert.equal(JSON.stringify(state).includes('nested'), false);
});

test('Cockpit startup stall is bounded but a started turn may keep thinking', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cockpit-startup-watchdog-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const mode of ['stalled', 'started']) {
    await t.test(mode, async (t) => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const line = value => JSON.stringify(value) + String.fromCharCode(10);
      let child; let kills = 0; let ready;
      const started = new Promise(resolve => { ready = resolve; });
      const runner = createRunner({ tempRoot: root, spawnImpl: () => {
        child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: { end() { queueMicrotask(() => {
          child.stdout.emit('data', line({ type: 'thread.started', thread_id: 'thread' }));
          if (mode === 'started') child.stdout.emit('data', line({ type: 'turn.started' }));
          ready();
        }); } }, kill() { kills++; this.emit('close', null, 'SIGKILL'); } });
        return child;
      } });
      const outcome = runner.runCase({ caseDef: COCKPIT_CASES[0] }).then(value => ({ value }), error => ({ error }));
      try {
        await started;
        t.mock.timers.tick(119999);
        assert.equal(kills, 0);
        t.mock.timers.tick(1);
        if (mode === 'stalled') {
          const result = await outcome;
          assert.equal(result.error.code, 'upstream_stalled');
          assert.equal(kills, 1);
        } else {
          child.stdout.emit('data', line({ type: 'item.completed', item: { type: 'agent_message', text: '<!doctype html><html><body><svg></svg></body></html>' } }));
          child.stdout.emit('data', line({ type: 'turn.completed' }));
          child.emit('close', 0);
          const result = await outcome;
          assert.equal(result.error, undefined);
          assert.equal(kills, 0, 'turn.started disarms the startup watchdog');
          t.mock.timers.tick(1200000);
          assert.equal(kills, 0, 'completion also clears the absolute deadline');
        }
      } finally {
        child?.emit('close', 0);
        await outcome;
        t.mock.timers.reset();
      }
    });
  }
});

test('zero-output stall stops as upstream_stalled when no item ever arrives', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'runner-stalled-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  // 报告 5.1 的 #3：两次中转挂死是「零输出」形态，CLI 把它报成可恢复的
  // Reconnecting 提示，所以没有任何既有分支会停掉进程，只能靠 errorEventCount
  // 累积到 2 且 outputStarted 仍为 false 才敢判定上游已死。
  const line = value => JSON.stringify(value) + String.fromCharCode(10);
  const runner = createRunner({ tempRoot: root, spawnImpl: () => {
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: { end() { queueMicrotask(() => {
      child.stdout.emit('data', line({ type: 'thread.started', thread_id: 'thread' }));
      child.stdout.emit('data', line({ type: 'error', message: 'Reconnecting... 1/5 (stream disconnected before completion: origin did not respond)' }));
      child.stdout.emit('data', line({ type: 'error', message: 'Reconnecting... 2/5 (stream disconnected before completion: origin did not respond)' }));
      // 刻意不发 close：挂死的真实形态就是进程一直活着，却再也不吐任何 item.*。
    }); } }, kill() { this.emit('close', null, 'SIGKILL'); } });
    return child;
  } });
  await assert.rejects(runner.runCase({ caseDef: CASES[0] }), error => {
    assert.equal(error.code, 'upstream_stalled');
    assert.equal(error.message, 'upstream_stalled');
    assert.equal(error.diagnostics.errorEventCount, 2);
    assert.equal(error.diagnostics.lastErrorClass, 'reconnect_notice');
    assert.equal(error.diagnostics.lastPhase, 'stopping');
    // 上游挂死不是本机的进程问题，归因沿用既有的工艺错误分类，不外扩诊断枚举。
    assert.equal(error.diagnostics.terminationReason, 'process_error');
    return true;
  });
});

test('a run that already produced output survives a burst of recoverable errors', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'runner-stall-guard-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  // 回归保护：报告 5.1 的 #4 在首次报错前就已经有输出，事后还有 287.7s 静默仍然成功。
  // 看门狗唯一认的证据是「从没出过字」，一旦产过 reasoning/agent_message 就永久失活，
  // 否则一次先报错、后恢复的运行会被误杀。
  const line = value => JSON.stringify(value) + String.fromCharCode(10);
  const runner = createRunner({ tempRoot: root, spawnImpl: () => {
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: { end() { queueMicrotask(() => {
      child.stdout.emit('data', line({ type: 'item.updated', item: { type: 'reasoning', text: 'thinking' } }));
      for (const attempt of [1, 2, 3]) child.stdout.emit('data', line({ type: 'error', message: `Reconnecting... ${attempt}/5 (stream disconnected before completion: origin did not respond)` }));
      child.stdout.emit('data', line({ type: 'item.completed', item: { type: 'agent_message', text: '<svg><!-- recovered --></svg>' } }));
      child.stdout.emit('data', line({ type: 'turn.completed' }));
      child.emit('close', 0);
    }); } }, kill() { assert.fail('output already started, so the stall watchdog must not fire'); } });
    return child;
  } });
  const result = await runner.runCase({ caseDef: CASES[0] });
  assert.equal(result.answer, '<svg><!-- recovered --></svg>');
  assert.equal(result.diagnostics.errorEventCount, 3);
  assert.equal(result.diagnostics.terminationReason, 'completed');
  assert.equal(result.diagnostics.exitCode, 0);
});

test('Cockpit preserves configured and explicit effort without changing other modes', async () => {
  for (const [mode, requested, expected] of [['cockpit', undefined, 'configured'], ['cockpit', 'ultra', 'ultra'], ['html-animated', undefined, 'configured']]) {
    const state = { runs: [], reservations: {}, nextSeq: 1 };
    const calls = [];
    const service = await createBenchmarkService({ store: { load: async () => {}, snapshot: async () => structuredClone(state), mutate: async fn => fn(state), close: async () => {} }, runner: { runCase: async input => { calls.push(input); return { answer: mode === 'cockpit' ? '<!doctype html><html><body><svg></svg></body></html>' : HTML_PREVIEW_FIXTURE }; } } });
    await service.run({ requestId: `effort_${mode}_${requested ?? 'default'}`, mode, ...(requested ? { reasoningEffort: requested } : {}) });
    await service.close();
    assert.equal(calls[0].reasoningEffort, expected);
    assert.equal(state.runs[0].reasoningEffort, expected);
  }
});

test('service retries an upstream stall once and keeps the stalled code visible', async () => {
  const storeFor = (state) => ({ load: async () => {}, snapshot: async () => structuredClone(state), mutate: async fn => fn(state), close: async () => {} });
  // 挂死此前只会以 timed_out 落地，而 timed_out 不可重试，等于重试机制对最常见的
  // 失败形态完全空转。一次新尝试有机会拿到另一条中转线路，两次都挂就把码报出来。
  const stalledState = { runs: [], reservations: {}, nextSeq: 1 };
  const stalled = [];
  const stalledService = await createBenchmarkService({ store: storeFor(stalledState), runner: { runCase: async () => { stalled.push('upstream_stalled'); throw Object.assign(new Error('private-secret'), { code: 'upstream_stalled' }); } } });
  await stalledService.run({ requestId: 'stalled_request_123' });
  await stalledService.close();
  assert.deepEqual(stalled, ['upstream_stalled', 'upstream_stalled']);
  assert.equal(stalledState.runs[0].status, 'failed');
  assert.equal(stalledState.runs[0].caseResults[0].errorCode, 'upstream_stalled');
  assert.equal(JSON.stringify(stalledState).includes('private-secret'), false);

  // 首次挂死、重试拿到完整回答时必须记为成功，而不是把首次失败留在记录上。
  const recoveredState = { runs: [], reservations: {}, nextSeq: 1 };
  let attempts = 0;
  const recovered = await createBenchmarkService({ store: storeFor(recoveredState), runner: { runCase: async () => {
    attempts += 1;
    if (attempts === 1) throw Object.assign(new Error('private-secret'), { code: 'upstream_stalled' });
    return { answer: '<svg><!-- second route --></svg>', diagnostics: { lastPhase: 'waiting', terminationReason: 'completed' } };
  } } });
  await recovered.run({ requestId: 'stalled_recovered_request_123' });
  await recovered.close();
  assert.equal(attempts, 2);
  assert.equal(recoveredState.runs[0].status, 'completed');
  assert.equal(recoveredState.runs[0].caseResults[0].answer, '<svg><!-- second route --></svg>');
});
