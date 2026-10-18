import net from 'node:net';
import { randomUUID } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PIPE = '\\\\.\\pipe\\codex-ipc';
const SOURCE = 'codex_app_server';
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const count = (value) => Number.isSafeInteger(value) && value >= 0;
const safePath = (value) => (typeof value === 'string' && value.length <= 256 && !['__proto__', 'prototype', 'constructor'].includes(value))
  || (Number.isSafeInteger(value) && value >= 0 && value <= 100_000);
const FIELDS = new Set(['latestTokenUsageInfo', 'threadRuntimeStatus', 'source', 'threadSource', 'parentThreadId', 'ephemeral', 'sideConversation']);

function tokens(value) {
  if (!object(value) || !['inputTokens', 'outputTokens', 'totalTokens'].every((key) => count(value[key]))
    || value.inputTokens + value.outputTokens !== value.totalTokens) return null;
  return { inputTokens: value.inputTokens, outputTokens: value.outputTokens, totalTokens: value.totalTokens };
}

function field(key, value) {
  if (key === 'latestTokenUsageInfo') return { total: tokens(value?.total) };
  if (key === 'threadRuntimeStatus') return {
    type: ['active', 'idle', 'notLoaded', 'systemError'].includes(value?.type) ? value.type : null,
    activeFlags: Array.isArray(value?.activeFlags) ? value.activeFlags.filter((flag) => ['waitingOnApproval', 'waitingOnUserInput'].includes(flag)) : [],
  };
  if (key === 'source') {
    if (['cli', 'vscode', 'exec', 'appServer', 'unknown'].includes(value)) return value;
    if (object(value) && Object.hasOwn(value, 'subAgent')) return { subAgent: true };
    return null;
  }
  if (key === 'parentThreadId') return UUID.test(value ?? '') ? value : null;
  if (key === 'threadSource') return value === 'ambient_suggestions' ? value : null;
  return typeof value === 'boolean' ? value : null;
}

// Full IPC frames include conversation text. Retain only these small counters and flags.
function project(value) {
  if (!object(value)) return null;
  return Object.fromEntries([...FIELDS].map((key) => [key, field(key, value[key])]));
}

function primary(value) {
  if (value.parentThreadId || value.source?.subAgent || value.ephemeral === true || value.sideConversation === true || value.threadSource === 'ambient_suggestions') return false;
  return ['cli', 'vscode', 'exec', 'appServer'].includes(value.source) ? true : null;
}

function applyPatch(state, patch) {
  const path = patch?.path;
  if (!Array.isArray(path) || path.length === 0 || path.length > 12 || !path.every(safePath)
    || !['add', 'replace', 'remove'].includes(patch.op)) return false;
  const key = path[0];
  if (!FIELDS.has(key)) return true;
  if (path.length === 1) { state[key] = field(key, patch.op === 'remove' ? null : patch.value); return true; }
  if (key === 'latestTokenUsageInfo') {
    if (path[1] !== 'total') return true;
    if (path.length === 2) { state[key] = { total: patch.op === 'remove' ? null : tokens(patch.value) }; return true; }
    if (path.length === 3 && ['inputTokens', 'outputTokens', 'totalTokens'].includes(path[2])) {
      state[key] ??= { total: null };
      state[key].total ??= { inputTokens: null, outputTokens: null, totalTokens: null };
      state[key].total[path[2]] = patch.op !== 'remove' && count(patch.value) ? patch.value : null;
    }
    return true;
  }
  if (key === 'threadRuntimeStatus') {
    if (path.length === 2 && path[1] === 'type') state[key].type = field(key, { type: patch.value }).type;
    else if (path[1] === 'activeFlags') state[key].activeFlags = [];
    return true;
  }
  // A changed ancestry field needs a fresh snapshot rather than guessing its meaning.
  return false;
}

export function createDesktopLiveConnector({
  pipePath = PIPE, connect = (path) => net.createConnection(path), wallClock = () => Date.now(),
  now = () => performance.now(), maxFrameBytes = 32 * 1024 * 1024, maxCandidates = 8,
  leaseMs = 8_000, refreshMs = 30_000, reconnectMs = 1_000, discoverySettleMs = 500,
} = {}) {
  return ({ status, observe }) => {
    let socket = null, clientId = null, stopped = false, started = false, timer = null;
    let buffer = Buffer.alloc(0), selected = null, lastRead = null, openedAt = null, retryAt = 0, ready = false;
    const candidates = new Map(), requests = new Map();

    function send(message) {
      if (!socket || socket.destroyed || !socket.writable) return;
      const body = Buffer.from(JSON.stringify(message), 'utf8'), header = Buffer.alloc(4);
      header.writeUInt32LE(body.length);
      socket.write(Buffer.concat([header, body]));
    }
    function follow(entry, following) {
      if (!clientId || !entry.owner) return;
      send({ type: 'broadcast', method: 'thread-stream-following-changed', version: 1, sourceClientId: clientId,
        targetClientIds: [entry.owner], params: { conversationId: entry.id, hostId: 'local', following } });
      entry.subscribed = following;
    }
    function remove(entry) {
      if (entry.subscribed) follow(entry, false);
      candidates.delete(entry.id);
      for (const [id, pending] of requests) if (pending.threadId === entry.id) requests.delete(id);
      observe({ type: 'removed', threadId: entry.id });
    }
    function disconnect(reason = 'source_disconnected') {
      const old = socket;
      for (const entry of candidates.values()) if (entry.subscribed) follow(entry, false);
      candidates.clear(); requests.clear(); socket = null; clientId = null; ready = false; buffer = Buffer.alloc(0);
      old?.destroy(); retryAt = now() + reconnectMs;
      status({ connected: false, source: SOURCE, reason });
    }
    function request(method, params, version, threadId = null) {
      const requestId = randomUUID();
      requests.set(requestId, { method, threadId, deadline: now() + 5_000 });
      send({ type: 'request', requestId, sourceClientId: clientId ?? 'initializing-client', version, method, params, timeoutMs: 5_000 });
    }
    function candidate(id, interestedBy = null) {
      if (!UUID.test(id ?? '')) return;
      let entry = candidates.get(id);
      if (!entry) {
        if (candidates.size >= maxCandidates) { disconnect('capacity_exceeded'); return; }
        if (ready) { ready = false; status({ connected: false, source: SOURCE, reason: 'connecting' }); }
        entry = { id, owner: null, subscribed: false, interests: new Set(), revision: null, state: null, resyncing: false, deadline: now() + 5_000 };
        candidates.set(id, entry);
        request('thread-owner-discovery', { hostId: 'local', conversationId: id }, 1, id);
      }
      if (interestedBy && entry.interests.size < 32) entry.interests.add(interestedBy);
    }
    function publish(entry) {
      const value = entry.state;
      if (!value || !ready) return;
      const runtime = value.threadRuntimeStatus?.type;
      if (!['active', 'idle', 'systemError'].includes(runtime)) { observe({ type: 'removed', threadId: entry.id }); return; }
      observe({ type: 'conversation', threadId: entry.id, primary: primary(value),
        state: runtime === 'active' ? 'active' : runtime === 'systemError' ? 'failed' : 'idle',
        usage: tokens(value.latestTokenUsageInfo?.total), observedAt: new Date(wallClock()).toISOString() });
    }
    function resync(entry) {
      ready = false;
      status({ connected: false, source: SOURCE, reason: 'connecting' });
      entry.state = null; entry.deadline = now() + 5_000;
      if (!entry.resyncing) { entry.resyncing = true; follow(entry, true); }
    }
    function handle(message) {
      if (!object(message)) return;
      if (message.type === 'client-discovery-request') {
        if (typeof message.requestId === 'string' && message.requestId.length <= 256)
          send({ type: 'client-discovery-response', requestId: message.requestId, response: { canHandle: false } });
        return;
      }
      if (message.type === 'response') {
        const pending = requests.get(message.requestId);
        if (!pending) return;
        requests.delete(message.requestId);
        if (message.method !== pending.method || message.resultType !== 'success') {
          if (pending.method === 'initialize') disconnect('source_unavailable');
          else disconnect('identity_unverified');
          return;
        }
        if (pending.method === 'initialize') {
          if (typeof message.result?.clientId !== 'string' || message.result.clientId.length > 256) return disconnect('source_invalid');
          clientId = message.result.clientId;
          if (selected !== null) candidate(selected);
        } else {
          const entry = candidates.get(pending.threadId);
          if (!entry) return;
          if (typeof message.handledByClientId !== 'string' || message.handledByClientId.length > 256) return disconnect('identity_unverified');
          entry.owner = message.handledByClientId;
          follow(entry, true);
        }
        return;
      }
      if (!clientId || message.type !== 'broadcast') return;
      const params = message.params;
      if (message.method === 'ipc-connection-reset') return disconnect();
      if (message.method === 'client-status-changed' && params?.status === 'disconnected') {
        if ([...candidates.values()].some((entry) => entry.owner === params.clientId || entry.interests.has(params.clientId))) disconnect();
        return;
      }
      if (!object(params) || params.hostId !== 'local' || !UUID.test(params.conversationId ?? '')) return;
      if (message.method === 'thread-stream-following-changed' && message.version === 1 && message.sourceClientId !== clientId) {
        if (selected !== null) return;
        if (params.following === true) candidate(params.conversationId, message.sourceClientId);
        else if (params.following === false) {
          const entry = candidates.get(params.conversationId);
          entry?.interests.delete(message.sourceClientId);
          if (entry && entry.interests.size === 0) remove(entry);
        }
        return;
      }
      if (message.method !== 'thread-stream-state-changed') return;
      const entry = candidates.get(params.conversationId);
      if (!entry?.subscribed || message.sourceClientId !== entry.owner) return;
      if (message.version !== 11) return disconnect('source_invalid');
      const change = params.change;
      if (!object(change) || !count(change.revision)) return disconnect('source_invalid');
      if (change.type === 'snapshot') {
        if (entry.revision !== null && change.revision < entry.revision) return;
        const value = change.conversationState;
        if (!object(value) || value.id !== entry.id) return disconnect('identity_unverified');
        entry.state = project(value); entry.revision = change.revision; entry.resyncing = false;
        publish(entry);
      } else if (change.type === 'patches') {
        if (entry.revision !== null && change.revision <= entry.revision) return;
        if (!entry.state || change.baseRevision !== entry.revision || !Array.isArray(change.patches) || change.patches.length > 20_000) {
          resync(entry);
          return;
        }
        for (const patch of change.patches) if (!applyPatch(entry.state, patch)) {
          resync(entry);
          return;
        }
        entry.revision = change.revision;
        publish(entry);
      }
    }
    function open() {
      if (stopped || socket) return;
      openedAt = now();
      try {
        const active = connect(pipePath); socket = active;
        active.on('connect', () => { if (socket === active) request('initialize', { clientType: 'desktop' }, 0); });
        active.on('data', (chunk) => {
          if (socket !== active) return;
          buffer = Buffer.concat([buffer, chunk]);
          while (buffer.length >= 4 && socket === active) {
            const length = buffer.readUInt32LE(0);
            if (length === 0 || length > maxFrameBytes) return disconnect('capacity_exceeded');
            if (buffer.length < length + 4) return;
            const frame = buffer.subarray(4, length + 4);
            buffer = buffer.length === length + 4 ? Buffer.alloc(0) : Buffer.from(buffer.subarray(length + 4));
            try { handle(JSON.parse(frame.toString('utf8'))); } catch { return disconnect('source_invalid'); }
          }
        });
        active.on('error', () => { if (socket === active) disconnect('source_unavailable'); });
        active.on('close', () => { if (socket === active) disconnect(); });
      } catch { disconnect('source_unavailable'); }
    }
    function tick() {
      if (stopped) return;
      if (lastRead === null || now() - lastRead > leaseMs) {
        if (socket) disconnect('source_unavailable');
        return;
      }
      if (socket && now() - openedAt > refreshMs) disconnect();
      for (const [id, pending] of requests) if (pending.deadline < now()) {
        requests.delete(id);
        if (pending.method === 'initialize') disconnect('source_unavailable');
        else disconnect('identity_unverified');
      }
      for (const entry of candidates.values()) if (!entry.state && entry.deadline < now()) { disconnect('source_unavailable'); break; }
      if (!socket && now() >= retryAt) open();
      if (clientId && socket?.writable) {
        if (!ready && now() - openedAt >= discoverySettleMs && requests.size === 0 && [...candidates.values()].every((entry) => entry.state !== null)) {
          ready = true;
          status({ connected: true, source: SOURCE });
          for (const entry of candidates.values()) publish(entry);
        }
        if (ready) observe({ type: 'heartbeat' });
      }
    }
    return {
      start() { if (started || stopped) return; started = true; timer = setInterval(tick, 250); timer.unref?.(); },
      select(taskId) {
        if (stopped || (taskId !== null && !UUID.test(taskId ?? ''))) return;
        lastRead = now();
        if (selected !== taskId) {
          for (const entry of [...candidates.values()]) remove(entry);
          selected = taskId;
          if (selected === null && socket) disconnect();
        }
        if (clientId && selected !== null) candidate(selected);
        if (!socket && now() >= retryAt) open();
      },
      stop() { if (stopped) return; stopped = true; clearInterval(timer); disconnect(); },
    };
  };
}
