import { randomUUID, createHash } from 'node:crypto';
import { casesForVersion, caseIdsFor, CASE_SET_VERSION, RUBRIC_VERSION, ANIMATED_VERSION, HTML_ANIMATED_VERSION, COCKPIT_VERSION } from './cases.js';
import { validateScores, completeScores, compareRuns } from './scoring.js';
import { createStore } from './store.js';
import { createRunner, APPROVED_MODELS, SAFE_PROGRESS_EVENTS, pickDiagnostics } from './runner.js';

const SCHEMA_VERSION = 1;

function publicRun(run) {
  return { runId: run.runId, requestId: run.requestId, status: run.status, model: run.model, reasoningEffort: run.reasoningEffort, caseResults: run.caseResults, caseSetVersion: run.caseSetVersion, rubricVersion: run.rubricVersion, schemaVersion: run.schemaVersion };
}
function serviceError(message, status, code = 'benchmark_error') { return Object.assign(new Error(message), { status, code }); }
function snapshotFromState(state, active, progress) {
  const baseline = state.baseline ? state.runs.find((run) => run.runId === state.baseline.runId) : null;
  const runs = state.runs.slice(-20).map(publicRun);
  return { status: active ? active.status : 'idle', activeRun: active ? { ...publicRun(active), progress } : null, latestRun: runs.at(-1) ?? null, runs, baseline: baseline ? { runId: baseline.runId } : null, comparison: baseline ? compareRuns(state.runs, baseline) : null, available: true };
}

export async function createBenchmarkService({ store = createStore(), runner = createRunner(), cliVersion = '0.162', catalogAvailable = true, wallClock = () => Date.now(), monotonicClock = () => performance.now() } = {}) {
  await store.load();
  let active = null;
  let closing = false;
  let execution = Promise.resolve();
  let closePromise;
  const runtime = new WeakMap();
  const stages = new Set(['queued', 'starting', 'waiting', 'generating', 'stopping']);
  function progressFor(record) {
    const value = runtime.get(record);
    return { stage: value.stage, elapsedMs: Math.max(0, monotonicClock() - value.started), budgetMs: value.budgetMs,
      lastEvent: value.lastEvent ? { ...value.lastEvent } : null, observedAt: new Date(wallClock()).toISOString() };
  }
  function onProgress(record, value) {
    if (active !== record || !value || typeof value !== 'object') return;
    const target = runtime.get(record);
    if (record.abortController.signal.aborted) target.stage = 'stopping';
    else if (stages.has(value.stage)) target.stage = value.stage;
    if (SAFE_PROGRESS_EVENTS.has(value.lastEvent?.type) && typeof value.lastEvent.at === 'string'
      && Number.isFinite(Date.parse(value.lastEvent.at))) target.lastEvent = { type: value.lastEvent.type, at: value.lastEvent.at };
  }
  const snapshot = async () => {
    const state = await store.snapshot();
    return snapshotFromState(state, active, active ? progressFor(active) : null);
  };

  async function execute(record) {
    record.status = 'running';
    runtime.get(record).stage = 'starting';
    await store.mutate((state) => {
      const persisted = state.runs.find((run) => run.runId === record.runId);
      if (persisted) persisted.status = 'running';
      if (state.reservations[record.requestId]) state.reservations[record.requestId].status = 'running';
    });
    for (const caseDef of casesForVersion(record.caseSetVersion)) {
      if (record.abortController.signal.aborted) { record.status = 'cancelled'; break; }
      try {
        const result = await runner.runCase({ model: record.model, reasoningEffort: record.reasoningEffort, caseDef, signal: record.abortController.signal, onProgress: value => onProgress(record, value) });
        const item = record.caseResults.find((entry) => entry.caseId === caseDef.caseId);
        if (item) {
          const diagnostics = pickDiagnostics(result?.diagnostics);
          Object.assign(item, { status: 'completed', answer: result.answer }, diagnostics ? { diagnostics } : {});
        }
      } catch (cause) {
        const code = ['cancelled', 'timed_out', 'spawn_failed', 'process_failed', 'authentication_failed', 'rate_limited', 'model_unavailable', 'malformed_output', 'incomplete_output', 'answer_too_large', 'output_too_large', 'invalid_config'].includes(cause?.code) ? cause.code : 'process_failed';
        record.status = code === 'cancelled' ? 'cancelled' : code === 'timed_out' ? 'timed_out' : 'failed';
        const item = record.caseResults.find((entry) => entry.caseId === caseDef.caseId);
        if (item) {
          const diagnostics = pickDiagnostics(cause?.diagnostics);
          Object.assign(item, { status: record.status, errorCode: code }, diagnostics ? { diagnostics } : {});
          if (cause?.cleanupState === 'temporary_directory_retained_process_exit_unconfirmed') item.cleanupState = 'temporary_directory_retained_process_exit_unconfirmed';
        }
        break;
      }
    }
    if (record.status === 'running') record.status = 'completed';
    await store.mutate((state) => {
      const persisted = state.runs.find((run) => run.runId === record.runId);
      if (persisted) Object.assign(persisted, { status: record.status, caseResults: record.caseResults });
      if (state.reservations[record.requestId]) state.reservations[record.requestId].status = record.status;
    });
    if (active?.runId === record.runId) active = null;
  }

  return {
    snapshot,
    async preview(runId) {
      if (closing) throw serviceError('Preview request failed.', 503, 'service_unavailable');
      if (!catalogAvailable) throw serviceError('Preview request failed.', 503, 'benchmark_unavailable');
      const state = await store.snapshot();
      const run = state.runs.find((item) => item.runId === runId);
      if (!run) throw serviceError('Preview request failed.', 404, 'run_not_found');
      if (![HTML_ANIMATED_VERSION, COCKPIT_VERSION].includes(run.caseSetVersion) || run.rubricVersion !== run.caseSetVersion) throw serviceError('Preview request failed.', 409, 'preview_version_mismatch');
      if (!Array.isArray(run.caseResults) || run.caseResults.length !== 1 || run.caseResults[0]?.caseId !== (run.caseSetVersion === COCKPIT_VERSION ? 'pelican-cockpit' : 'pelican-html-animated')) throw serviceError('Preview request failed.', 409, 'preview_case_mismatch');
      const item = run.caseResults[0];
      const statuses = ['queued', 'running', 'completed', 'failed', 'cancelled', 'timed_out'];
      if (!statuses.includes(run.status) || !statuses.includes(item.status) || (item.answer !== undefined && item.answer !== null && typeof item.answer !== 'string')) throw serviceError('Preview request failed.', 409, 'preview_record_invalid');
      const value = { runId: run.runId, status: run.status, caseSetVersion: run.caseSetVersion, rubricVersion: run.rubricVersion, caseId: item.caseId, caseStatus: item.status, previewState: 'unavailable', reason: null, answer: null, contentDigest: null };
      if (['queued', 'running'].includes(run.status) && ['queued', 'running', 'completed'].includes(item.status)) value.previewState = 'pending';
      else if (['failed', 'cancelled', 'timed_out'].includes(run.status)) value.reason = 'run_' + run.status;
      else if (run.status === 'completed' && item.status === 'completed') {
        if (!item.answer) value.reason = 'answer_missing';
        else if (item.answer.length > 131072 || Buffer.byteLength(item.answer, 'utf8') > 131072) { value.previewState = 'too_large'; value.reason = 'preview_budget_exceeded'; }
        else { value.previewState = 'ready'; value.answer = item.answer; value.contentDigest = createHash('sha256').update(item.answer, 'utf8').digest('hex'); }
      } else throw serviceError('Preview request failed.', 409, 'preview_record_invalid');
      return value;
    },
    async run({ requestId, model = 'configured', reasoningEffort = 'configured', mode = 'static' }) {
      if (closing) throw serviceError('Benchmark service is closing.', 503, 'service_closing');
      if (!APPROVED_MODELS.has(model) || !['configured', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(reasoningEffort)) throw serviceError('Benchmark configuration is invalid.', 400, 'invalid_config');
      if (!catalogAvailable) throw serviceError('Benchmark feature is unavailable.', 503, 'benchmark_unavailable');
      if (!['static', 'animated', 'html-animated', 'cockpit'].includes(mode)) throw serviceError('Benchmark mode is invalid.', 400, 'schema_invalid');
      const caseSetVersion = mode === 'cockpit' ? COCKPIT_VERSION : mode === 'html-animated' ? HTML_ANIMATED_VERSION : mode === 'animated' ? ANIMATED_VERSION : CASE_SET_VERSION;
      const rubricVersion = mode === 'cockpit' ? COCKPIT_VERSION : mode === 'html-animated' ? HTML_ANIMATED_VERSION : mode === 'animated' ? ANIMATED_VERSION : RUBRIC_VERSION;
      const requestPayloadHash = createHash('sha256').update(JSON.stringify(mode === 'static'
        ? { model, reasoningEffort, caseSetVersion: CASE_SET_VERSION }
        : mode === 'animated' ? { model, reasoningEffort, caseSetVersion, mode: 'animated' }
        : mode === 'cockpit' ? { model, reasoningEffort, caseSetVersion: COCKPIT_VERSION, mode: 'cockpit' }
        : { model, reasoningEffort, caseSetVersion: HTML_ANIMATED_VERSION, mode: 'html-animated' })).digest('hex');
      if (active) {
        if (active.requestId === requestId) {
          if (active.requestPayloadHash !== requestPayloadHash) throw serviceError('Request id is already associated with another run.', 409, 'request_id_conflict');
          return snapshot();
        }
        throw serviceError('A benchmark run is already active.', 409, 'run_active');
      }
      const record = { runId: randomUUID(), requestId, requestPayloadHash, status: 'queued', createdAt: new Date().toISOString(), createdSeq: 0, cliVersion, model, reasoningEffort, caseSetVersion, rubricVersion, schemaVersion: SCHEMA_VERSION, caseResults: casesForVersion(caseSetVersion).map((item) => ({ caseId: item.caseId, status: 'queued' })), abortController: new AbortController() };
      runtime.set(record, { stage: 'queued', started: monotonicClock(), budgetMs: Number.isFinite(runner.budgetMs) && runner.budgetMs > 0 ? runner.budgetMs : null, lastEvent: null });
      active = record;
      let releaseReservation;
      const reservationReady = new Promise((resolve) => { releaseReservation = resolve; });
      execution = reservationReady;
      let reservationResult;
      try {
        reservationResult = await store.mutate((next) => {
          const existing = next.reservations[requestId];
          if (existing) {
            if (existing.requestPayloadHash !== requestPayloadHash) throw serviceError('Request id is already associated with another run.', 409, 'request_id_conflict');
            return { existing: true };
          }
          record.createdSeq = next.nextSeq++;
          next.reservations[requestId] = { requestId, requestPayloadHash, runId: record.runId, status: 'queued' };
          const persisted = { ...record }; delete persisted.abortController; next.runs.push(persisted);
          return { existing: false };
        });
      } catch (error) {
        if (active?.runId === record.runId) active = null;
        releaseReservation();
        throw error;
      }
      if (reservationResult.existing) {
        if (active?.runId === record.runId) active = null;
        releaseReservation();
        return snapshot();
      }
      execution = execute(record).catch(async () => {
        record.status = 'failed';
        await store.mutate((next) => { const persisted = next.runs.find((run) => run.runId === record.runId); if (persisted) Object.assign(persisted, { status: 'failed', caseResults: record.caseResults }); if (next.reservations[record.requestId]) next.reservations[record.requestId].status = 'failed'; });
        if (active?.runId === record.runId) active = null;
      }).finally(() => { if (active?.runId === record.runId) active = null; });
      // Keep a rejection observer while close() retains the original execution result.
      execution.catch(() => {});
      releaseReservation();
      return snapshot();
    },
    async score({ runId, caseId, rubricVersion, scores }) {
      await store.mutate((state) => {
        const run = state.runs.find((item) => item.runId === runId);
        if (!run) throw serviceError('Run was not found.', 404, 'run_not_found');
        if (rubricVersion !== run.rubricVersion || !caseIdsFor(run).includes(caseId) || !validateScores(scores)) throw serviceError('Score payload is invalid.', 400, 'score_invalid');
        if (run.status !== 'completed') throw serviceError('Only completed runs can be scored.', 409, 'run_not_scoreable');
        const item = run.caseResults.find((result) => result.caseId === caseId);
        if (!item || item.status !== 'completed') throw serviceError('Case is not scoreable.', 409, 'case_not_scoreable');
        if (item.scores && JSON.stringify(item.scores) !== JSON.stringify(scores)) throw serviceError('Score already exists with different values.', 409, 'score_conflict');
        item.scores = scores;
      });
      return snapshot();
    },
    async baseline({ runId }) {
      await store.mutate((state) => {
        const run = state.runs.find((item) => item.runId === runId);
        if (!run) throw serviceError('Run was not found.', 404, 'run_not_found');
        if (run.status !== 'completed' || !completeScores(run)) throw serviceError('Baseline requires a fully scored completed run.', 409, 'baseline_not_ready');
        state.baseline = { runId: run.runId, model: run.model, cliVersion: run.cliVersion, reasoningEffort: run.reasoningEffort, caseSetVersion: run.caseSetVersion, rubricVersion: run.rubricVersion, schemaVersion: run.schemaVersion };
      });
      return snapshot();
    },
    async cancel({ requestId }) {
      if (!active || active.requestId !== requestId) {
        const state = await store.snapshot();
        const run = state.runs.find((item) => item.requestId === requestId);
        if (!run) throw serviceError('Request was not found.', 404, 'request_not_found');
        if (run.status === 'cancelled') return snapshot();
        throw serviceError('Run is already terminal.', 409, 'run_terminal');
      }
      runtime.get(active).stage = 'stopping';
      active.abortController.abort();
      return snapshot();
    },
    close() {
      if (!closePromise) {
        closing = true;
        if (active) runtime.get(active).stage = 'stopping';
        active?.abortController.abort();
        closePromise = (async () => {
          const pending = execution;
          await pending;
          if (execution !== pending) await execution;
          await store.close();
        })();
      }
      return closePromise;
    }
  };
}
