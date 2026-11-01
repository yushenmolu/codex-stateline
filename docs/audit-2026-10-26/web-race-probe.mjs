// Main-agent diagnostic probe; synthetic routes only, no network or business writes.
import { createWebFixture, idleBenchmark, defaults, emptyTasks, capabilities, jsonResponse, syntheticIds, fire, flushPromises } from '../../tests/helpers/web-ui-fixture.js';
const basic = benchmark => request => {
  if (request.url === '/api/tasks') return jsonResponse(emptyTasks);
  if (request.url === '/api/capabilities') return jsonResponse(capabilities);
  if (request.url === '/api/nonce') return jsonResponse({});
  if (request.url === '/api/benchmark') return jsonResponse({ defaults: defaults(), ...benchmark });
  throw new Error('unexpected synthetic route: ' + request.url);
};
const snap = (fixture, label) => console.log(JSON.stringify({label, message: fixture.$('benchmark-message').textContent, state: fixture.$('benchmark-state').textContent, disabled: fixture.$('run').disabled, cancelHidden: fixture.$('cancel').classList.contains('hidden'), catalog: fixture.$('catalog-message')?.textContent, htmlCapability: fixture.$('html-capability').textContent, model: { value: fixture.$('model').value, options: fixture.$('model').options.map(o=>[o.value,o.disabled]) }, effort: { value: fixture.$('effort').value, options: fixture.$('effort').options.map(o=>[o.value,o.disabled]) }, requests: fixture.requests.map(r=>r.method+' '+r.url)}));
let failed = false;
const fixture = await createWebFixture(request => {
  if (request.url === '/api/benchmark/run') throw new TypeError('synthetic response connection lost');
  if (request.url === '/api/benchmark' && failed) throw new TypeError('synthetic GET connection lost');
  return basic(idleBenchmark)(request);
});
failed = true;
for (const label of ['initial','second','third']) {
  fire(fixture.$('run'), 'click'); await flushPromises(30); snap(fixture,label);
}
let rejectOldGet, accepted = false, holdGet = false;
const active = { runId: syntheticIds.run, requestId: null, status: 'running', model: 'configured', reasoningEffort: 'configured', caseSetVersion: 'pelican-svg-v2', rubricVersion: 'pelican-svg-v2', caseResults: [] };
const race = await createWebFixture(request => {
  if (request.url === '/api/benchmark/run') { accepted = true; return jsonResponse({ ...idleBenchmark, defaults: defaults(), status: 'running', activeRun: { ...active, requestId: request.body.requestId } }); }
  if (request.url === '/api/benchmark' && holdGet && !accepted) return new Promise((_, reject) => { rejectOldGet = reject; });
  return basic({ ...idleBenchmark, status: 'running', activeRun })(request);
});
holdGet = true;
const stalePoll = race.pollBenchmark();
fire(race.$('run'), 'click'); await flushPromises(30); snap(race,'confirmed');
rejectOldGet(new TypeError('late failure from the superseded GET'));
await stalePoll; snap(race,'late rejected');
process.exit(0);
