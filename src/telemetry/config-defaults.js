import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, parse, sep } from 'node:path';
import { validModel, validEffort } from './usage.js';

const LIMIT = 262144;
// The catalog is read with the same bounded window as the config file and its
// selectable identities are capped, so a hostile or corrupt document cannot
// enlarge the widget payload without limit.
const CATALOG_LIMIT = 262144;
const MAX_MODELS = 64;
const MAX_DISPLAY_NAME = 120;
const TOP_LEVEL_KEYS = ['model', 'model_reasoning_effort', 'profile', 'model_catalog_json'];
const DESKTOP_KEYS = ['enabled-reasoning-efforts'];
// The sentinel always means "whatever Codex itself is configured to use".
export const CONFIGURED_MODEL = Object.freeze({ slug: 'configured', displayName: '当前配置' });
// Labels are display-only; the wire value stays the exact Codex effort word.
const EFFORT_LABELS = Object.freeze({ configured: '当前配置' });
const FALLBACK_EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'persistent', 'none']);
// Codex lists efforts per model in capability order. The desktop enable list can
// arrive in any order (ultra before max, for example), so selectors sort by the
// real ladder and keep unknown vocabulary at the end in its original order.
const EFFORT_ORDER = Object.freeze({ low: 0, medium: 1, high: 2, xhigh: 3, max: 4, ultra: 5 });
const effortRank = (value) => Object.prototype.hasOwnProperty.call(EFFORT_ORDER, value) ? EFFORT_ORDER[value] : Number.MAX_SAFE_INTEGER;
const effortItem = (value) => ({ value, label: EFFORT_LABELS[value] || value });
export const CONFIGURED_EFFORT = Object.freeze(effortItem('configured'));
const field = (reason, source = 'none', value = null, state = 'unavailable') => ({ state, source, reason, value });
// A failed read must still leave the panel usable: the configured sentinel is
// always selectable, so the arrays are never empty even when nothing is known.
export function unavailableDefaults(reason, state = 'unavailable', sources = {}) {
  return {
    model: field(reason, sources.model, null, state),
    reasoningEffort: field(reason, sources.reasoningEffort, null, state),
    availableModels: [{ ...CONFIGURED_MODEL }],
    availableEfforts: [{ ...CONFIGURED_EFFORT }],
  };
}

// Tokenize logical statements without interpreting unrelated configuration.
// All string/container states are tracked, so a fake key inside a secret is inert.
function statements(text) {
  const out = [];
  let token = '', quote = null, multi = false, comment = false, escaped = false;
  const stack = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (comment) { if (c !== '\n') continue; comment = false; }
    if (quote) {
      token += c;
      if (escaped) {
        if (c === 'u' || c === 'U') {
          const count = c === 'u' ? 4 : 8;
          const digits = text.slice(i + 1, i + 1 + count);
          if (!new RegExp('^[0-9a-fA-F]{' + count + '}$').test(digits)) throw Error('syntax_unsupported');
          const value = Number.parseInt(digits, 16);
          if (value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) throw Error('syntax_unsupported');
          token += digits; i += count; escaped = false; continue;
        }
        if (!/^[btnfr"\\]$/.test(c) && !(multi && /\s/.test(c))) throw Error('syntax_unsupported');
        escaped = false; continue;
      }
      if (quote === '"' && c === '\\') { escaped = true; continue; }
      if (!multi && (c === '\n' || c === '\r')) throw Error('syntax_unsupported');
      if (c === quote) {
        if (!multi) quote = null;
        else if (text.slice(i, i + 3) === quote.repeat(3)) { token += quote.repeat(2); i += 2; quote = null; multi = false; }
      }
      continue;
    }
    if (c === '#') { comment = true; continue; }
    if (c === '"' || c === "'") {
      quote = c; multi = text.slice(i, i + 3) === c.repeat(3);
      token += multi ? c.repeat(3) : c; if (multi) i += 2; continue;
    }
    if (c === '[' || c === '{') stack.push(c);
    if (c === ']' || c === '}') { if (stack.pop() !== (c === ']' ? '[' : '{')) throw Error('syntax_unsupported'); }
    if ((c === '\n' || c === '\r') && stack.length === 0) { if (token.trim()) out.push(token.trim()); token = ''; }
    else token += c;
  }
  if (quote || escaped || stack.length) throw Error('syntax_unsupported');
  if (token.trim()) out.push(token.trim());
  return out;
}

const SECTION = /^\[\[?(?:[A-Za-z0-9_-]+|"[^"\\\r\n]+"|'[^'\r\n]+')(?:\.(?:[A-Za-z0-9_-]+|"[^"\\\r\n]+"|'[^'\r\n]+'))*\]\]?$/;
const ASSIGNMENT = /^(?:([A-Za-z0-9_-]+)|"([^"\\\r\n]+)"|'([^'\r\n]+)')\s*=\s*([\s\S]+)$/;
const COMPACT_STRING = /^(?:"([^"\\\r\n]*)"|'([^'\r\n]*)')$/;

// Parse only the recognized TOML statements into scalar defaults plus the
// catalog reference and effort list. Every other statement stays inert so no
// unrelated configuration value can influence a benchmark request.
function parseConfigDocument(text) {
  try {
    if (typeof text !== 'string' || text.includes(String.fromCharCode(0))) throw Error('syntax_unsupported');
    const rows = statements(text.replace(/^\uFEFF/, ''));
    let top = true, desktop = false, profile = false, duplicate = false;
    const values = new Map();
    for (const row of rows) {
      if (row.startsWith('[')) {
        if (!SECTION.test(row)) throw Error('syntax_unsupported');
        if (row.startsWith('[[') !== row.endsWith(']]')) throw Error('syntax_unsupported');
        // Only the exact [desktop] table enables effort discovery; every
        // nested or unrelated table keeps its keys inert.
        top = false; desktop = row === '[desktop]';
        continue;
      }
      const match = row.match(ASSIGNMENT);
      if (!match) throw Error('syntax_unsupported');
      const key = match[1] ?? match[2] ?? match[3];
      if (!(top ? TOP_LEVEL_KEYS.includes(key) : desktop && DESKTOP_KEYS.includes(key))) continue;
      if (values.has(key)) duplicate = true;
      values.set(key, match[4]);
      if (key === 'profile') profile = true;
    }
    if (profile) return { ...unavailableDefaults('profile_unsupported'), catalogRef: null, efforts: null };
    if (duplicate) return { ...unavailableDefaults('duplicate_key'), catalogRef: null, efforts: null };
    const extract = (key, validator) => {
      if (!values.has(key)) return field('key_missing');
      const raw = values.get(key);
      const match = raw.match(COMPACT_STRING);
      if (!match || raw.startsWith('"""') || raw.startsWith("'''")) return field('syntax_unsupported', 'config_top_level');
      const value = match[1] ?? match[2];
      return validator(value) ? field('none', 'config_top_level', value, 'available') : field('value_invalid', 'config_top_level');
    };
    const model = extract('model', validModel);
    let catalogRef = null;
    if (values.has('model_catalog_json')) {
      const match = values.get('model_catalog_json').match(COMPACT_STRING);
      const value = match ? match[1] ?? match[2] : null;
      catalogRef = typeof value === 'string' && value.length > 0 && value.length <= 512 ? value : null;
    }
    const efforts = values.has('enabled-reasoning-efforts') ? parseStringArray(values.get('enabled-reasoning-efforts')) : null;
    return { model, reasoningEffort: extract('model_reasoning_effort', validEffort), catalogRef, efforts };
  } catch {
    return { ...unavailableDefaults('syntax_unsupported'), catalogRef: null, efforts: null };
  }
}

// Strict single-line string-array subset: quoted strings separated by commas.
// Anything else degrades the whole value instead of guessing an interpretation.
function parseStringArray(raw) {
  const text = raw.trim();
  if (!text.startsWith('[') || !text.endsWith(']')) return null;
  const body = text.slice(1, -1);
  const out = [];
  let i = 0;
  const skip = () => { while (i < body.length && /\s/.test(body[i])) i++; };
  skip();
  if (i === body.length) return out;
  for (;;) {
    skip();
    const quote = body[i];
    if (quote !== '"' && quote !== "'") return null;
    const start = i + 1;
    i = start;
    while (i < body.length && body[i] !== quote) {
      if (body[i] === '\\' || body[i] === '\n' || body[i] === '\r') return null;
      i++;
    }
    if (i >= body.length) return null;
    out.push(body.slice(start, i));
    i++;
    skip();
    if (i === body.length) return out;
    if (body[i] !== ',') return null;
    i++;
    skip();
    if (i === body.length) return out;
  }
}

export function parseConfigDefaults(text) {
  const { model, reasoningEffort } = parseConfigDocument(text);
  return { model, reasoningEffort };
}

async function safePath(path) {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  let current = root, stat;
  const parts = absolute.slice(root.length).split(sep).filter(Boolean);
  for (let i = -1; i < parts.length; i++) {
    if (i >= 0) current = join(current, parts[i]);
    stat = await fs.lstat(current, { bigint: true });
    if (stat.isSymbolicLink() || (i < parts.length - 1 && !stat.isDirectory()) || resolve(await fs.realpath(current)) !== resolve(current)) throw Error('file_unsafe');
  }
  if (!stat.isFile() || typeof stat.ino !== 'bigint' || typeof stat.dev !== 'bigint') throw Error('file_unsafe');
  return stat;
}

// Read a bounded, link-free, already-open file and reject concurrent identity changes.
async function readStableText(path, limit) {
  let handle;
  try {
    const before = await safePath(path);
    handle = await fs.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat({ bigint: true });
    const checked = await safePath(path);
    const same = (a, b) => a.ino === b.ino && a.dev === b.dev && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
    if (!same(before, opened) || !same(opened, checked)) throw Error('file_changed');
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const got = await handle.read(buffer, length, buffer.length - length, length);
      if (!got.bytesRead) break; length += got.bytesRead;
    }
    if (!same(opened, await handle.stat({ bigint: true })) || !same(opened, await safePath(path))) throw Error('file_changed');
    if (length > limit) throw Error('file_too_large');
    try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length)); } catch { throw Error('syntax_unsupported'); }
  } finally { await handle?.close(); }
}

// The catalog is resolved relative to the Codex home and may never escape it.
function catalogPath(codexHome, reference) {
  if (typeof reference !== 'string' || !reference || reference.length > 512 || reference.includes(String.fromCharCode(0))) return null;
  const root = resolve(codexHome);
  const target = resolve(root, reference);
  const prefix = root.endsWith(sep) ? root : root + sep;
  if (target === root || !target.startsWith(prefix)) return null;
  return target;
}

// Extract only the selectable identity of each catalog entry. Exactly one
// JSON.parse call is made for the whole document; instruction text and every
// other catalog field stay out of the payload.
function parseCatalog(text) {
  let document;
  try { document = JSON.parse(text); } catch { return []; }
  if (!document || typeof document !== 'object' || Array.isArray(document) || !Array.isArray(document.models)) return [];
  const entries = [];
  for (const value of document.models) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !validModel(value.slug)) continue;
    const displayName = value.display_name;
    if (typeof displayName !== 'string' || !displayName || displayName.length > MAX_DISPLAY_NAME || /[\u0000-\u001f\u007f]/.test(displayName)) continue;
    const priority = Number.isFinite(value.priority) ? value.priority : Number.MAX_SAFE_INTEGER;
    const levels = Array.isArray(value.supported_reasoning_levels)
      ? value.supported_reasoning_levels.map(level => level && typeof level === 'object' ? level.effort : null).filter(validEffort)
      : [];
    entries.push({ slug: value.slug, displayName, priority, levels });
  }
  return entries.sort((a, b) => a.priority - b.priority).slice(0, MAX_MODELS);
}

async function readCatalog(codexHome, reference) {
  const path = catalogPath(codexHome, reference);
  if (!path) return [];
  try { return parseCatalog(await readStableText(path, CATALOG_LIMIT)); } catch { return []; }
}

function modelList(catalog) {
  const list = [{ ...CONFIGURED_MODEL }];
  const seen = new Set(['configured']);
  for (const entry of catalog) {
    if (seen.has(entry.slug)) continue;
    seen.add(entry.slug);
    list.push({ slug: entry.slug, displayName: entry.displayName });
  }
  return list;
}

// The configured list wins whenever Codex exposes one; otherwise the full
// Codex vocabulary is offered so the selector is never stuck on one option.
function effortList(efforts) {
  const list = [{ ...CONFIGURED_EFFORT }];
  const seen = new Set(['configured']);
  const values = (Array.isArray(efforts) && efforts.length ? efforts : FALLBACK_EFFORTS).slice().sort((a, b) => effortRank(a) - effortRank(b));
  for (const value of values) {
    if (!validEffort(value) || seen.has(value)) continue;
    seen.add(value);
    list.push(effortItem(value));
  }
  if (list.length === 1) for (const value of FALLBACK_EFFORTS) list.push(effortItem(value));
  return list;
}

export async function readConfigDefaults({ codexHome = process.env.CODEX_HOME ?? join(homedir(), '.codex') } = {}) {
  if (!codexHome) return unavailableDefaults('config_missing');
  let document;
  try { document = parseConfigDocument(await readStableText(join(codexHome, 'config.toml'), LIMIT)); }
  catch (error) {
    const reason = error.code === 'ENOENT' ? 'config_missing' : ['EPERM', 'EACCES'].includes(error.code) ? 'file_unsafe' : ['file_unsafe', 'file_changed', 'file_too_large', 'syntax_unsupported'].includes(error.message) ? error.message : 'read_failed';
    return unavailableDefaults(reason);
  }
  const catalog = await readCatalog(codexHome, document.catalogRef);
  return {
    model: document.model,
    reasoningEffort: document.reasoningEffort,
    availableModels: modelList(catalog),
    availableEfforts: effortList(document.efforts),
  };
}
export function createConfigDefaultsReader({ codexHome, monotonicClock = () => performance.now(), read = () => readConfigDefaults({ codexHome }) } = {}) {
  let current = unavailableDefaults('config_missing'), observed = null, attempted = null, running = null;
  const copyList = (value, keys) => (Array.isArray(value) ? value : []).flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const copy = {};
    for (const key of keys) if (typeof item[key] === 'string') copy[key] = item[key];
    return keys.every((key) => typeof copy[key] === 'string') ? [copy] : [];
  });
  const copy = (value) => {
    const availableModels = copyList(value.availableModels, ['slug', 'displayName']);
    const availableEfforts = copyList(value.availableEfforts, ['value', 'label']);
    return {
      model: { ...value.model },
      reasoningEffort: { ...value.reasoningEffort },
      // The sentinel is the floor: even a defective read stays selectable.
      availableModels: availableModels.length ? availableModels : [{ ...CONFIGURED_MODEL }],
      availableEfforts: availableEfforts.length ? availableEfforts : [{ ...CONFIGURED_EFFORT }],
    };
  };
  function snapshot() {
    // A stale snapshot keeps the last known selectable identities: they are
    // still bounded by the catalog, while the scalar defaults fail closed.
    if (observed !== null && monotonicClock() - observed > 15000) {
      return {
        ...unavailableDefaults('snapshot_stale', 'stale', { model: current.model.source, reasoningEffort: current.reasoningEffort.source }),
        availableModels: copy(current).availableModels,
        availableEfforts: copy(current).availableEfforts,
      };
    }
    return copy(current);
  }
  async function refresh() {
    if (running) return running;
    const now = monotonicClock();
    if (attempted !== null && now >= attempted && now - attempted < 5000) return snapshot();
    attempted = now;
    running = (async () => {
      try { current = await read(); if (current.model.reason !== 'read_failed' && current.reasoningEffort.reason !== 'read_failed') observed = monotonicClock(); }
      catch { current = unavailableDefaults('read_failed'); }
      return snapshot();
    })().finally(() => { running = null; });
    return running;
  }
  return { refresh, snapshot };
}
