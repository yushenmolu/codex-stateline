import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { createCompanionServer } from '../../src/server.js';
import * as fixtures from '../fixtures/html-preview.js';

// Explicit process entry prevents node --test discovery from opening a listener.
if (process.argv.includes('--serve')) {
const version = 'pelican-html-animated-v1';
const runId = '22222222-2222-4222-8222-222222222222';
let answer, status = 'completed', stopped = false;
const record = () => ({runId, requestId:'fixture_request_0001', model:'configured', reasoningEffort:'configured', schemaVersion:1, caseSetVersion:version, rubricVersion:version, status, caseResults:[{caseId:'pelican-html-animated',status,answer}]});
const benchmark = {
  snapshot: async () => ({status,available:true,activeRun:['queued','running'].includes(status)?record():null,latestRun:record(),runs:[record()],baseline:null,comparison:null}),
  run: async () => { status='running'; return benchmark.snapshot(); },
  score: async () => benchmark.snapshot(), baseline: async () => benchmark.snapshot(),
  cancel: async () => {status='cancelled';return benchmark.snapshot();}, close: async () => {},
  preview: async id => {
    if(id!==runId)throw Object.assign(new Error('Fixture request failed.'),{status:404,code:'run_not_found'});
    const pending=['queued','running'].includes(status);
    const reason=pending?null:status==='completed'?(answer?null:'answer_missing'):'run_'+status;
    const tooLarge=status==='completed'&&typeof answer==='string'&&(answer.length>131072||Buffer.byteLength(answer)>131072);
    const ready=!pending&&!reason&&!tooLarge;
    return {runId,status,caseSetVersion:version,rubricVersion:version,caseId:'pelican-html-animated',caseStatus:status,previewState:pending?'pending':tooLarge?'too_large':ready?'ready':'unavailable',reason:tooLarge?'preview_budget_exceeded':reason,answer:ready?answer:null,contentDigest:ready?createHash('sha256').update(answer,'utf8').digest('hex'):null};
  }
};
const app=createCompanionServer({benchmark,telemetry:{snapshot:()=>({state:'empty',usage:null,speed:null}),stop:async()=>{}},defaults:{snapshot:()=>({model:{state:'unavailable'},reasoningEffort:{state:'unavailable'}}),stop:async()=>{}}});
const emit=data=>process.stdout.write(JSON.stringify(data)+'\n');
async function close(){if(stopped)return;stopped=true;await app.close();process.exit(0);}
const input=createInterface({input:process.stdin});
input.on('line',line=>{try{
  const command=JSON.parse(line);
  if(command.command==='close'){void close();return;}
  if(command.command==='select'){
    // Select WP2 exports only; never accept HTML or expose HTTP controls.
    const value=fixtures[command.fixture];
    const html=typeof value==='string'?value:value?.html;
    if(typeof html!=='string')throw Error();
    answer=html;status='completed';emit({event:'selected',fixture:command.fixture});return;
  }
  if(command.command==='negative-list'){emit({event:'negatives',fixtures:fixtures.NEGATIVE_HTML.map(({name,errorCode})=>({name,errorCode}))});return;}
  if(command.command==='negative'){
    const value=fixtures.NEGATIVE_HTML.find(item=>item.name===command.name);
    if(!value||typeof value.answer!=='string')throw Error();
    answer=value.answer;status='completed';emit({event:'selected',fixture:value.name,errorCode:value.errorCode});return;
  }
  if(command.command==='state'&&['queued','running','completed','failed','cancelled','timed_out'].includes(command.status)){status=command.status;emit({event:'state',status});return;}
  if(command.command==='empty'){answer='';status='completed';emit({event:'empty'});return;}
  if(command.command==='list'){emit({event:'fixtures',names:Object.keys(fixtures).filter(key=>typeof fixtures[key]==='string'||typeof fixtures[key]?.html==='string')});return;}
  throw Error();
}catch{emit({event:'control_error'});}});
input.on('close',()=>void close());
app.server.once('error',async error=>{process.stderr.write(error.code==='EADDRINUSE'?'Fixture port 4173 is occupied.\n':'Fixture startup failed.\n');await app.close();process.exit(1);});
app.server.listen(4173,'127.0.0.1',async()=>{
  const response=await fetch('http://127.0.0.1:4173/api/capabilities');
  const {instanceId}=await response.json();emit({event:'ready',instanceId,runId});
});
}
