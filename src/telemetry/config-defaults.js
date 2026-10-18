import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, parse, sep } from 'node:path';
import { validModel, validEffort } from './usage.js';

const LIMIT = 262144;
const field = (reason, source = 'none', value = null, state = 'unavailable') => ({ state, source, reason, value });
export function unavailableDefaults(reason, state = 'unavailable', sources = {}) {
  return { model: field(reason, sources.model, null, state), reasoningEffort: field(reason, sources.reasoningEffort, null, state) };
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

export function parseConfigDefaults(text) {
  try {
    if (typeof text !== 'string' || text.includes(String.fromCharCode(0))) throw Error('syntax_unsupported');
    const rows = statements(text.replace(/^\uFEFF/, ''));
    let top = true, profile = false, duplicate = false;
    const values = new Map();
    for (const row of rows) {
      if (row.startsWith('[')) {
        if (!/^\[\[?(?:[A-Za-z0-9_-]+|"[^"\\\r\n]+"|'[^'\r\n]+')(?:\.(?:[A-Za-z0-9_-]+|"[^"\\\r\n]+"|'[^'\r\n]+'))*\]\]?$/.test(row)) throw Error('syntax_unsupported');
        if (row.startsWith('[[') !== row.endsWith(']]')) throw Error('syntax_unsupported');
        top = false; continue;
      }
      const match = row.match(/^(?:([A-Za-z0-9_-]+)|"([^"\\\r\n]+)"|'([^'\r\n]+)')\s*=\s*([\s\S]+)$/);
      if (!match) throw Error('syntax_unsupported');
      const key = match[1] ?? match[2] ?? match[3];
      if (!top || !['model', 'model_reasoning_effort', 'profile'].includes(key)) continue;
      if (values.has(key)) duplicate = true;
      values.set(key, match[4]);
      if (key === 'profile') profile = true;
    }
    if (profile) return unavailableDefaults('profile_unsupported');
    if (duplicate) return unavailableDefaults('duplicate_key');
    const extract = (key, validator) => {
      if (!values.has(key)) return field('key_missing');
      const raw = values.get(key);
      const match = raw.match(/^(?:"([^"\\\r\n]*)"|'([^'\r\n]*)')$/);
      if (!match || raw.startsWith('"""') || raw.startsWith("'''")) return field('syntax_unsupported', 'config_top_level');
      const value = match[1] ?? match[2];
      return validator(value) ? field('none', 'config_top_level', value, 'available') : field('value_invalid', 'config_top_level');
    };
    return { model: extract('model', validModel), reasoningEffort: extract('model_reasoning_effort', validEffort) };
  } catch { return unavailableDefaults('syntax_unsupported'); }
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
export async function readConfigDefaults({ codexHome = process.env.CODEX_HOME ?? join(homedir(), '.codex') } = {}) {
  if (!codexHome) return unavailableDefaults('config_missing');
  const path = join(codexHome, 'config.toml');
  let handle;
  try {
    const before = await safePath(path);
    handle = await fs.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat({ bigint: true });
    const checked = await safePath(path);
    const same = (a, b) => a.ino === b.ino && a.dev === b.dev && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
    if (!same(before, opened) || !same(opened, checked)) throw Error('file_changed');
    const buffer = Buffer.alloc(LIMIT + 1);
    let length = 0;
    while (length < buffer.length) {
      const got = await handle.read(buffer, length, buffer.length - length, length);
      if (!got.bytesRead) break; length += got.bytesRead;
    }
    if (!same(opened, await handle.stat({ bigint: true })) || !same(opened, await safePath(path))) throw Error('file_changed');
    if (length > LIMIT) throw Error('file_too_large');
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length)); } catch { throw Error('syntax_unsupported'); }
    return parseConfigDefaults(text);
  } catch (error) {
    const reason = error.code === 'ENOENT' ? 'config_missing' : ['EPERM', 'EACCES'].includes(error.code) ? 'file_unsafe' : ['file_unsafe', 'file_changed', 'file_too_large', 'syntax_unsupported'].includes(error.message) ? error.message : 'read_failed';
    return unavailableDefaults(reason);
  } finally { await handle?.close(); }
}
export function createConfigDefaultsReader({ codexHome, monotonicClock = () => performance.now(), read = () => readConfigDefaults({ codexHome }) } = {}) {
  let current = unavailableDefaults('config_missing'), observed = null, attempted = null, running = null;
  function snapshot() {
    if (observed !== null && monotonicClock() - observed > 15000) return unavailableDefaults('snapshot_stale', 'stale', { model: current.model.source, reasoningEffort: current.reasoningEffort.source });
    return { model: { ...current.model }, reasoningEffort: { ...current.reasoningEffort } };
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
