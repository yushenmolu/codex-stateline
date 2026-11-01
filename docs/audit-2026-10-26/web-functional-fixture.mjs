// 独立只读功能审计 fixture：仅 Node 内置模块、内存 DOM/fetch；不监听端口、不读配置/日志、不发网络请求。
// 运行：node --experimental-vm-modules docs/audit-2026-10-26/web-functional-fixture.mjs
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const source = await readFile(new URL('../../src/public/app.js', import.meta.url), 'utf8');
const indexSource = await readFile(new URL('../../src/public/index.html', import.meta.url), 'utf8');
function htmlOptions(id) {
  const body = indexSource.match(new RegExp('<select id="' + id + '">([\\s\\S]*?)</select>'))?.[1] ?? '';
  return [...body.matchAll(/<option(?:\s[^>]*)?>([^<]*)<\/option>/g)].map(match => match[0].match(/\bvalue="([^"]*)"/)?.[1] ?? match[1]);
}
const staticIds = [
  'connection', 'session-state', 'task-select', 'task-pin', 'task-title', 'task-flags',
  'current-turn', 'agents-meta', 'agents', 'input-tokens', 'output-tokens', 'total-tokens',
  'speed', 'conversation-context', 'telemetry-message', 'session-id', 'benchmark-details',
  'benchmark-state', 'mode-prompt', 'mode-source', 'mode-version', 'cockpit-capability',
  'html-capability', 'mode', 'model', 'effort', 'run', 'cancel', 'benchmark-message',
  'benchmark-progress', 'cases', 'baseline-control', 'comparison', 'html-mode', 'cockpit-mode',
];
const options = {
  mode: ['static', 'animated', 'html-animated', 'cockpit'],
  model: htmlOptions('model'),
  effort: htmlOptions('effort'),
  'html-mode': ['html-animated'], 'cockpit-mode': ['cockpit'],
};

class Node {
  constructor(tag = '', id = '') {
    this.tagName = tag.toUpperCase(); this.id = id; this.dataset = {}; this.children = [];
    this.listeners = new Map(); this.attributes = {}; this.disabled = false; this.hidden = false;
    this.value = options[id]?.[0] ?? ''; this.textContent = ''; this.className = '';
    this.classList = { toggle: (name, value) => { this[name] = value; } };
    this.lastElementChild = { textContent: '' };
    this.parentElement = null;
  }
  append(...nodes) { for (const node of nodes) { this.children.push(node); if (node instanceof Node) node.parentElement = this; } }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  addEventListener(type, fn) { const list = this.listeners.get(type) ?? []; list.push(fn); this.listeners.set(type, list); }
  closest(selector) { return selector === 'button' && this.tagName === 'BUTTON' ? this : null; }
  querySelectorAll() { return []; }
  replaceWith() {}
  focus() {}
}
function boot({ fetchImpl }) {
  const nodes = new Map(staticIds.map(id => [id, new Node(id === 'run' || id === 'cancel' || id === 'task-pin' ? 'button' : id.includes('mode') || ['model', 'effort', 'task-select'].includes(id) ? 'select' : 'div', id)]));
  nodes.get('html-mode').disabled = true; nodes.get('cockpit-mode').disabled = true;
  const document = {
    getElementById: id => nodes.get(id),
    createElement: tag => new Node(tag),
    listeners: new Map(),
    addEventListener(type, fn) { const list = this.listeners.get(type) ?? []; list.push(fn); this.listeners.set(type, list); },
  };
  const intervals = [];
  let uuidCounter = 0;
  const context = vm.createContext({
    document, window: { addEventListener() {} }, console, Intl, Date, TextEncoder, URL, Blob, Map, Set, Promise, Object, Array, Number, String, JSON, Error,
    crypto: { randomUUID: () => 'aaaaaaaa-aaaa-4aaa-8aaa-' + String(++uuidCounter).padStart(12, '0') },
    fetch: fetchImpl, AbortController, setTimeout, clearTimeout,
    setInterval: fn => { intervals.push(fn); return intervals.length; },
    DOMParser: class { parseFromString() { throw new Error('fixture 不解析 SVG'); } },
  });
  return { context, nodes, document, intervals };
}
const emptyTasks = { tasks: [], sampledAt: '2026-10-26T00:00:00.000Z', stale: false, truncated: false };
const capabilities = { product: 'codex-companion', protocolVersion: 1, instanceId: '11111111-1111-4111-8111-111111111111', capabilities: ['pelican-cockpit-v1', 'cockpit-preview-source-v1', 'pelican-html-animated-v1', 'isolated-html-preview-v1'] };
const idle = { status: 'idle', activeRun: null, latestRun: null, runs: [], baseline: null, comparison: null, available: true };
const active = { status: 'running', activeRun: { runId: '11111111-1111-4111-8111-111111111111', requestId: 'fixture-request', status: 'running', model: 'configured', reasoningEffort: 'configured', caseSetVersion: 'pelican-svg-v2', rubricVersion: 'pelican-svg-v2', caseResults: [] }, latestRun: null, runs: [], baseline: null, comparison: null, available: true };
const catalog = {
  model: { state: 'available', source: 'config_top_level', reason: 'none', value: 'configured-fixture' },
  reasoningEffort: { state: 'available', source: 'config_top_level', reason: 'none', value: 'persistent' },
  availableModels: [{ slug: 'configured', displayName: '当前配置' }, { slug: 'fixture-provider/new-model', displayName: 'Fixture New Model' }],
  availableEfforts: [{ value: 'configured', label: '当前配置' }, { value: 'persistent', label: 'persistent' }, { value: 'none', label: 'none' }],
};
const response = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, headers: { get: name => name === 'X-Codex-Companion-Nonce' ? 'fixture-nonce' : null } });
async function evaluate(fetchImpl) {
  const harness = boot({ fetchImpl });
  const module = new vm.SourceTextModule(source, { context: harness.context, identifier: 'file:///src/public/app.js' });
  await module.link(() => { throw new Error('fixture 不允许 import'); });
  await module.evaluate();
  return harness;
}

// 1. 服务端已经接收运行，但客户端收到响应前连接失败。
const submissions = [];
const fetchTrace = [];
process.on('unhandledRejection', error => { throw error; });
let fetchCount = 0;
const lossHarness = await evaluate(async (path, init = {}) => {
  fetchCount++; fetchTrace.push({ path, method: init.method ?? 'GET' });
  if (path === '/api/tasks') return response(emptyTasks);
  if (path === '/api/capabilities') return response(capabilities);
  if (path === '/api/nonce') return response({});
  if (path === '/api/benchmark') return response(idle);
  if (path === '/api/benchmark/run') { submissions.push(JSON.parse(init.body)); throw new TypeError('fixture: response connection lost'); }
  throw new Error('unexpected route ' + path);
});
for (let i = 0; i < 20 && (lossHarness.nodes.get('run').disabled || !lossHarness.nodes.get('benchmark-message').textContent); i++) await new Promise(resolve => setImmediate(resolve));
const beforeRetry = { requests: fetchCount, disabled: lossHarness.nodes.get('run').disabled, message: lossHarness.nodes.get('benchmark-message').textContent };
assert.equal(beforeRetry.disabled, false, JSON.stringify({ fetchTrace, beforeRetry }));
lossHarness.document.listeners.get('click')[0]({ target: lossHarness.nodes.get('run') });
for (let i = 0; i < 20 && !lossHarness.nodes.get('benchmark-message').className.endsWith(' error'); i++) await new Promise(resolve => setImmediate(resolve));
for (let i = 0; i < 20 && lossHarness.nodes.get('run').disabled; i++) await new Promise(resolve => setImmediate(resolve));
assert.equal(lossHarness.nodes.get('run').disabled, false, JSON.stringify({ fetchTrace, beforeRetry }));
lossHarness.document.listeners.get('click')[0]({ target: lossHarness.nodes.get('run') });
for (let i = 0; i < 20 && submissions.length < 2; i++) await new Promise(resolve => setImmediate(resolve));
assert.equal(submissions.length, 2, JSON.stringify({ fetchTrace, disabled: lossHarness.nodes.get('run').disabled, message: lossHarness.nodes.get('benchmark-message').textContent }));
assert.notEqual(submissions[0].requestId, submissions[1].requestId);
console.log(JSON.stringify({ finding: 'ambiguous-submit-retry', beforeRetry, requestIds: submissions.map(item => item.requestId), submissions: submissions.length, expected: '先 GET 对账或复用同一 requestId，且未知期间禁用再次提交' }, null, 2));

// 2. 状态 GET 挂起：首个 loadBenchmark 完成后，下一轮永久阻塞，后续轮询跳过。
let benchmarkGets = 0;
let resolveHung;
const hung = new Promise(resolve => { resolveHung = resolve; });
const pollingHarness = await evaluate(async path => {
  if (path === '/api/tasks') return response(emptyTasks);
  if (path === '/api/capabilities') return response(capabilities);
  if (path === '/api/nonce') return response({});
  if (path === '/api/benchmark') { benchmarkGets++; if (benchmarkGets === 2) return hung; return response(idle); }
  throw new Error('unexpected route ' + path);
});
const poll = pollingHarness.intervals[1];
const secondPoll = poll(); // 不 await：第二次 GET 刻意保持挂起。
await Promise.all([poll(), poll(), poll()]); // 都被 polling 标志跳过。
await new Promise(resolve => setTimeout(resolve, 50));
assert.equal(benchmarkGets, 2);
assert.equal(pollingHarness.nodes.get('benchmark-state').textContent, '未启动');
resolveHung(response(active));
await new Promise(resolve => setImmediate(resolve));
await new Promise(resolve => setImmediate(resolve));
assert.equal(pollingHarness.nodes.get('benchmark-state').textContent, '运行中');
console.log(JSON.stringify({ finding: 'hung-poll-blocks-refresh', benchmarkGetsWhileHung: benchmarkGets, displayedWhileHung: '未启动', runDisabledWhileHung: false, expected: '请求应有期限；过期显示不可用，后续轮询能恢复；不能把永久等待当旧数据保留' }, null, 2));

// 3. 后端提供了目录，但初始化后 DOM 保留 HTML 硬编码项。
const catalogHarness = await evaluate(async path => {
  if (path === '/api/tasks') return response(emptyTasks);
  if (path === '/api/capabilities') return response(capabilities);
  if (path === '/api/nonce') return response({});
  if (path === '/api/benchmark') return response({ ...idle, defaults: catalog });
  throw new Error('unexpected route ' + path);
});
assert.equal(catalogHarness.nodes.get('model').children.length, 0, '初始化没有重建模型 select');
assert.equal(catalogHarness.nodes.get('model').value, 'configured');
assert.equal(options.model.includes('fixture-provider/new-model'), false);
assert.equal(options.effort.includes('persistent'), false);
assert.equal(options.effort.includes('none'), false);
console.log(JSON.stringify({ finding: 'catalog-not-bound-to-controls', catalogModels: catalog.availableModels, actualWebModels: options.model, catalogEfforts: catalog.availableEfforts, actualWebEfforts: options.effort, serverRead: 'src/server.js:282-299 返回 defaults 并按当前目录校验', expected: '按每次快照更新选项并保留合法草稿' }, null, 2));
console.log('PASS: 3/3 目标场景通过（仅内存 fixture，无网络或业务写入）。');
