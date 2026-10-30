import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { isRegisteredCase } from './cases.js';
import { validModel, validEffort, EFFORT_VALUES } from '../telemetry/usage.js';

export const MODEL_SENTINEL = 'configured';
export const SAFE_PROGRESS_EVENTS = new Set(['thread.started', 'turn.started', 'item.started', 'item.updated', 'item.completed', 'turn.completed', 'turn.failed', 'error']);
// Cockpit generation can still be making progress after the old fifteen-minute
// cutoff. Allow twenty minutes by default, with a finite thirty-minute ceiling
// for explicit configuration; retry and cleanup policies remain unchanged.
export const DEFAULT_TIMEOUT_MS = 1200000;
export const MIN_TIMEOUT_MS = 60000;
export const MAX_TIMEOUT_MS = 1800000;
export const TIMEOUT_ENV_KEY = 'CODEX_STATELINE_PELICAN_TIMEOUT_MS';
// Legacy short names the desktop panel used before the catalog became the
// source of truth. A short name carries no provider, so the provider is taken
// from the catalog at hand rather than baked in here: any provider that serves
// the model resolves, and none is privileged.
const LEGACY_SHORT_NAMES = ['gpt-6-astra', 'gpt-6.1-sol'];
// The families the fallback gate admits. It is keyed on the model, never the
// provider: a catalog that fails to load must not strand whichever provider the
// user happens to be routing through, and a new provider needs no code change.
const FALLBACK_FAMILIES = new Set(['gpt-6-astra', 'gpt-6.1-sol', 'deepseek-v4.1-flash']);
// Static fallback, used only while the catalog is unavailable, so a missing or
// unreadable catalog cannot lock the panel out of the models Codex still runs.
export const APPROVED_MODELS = new Set([MODEL_SENTINEL, ...FALLBACK_FAMILIES]);
// The family a slug names, ignoring whichever provider prefixes it.
function modelFamily(model) {
  const slash = model.lastIndexOf('/');
  return slash < 0 ? model : model.slice(slash + 1);
}
function staticModelAllowed(model) {
  if (model === MODEL_SENTINEL) return true;
  return typeof model === 'string' && validModel(model) && FALLBACK_FAMILIES.has(modelFamily(model));
}
// The provider a bare short name belongs to, discovered from the catalog
// instead of assumed: the single provider that serves that short name wins, and
// an ambiguous or absent catalog leaves the short name alone.
function shortNameProvider(shortName, availableModels) {
  const values = policyValues(availableModels, 'slug');
  if (values === null) return null;
  const owners = new Set();
  for (const slug of values) {
    if (!validModel(slug)) continue;
    const slash = slug.lastIndexOf('/');
    if (slash > 0 && slug.slice(slash + 1) === shortName) owners.add(slug.slice(0, slash));
  }
  return owners.size === 1 ? owners.values().next().value : null;
}
function aliasSlug(shortName, availableModels) {
  const provider = shortNameProvider(shortName, availableModels);
  return provider === null ? null : provider + '/' + shortName;
}
export const EFFORTS = new Set([MODEL_SENTINEL, ...Array.from(EFFORT_VALUES)]);
export function resolveBenchmarkModel(model, availableModels = null) {
  if (typeof model !== 'string') return null;
  if (model === MODEL_SENTINEL) return MODEL_SENTINEL;
  if (!validModel(model)) return null;
  const canonical = canonicalModel(model, availableModels);
  if (canonical === null) return null;
  // Without a catalog policy the static fallback still bounds what can run.
  return staticModelAllowed(model) || staticModelAllowed(canonical) ? canonical : null;
}
// The CLI argument for an already-policy-checked model. Catalog slugs outside
// the static fallback must still reach the CLI verbatim: passing null would be
// stringified to "--model null", silently running a different model than the
// one the run records.
export function benchmarkModelArgument(model, availableModels = null) {
  return canonicalModel(model, availableModels);
}
// Identifier-shaped models resolve to their canonical slug even when they are
// not yet in the static set; catalog membership decides their policy fate.
function canonicalModel(model, availableModels = null) {
  if (model === MODEL_SENTINEL) return MODEL_SENTINEL;
  if (typeof model !== 'string' || !validModel(model)) return null;
  if (!LEGACY_SHORT_NAMES.includes(model)) return model;
  // A short name stays itself unless the catalog proves which provider owns it,
  // so an unknown catalog never invents a provider-qualified slug.
  return aliasSlug(model, availableModels) ?? model;
}
// The credential policy may arrive as the payload shape ({slug} / {value}) or
// as bare wire strings; anything else is ignored instead of trusted.
function policyValues(policy, key) {
  if (policy === null || policy === undefined) return null;
  const values = policy instanceof Set ? [...policy] : Array.isArray(policy) ? policy : [];
  const out = new Set();
  for (const item of values) {
    const value = typeof item === 'string' ? item : item && typeof item === 'object' ? item[key] : null;
    if (typeof value === 'string') out.add(value);
  }
  return out;
}
// The request policy is the configured catalog, not a static allowlist. A
// null/undefined policy keeps only the identifier guard; without any discovered
// catalog slug the historical static set still applies.
export function modelAllowlist(availableModels = null) {
  const values = policyValues(availableModels, 'slug');
  if (values === null) return null;
  // Only the catalog's own slugs. The sentinel-only case stays distinguishable so
  // the caller can fall back on families rather than on a fixed set of vendors.
  const allowed = new Set([MODEL_SENTINEL]);
  for (const slug of values) if (validModel(slug)) allowed.add(slug);
  return allowed;
}
export function effortAllowlist(availableEfforts = null) {
  const values = policyValues(availableEfforts, 'value');
  if (values === null) return null;
  const allowed = new Set([MODEL_SENTINEL]);
  for (const effort of values) if (validEffort(effort)) allowed.add(effort);
  if (allowed.size === 1) for (const effort of EFFORT_VALUES) allowed.add(effort);
  return allowed;
}
export function isAllowedModel(model, availableModels = null) {
  const canonical = canonicalModel(model, availableModels);
  if (canonical === null) return false;
  const allowed = modelAllowlist(availableModels);
  if (allowed === null) return staticModelAllowed(model) || staticModelAllowed(canonical);
  // A catalog that contributed nothing beyond the sentinel leaves the fallback
  // families in play for every provider, not just the ones spelled out above.
  if (allowed.size === 1) return staticModelAllowed(model) || staticModelAllowed(canonical);
  return allowed.has(model) || allowed.has(canonical);
}
export function isAllowedEffort(effort, availableEfforts = null) {
  const allowed = effortAllowlist(availableEfforts);
  if (allowed === null) return effort === MODEL_SENTINEL || validEffort(effort);
  return allowed.has(effort);
}
// Three independent budgets. The answer is the only part that is kept, so it
// gets the strict limit. Reasoning summaries are re-emitted in full on every
// item.completed, so a reasoning-heavy run legitimately streams far more than
// the answer it produces; the stream and line caps only guard against a
// runaway process, never against a large document.
export const MAX_ANSWER = 256 * 1024;
export const MAX_LINE = 2 * 1024 * 1024;
export const MAX_STREAM = 16 * 1024 * 1024;
export const MAX_STDERR = 64 * 1024;
export const DIAGNOSTIC_KEYS = Object.freeze(['startedAt', 'finishedAt', 'timeoutMs', 'elapsedMs', 'firstEventElapsedMs', 'lastEventElapsedMs', 'lastPhase', 'terminationReason', 'cleanupStatus', 'configWarning', 'errorEventCount', 'turnFailedEventCount', 'firstErrorElapsedMs', 'lastErrorElapsedMs', 'lastErrorClass', 'exitCode', 'stderrBytes']);
const LAST_PHASES = new Set(['queued', 'starting', 'waiting', 'generating', 'stopping', 'unknown']);
const TERMINATION_REASONS = new Set(['completed', 'budget_exhausted', 'cancelled', 'process_error', 'invalid_output']);
const CLEANUP_STATUSES = new Set(['confirmed', 'unconfirmed', 'not_needed']);
const CONFIG_WARNINGS = new Set(['timeout_config_invalid']);
const LAST_ERROR_CLASSES = new Set(['reconnect_notice', 'upstream_notice', 'authentication_notice', 'rate_limit_notice', 'model_notice', 'other']);
const GENERATION_INSTRUCTIONS = 'This is self-contained document generation. Follow the original user prompt directly and return only the requested document, without introductory prose, Markdown fences, or a closing explanation. Keep the implementation focused on the requested artwork and motion; avoid adding unrequested page sections or elaborate control panels. Do not perform repository engineering workflows or use commands, MCP tools, subagents, or file operations. Preserve all applicable safety and authorization rules.';

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

// The only place the CLI's own text is read. Two phrasings are recognised, in
// this order: the retry notice the CLI emits while it is still working ("... n/m"),
// and the bare stream loss it emits once those retries are exhausted. The first
// five notices of a failing provider run contain both phrases, so the retry
// wording must win or a run that is still retrying would be killed.
const RETRYING_MESSAGE = /reconnect|retrying/i;
const STREAM_LOST_MESSAGE = /stream disconnected before completion|connection lost mid-reply/i;

function messageOf(event) {
  const details = event.error && typeof event.error === 'object' ? event.error : event;
  return typeof event.message === 'string' ? event.message
    : typeof event.error === 'string' ? event.error
    : typeof details.message === 'string' ? details.message : '';
}

// Structured fields first, then that retry/stream-loss wording. The local process
// is never blamed for a provider that dropped the stream, because that wording
// sends people to fix a machine that is working.
function failureCode(event) {
  const details = event.error && typeof event.error === 'object' ? event.error : event;
  const status = details.status ?? details.status_code ?? details.http_status_code;
  if (status === 401) return 'authentication_failed';
  if (status === 429) return 'rate_limited';
  if (['model_not_found', 'model_not_available'].includes(details.code)) return 'model_unavailable';
  // Shares errorClassFor so classification and diagnostics can never disagree.
  if (errorClassFor(event) === 'upstream_notice') return 'upstream_stream_lost';
  return 'process_failed';
}

// Diagnostics-only coarse class: structured fields first, then the CLI's own
// wording. It decides recoverability too: the CLI reports a transient reconnect as
// an `error` event and then keeps streaming, so killing the child on it loses a
// finished artwork. The retry wording is tested first because those notices carry
// the stream-loss phrase as well, and only the retry wording means "still working".
function errorClassFor(event) {
  const details = event.error && typeof event.error === 'object' ? event.error : event;
  const status = details.status ?? details.status_code ?? details.http_status_code;
  if (status === 401) return 'authentication_notice';
  if (status === 429 || details.code === 'rate_limited') return 'rate_limit_notice';
  if (details.code === 'authentication_failed') return 'authentication_notice';
  if (['model_not_found', 'model_not_available'].includes(details.code)) return 'model_notice';
  const message = messageOf(event);
  if (RETRYING_MESSAGE.test(message)) return 'reconnect_notice';
  if (STREAM_LOST_MESSAGE.test(message)) return 'upstream_notice';
  return 'other';
}

// A reconnect notice is the CLI saying it is retrying, not a terminal failure: the
// same run can still finish and produce a complete answer. Only a structured error
// or a turn.failed ends the run.
function recoverableNotice(event) {
  return event.type === 'error' && errorClassFor(event) === 'reconnect_notice';
}

export function createRunner({ executable = resolveExecutable(), spawnImpl = spawn, taskkillImpl, timeoutMs, terminationTimeoutMs = 5000, platform = process.platform, tempRoot = tmpdir(), env = process.env, wallClock = () => Date.now(), modelPolicy, effortPolicy } = {}) {
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
      let child; let timer; let startupTimer; let abortHandler; let stopPromise; let failure;
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
      let models, efforts;
      try { models = typeof modelPolicy === 'function' ? modelPolicy() : modelPolicy; } catch { models = []; }
      try { efforts = typeof effortPolicy === 'function' ? effortPolicy() : effortPolicy; } catch { efforts = []; }
      if (!isAllowedModel(model, models) || !isAllowedEffort(reasoningEffort, efforts) || !isRegisteredCase(caseDef)) {
        const error = failWith('invalid_config');
        error.diagnostics = finish('invalid_config');
        throw error;
      }
      const cwd = await mkdtemp(join(tempRoot, 'codex-companion-'));
      const stopped = new Promise((resolve) => { resolveStopped = resolve; });
      const decoder = new StringDecoder('utf8');
      // The stream is parsed line by line as it arrives. Only the final answer is
      // retained, so a long reasoning summary cannot inflate the answer budget.
      let answer = null; let turnCompleted = false; let malformed = false; let sawFailure = null, sawReconnect = false;
      let streamBytes = 0; let stderrBytes = 0; let remainder = '';
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
        try { event = JSON.parse(line); } catch { malformed = true; return; }
        if (!event || typeof event !== 'object' || Array.isArray(event)) { malformed = true; return; }
        if (event.type === 'turn.started') {
          clearTimeout(startupTimer);
          startupTimer = null;
        }
        // Answer extraction is independent from the safe-progress allowlist: a
        // registered case may only be scored from a complete agent_message.
        if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') {
          if (Buffer.byteLength(event.item.text) > MAX_ANSWER) { void stop('answer_too_large'); return; }
          answer = event.item.text;
        }
        if (event.type === 'turn.completed' && (event.status === undefined || event.status === 'completed')) turnCompleted = true;
        // A transient reconnect notice is recoverable; killing the child here would
        // discard a run that the CLI is still retrying. Every other error event and
        // every turn.failed stays terminal.
        const notice = recoverableNotice(event);
        if (notice) sawReconnect = true;
        if (!notice && (event.type === 'error' || event.type === 'turn.failed')) {
          sawFailure ??= failureCode(event);
          void stop(sawFailure);
        }
        if (!SAFE_PROGRESS_EVENTS.has(event.type)) return;
        const failed = !notice && (event.type === 'error' || event.type === 'turn.failed');
        if (event.type.startsWith('item.') && (event.item?.type === 'reasoning' || event.item?.type === 'agent_message')) outputStarted = true;
        const elapsed = Math.max(0, wallClock() - startedMs);
        diagnostics.firstEventElapsedMs ??= elapsed;
        diagnostics.lastEventElapsedMs = elapsed;
        if (event.type === 'error' || event.type === 'turn.failed') {
          if (event.type === 'error') diagnostics.errorEventCount += 1;
          else diagnostics.turnFailedEventCount += 1;
          diagnostics.firstErrorElapsedMs ??= elapsed;
          diagnostics.lastErrorElapsedMs = elapsed;
          diagnostics.lastErrorClass = errorClassFor(event);
          // 零输出加上两次以上报错，是「上游已经死了」的确定特征：中转挂死的运行到预算
          // 耗尽都不会产出任何 item.*，而真正在推进的运行在首次报错前就已经有输出了。
          // 判据取「有没有产出过输出」而不是「静默了多久」——静默时长的可行阈值窗口只有
          // 288–332s（余量 4%），会误杀合法的长思考；同理只报一次错就掐同样有误杀风险。
          if (!outputStarted && diagnostics.errorEventCount >= 2) void stop('upstream_stalled');
        }
        publish(failed ? 'stopping' : outputStarted ? 'generating' : 'waiting', event.type);
      };
      const consumeLine = (line) => {
        const bytes = Buffer.byteLength(line, 'utf8');
        if (bytes > MAX_LINE) { void stop('output_too_large'); return; }
        observeLine(line);
      };
      // Turn EOF/decoder output into complete lines; a trailing partial line is
      // flushed by finish() so a final event without a newline is still counted.
      const consumeChunk = (text) => {
        remainder += text;
        let end;
        while ((end = remainder.indexOf('\n')) >= 0) {
          consumeLine(remainder.slice(0, end));
          remainder = remainder.slice(end + 1);
        }
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
          '-c', 'mcp_servers={}',
          '-c', 'web_search="disabled"', '-c', 'developer_instructions=' + JSON.stringify(GENERATION_INSTRUCTIONS)];
        if (model !== 'configured') {
          const argvModel = benchmarkModelArgument(model, models);
          if (argvModel === null) throw failWith('invalid_config');
          args.push('--model', argvModel);
        }
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
          streamBytes += Buffer.byteLength(chunk);
          if (streamBytes > MAX_STREAM) { void stop('output_too_large'); return; }
          consumeChunk(decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        });
        child.stderr?.on('data', (chunk) => {
          stderrBytes += Buffer.byteLength(chunk);
          diagnostics.stderrBytes = stderrBytes;
          if (stderrBytes > MAX_STDERR) void stop('output_too_large');
        });
        child.stdin?.on?.('error', () => { void stop('process_failed'); });
        timer = setTimeout(() => { void stop('timed_out'); }, budgetMs);
        if (caseDef.caseId === 'pelican-cockpit') {
          // Waiting two minutes for the first turn is not useful model reasoning.
          // Retry that startup stall through the service, but disarm this watchdog
          // as soon as a turn starts so legitimate long thinking is not killed.
          startupTimer = setTimeout(() => { void stop('upstream_stalled'); }, Math.min(120000, budgetMs));
        }
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
        // Flush the decoder and any final line that arrived without a newline.
        consumeChunk(decoder.end());
        if (remainder.trim()) consumeLine(remainder);
        remainder = '';
        if (failure) throw failWith(failure, { reason: failure });
        if (exit.signalName) throw failWith('process_failed');
        const processFailed = exit.code !== 0;
        // A reconnect followed by a natural non-zero exit is still a dropped
        // upstream turn. Preserve that evidence so the service's existing single
        // retry can run instead of misclassifying it as a local process failure.
        if (sawReconnect && !turnCompleted && processFailed) throw failWith('upstream_stream_lost');
        if (sawFailure || processFailed || malformed) throw failWith(sawFailure ?? (processFailed ? 'process_failed' : 'malformed_output'));
        if (!answer || !turnCompleted) throw failWith('incomplete_output');
        outcome = { value: { answer, stderrTruncated: stderrBytes >= MAX_STDERR } };
      } catch (error) {
        outcome = { error: error?.code ? error : failWith('spawn_failed') };
      } finally {
        clearTimeout(timer);
        clearTimeout(startupTimer);
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
