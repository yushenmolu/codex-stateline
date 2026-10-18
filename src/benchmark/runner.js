import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { isRegisteredCase } from './cases.js';

export const APPROVED_MODELS = new Set(['configured', 'example-provider/gpt-6-astra', 'example-provider/gpt-6.1-sol', 'example-provider/deepseek-v4.1-flash', 'gpt-6-astra', 'gpt-6.1-sol']);
export const SAFE_PROGRESS_EVENTS = new Set(['thread.started', 'turn.started', 'item.started', 'item.updated', 'item.completed', 'turn.completed', 'turn.failed', 'error']);
export const DEFAULT_TIMEOUT_MS = 900000;
export const MIN_TIMEOUT_MS = 60000;
export const MAX_TIMEOUT_MS = 900000;
export const TIMEOUT_ENV_KEY = 'CODEX_STATELINE_PELICAN_TIMEOUT_MS';
export function resolveBenchmarkModel(model) {
  if (!APPROVED_MODELS.has(model)) return null;
  return model === 'gpt-6-astra' || model === 'gpt-6.1-sol' ? 'example-provider/' + model : model;
}
const EFFORTS = new Set(['configured', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const MAX_STDOUT = 256 * 1024;
const MAX_STDERR = 64 * 1024;
export const DIAGNOSTIC_KEYS = Object.freeze(['startedAt', 'finishedAt', 'timeoutMs', 'elapsedMs', 'firstEventElapsedMs', 'lastEventElapsedMs', 'lastPhase', 'terminationReason', 'cleanupStatus', 'configWarning', 'errorEventCount', 'turnFailedEventCount', 'firstErrorElapsedMs', 'lastErrorElapsedMs', 'lastErrorClass', 'exitCode', 'stderrBytes']);
const LAST_PHASES = new Set(['queued', 'starting', 'waiting', 'generating', 'stopping', 'unknown']);
const TERMINATION_REASONS = new Set(['completed', 'budget_exhausted', 'cancelled', 'process_error', 'invalid_output']);
const CLEANUP_STATUSES = new Set(['confirmed', 'unconfirmed', 'not_needed']);
const CONFIG_WARNINGS = new Set(['timeout_config_invalid']);
const LAST_ERROR_CLASSES = new Set(['reconnect_notice', 'authentication_notice', 'rate_limit_notice', 'model_notice', 'other']);
const GENERATION_INSTRUCTIONS = 'This is self-contained document generation. Follow the original user prompt directly and return the requested document. Do not perform repository engineering workflows or use commands, MCP tools, subagents, or file operations. Preserve all applicable safety and authorization rules.';

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function terminationReasonFor(code) {
  if (code === 'completed') return 'completed';
  if (code === 'timed_out') return 'budget_exhausted';
  if (code === 'cancelled') return 'cancelled';
  if (['malformed_output', 'incomplete_output', 'answer_too_large', 'output_too_large'].includes(code)) return 'invalid_output';
  return 'process_error';
}

// Copy only allowlisted, type-checked diagnostics; unknown keys and values never reach persistence.
export function pickDiagnostics(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const iso = (input) => typeof input === 'string' && Number.isFinite(Date.parse(input)) ? input : null;
  const count = (input) => Number.isFinite(input) && input >= 0 ? input : null;
  const positive = (input) => Number.isFinite(input) && input > 0 ? input : null;
  return {
    startedAt: iso(value.startedAt),
    finishedAt: iso(value.finishedAt),
    timeoutMs: positive(value.timeoutMs),
    elapsedMs: count(value.elapsedMs),
    firstEventElapsedMs: count(value.firstEventElapsedMs),
    lastEventElapsedMs: count(value.lastEventElapsedMs),
    lastPhase: LAST_PHASES.has(value.lastPhase) ? value.lastPhase : 'unknown',
    terminationReason: TERMINATION_REASONS.has(value.terminationReason) ? value.terminationReason : 'process_error',
    cleanupStatus: CLEANUP_STATUSES.has(value.cleanupStatus) ? value.cleanupStatus : 'unconfirmed',
    // Stable optional field: only the allowlisted token is ever copied, never raw env input.
    configWarning: CONFIG_WARNINGS.has(value.configWarning) ? value.configWarning : null,
    errorEventCount: count(value.errorEventCount),
    turnFailedEventCount: count(value.turnFailedEventCount),
    firstErrorElapsedMs: count(value.firstErrorElapsedMs),
    lastErrorElapsedMs: count(value.lastErrorElapsedMs),
    // Coarse classification only; the source message is never stored, just the enum token.
    lastErrorClass: LAST_ERROR_CLASSES.has(value.lastErrorClass) ? value.lastErrorClass : null,
    exitCode: Number.isInteger(value.exitCode) ? value.exitCode : null,
    stderrBytes: count(value.stderrBytes)
  };
}

/** Resolve the npm native Codex binary before falling back to PATH. */
export function resolveExecutable({ explicit = process.env.CODEX_EXE, env = process.env, platform = process.platform, arch = process.arch, exists = existsSync } = {}) {
  if (typeof explicit === 'string' && explicit.length > 0) return explicit;
  if (platform !== 'win32') return 'codex';
  const nativePackage = arch === 'arm64' ? 'codex-win32-arm64' : 'codex-win32-x64';
  const target = arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
  const packageRoots = unique([
    env.APPDATA && join(env.APPDATA, 'npm', 'node_modules', '@openai', 'codex'),
    env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'npm', 'node_modules', '@openai', 'codex'),
    join(process.cwd(), 'node_modules', '@openai', 'codex')
  ]);
  const candidates = packageRoots.map((root) => join(root, 'node_modules', '@openai', nativePackage, 'vendor', target, 'bin', 'codex.exe'));
  return candidates.find((candidate) => exists(candidate)) ?? 'codex.exe';
}

// An explicit option wins (tests inject short budgets), then a strict decimal env override, then the default.
export function resolveTimeoutMs({ explicit, env = process.env } = {}) {
  if (Number.isFinite(explicit) && explicit > 0) return { timeoutMs: explicit, configWarning: null };
  const raw = env ? env[TIMEOUT_ENV_KEY] : undefined;
  if (raw === undefined || raw === null || raw === '') return { timeoutMs: DEFAULT_TIMEOUT_MS, configWarning: null };
  const invalid = { timeoutMs: DEFAULT_TIMEOUT_MS, configWarning: 'timeout_config_invalid' };
  if (typeof raw !== 'string' || !/^[1-9][0-9]*$/.test(raw)) return invalid;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < MIN_TIMEOUT_MS || value > MAX_TIMEOUT_MS) return invalid;
  return { timeoutMs: value, configWarning: null };
}

// Inspect only explicit fields on CLI failure events; never infer from message/stderr.
function failureCode(event) {
  const details = event.error && typeof event.error === 'object' ? event.error : event;
  const status = details.status ?? details.status_code ?? details.http_status_code;
  if (status === 401) return 'authentication_failed';
  if (status === 429) return 'rate_limited';
  if (['model_not_found', 'model_not_available'].includes(details.code)) return 'model_unavailable';
  return 'process_failed';
}

// Diagnostics-only coarse class: structured fields first, then the CLI reconnect notice text.
// It never feeds failureCode, so classification can never widen what counts as a failure.
function errorClassFor(event) {
  const details = event.error && typeof event.error === 'object' ? event.error : event;
  const status = details.status ?? details.status_code ?? details.http_status_code;
  if (status === 401) return 'authentication_notice';
  if (status === 429 || details.code === 'rate_limited') return 'rate_limit_notice';
  if (details.code === 'authentication_failed') return 'authentication_notice';
  if (['model_not_found', 'model_not_available'].includes(details.code)) return 'model_notice';
  const message = typeof event.message === 'string' ? event.message
    : typeof event.error === 'string' ? event.error
    : typeof details.message === 'string' ? details.message : '';
  return /reconnect|retrying/i.test(message) ? 'reconnect_notice' : 'other';
}

function parseOutput(text, processFailed = false) {
  let final = null;
  let completed = false;
  let malformed = false;
  let failure = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { malformed = true; continue; }
    if (!event || typeof event !== 'object' || Array.isArray(event)) { malformed = true; continue; }
    if (event.type === 'error' || event.type === 'turn.failed') { failure ??= failureCode(event); continue; }
    if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') {
      if (Buffer.byteLength(event.item.text) > MAX_STDOUT) throw Object.assign(new Error('answer_too_large'), { code: 'answer_too_large' });
      final = event.item.text;
    }
    if (event.type === 'turn.completed' && (event.status === undefined || event.status === 'completed')) completed = true;
  }
  if (failure || processFailed || malformed) {
    const code = failure ?? (processFailed ? 'process_failed' : 'malformed_output');
    throw Object.assign(new Error(code), { code });
  }
  if (!final || !completed) throw Object.assign(new Error('incomplete_output'), { code: 'incomplete_output' });
  return final;
}

export function createRunner({ executable = resolveExecutable(), spawnImpl = spawn, taskkillImpl, timeoutMs, terminationTimeoutMs = 5000, platform = process.platform, tempRoot = tmpdir(), env = process.env, wallClock = () => Date.now() } = {}) {
  const resolved = resolveTimeoutMs({ explicit: timeoutMs, env });
  const budgetMs = resolved.timeoutMs;
  const configWarning = resolved.configWarning;
  const killTree = taskkillImpl ?? ((pid) => {
    const helper = spawnImpl(
      process.env.SystemRoot ? join(process.env.SystemRoot, 'System32', 'taskkill.exe') : 'taskkill.exe',
      ['/PID', String(pid), '/T', '/F'],
      { windowsHide: true, shell: false, stdio: 'ignore' }
    );
    let closed = false, resolveExit;
    const helperExit = new Promise(resolve => { resolveExit = resolve; });
    const result = new Promise((resolve, reject) => {
      helper.once('close', code => { closed = true; resolveExit(true); code === 0 ? resolve() : reject(new Error('taskkill_failed')); });
      helper.once('error', () => {
        // A spawn error without a PID never created an owned process.
        if (!Number.isInteger(helper.pid)) { closed = true; resolveExit(true); }
        reject(new Error('taskkill_failed'));
      });
    });
    return { result, async cleanup() {
      if (closed) return true;
      try { helper.kill('SIGKILL'); } catch { /* Close confirmation decides cleanup. */ }
      let timer;
      try { return await Promise.race([helperExit, new Promise(resolve => { timer = setTimeout(() => resolve(false), terminationTimeoutMs / 4); })]); }
      finally { clearTimeout(timer); }
    } };
  });
  return {
    budgetMs,
    async runCase({ model = 'configured', reasoningEffort = 'configured', caseDef, signal, onProgress }) {
      let child; let timer; let abortHandler; let stopPromise; let failure;
      let exited; let exitConfirmed = false; let helperCleanupConfirmed = true; let resolveStopped;
      const startedMs = wallClock();
      const diagnostics = {
        startedAt: new Date(startedMs).toISOString(), finishedAt: null, timeoutMs: budgetMs, elapsedMs: null,
        firstEventElapsedMs: null, lastEventElapsedMs: null, lastPhase: 'unknown',
        terminationReason: 'process_error', cleanupStatus: 'not_needed', configWarning,
        errorEventCount: 0, turnFailedEventCount: 0, firstErrorElapsedMs: null, lastErrorElapsedMs: null,
        lastErrorClass: null, exitCode: null, stderrBytes: 0
      };
      const finish = (reason, directoryRemoved) => {
        const at = wallClock();
        diagnostics.finishedAt = new Date(at).toISOString();
        diagnostics.elapsedMs = Math.max(0, at - startedMs);
        diagnostics.terminationReason = terminationReasonFor(reason);
        diagnostics.cleanupStatus = !child ? 'not_needed'
          : exitConfirmed && helperCleanupConfirmed && directoryRemoved ? 'confirmed' : 'unconfirmed';
        return pickDiagnostics(diagnostics);
      };
      const failWith = (code, { message = code, reason, cleanupState } = {}) => {
        const error = new Error(message);
        error.code = code;
        if (reason !== undefined) error.reason = reason;
        if (cleanupState !== undefined) error.cleanupState = cleanupState;
        return error;
      };
      if (!APPROVED_MODELS.has(model) || !EFFORTS.has(reasoningEffort) || !isRegisteredCase(caseDef)) {
        const error = failWith('invalid_config');
        error.diagnostics = finish('invalid_config');
        throw error;
      }
      const cwd = await mkdtemp(join(tempRoot, 'codex-companion-'));
      const stopped = new Promise((resolve) => { resolveStopped = resolve; });
      const decoder = new StringDecoder('utf8');
      let out = ''; let outputBytes = 0; let stderrBytes = 0; let progressRemainder = '';
      let lastEvent = null; let outputStarted = false;
      const publish = (stage, type = null) => {
        const at = new Date(wallClock()).toISOString();
        if (type) lastEvent = { type, at };
        const effectiveStage = failure || stopPromise ? 'stopping' : stage;
        diagnostics.lastPhase = effectiveStage;
        onProgress?.({ stage: effectiveStage, budgetMs, lastEvent: lastEvent ? { ...lastEvent } : null, observedAt: at });
      };
      const observeLine = (line) => {
        if (!line.trim()) return;
        let event;
        try { event = JSON.parse(line); } catch { return; }
        if (!event || typeof event !== 'object' || Array.isArray(event) || !SAFE_PROGRESS_EVENTS.has(event.type)) return;
        const failed = event.type === 'error' || event.type === 'turn.failed';
        if (event.type.startsWith('item.') && (event.item?.type === 'reasoning' || event.item?.type === 'agent_message')) outputStarted = true;
        const elapsed = Math.max(0, wallClock() - startedMs);
        diagnostics.firstEventElapsedMs ??= elapsed;
        diagnostics.lastEventElapsedMs = elapsed;
        if (failed) {
          if (event.type === 'error') diagnostics.errorEventCount += 1;
          else diagnostics.turnFailedEventCount += 1;
          diagnostics.firstErrorElapsedMs ??= elapsed;
          diagnostics.lastErrorElapsedMs = elapsed;
          diagnostics.lastErrorClass = errorClassFor(event);
        }
        publish(failed ? 'stopping' : outputStarted ? 'generating' : 'waiting', event.type);
        if (failed) void stop(failureCode(event));
      };
      const stop = (code) => {
        failure ??= code;
        publish('stopping');
        // EOF failure classification may run after close. Never address a stale PID.
        if (exitConfirmed) return exited;
        if (!stopPromise) {
          stopPromise = (async () => {
            let deadlineTimer, killTimer, operation;
            const deadline = new Promise(resolve => { deadlineTimer = setTimeout(() => resolve(null), terminationTimeoutMs); });
            try {
              try {
                if (platform === 'win32' && Number.isInteger(child?.pid)) {
                  operation = killTree(child.pid);
                  await Promise.race([operation?.result ?? operation, new Promise((_resolve, reject) => {
                    killTimer = setTimeout(() => reject(new Error('taskkill_failed')), terminationTimeoutMs / 2);
                  })]);
                } else child?.kill?.('SIGKILL');
              } catch {
                if (!exitConfirmed) { try { child?.kill?.('SIGKILL'); } catch { /* Exit confirmation remains authoritative. */ } }
              } finally {
                clearTimeout(killTimer);
                if (operation?.cleanup) {
                  try { helperCleanupConfirmed = await operation.cleanup(); }
                  catch { helperCleanupConfirmed = false; }
                }
              }
              return await Promise.race([exited, deadline]);
            } finally { clearTimeout(deadlineTimer); clearTimeout(killTimer); }
          })();
          resolveStopped(stopPromise);
        }
        return stopPromise;
      };
      let directoryRemoved = false;
      let outcome;
      try {
        if (signal?.aborted) throw failWith('cancelled');
        const args = ['exec', '--json', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only',
          '--disable', 'shell_tool', '--disable', 'multi_agent', '--disable', 'apps', '--disable', 'plugins',
          '-c', 'mcp_servers.comsol_gui.enabled=false', '-c', 'mcp_servers.node_repl.enabled=false',
          '-c', 'web_search="disabled"', '-c', 'developer_instructions=' + JSON.stringify(GENERATION_INSTRUCTIONS)];
        if (model !== 'configured') args.push('--model', resolveBenchmarkModel(model));
        if (reasoningEffort !== 'configured') args.push('-c', 'model_reasoning_effort=' + reasoningEffort);
        args.push('-');
        publish('starting');
        try { child = spawnImpl(executable, args, { cwd, shell: false, windowsHide: true, env: { ...process.env } }); }
        catch { throw failWith('spawn_failed'); }
        exited = new Promise((resolve) => {
          child.once('close', (code, signalName) => {
            exitConfirmed = true;
            diagnostics.exitCode = Number.isInteger(code) ? code : null;
            resolve({ code, signalName });
          });
          child.once('error', () => {
            failure ??= 'spawn_failed';
            if (Number.isInteger(child.pid)) void stop('spawn_failed');
            else { exitConfirmed = true; resolve({ code: null }); }
          });
        });
        child.stdout?.on('data', (chunk) => {
          outputBytes += Buffer.byteLength(chunk);
          if (outputBytes > MAX_STDOUT) { void stop('output_too_large'); return; }
          const decoded = decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          out += decoded;
          progressRemainder += decoded;
          let end;
          while ((end = progressRemainder.indexOf('\n')) >= 0) {
            observeLine(progressRemainder.slice(0, end));
            progressRemainder = progressRemainder.slice(end + 1);
          }
        });
        child.stderr?.on('data', (chunk) => {
          stderrBytes += Buffer.byteLength(chunk);
          diagnostics.stderrBytes = stderrBytes;
          if (stderrBytes > MAX_STDERR) void stop('output_too_large');
        });
        child.stdin?.on?.('error', () => { void stop('process_failed'); });
        timer = setTimeout(() => { void stop('timed_out'); }, budgetMs);
        abortHandler = () => { void stop('cancelled'); };
        signal?.addEventListener('abort', abortHandler, { once: true });
        if (signal?.aborted) abortHandler();
        publish('waiting');
        try { child.stdin?.end(caseDef.prompt); }
        catch { await stop('process_failed'); }
        const exit = await Promise.race([exited, stopped]);
        await stopPromise;
        if (!exit || !helperCleanupConfirmed) throw failWith('process_failed', {
          message: 'termination_unconfirmed; temporary_directory_retained', reason: failure,
          cleanupState: 'temporary_directory_retained_process_exit_unconfirmed'
        });
        const decoderTail = decoder.end();
        out += decoderTail;
        observeLine(progressRemainder + decoderTail);
        if (failure) throw failWith(failure, { reason: failure });
        if (exit.signalName) throw failWith('process_failed');
        outcome = { value: { answer: parseOutput(out, exit.code !== 0), stderrTruncated: stderrBytes >= MAX_STDERR } };
      } catch (error) {
        outcome = { error: error?.code ? error : failWith('spawn_failed') };
      } finally {
        clearTimeout(timer);
        if (abortHandler) signal?.removeEventListener('abort', abortHandler);
        try { await stopPromise; } catch { /* Terminal classification is produced below. */ }
        try {
          if (!child || (exitConfirmed && helperCleanupConfirmed)) {
            await rm(cwd, { recursive: true, force: true });
            directoryRemoved = true;
          }
        } catch { /* Cleanup failure stays visible through diagnostics instead of masking the failure. */ }
      }
      if (outcome.error) {
        outcome.error.diagnostics = finish(outcome.error.reason ?? outcome.error.code, directoryRemoved);
        throw outcome.error;
      }
      outcome.value.diagnostics = finish('completed', directoryRemoved);
      return outcome.value;
    }
  };
}
