// Read-only probe: dump the full key surface of the app-server conversation state
// so we can see whether upstream carries a real change timestamp per usage block.
import net from 'node:net';
import { randomUUID } from 'node:crypto';

const PIPE = '\\\\.\\pipe\\codex-ipc';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const seconds = Number(process.argv[2] ?? 5);

const socket = net.connect(PIPE);
let clientId = null;
let buffer = Buffer.alloc(0);
const requests = new Map();
const threads = new Map();
const seenMethods = new Map();

function send(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8'), header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  socket.write(Buffer.concat([header, body]));
}

function request(method, params, version, threadId = null) {
  const requestId = randomUUID();
  requests.set(requestId, { method, threadId });
  send({ type: 'request', requestId, sourceClientId: clientId ?? 'initializing-client', version, method, params, timeoutMs: 5000 });
}

function follow(entry, following) {
  if (!clientId || !entry.owner) return;
  send({ type: 'broadcast', method: 'thread-stream-following-changed', version: 1, sourceClientId: clientId,
    targetClientIds: [entry.owner], params: { conversationId: entry.id, hostId: 'local', following } });
}

function handle(message) {
  if (!message || typeof message !== 'object') return;
  if (message.type === 'response') {
    const pending = requests.get(message.requestId);
    if (!pending) return;
    requests.delete(message.requestId);
    if (pending.method === 'initialize') { clientId = message.result?.clientId; return; }
    if (pending.threadId) {
      const entry = threads.get(pending.threadId);
      if (entry) { entry.owner = message.handledByClientId; follow(entry, true); }
    }
    return;
  }
  if (message.type !== 'broadcast') return;
  const key = message.method + (message.version != null ? '@' + message.version : '');
  seenMethods.set(key, (seenMethods.get(key) ?? 0) + 1);
  const params = message.params;
  if (!params || params.hostId !== 'local' || !UUID.test(params.conversationId ?? '')) return;
  if (message.method === 'thread-stream-following-changed' && message.sourceClientId !== clientId) {
    if (params.following === true && !threads.has(params.conversationId)) {
      const entry = { id: params.conversationId, owner: null, interests: new Set([message.sourceClientId]) };
      threads.set(entry.id, entry);
      request('thread-owner-discovery', { hostId: 'local', conversationId: entry.id }, 1, entry.id);
    }
    return;
  }
  if (message.method !== 'thread-stream-state-changed' || message.version !== 11) return;
  const entry = threads.get(params.conversationId);
  if (!entry?.owner || message.sourceClientId !== entry.owner) return;
  const change = params.change;
  if (change?.type === 'snapshot' && change.conversationState) entry.state = change.conversationState;
}

socket.on('connect', () => request('initialize', { clientType: 'desktop' }, 0));
socket.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length >= 4) {
    const length = buffer.readUInt32LE(0);
    if (!length || buffer.length < length + 4) return;
    const frame = buffer.subarray(4, length + 4);
    buffer = buffer.length === length + 4 ? Buffer.alloc(0) : Buffer.from(buffer.subarray(length + 4));
    try { handle(JSON.parse(frame.toString('utf8'))); } catch { return; }
  }
});
socket.on('error', (error) => { console.log('ERR', error.message); process.exit(1); });

setTimeout(() => {
  console.log('METHODS', JSON.stringify([...seenMethods.entries()]));
  for (const entry of threads.values()) {
    const s = entry.state;
    if (!s) { console.log('-', entry.id, 'no snapshot'); continue; }
    console.log('TOP KEYS', JSON.stringify(Object.keys(s)));
    console.log('latestTokenUsageInfo KEYS', JSON.stringify(Object.keys(s.latestTokenUsageInfo ?? {})));
    console.log('latestTokenUsageInfo TOTAL KEYS', JSON.stringify(Object.keys(s.latestTokenUsageInfo?.total ?? {})));
    console.log('threadRuntimeStatus', JSON.stringify(s.threadRuntimeStatus));
    console.log('sample scalars', JSON.stringify({
      id: s.id, updatedAt: s.updatedAt, createdAt: s.createdAt, lastTurnId: s.lastTurnId,
      threadSource: s.threadSource, source: s.source,
    }));
  }
  process.exit(0);
}, seconds * 1000);
