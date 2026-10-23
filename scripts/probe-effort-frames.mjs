// Read-only probe: what do live thread snapshots actually carry for `latestModel`
// and `latestReasoningEffort`? The card falls back to its unknown label whenever
// provider switch is exactly when they go missing, so print both verbatim per frame.
import net from 'node:net';
import { randomUUID } from 'node:crypto';

const PIPE = '\\\\.\\pipe\\codex-ipc';
const seconds = Number(process.argv[2] ?? 20);
const socket = net.createConnection(PIPE);
let buffer = Buffer.alloc(0);
let clientId = null;
const requests = new Map();
const threads = new Map();
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
    buffer = Buffer.from(buffer.subarray(length + 4));
    let message;
    try { message = JSON.parse(frame.toString('utf8')); } catch { continue; }
    handle(message);
  }
});

function report(entry, tag) {
  const s = entry.state ?? {};
  console.log(JSON.stringify({
    tag, id: entry.id.slice(0, 8), rev: entry.revision ?? null,
    runtime: s.threadRuntimeStatus?.type ?? null,
    model: s.latestModel ?? null,
    effort: s.latestReasoningEffort ?? null,
    // Every key that could plausibly hold a level the card is not reading.
    levelFields: Object.fromEntries(Object.entries(s).filter(([k]) => /effort|reason|model|level|provider/i.test(k)).map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v).slice(0, 200) : v])),
  }));
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
        console.log(`FOLLOW ${entry.id.slice(0, 8)} via ${message.handledByClientId.slice(0, 8)}`);
      }
    }
    return;
  }
  if (message.type !== 'broadcast' || !clientId) return;
  const params = message.params;
  if (!params || typeof params !== 'object') return;
  if (message.method === 'thread-stream-following-changed' && params.following === true && message.sourceClientId !== clientId) {
    const id = params.conversationId;
    if (typeof id !== 'string') return;
    if (!threads.has(id)) {
      threads.set(id, { id, revision: null, state: null });
      request('thread-owner-discovery', { hostId: 'local', conversationId: id }, 1, id);
    }
    return;
  }
  if (message.method !== 'thread-stream-state-changed') return;
  let entry = threads.get(params.conversationId);
  if (!entry) { entry = { id: params.conversationId, revision: null, state: null }; threads.set(entry.id, entry); }
  const change = params.change;
  if (!change) return;
  if (change.type === 'snapshot') {
    entry.state = change.conversationState ?? null;
    entry.revision = change.revision;
    report(entry, 'SNAPSHOT');
    return;
  }
  if (change.type !== 'patches') return;
  entry.revision = change.revision;
  for (const patch of change.patches ?? []) {
    const path = patch.path ?? [];
    if (path[0] === 'latestModel') {
      entry.state = { ...(entry.state ?? {}), latestModel: patch.op === 'remove' ? null : patch.value };
      console.log(`PATCH latestModel=${JSON.stringify(patch.value)} op=${patch.op}`);
    } else if (path[0] === 'latestReasoningEffort') {
      entry.state = { ...(entry.state ?? {}), latestReasoningEffort: patch.op === 'remove' ? null : patch.value };
      console.log(`PATCH latestReasoningEffort=${JSON.stringify(patch.value)} op=${patch.op}`);
    } else if (path[0] === 'threadRuntimeStatus') {
      entry.state = { ...(entry.state ?? {}), threadRuntimeStatus: { type: patch.value } };
    }
  }
}

setTimeout(() => {
  console.log('--- THREADS', threads.size, '---');
  for (const entry of threads.values()) report(entry, 'FINAL');
  process.exit(0);
}, seconds * 1000);

