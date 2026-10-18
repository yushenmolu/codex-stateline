(function(scope){
'use strict';
const ORIGIN='http://127.0.0.1:4173',VERSION='pelican-html-animated-v1',UUID='[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const uuid=new RegExp('^'+UUID+'$'),fragment=new RegExp('^#v=1&instanceId=('+UUID+')&runId=('+UUID+')$');
const codes=['document_invalid','namespace_invalid','element_forbidden','attribute_forbidden','value_invalid','css_invalid','css_unsupported','reference_invalid','budget_exceeded','render_timeout','internal_error'];
const keys=['v','boot','channel','generation','instanceId','runId'];
const bytes=s=>new TextEncoder().encode(s).length;
const exact=(o,ks)=>o!==null&&typeof o==='object'&&!Array.isArray(o)&&[Object.prototype,null].includes(Object.getPrototypeOf(o))&&Object.keys(o).sort().join(',')===ks.slice().sort().join(',');
function parseTarget(hash){const m=fragment.exec(hash);return m?{instanceId:m[1],runId:m[2]}:null;}
function validMessage(d,type){
 if(type==='preview.hello')return exact(d,['type','v','boot'])&&d.type===type&&d.v===1&&typeof d.boot==='string'&&/^[0-9a-f]{32}$/.test(d.boot);
 const extra=type==='preview.result'?['contentDigest','state','errorCode']:[];
 if(!['preview.ack','preview.result'].includes(type)||!exact(d,['type',...keys,...extra])||d.type!==type||d.v!==1||typeof d.boot!=='string'||!/^[0-9a-f]{32}$/.test(d.boot)||typeof d.channel!=='string'||!/^[0-9a-f]{32}$/.test(d.channel)||!Number.isSafeInteger(d.generation)||d.generation<1||!uuid.test(d.instanceId)||!uuid.test(d.runId)||bytes(JSON.stringify(d))>2048)return false;
 return type==='preview.ack'||(typeof d.contentDigest==='string'&&/^[0-9a-f]{64}$/.test(d.contentDigest)&&((d.state==='rendered'&&d.errorCode===null)||(d.state==='rejected'&&codes.includes(d.errorCode))));
}
function createSession({window,document,stage,target,generation,answer,contentDigest,onResult,onError}){
 let iframe,initialLoadSeen=false,boundBoot=null,initSent=false,ackSeen=false,destroyed=false,renderSent=false,handshakeTimer,renderTimer;
 const channel=Array.from(window.crypto.getRandomValues(new Uint8Array(16)),n=>n.toString(16).padStart(2,'0')).join('');
 const tuple=()=>({v:1,boot:boundBoot,channel,generation,...target});
 const destroy=()=>{if(destroyed)return;destroyed=true;window.clearTimeout(handshakeTimer);window.clearTimeout(renderTimer);window.removeEventListener('message',receive);iframe.removeEventListener('load',load);iframe.remove();};
 const error=code=>{destroy();onError(code);};
 const init=()=>{if(!destroyed&&initialLoadSeen&&boundBoot!==null&&!ackSeen){initSent=true;iframe.contentWindow.postMessage({type:'preview.init',...tuple()},'*');}};
 function load(){if(destroyed)return;if(initialLoadSeen){error('frame_reloaded');return;}initialLoadSeen=true;init();}
 function receive(event){
 if(destroyed||event.source!==iframe.contentWindow||event.origin!=='null')return;const d=event.data;
 if(validMessage(d,'preview.hello')){if(boundBoot!==null&&boundBoot!==d.boot){error('frame_reloaded');return;}boundBoot=d.boot;init();return;}
 if(!initSent||!keys.every(k=>d?.[k]===tuple()[k]))return;
 if(validMessage(d,'preview.ack')){if(ackSeen)return;ackSeen=true;window.clearTimeout(handshakeTimer);renderSent=true;renderTimer=window.setTimeout(()=>error('render_timeout'),3000);iframe.contentWindow.postMessage({type:'preview.render',...tuple(),contentDigest,answer},'*');return;}
 if(renderSent&&validMessage(d,'preview.result')&&d.contentDigest===contentDigest){window.clearTimeout(renderTimer);renderSent=false;if(d.state==='rejected'){error(d.errorCode);return;}onResult();}
 }
 window.addEventListener('message',receive);iframe=document.createElement('iframe');iframe.setAttribute('sandbox','allow-scripts');iframe.setAttribute('referrerpolicy','no-referrer');iframe.setAttribute('title','隔离 HTML 动画');iframe.src='/preview-frame';iframe.addEventListener('load',load);handshakeTimer=window.setTimeout(()=>error('handshake_timeout'),2000);stage.replaceChildren(iframe);
 return {destroy,iframe,get state(){return {initialLoadSeen,boundBoot,initSent,ackSeen,destroyed,generation};}};
}
async function readJSON(response,limit,signal){
 if(response.headers.get('content-encoding')&&!['identity'].includes(response.headers.get('content-encoding')))throw Error('protocol_error');
 if(!/^application\/json(?:;|$)/i.test(response.headers.get('content-type')??''))throw Error('protocol_error');
 const reader=response.body?.getReader();if(!reader)throw Error('protocol_error');const chunks=[];let total=0;
 try{while(true){if(signal?.aborted)throw Error('service_unavailable');const {done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>limit)throw Error('protocol_error');chunks.push(value);}const joined=new Uint8Array(total);let offset=0;for(const c of chunks){joined.set(c,offset);offset+=c.length;}return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(joined));}
 catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
}
function validPreview(d,target){
 const all=['protocolVersion','instanceId','runId','status','caseSetVersion','rubricVersion','caseId','caseStatus','previewState','reason','answer','contentDigest'];
 const statuses=['queued','running','completed','failed','cancelled','timed_out'];
 if(!exact(d,all)||d.protocolVersion!==1||d.instanceId!==target.instanceId||d.runId!==target.runId||d.caseSetVersion!==VERSION||d.rubricVersion!==VERSION||d.caseId!=='pelican-html-animated'||!statuses.includes(d.status)||!statuses.includes(d.caseStatus))return false;
 if(['queued','running'].includes(d.status))return ['queued','running','completed'].includes(d.caseStatus)&&d.previewState==='pending'&&d.reason===null&&d.answer===null&&d.contentDigest===null;
 if(['failed','cancelled','timed_out'].includes(d.status))return d.previewState==='unavailable'&&d.reason==='run_'+d.status&&d.answer===null&&d.contentDigest===null;
 if(d.status!=='completed'||d.caseStatus!=='completed')return false;
 if(d.previewState==='unavailable')return d.reason==='answer_missing'&&d.answer===null&&d.contentDigest===null;
 if(d.previewState==='too_large')return d.reason==='preview_budget_exceeded'&&d.answer===null&&d.contentDigest===null;
 return d.previewState==='ready'&&d.reason===null&&typeof d.answer==='string'&&d.answer.length>0&&d.answer.length<=131072&&bytes(d.answer)<=131072&&typeof d.contentDigest==='string'&&/^[0-9a-f]{64}$/.test(d.contentDigest);
}
function start(){
 const $=id=>scope.document.getElementById(id),target=parseTarget(scope.location.hash);let requestGeneration=0,frameGeneration=0,controller=null,pollTimer=null,session=null,lastDigest=null;
 const status=(text,error=false)=>{$('preview-status').textContent=text;$('preview-status').dataset.state=error?'error':'normal';};
 function clear(){requestGeneration++;controller?.abort();controller=null;scope.clearTimeout(pollTimer);session?.destroy();session=null;frameGeneration++;lastDigest=null;}
 function stop(code){clear();status('预览不可用：'+code,true);$('preview-retry').hidden=false;}
 async function request(path,gen){controller=new AbortController();const current=controller,timer=scope.setTimeout(()=>current.abort(),5000);try{const r=await scope.fetch(path,{cache:'no-store',headers:{Accept:'application/json'},signal:current.signal});const data=await readJSON(r,r.ok?819200:2048,current.signal);if(gen!==requestGeneration)throw Error('stale');if(!r.ok){
 if(path==='/api/capabilities'){
  if(!exact(data,['error'])||!exact(data.error,['code','message'])||typeof data.error.code!=='string'||typeof data.error.message!=='string')throw Error('protocol_error');
  throw Error('service_unavailable');
 }
 const statuses={preview_query_invalid:400,host_invalid:403,origin_invalid:403,fetch_metadata_invalid:403,run_not_found:404,method_not_allowed:405,instance_mismatch:409,preview_version_mismatch:409,preview_case_mismatch:409,preview_record_invalid:409,benchmark_unavailable:503,service_unavailable:503};
 if(!exact(data,['protocolVersion','instanceId','error'])||data.protocolVersion!==1||typeof data.instanceId!=='string'||!uuid.test(data.instanceId)||!exact(data.error,['code','message'])||data.error.message!=='Preview request failed.'||typeof data.error.code!=='string'||!Object.hasOwn(statuses,data.error.code)||statuses[data.error.code]!==r.status||(data.error.code!=='instance_mismatch'&&data.instanceId!==target.instanceId)||(data.error.code==='method_not_allowed'&&r.headers.get('allow')!=='GET'))throw Error('protocol_error');
 throw Error(data.error.code==='instance_mismatch'?'instance_mismatch':'service_unavailable');
 }return data;}finally{scope.clearTimeout(timer);if(controller===current)controller=null;}}
 async function poll(gen){try{const d=await request('/api/benchmark/preview?runId='+target.runId+'&instanceId='+target.instanceId,gen);if(gen!==requestGeneration)return;if(d.instanceId!==target.instanceId){stop('instance_mismatch');return;}if(!validPreview(d,target))throw Error('protocol_error');
 if(d.previewState==='pending'){status('等待 HTML 动画结果…');pollTimer=scope.setTimeout(()=>poll(gen),1000);return;}
 if(d.previewState!=='ready'){stop(d.reason);return;}
 $('preview-source').textContent=d.answer;
 const digest=Array.from(new Uint8Array(await scope.crypto.subtle.digest('SHA-256',new TextEncoder().encode(d.answer))),n=>n.toString(16).padStart(2,'0')).join('');if(gen!==requestGeneration)return;if(digest!==d.contentDigest)throw Error('protocol_error');if(lastDigest===digest)return;
 session?.destroy();lastDigest=digest;status('正在验证并渲染…');session=createSession({window:scope,document:scope.document,stage:$('preview-stage'),target,generation:++frameGeneration,answer:d.answer,contentDigest:digest,onResult:()=>status('动画已显示'),onError:stop});
 }catch(e){if(gen===requestGeneration)stop(e.message==='instance_mismatch'?'instance_mismatch':e.message==='protocol_error'?'protocol_error':'service_unavailable');}}
 async function retry(){clear();$('preview-retry').hidden=true;$('preview-source').textContent='';if(!target||scope.location.origin!==ORIGIN){stop('target_invalid');$('preview-retry').hidden=true;return;}const gen=requestGeneration;status('正在验证服务实例…');try{const c=await request('/api/capabilities',gen);if(gen!==requestGeneration)return;if(c.instanceId!==target.instanceId)throw Error('instance_mismatch');if(c.product!=='codex-companion'||c.protocolVersion!==1||!Array.isArray(c.capabilities)||![VERSION,'isolated-html-preview-v1'].every(x=>c.capabilities.includes(x))){stop('capability_missing');return;}await poll(gen);}catch(e){if(gen===requestGeneration)stop(e.message==='instance_mismatch'?'instance_mismatch':'service_unavailable');}}
 $('preview-retry').addEventListener('click',retry);scope.addEventListener('pagehide',clear,{once:true});scope.addEventListener('hashchange',()=>{clear();status('目标已改变，请重新打开预览。',true);$('preview-retry').hidden=true;});retry();
}
if(typeof module!=='undefined'&&module.exports)module.exports={parseTarget,validMessage,createSession,readJSON,validPreview};else if(scope.document)start();
})(globalThis);
