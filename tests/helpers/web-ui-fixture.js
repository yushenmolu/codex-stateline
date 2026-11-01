// Purely in-memory Web UI fixture. No sockets, real configuration, logs, or model calls.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

export const vmModulesAvailable = typeof vm.SourceTextModule === 'function';
export const vmModulesSkipReason = 'vm.SourceTextModule requires Node --experimental-vm-modules';

const appUrl = new URL('../../src/public/app.js', import.meta.url);
const indexUrl = new URL('../../src/public/index.html', import.meta.url);
const camel = name => name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
const kebab = name => name.replace(/[A-Z]/g, letter => '-' + letter.toLowerCase());

class FixtureStyle {
  setProperty(name, value) { this[kebab(name)] = String(value); }
}

class FixtureNode {
  constructor(document, tagName = 'div') {
    this.ownerDocument = document;
    this.tagName = tagName.toUpperCase();
    this.localName = tagName.toLowerCase();
    this.parentElement = null;
    this.children = [];
    this.dataset = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.disabled = false;
    this.hidden = false;
    this.open = false;
    this.textContent = '';
    this.style = new FixtureStyle();
    this._value = null;
    this._className = '';
    this.selectedIndex = -1;
    const node = this;
    this.classList = {
      contains: name => node.className.split(/\s+/).includes(name),
      add: (...names) => { node.className = [...new Set([...node.className.split(/\s+/).filter(Boolean), ...names])].join(' '); },
      remove: (...names) => { node.className = node.className.split(/\s+/).filter(name => name && !names.includes(name)).join(' '); },
      toggle: (name, force) => {
        const enabled = force === undefined ? !node.classList.contains(name) : Boolean(force);
        if (enabled) node.classList.add(name); else node.classList.remove(name);
        return enabled;
      },
    };
  }
  get id() { return this.getAttribute('id') ?? ''; }
  set id(value) { this.setAttribute('id', value); }
  get className() { return this._className; }
  set className(value) { this._className = String(value); }
  get value() {
    if (this.localName === 'option') return this._value ?? this.textContent;
    if (this.localName !== 'select') return this._value ?? '';
    const options = this.children.filter(child => child.localName === 'option');
    if (!options.length) return '';
    if (this._value === null) return options[0].value;
    return options.some(option => option.value === this._value) ? this._value : '';
  }
  set value(value) { this._value = String(value); this.syncSelectedOption(); }
  get options() { return this.localName === 'select' ? [...this.children] : []; }
  syncSelectedOption() {
    if (this.localName !== 'select') return;
    this.selectedIndex = this.children.findIndex(option => option.value === this.value);
  }
  get firstElementChild() { return this.children[0] ?? null; }
  get lastElementChild() { return this.children.at(-1) ?? null; }
  get isConnected() { return this === this.ownerDocument || Boolean(this.parentElement?.isConnected); }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === 'class') this.className = String(value);
    if (name === 'value') this._value = String(value);
    if (name.startsWith('data-')) this.dataset[camel(name.slice(5))] = String(value);
  }
  getAttribute(name) {
    if (name === 'class') return this.className || null;
    if (name.startsWith('data-') && this.dataset[camel(name.slice(5))] !== undefined) return String(this.dataset[camel(name.slice(5))]);
    return this.attributes.get(name) ?? null;
  }
  hasAttribute(name) { return this.getAttribute(name) !== null; }
  removeAttribute(name) {
    this.attributes.delete(name);
    if (name === 'class') this.className = '';
    if (name.startsWith('data-')) delete this.dataset[camel(name.slice(5))];
  }
  append(...nodes) {
    for (const node of nodes) {
      if (!(node instanceof FixtureNode)) throw new TypeError('fixture only appends element nodes');
      node.parentElement?.removeChild(node);
      this.children.push(node);
      node.parentElement = this;
    }
    this.syncSelectedOption();
  }
  appendChild(node) { this.append(node); return node; }
  removeChild(node) {
    const index = this.children.indexOf(node);
    if (index < 0) throw new Error('fixture removeChild: node is not a child');
    this.ownerDocument.releaseFocusWithin(node);
    this.children.splice(index, 1);
    node.parentElement = null;
    this.syncSelectedOption();
  }
  replaceChildren(...nodes) {
    for (const child of this.children) { this.ownerDocument.releaseFocusWithin(child); child.parentElement = null; }
    this.children = [];
    this.append(...nodes);
    this.syncSelectedOption();
  }
  replaceWith(node) {
    if (!this.parentElement) return;
    const parent = this.parentElement;
    const index = parent.children.indexOf(this);
    this.ownerDocument.releaseFocusWithin(this);
    parent.children[index] = node;
    node.parentElement = parent;
    this.parentElement = null;
  }
  before(...nodes) {
    if (!this.parentElement) return;
    const parent = this.parentElement;
    for (const node of nodes) {
      if (!(node instanceof FixtureNode)) throw new TypeError('fixture only inserts element nodes');
      node.parentElement?.removeChild(node);
      parent.children.splice(parent.children.indexOf(this), 0, node);
      node.parentElement = parent;
    }
    parent.syncSelectedOption();
  }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  dispatchEvent(event) {
    event.target ??= this;
    event.currentTarget = this;
    for (const listener of [...(this.listeners.get(event.type) ?? [])]) listener.call(this, event);
    return !event.defaultPrevented;
  }
  focus() { if (this.isConnected) this.ownerDocument.activeElement = this; }
  blur() { if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body; }
  matches(selector) {
    return selector.trim().match(/^([a-zA-Z][\w-]*)?((?:[.#][\w-]+|\[[^\]]+\])*)$/) !== null && simpleMatches(this, selector);
  }
  closest(selector) {
    let current = this;
    while (current && current !== this.ownerDocument) {
      if (current.matches(selector)) return current;
      current = current.parentElement;
    }
    return null;
  }
  querySelectorAll(selector) { return queryAll(this, selector); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  contains(node) { return contains(this, node); }
}

function simpleMatches(node, source) {
  const match = source.trim().match(/^([a-zA-Z][\w-]*)?((?:[.#][\w-]+|\[[^\]]+\])*)$/);
  if (!match || (match[1] && node.localName !== match[1].toLowerCase())) return false;
  for (const token of match[2].matchAll(/([.#])([\w-]+)|\[([\w-]+)(?:=["']?([^\]"']*)["']?)?\]/g)) {
    if (token[1] === '.' && !node.classList.contains(token[2])) return false;
    if (token[1] === '#' && node.id !== token[2]) return false;
    if (token[3] && !node.hasAttribute(token[3])) return false;
    if (token[3] && token[4] !== undefined && node.getAttribute(token[3]) !== token[4]) return false;
  }
  return true;
}

function descendants(root) {
  const result = [];
  for (const child of root.children ?? []) { result.push(child, ...descendants(child)); }
  return result;
}

function queryAll(root, selector) {
  const candidates = descendants(root);
  return candidates.filter(node => {
    const parts = selector.trim().split(/\s+/);
    let current = node;
    let index = parts.length - 1;
    if (!current.matches(parts[index].replace(/^[>]/, ''))) return false;
    while (--index >= 0) {
      if (parts[index] === '>') { index--; current = current.parentElement; if (!current || !current.matches(parts[index])) return false; }
      else {
        current = current.parentElement;
        while (current && current !== root && !current.matches(parts[index])) current = current.parentElement;
        if (!current || current === root || !current.matches(parts[index])) return false;
      }
    }
    return true;
  });
}

class FixtureDocument extends FixtureNode {
  constructor() {
    super(null, '#document');
    this.ownerDocument = this;
    this.documentElement = null;
    this.body = null;
    this.activeElement = null;
  }
  createElement(tagName) { return new FixtureNode(this, tagName); }
  getElementById(id) { return descendants(this).find(node => node.id === id) ?? null; }
  releaseFocusWithin(root) {
    if (this.activeElement === root || root.children?.some(child => contains(child, this.activeElement))) this.activeElement = this.body;
  }
}

function contains(root, sought) { return root === sought || Boolean(root?.children?.some(child => contains(child, sought))); }

// The fixture parses the shipped HTML into a small DOM, rather than duplicating its controls.
function parseIndex(document, html) {
  const root = document.createElement('html');
  root.id = '__fixture-root__';
  document.append(root);
  const stack = [root];
  const voidTags = new Set(['meta', 'link', 'input', 'img', 'br', 'hr']);
  for (const token of html.match(/<!--[\s\S]*?-->|<![^>]*>|<\/?[a-zA-Z][^>]*>|[^<]+/g) ?? []) {
    if (token.startsWith('<!--') || /^<!/.test(token)) continue;
    if (/^<\//.test(token)) {
      const tag = token.match(/^<\/([\w-]+)/)?.[1]?.toLowerCase();
      const index = stack.findLastIndex(node => node.localName === tag);
      if (index > 0) stack.length = index;
      continue;
    }
    if (token[0] !== '<') continue;
    const match = token.match(/^<([\w-]+)([\s\S]*?)\/?>$/);
    if (!match) continue;
    const node = document.createElement(match[1]);
    for (const attribute of match[2].matchAll(/([:\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
      node.setAttribute(attribute[1], attribute[2] ?? attribute[3] ?? attribute[4] ?? '');
    }
    stack.at(-1).append(node);
    if (!voidTags.has(node.localName) && !token.endsWith('/>')) stack.push(node);
    if (node.localName === 'html') document.documentElement = node;
    if (node.localName === 'body') document.body = node;
  }
  document.activeElement = document.body;
  // Preserve visible option labels as well as their values.
  for (const token of html.matchAll(/<option\b([^>]*)>([^<]*)<\/option>/g)) {
    const value = token[1].match(/\bvalue="([^"]*)"/)?.[1] ?? token[2];
    const option = descendants(document).find(node => node.localName === 'option' && node.value === value && !node.textContent);
    if (option) option.textContent = token[2];
  }
  return document;
}

export class FakeClock {
  constructor() { this.now = 0; this.nextId = 0; this.timers = new Map(); this.intervals = []; }
  setTimeout = (callback, delay = 0) => { const id = ++this.nextId; this.timers.set(id, { at: this.now + Math.max(0, Number(delay) || 0), callback }); return id; };
  clearTimeout = id => { this.timers.delete(id); };
  setInterval = (callback, delay) => { const entry = { callback, delay }; this.intervals.push(entry); return this.intervals.length; };
  clearInterval = () => {};
  advance(milliseconds) {
    const end = this.now + milliseconds;
    for (;;) {
      const due = [...this.timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.timers.delete(due[0]);
      this.now = due[1].at;
      due[1].callback();
    }
    this.now = end;
  }
}

export const syntheticIds = {
  taskA: 'deadbeef-0000-4000-8000-000000000001',
  taskB: 'deadbeef-0000-4000-8000-000000000002',
  run: 'cafecafe-0000-4000-8000-000000000001',
  instance: '11111111-1111-4111-8111-111111111111',
};
export const capabilities = { product: 'codex-companion', protocolVersion: 1, instanceId: syntheticIds.instance, capabilities: [] };
export const emptyTasks = { tasks: [], sampledAt: '2026-10-26T00:00:00.000Z', stale: false, truncated: false };
export const idleBenchmark = { status: 'idle', activeRun: null, latestRun: null, runs: [], baseline: null, comparison: null, available: true, defaults: defaults() };
export function defaults(overrides = {}) {
  return {
    model: { state: 'available', source: 'config_top_level', reason: 'none', value: 'synthetic/model-a' },
    reasoningEffort: { state: 'available', source: 'config_top_level', reason: 'none', value: 'high' },
    availableModels: [{ slug: 'configured', displayName: '沿用配置' }, { slug: 'synthetic/model-a', displayName: '合成模型 A' }, { slug: 'synthetic/model-b', displayName: '合成模型 B' }],
    availableEfforts: [{ value: 'configured', label: '沿用配置' }, { value: 'low', label: 'low' }, { value: 'high', label: 'high' }],
    ...overrides,
  };
}
export function completedBenchmark(overrides = {}) {
  const run = {
    runId: syntheticIds.run, requestId: 'synthetic-request', status: 'completed',
    model: 'synthetic/model-a', reasoningEffort: 'high',
    caseSetVersion: 'pelican-svg-v2', rubricVersion: 'pelican-svg-v2',
    caseResults: [{ caseId: 'pelican-svg', status: 'completed', scores: { correctness: 1, consistency: 2, constraint_adherence: 3 } }],
  };
  return { ...idleBenchmark, status: 'completed', latestRun: run, ...overrides };
}
export function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 400, status, json: async () => body, headers: { get: name => name.toLowerCase() === 'x-codex-companion-nonce' ? 'synthetic-nonce' : null } };
}
export function hangingResponse(signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { const error = new Error('synthetic fetch aborted'); error.name = 'AbortError'; reject(error); };
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  });
}

export async function flushPromises(turns = 12) {
  for (let index = 0; index < turns; index++) await new Promise(resolve => setImmediate(resolve));
}

export async function createWebFixture(route, { supportsVm = true } = {}) {
  if (!supportsVm || !vmModulesAvailable) throw Object.assign(new Error(vmModulesSkipReason), { code: 'ERR_VM_MODULE_UNAVAILABLE' });
  const [source, html] = await Promise.all([readFile(appUrl, 'utf8'), readFile(indexUrl, 'utf8')]);
  const document = parseIndex(new FixtureDocument(), html);
  const clock = new FakeClock();
  const requests = [];
  let uuidCounter = 0;
  const mediaListeners = new Set();
  const media = { matches: false, addEventListener: (type, listener) => { if (type === 'change') mediaListeners.add(listener); } };
  const window = { document, matchMedia: () => media, addEventListener() {} };
  const context = vm.createContext({
    document, window, console, Intl, Date, TextEncoder, URL, Blob, Map, Set, Promise, Object, Array, Number, String, JSON, Error,
    crypto: { randomUUID: () => 'aaaaaaaa-aaaa-4aaa-8aaa-' + String(++uuidCounter).padStart(12, '0') },
    AbortController, matchMedia: window.matchMedia,
    fetch: async (url, init = {}) => {
      const request = { url: String(url), method: init.method ?? 'GET', init, body: init.body ? JSON.parse(init.body) : null, signal: init.signal };
      requests.push(request);
      if (!request.url.startsWith('/api/')) throw new Error('fixture forbids non-synthetic URL: ' + request.url);
      if (request.method !== 'GET' && request.url !== '/api/benchmark/run') throw new Error('fixture forbids unconfigured synthetic POST: ' + request.url);
      return route(request);
    },
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    setInterval: clock.setInterval, clearInterval: clock.clearInterval,
    DOMParser: class { parseFromString() { throw new Error('fixture does not parse SVG; use synthetic cases without answer markup'); } },
  });
  const module = new vm.SourceTextModule(source, { context, identifier: 'file:///src/public/app.js' });
  await module.link(() => { throw new Error('fixture forbids application imports'); });
  await module.evaluate();
  await flushPromises();
  return {
    document, window, context, clock, requests, source, html, media, mediaListeners,
    $: id => document.getElementById(id),
    requestsTo: url => requests.filter(request => request.url === url),
    pollBenchmark: async () => { await clock.intervals.find((_, index) => index === 1)?.callback(); await flushPromises(); },
    pollTelemetry: async () => { await clock.intervals[0]?.callback(); await flushPromises(); },
    advance: async milliseconds => { clock.advance(milliseconds); await flushPromises(); },
    flush: flushPromises,
  };
}

export function event(type) {
  return { type, target: null, currentTarget: null, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
}
export function fire(node, type) {
  const dispatched = event(type);
  dispatched.target = node;
  let current = node;
  while (current) { current.dispatchEvent(dispatched); current = current.parentElement; }
  if (type === 'click' && !dispatched.defaultPrevented && node.localName === 'summary' && node.parentElement?.localName === 'details') node.parentElement.open = !node.parentElement.open;
  return dispatched;
}
