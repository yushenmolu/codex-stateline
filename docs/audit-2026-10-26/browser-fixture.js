// 在页面任何业务脚本之前注入。真实静态 HTML/CSS/JS 仍从被测服务加载；
// 所有 /api 请求均在内存中合成，绝不转发到真实 API，也不会调用模型或写入数据。
(() => {
  const nativeFetch = window.fetch.bind(window);
  const completedId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const fixture = window.__codexFixture = {
    submissions: [], posts: [], benchmarkGets: 0,
    hangNextPoll: false, postMode: 'normal',
    activeRun: null,
    defaults: {
      model: { state: 'available', source: 'config_top_level', reason: 'none', value: 'fixture-provider/new-model' },
      reasoningEffort: { state: 'available', source: 'config_top_level', reason: 'none', value: 'persistent' },
      availableModels: [
        { slug: 'configured', displayName: '当前配置' },
        { slug: 'fixture-provider/new-model', displayName: '合成模型 · New Model' },
        { slug: 'fixture-provider/other-model', displayName: '合成模型 · Other Model' },
      ],
      availableEfforts: [
        { value: 'configured', label: '当前配置' },
        { value: 'persistent', label: 'persistent' },
        { value: 'none', label: 'none' },
      ],
    },
    completedRun: {
      runId: completedId, requestId: 'ui_fixture_completed', status: 'completed',
      model: 'configured', reasoningEffort: 'configured',
      caseSetVersion: 'pelican-svg-v2', rubricVersion: 'pelican-svg-v2', schemaVersion: 1,
      caseResults: [{ caseId: 'pelican-svg', status: 'completed', answer: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><rect width="20" height="20" fill="#888"/></svg>' }],
    },
    tasks: [
      { id: '11111111-1111-4111-8111-111111111111', title: '合成同名任务（仅测试）', updatedAt: '2026-10-26T07:00:00.000Z', stale: false, truncated: false },
      { id: '11111111-2222-4222-8222-222222222222', title: '合成同名任务（仅测试）', updatedAt: '2026-10-26T07:00:00.000Z', stale: false, truncated: false },
      { id: '11111111-1111-4111-8111-111111111111', title: '合成同名任务（仅测试）', updatedAt: '2026-10-26T07:00:00.000Z', stale: false, truncated: false },
    ],
    agents: [
      { id: 'agent-fixture-1', role: 'code-reviewer', model: 'fixture-provider/a-very-long-model-name-used-for-layout', effort: 'persistent', state: 'completed', association: 'current_turn', updatedAt: '2026-10-26T07:00:00.000Z' },
      { id: 'agent-fixture-2', role: 'debugger', model: 'fixture-provider/another-long-model-name', effort: 'none', state: 'in_progress', association: 'other_turn', updatedAt: '2026-10-26T07:00:00.000Z' },
    ],
    changeDefault() { this.defaults = { ...this.defaults, model: { ...this.defaults.model, value: this.defaults.model.value + '-changed' } }; },
    snapshot() {
      const runs = [...(this.activeRun ? [this.activeRun] : []), this.completedRun];
      const active = this.activeRun ? { ...this.activeRun, progress: { stage: 'generating', elapsedMs: 1200, budgetMs: 900000, lastEvent: null } } : null;
      return { status: active?.status ?? 'idle', activeRun: active, latestRun: runs.at(-1), runs, baseline: null, comparison: null, available: true, defaults: this.defaults };
    },
  };
  const json = (body, status = 200, headers = {}) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } }));
  const telemetry = id => ({
    state: 'unavailable', reason: 'turn_incomplete', sampledAt: new Date().toISOString(),
    task: { ...fixture.tasks.find(task => task.id === id) },
    currentTurn: null, agents: fixture.agents,
  });
  async function post(path, init) {
    const payload = JSON.parse(init.body);
    fixture.posts.push({ path, payload });
    if (path === '/api/benchmark/run') {
      fixture.submissions.push(payload);
      if (fixture.postMode === 'lose-no-record') {
        fixture.postMode = 'normal';
        throw new TypeError('fixture: synthetic response lost, no run record');
      }
      if (!fixture.activeRun) {
        fixture.activeRun = {
          runId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', requestId: payload.requestId, status: 'running',
          model: payload.model, reasoningEffort: payload.reasoningEffort,
          caseSetVersion: 'pelican-svg-v2', rubricVersion: 'pelican-svg-v2', schemaVersion: 1,
          caseResults: [{ caseId: 'pelican-svg', status: 'running' }],
        };
      }
      if (fixture.activeRun.requestId !== payload.requestId) return json({ error: { code: 'run_active' } }, 409);
      if (fixture.postMode === 'lose-with-record') {
        fixture.postMode = 'normal';
        throw new TypeError('fixture: synthetic response lost after accepting run');
      }
      return json(fixture.snapshot());
    }
    return json({ error: { code: 'fixture_blocked' } }, 503);
  }
  window.fetch = async (input, init = {}) => {
    const path = typeof input === 'string' ? input : input.url;
    if (!path.startsWith('/api/')) return nativeFetch(input, init);
    const method = init.method ?? 'GET';
    if (method !== 'GET') return post(path, init);
    if (path === '/api/tasks') return json({ tasks: fixture.tasks, sampledAt: new Date().toISOString(), stale: false, truncated: false });
    if (path.startsWith('/api/telemetry?taskId=')) return json(telemetry(decodeURIComponent(path.split('=')[1])));
    if (path === '/api/capabilities') return json({ product: 'codex-companion', protocolVersion: 1, instanceId: '11111111-1111-4111-8111-111111111111', capabilities: [] });
    if (path === '/api/nonce') return json({}, 200, { 'X-Codex-Companion-Nonce': 'fixture-only' });
    if (path === '/api/benchmark') {
      fixture.benchmarkGets++;
      if (fixture.hangNextPoll) {
        fixture.hangNextPoll = false;
        return new Promise((resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('fixture timeout', 'AbortError')), { once: true });
        });
      }
      return json(fixture.snapshot());
    }
    return json({ error: { code: 'fixture_unknown_route' } }, 404);
  };
})();
