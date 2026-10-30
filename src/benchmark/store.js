import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
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
  async function save(value) {
    const tmp = filePath + '.tmp-' + randomUUID();
    try {
      await writeFile(tmp, JSON.stringify(value), 'utf8');
      await rename(tmp, filePath);
    } finally {
      await rm(tmp, { force: true }).catch(() => {});
    }
  }
  function mutate(fn) {
    const operation = queue.catch(() => {}).then(async () => {
      const current = await ensure();
      const candidate = structuredClone(current);
      const result = await fn(candidate);
      // Detach the committed state from objects retained by the caller.
      const committed = structuredClone(candidate);
      await save(committed);
      data = committed;
      return result;
    });
    queue = operation.catch(() => {});
    return operation;
  }
  return { filePath, load: ensure, mutate, async snapshot() { await ensure(); return structuredClone(data); }, async close() { await queue; } };
}
