// Read-only probe: attach to the Codex app-server IPC pipe exactly like the
// widget does, follow one live conversation, and dump the raw shapes of
// latestTokenUsageInfo so we can see which counters actually exist upstream.
// It only sends protocol handshake/follow messages; it never mutates state.
import net from 'node:net';
import { randomUUID } from 'node:crypto';

const PIPE = '\\\\.\\pipe\\codex-ipc';
const seconds = Number(process.argv[2] ?? 20);
const socket = net.createConnection(PIPE);
let buffer = Buffer.alloc(0);
let clientId = null;
const seen = new Set();
const requests = new Map();
const target = process.argv[3] ?? null;
let followed = null;
const dumps = [];

function send(message) {
  if (socket.destroyed || !socket.writable) return;
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  socket.write(Buffer.concat([header, body]));
}
function request(method, params, version, tag) {
  const requestId = randomUUID();
  requests.set(requestId, tag ?? method);
  send({ type: 'request', requestId, sourceClientId: clientId ?? 'initializing-client', version, method, params, timeoutMs: 5000 });
}
function follow(conversationId, owner, on) {
  send({ type: 'broadcast', method: 'thread-stream-following-changed', version: 1, sourceClientId: clientId,
    targetClientIds: [owner], params: { conversationId, hostId: 'local', following: on } });
}

socket.on('connect', () => request('initialize', { clientType: 'desktop' }, 0, `initialize:${target ?? ''}`));
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

function handle(message) {
  if (!message || typeof message !== 'object') return;
  if (message.type === 'client-discovery-request') {
    if (typeof message.requestId === 'string') send({ type: 'client-discovery-response', requestId: message.requestId, response: { canHandle: false } });
    return;
  }
  if (message.type === 'response') {
    const tag = requests.get(message.requestId);
    requests.delete(message.requestId);
    if (typeof tag === 'string' && tag.startsWith('initialize') && message.result?.clientId) {
      clientId = message.result.clientId;
      console.log('CLIENT', clientId);
      const explicit = tag.slice('initialize:'.length);
      if (explicit) request('thread-owner-discovery', { hostId: 'local', conversationId: explicit }, 1, explicit);
      return;
    }
    if (tag && message.resultType === 'success' && message.handledByClientId && /^[0-9a-f-]{36}$/.test(tag) && followed !== tag) {
      followed = tag;
      console.log('FOLLOW', tag);
      follow(tag, message.handledByClientId, true);
    }
    return;
  }
  if (message.type !== 'broadcast' || !clientId) return;
  const method = message.method, params = message.params;
  if (!params || typeof params !== 'object') return;
  if (method === 'thread-stream-following-changed' && params.following === true && params.sourceClientId !== clientId) {
    const id = params.conversationId;
    if (!seen.has(id)) {
      seen.add(id);
      console.log('DISCOVERED', id);
      if (!followed) request('thread-owner-discovery', { hostId: 'local', conversationId: id }, 1, id);
    }
    return;
  }
  if (method !== 'thread-stream-state-changed') return;
  if (params.conversationId !== followed) return;
  const change = params.change;
  if (!change) return;
  if (change.type === 'snapshot') {
    const state = change.conversationState ?? {};
    console.log('SNAPSHOT rev', change.revision, 'runtime', state.threadRuntimeStatus?.type, 'model', state.latestModel);
    const info = state.latestTokenUsageInfo;
    if (info?.total) {
      console.log('TOTAL-KEYS', JSON.stringify(Object.keys(info.total)));
      console.log('TOTAL', JSON.stringify(info.total));
      dumps.push({ label: 'total', keys: Object.keys(info.total) });
    }
    if (info?.last) {
      console.log('LAST-KEYS', JSON.stringify(Object.keys(info.last)));
      console.log('LAST', JSON.stringify(info.last));
      dumps.push({ label: 'last', keys: Object.keys(info.last) });
    }
    if (info?.modelContextWindow) console.log('CONTEXT-WINDOW', info.modelContextWindow);
    console.log('INFO-KEYS', JSON.stringify(info ? Object.keys(info) : null));
  } else if (change.type === 'patches') {
    for (const patch of change.patches ?? []) {
      if (Array.isArray(patch.path) && patch.path[0] === 'latestTokenUsageInfo') {
        console.log('PATCH', patch.op, patch.path.join('.'), JSON.stringify(patch.value)?.slice(0, 200));
      }
    }
  }
}

setTimeout(() => {
  console.log('DONE. discovered', seen.size, 'followed', followed);
  const unique = new Map();
  for (const dump of dumps) unique.set(dump.label, dump);
  for (const dump of unique.values()) console.log('DUMP', dump.label, JSON.stringify(dump.keys));
  process.exit(0);
}, seconds * 1000);
