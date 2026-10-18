import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const empty = () => ({ version: 1, nextSeq: 1, reservations: {}, runs: [], baseline: null });
export function createStore({ filePath = join(process.env.LOCALAPPDATA ?? process.env.TEMP ?? '.', 'codex-companion', 'benchmark.json') } = {}) {
  let data = null;
  let queue = Promise.resolve();
  async function ensure() {
    if (data) return data;
    await mkdir(dirname(filePath), { recursive: true });
    try { data = JSON.parse(await readFile(filePath, 'utf8')); } catch { data = empty(); }
    for (const reservation of Object.values(data.reservations ?? {})) if (['queued', 'running'].includes(reservation.status)) reservation.status = 'interrupted';
    for (const run of data.runs ?? []) if (['queued', 'running'].includes(run.status)) run.status = 'interrupted';
    return data;
  }
  async function save() { const tmp = filePath + '.tmp-' + randomUUID(); await writeFile(tmp, JSON.stringify(data), 'utf8'); await rename(tmp, filePath); }
  function mutate(fn) {
    const operation = queue.catch(() => {}).then(async () => { await ensure(); const result = await fn(data); await save(); return result; });
    queue = operation.catch(() => {});
    return operation;
  }
  return { filePath, load: ensure, mutate, async snapshot() { await ensure(); return structuredClone(data); }, async close() { await queue; } };
}
