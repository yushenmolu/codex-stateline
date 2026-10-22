// Read-only probe: enumerate EVERY conversation the Codex app-server is willing
// to stream, follow all of them, and dump each one's runtime state + token
// counters. Used to check whether the widget picks the conversation the user is
// actually looking at.
import net from 'node:net';
import { randomUUID } from 'node:crypto';

const PIPE = '\\\\.\\pipe\\codex-ipc';
const seconds = Number(process.argv[2] ?? 15);
const socket = net.createConnection(PIPE);
let buffer = Buffer.alloc(0);
let clientId = null;
const threads = new Map();
const requests = new Map();
const followedTo = new Map();

function send(message) {
  if (socket.destroyed || !socket.writable) return;
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  socket.write(Buffer.concat([header, body]));
}
function request(method, params, version, threadId = null) {
  const requestId = randomUUID();
  requests.set(requestId, { method, threadId });
  send({ type: 'request', requestId, sourceClientId: clientId ?? 'initializing-client', version, method, params, timeoutMs: 5000 });
}
function follow(conversationId, owner, on) {
  send({ type: 'broadcast', method: 'thread-stream-following-changed', version: 1, sourceClientId: clientId,
    targetClientIds: [owner], params: { conversationId, hostId: 'local', following: on } });
}

socket.on('connect', () => request('initialize', { clientType: 'desktop' }, 0));
socket.on('error', (error) => { console.log('ERROR', error.code, error.message); process.exit(1); });
socket.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length >= 4) {
    const length = buffer.readUInt32LE(0);
    if (buffer.length < length + 4) return;
    const frame = buffer.subarray(4, length + 4);
    buffer = buffer.length === length + 4 ? Buffer.alloc(0) : Buffer.from(buffer.subarray(length + 4));
    let message;
    try { message = JSON.parse(frame.toString('utf8')); } catch { continue; }
    handle(message);
  }
});

function primary(value) {
  if (value.parentThreadId || value.source?.subAgent || value.ephemeral === true || value.sideConversation === true || value.threadSource === 'ambient_suggestions') return false;
  return ['cli', 'vscode', 'exec', 'appServer'].includes(value.source) ? true : null;
}

function handle(message) {
  if (!message || typeof message !== 'object') return;
  if (message.type === 'client-discovery-request') {
    if (typeof message.requestId === 'string') send({ type: 'client-discovery-response', requestId: message.requestId, response: { canHandle: false } });
    return;
  }
  if (message.type === 'response') {
    const pending = requests.get(message.requestId);
    requests.delete(message.requestId);
    if (pending?.method === 'initialize' && message.result?.clientId) { clientId = message.result.clientId; return; }
    if (pending?.method === 'thread-owner-discovery' && message.resultType === 'success' && message.handledByClientId) {
      const entry = threads.get(pending.threadId);
      if (entry && followedTo.get(entry.id) !== message.handledByClientId) {
        followedTo.set(entry.id, message.handledByClientId);
        follow(entry.id, message.handledByClientId, true);
      }
    }
    return;
  }
  if (message.type !== 'broadcast' || !clientId) return;
  const params = message.params;
  if (!params || typeof params !== 'object') return;
  if (message.method === 'thread-stream-following-changed' && params.following === true && message.sourceClientId !== clientId) {
    const id = params.conversationId;
    if (!threads.has(id)) {
      threads.set(id, { id, rev: null, state: null });
      request('thread-owner-discovery', { hostId: 'local', conversationId: id }, 1, id);
    }
    return;
  }
  if (message.method !== 'thread-stream-state-changed') return;
  const entry = threads.get(params.conversationId);
  if (!entry) return;
  const change = params.change;
  if (change?.type === 'snapshot') {
    entry.state = change.conversationState ?? null;
    entry.rev = change.revision;
  } else if (change?.type === 'patches' && entry.state && Array.isArray(change.patches)) {
    for (const patch of change.patches) {
      const path = patch.path ?? [];
      if (path[0] === 'latestTokenUsageInfo' && path[1] === 'total' && path.length === 3 && entry.state.latestTokenUsageInfo?.total) {
        entry.state.latestTokenUsageInfo.total[path[2]] = patch.op === 'remove' ? null : patch.value;
      }
      if (path[0] === 'threadRuntimeStatus' && path[1] === 'type') entry.state.threadRuntimeStatus = { ...(entry.state.threadRuntimeStatus ?? {}), type: patch.value };
      if (path[0] === 'latestModel') entry.state.latestModel = patch.value;
    }
    entry.rev = change.revision;
    entry.patches = (entry.patches ?? 0) + change.patches.length;
  }
}

setTimeout(() => {
  console.log('THREADS', threads.size);
  for (const entry of threads.values()) {
    const s = entry.state;
    if (!s) { console.log('-', entry.id, 'no snapshot'); continue; }
    const t = s.latestTokenUsageInfo?.total;
    console.log(JSON.stringify({
      id: entry.id, rev: entry.rev,
      runtimeFull:JSON.stringify(v.threadRuntimeStatus),runtime: s.threadRuntimeStatus?.type, patches: entry.patches ?? 0,
      primary: primary(s), source: s.source, parent: s.parentThreadId ?? null,
      ephemeral: s.ephemeral ?? null, side: s.sideConversation ?? null,
      model: s.latestModel ?? null,
      total: t ? { input: t.inputTokens, cached: t.cachedInputTokens, output: t.outputTokens, total: t.totalTokens } : null,
      last: s.latestTokenUsageInfo?.last ? { input: s.latestTokenUsageInfo.last.inputTokens, output: s.latestTokenUsageInfo.last.outputTokens } : null,
      ctx: s.latestTokenUsageInfo?.modelContextWindow ?? null,
    }));
  }
  process.exit(0);
}, seconds * 1000);
