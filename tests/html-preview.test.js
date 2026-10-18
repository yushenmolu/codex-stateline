import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {spawnSync} from 'node:child_process';
import {HTML_PREVIEW_FIXTURE,MINIMAL_HTML,NEGATIVE_HTML} from './fixtures/html-preview.js';
function load(file){const context=vm.createContext({module:{exports:{}},TextEncoder,TextDecoder,Uint8Array});vm.runInContext(fs.readFileSync(new URL('../src/public/'+file,import.meta.url),'utf8'),context);const api=context.module.exports;api.cloneMessage=d=>vm.runInContext('('+JSON.stringify(d)+')',context);return api;}
const frame=load('preview-frame.js'),host=load('preview.js');
const rejection=(fn,code)=>assert.throws(fn,e=>e.code===code);
// Platform XML supplies nodes to the production validator; not Edge evidence.
function xmlDocuments(sources){
 const script=[
 "$ErrorActionPreference='Stop'",
 '$sources=([Console]::In.ReadToEnd() | ConvertFrom-Json)',
 'function Tree($node){',
 'if($node.NodeType -eq [Xml.XmlNodeType]::Element){',
 '$attrs=@(foreach($a in $node.Attributes){@{name=$a.Name;value=$a.Value;namespaceURI=$a.NamespaceURI}})',
 'return @{nodeType=1;localName=$node.LocalName;nodeName=$node.Name;prefix=$node.Prefix;namespaceURI=$node.NamespaceURI;attributes=$attrs;childNodes=@(foreach($c in $node.ChildNodes){Tree $c})}}',
 'if($node.NodeType -in @([Xml.XmlNodeType]::Text,[Xml.XmlNodeType]::Whitespace,[Xml.XmlNodeType]::SignificantWhitespace)){return @{nodeType=3;nodeValue=$node.Value}}',
 'return @{nodeType=99}}',
 '$result=@(foreach($source in $sources){try{$doc=New-Object Xml.XmlDocument;$doc.PreserveWhitespace=$true;$doc.XmlResolver=$null;$doc.LoadXml($source);@{childNodes=@(foreach($n in $doc.ChildNodes){Tree $n})}}catch{@{invalid=$true}}})',
 'ConvertTo-Json -InputObject $result -Depth 100 -Compress'
 ].join('\n');
 const r=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{input:JSON.stringify(sources),encoding:'utf8',maxBuffer:12000000,timeout:20000});assert.equal(r.status,0,r.stderr||r.error?.message);return JSON.parse(r.stdout.replace(/^\uFEFF/,'' )).map(hydrate);
}
function hydrate(d){if(d.invalid)return d;function walk(n,p){n.parentNode=p;n.childNodes??=[];n.attributes??=[];n.getAttribute=k=>n.attributes.find(a=>a.name===k)?.value??null;n.childNodes.forEach(c=>walk(c,n));Object.defineProperty(n,'textContent',{get(){return n.nodeType===3?n.nodeValue:n.childNodes.map(c=>c.textContent).join('');}});}walk(d,null);d.documentElement=d.childNodes.find(n=>n.nodeType===1);return d;}
const minimal=MINIMAL_HTML;
const negatives=[
 ['script',HTML_PREVIEW_FIXTURE.replace('<div class="stage">','<script>alert(1)</script><div class="stage">'),'element_forbidden'],
 ['event',HTML_PREVIEW_FIXTURE.replace('<div class="stage">','<div class="stage" onclick="alert(1)">'),'attribute_forbidden'],
 ['resource',HTML_PREVIEW_FIXTURE.replace('<div class="stage">','<img src="http://127.0.0.1:1/"/><div class="stage">'),'element_forbidden'],
 ['namespace',HTML_PREVIEW_FIXTURE.replace('http://www.w3.org/2000/svg','http://www.w3.org/1999/xhtml'),'namespace_invalid'],
 ['root paint',HTML_PREVIEW_FIXTURE.replace('viewBox="0 0 800 600"','viewBox="0 0 800 600" fill="#FFFFFF"'),'attribute_forbidden'],
 ['points',HTML_PREVIEW_FIXTURE.replace('240,410 320,300 380,410','240, 410 320,300 380,410'),'value_invalid'],
 ['four decimals',HTML_PREVIEW_FIXTURE.replace('cx="240"','cx="240.0001"'),'value_invalid'],
 ['HTML animation',HTML_PREVIEW_FIXTURE.replace('<div class="stage">','<div class="bird">'),'reference_invalid'],
 ['second SVG',HTML_PREVIEW_FIXTURE.replace('</svg>','</svg><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600"/>'),'budget_exceeded'],
 ...['form','iframe','a','foreignObject','use','animate','path'].map(tag=>[tag,HTML_PREVIEW_FIXTURE.replace('<div class="stage">','<'+tag+'/><div class="stage">'),'element_forbidden'])
];
const docs=xmlDocuments([HTML_PREVIEW_FIXTURE,minimal,...negatives.map(f=>f[1])]);
const sharedNegativeDocs=xmlDocuments(NEGATIVE_HTML.map(f=>f.answer));
for(const [i,f] of NEGATIVE_HTML.entries())test('shared negative '+f.name,()=>rejection(()=>{frame.sourceCheck(f.answer);if(sharedNegativeDocs[i].invalid)throw Object.assign(Error(),{code:'document_invalid'});frame.validateDocument(sharedNegativeDocs[i]);},f.errorCode));
test('frozen fixture: three targets; D=8, E=18; minimal empty document',()=>{
 frame.sourceCheck(HTML_PREVIEW_FIXTURE);const v=frame.validateDocument(docs[0]);assert.equal(v.counts.animated,3);assert.equal(v.counts.svg,1);assert.equal(v.ast.classes[0].declarations.length,8);assert.equal(v.ast.classes[0].expanded.length,18);assert.equal(v.ast.rules,10);assert.equal(v.ast.declarations,27);assert.equal(frame.validateDocument(docs[1]).counts.animated,0);
});
for(const [i,f] of negatives.entries())test('reject '+f[0],()=>rejection(()=>{frame.sourceCheck(f[1]);frame.validateDocument(docs[i+2]);},f[2]));
test('CSS grammar, exact case, complete longhands, no silent repair',()=>{
 const css=docs[0].documentElement.childNodes.find(n=>n.localName==='head').childNodes.find(n=>n.localName==='style').textContent;
 for(const p of ['animation-name','animation-duration','animation-timing-function','animation-iteration-count','animation-direction'])rejection(()=>frame.parseCSS(css.replace(new RegExp(p+':[^;]+;'),' ')),'css_invalid');
 for(const bad of ['.x{display:block}','.x{display:block;display:block;}','.x{} .x{}','@keyframes a{100%{transform:rotate(0deg);}0%{transform:rotate(360deg);}}','@keyframes a{0%{transform:rotate(0deg);}0%{transform:rotate(360deg);}}','.x{transform:translatey(0px);}','.x{animation-delay:1s;}','.x{margin-top:0px;}','.x{opacity:0.1234;}','.x{padding:0px 1px;}','.x{width:1e2px;}','.x{color:#ff ffff;}','.x{display:block!important;}','.x{width:calc(1px);}','/*x*/','.x{animation:spin 1s;}','@import url(x);','.x{--x:1;}','.x{fill:url(x);}'])rejection(()=>frame.parseCSS(bad),'css_invalid');
 assert.equal(frame.parseCSS('.x{transform:translateY(-8px);}').classes[0].declarations[0].value,'translateY(-8px)');assert.equal(frame.tokenize('1s 0% @keyframes').length,6);
});
test('inclusive limits and raw-input controls',()=>{
 for(const [k,n] of Object.entries(frame.LIMITS)){frame.budget(k,n-1);frame.budget(k,n);rejection(()=>frame.budget(k,n+1),'budget_exceeded');}
 for(const n of [131071,131072])frame.sourceCheck('x'.repeat(n));rejection(()=>frame.sourceCheck('x'.repeat(131073)),'budget_exceeded');for(const s of ['\0','\ud800','\udfff','&amp;','<!DOCTYPE html>','<?xml?>'])rejection(()=>frame.sourceCheck(s),'document_invalid');frame.sourceCheck('😀');rejection(()=>frame.sourceCheck('中'.repeat(43691)),'budget_exceeded');
 for(const n of [32767,32768])frame.parseCSS(' '.repeat(n));rejection(()=>frame.parseCSS(' '.repeat(32769)),'budget_exceeded');
 for(const n of [127,128])assert.equal(frame.parseCSS(Array.from({length:n},(_,i)=>'.x'+i+'{}').join('')).rules,n);rejection(()=>frame.parseCSS(Array.from({length:129},(_,i)=>'.x'+i+'{}').join('')),'budget_exceeded');
});
test('actual XML element/node/depth/text/points budget accounting',()=>{
 const clone=n=>JSON.parse(JSON.stringify(n,(k,v)=>['parentNode','textContent','documentElement'].includes(k)||typeof v==='function'?undefined:v));
 const base=clone(docs[1]),el=(name,attrs=[],children=[],ns=frame.XHTML)=>({nodeType:1,localName:name,nodeName:name,prefix:'',namespaceURI:ns,attributes:attrs,childNodes:children}),body=d=>d.childNodes[0].childNodes[1];
 for(const count of [1023,1024,1025]){const d=clone(base);body(d).childNodes=Array.from({length:count-5},()=>el('span'));const run=()=>frame.validateDocument(hydrate(d));if(count>1024)rejection(run,'budget_exceeded');else assert.equal(run().counts.elements,count);}
 for(const count of [4095,4096,4097]){const d=clone(base);body(d).childNodes=Array.from({length:count-6},()=>({nodeType:3,nodeValue:''}));const run=()=>frame.validateDocument(hydrate(d));if(count>4096)rejection(run,'budget_exceeded');else assert.equal(run().counts.nodes,count);}
 for(const depth of [23,24,25]){const d=clone(base);let n=body(d);for(let i=3;i<=depth;i++){const child=el('div');n.childNodes=[child];n=child;}const run=()=>frame.validateDocument(hydrate(d));if(depth>24)rejection(run,'budget_exceeded');else run();}
 for(const n of [16383,16384,16385]){const d=clone(base);body(d).childNodes=[{nodeType:3,nodeValue:'x'.repeat(n-7)}];const run=()=>frame.validateDocument(hydrate(d));if(n>16384)rejection(run,'budget_exceeded');else assert.equal(run().counts.textUnits,n);}
 for(const n of [255,256,257]){const d=clone(base);body(d).childNodes=[el('svg',[{name:'xmlns',value:frame.SVG},{name:'viewBox',value:'0 0 800 600'}],[el('polygon',[{name:'points',value:Array(n).fill('1,1').join(' ')}],[],frame.SVG)],frame.SVG)];const run=()=>frame.validateDocument(hydrate(d));if(n>256)rejection(run,'budget_exceeded');else assert.equal(run().counts.totalPoints,n);}
});
function fakeSheet(ast,mutate=()=>{}){const rules=[...ast.classes,...ast.keyframes];return class{constructor(){this.cssRules=[];}insertRule(text,index){const r=rules[index],style=ds=>({length:ds.length,item:i=>ds[i].property,getPropertyPriority:()=>'',getPropertyValue:p=>ds.find(d=>d.property===p)?.value??''});const a=r.kind==='class'?{type:1,selectorText:'.'+r.name,style:style(r.expanded)}:{type:7,name:r.name,cssRules:r.frames.map(f=>({type:8,keyText:f.percent+'%',style:style(f.expanded)}))};mutate(a,index);this.cssRules.push(a);return index;}};}
test('CSSOM expanded count, property set, priority and semantic verification',()=>{
 const ast=frame.validateDocument(docs[0]).ast;assert.match(frame.checkCSSOM(ast,fakeSheet(ast)),/margin-top:0px/);
 for(const mutation of [r=>r.style.length=8,r=>r.style.getPropertyValue=()=>'',r=>r.style.getPropertyPriority=()=>'important',r=>r.style.item=()=>'unknown'])rejection(()=>frame.checkCSSOM(ast,fakeSheet(ast,(r,i)=>{if(i===0)mutation(r);})),'css_unsupported');
 assert.equal(frame.semanticValue('color','#EAF4FA','rgb(234, 244, 250)'),true);assert.equal(frame.semanticValue('transform-origin','center','50% 50%'),true);assert.equal(frame.semanticValue('transform','translateY(-8px)','translateY(-8.0px)'),true);assert.equal(frame.semanticValue('transform','translateY(-8px)','translate(0px, -8px)'),false);
});
const target={instanceId:'11111111-1111-4111-8111-111111111111',runId:'22222222-2222-4222-8222-222222222222'};
async function autostartError({status,body,allow=null,capabilityError=false}){
 const nodes=new Map(['preview-status','preview-retry','preview-source','preview-stage'].map(id=>[id,{textContent:'',dataset:{},hidden:false,addEventListener(){}}])),timers=new Map(),requests=[];let next=0,frames=0;
 const capabilities={product:'codex-companion',protocolVersion:1,instanceId:target.instanceId,capabilities:['pelican-html-animated-v1','isolated-html-preview-v1']};
 const context=vm.createContext({TextEncoder,TextDecoder,Uint8Array,AbortController,location:{origin:'http://127.0.0.1:4173',hash:'#v=1&instanceId='+target.instanceId+'&runId='+target.runId},document:{getElementById:id=>nodes.get(id),createElement(){frames++;throw Error('unexpected frame');}},addEventListener(){},setTimeout(fn,ms){timers.set(++next,{fn,ms});return next;},clearTimeout(id){timers.delete(id);},async fetch(path,options){
  requests.push({path,options});const isError=capabilityError||path!=='/api/capabilities',http=isError?status:200,encoded=new TextEncoder().encode(JSON.stringify(isError?body:capabilities));let part=0;
  return {ok:http>=200&&http<300,status:http,headers:{get:name=>name==='content-type'?'application/json':name==='allow'?allow:null},body:{getReader(){return {async read(){return part++===0?{done:false,value:encoded.slice(0,7)}:part===2?{done:false,value:encoded.slice(7)}:{done:true};},async cancel(){},releaseLock(){}};}}};
 }});
 vm.runInContext(fs.readFileSync(new URL('../src/public/preview.js',import.meta.url),'utf8'),context);
 for(let i=0;i<20&&nodes.get('preview-status').dataset.state!=='error';i++)await new Promise(resolve=>setImmediate(resolve));
 assert.equal(nodes.get('preview-status').dataset.state,'error');assert.equal(nodes.get('preview-retry').hidden,false);assert.equal(nodes.get('preview-source').textContent,'');assert.equal(frames,0);assert.equal(timers.size,0);assert.equal(requests.length,capabilityError?1:2);
 assert.equal(requests[0].path,'/api/capabilities');if(!capabilityError)assert.equal(requests[1].path,'/api/benchmark/preview?runId='+target.runId+'&instanceId='+target.instanceId);
 assert.ok(requests.every(r=>r.options.cache==='no-store'&&r.options.headers.Accept==='application/json'));
 return nodes.get('preview-status').textContent;
}
const previewError=(code,instanceId=target.instanceId)=>({protocolVersion:1,instanceId,error:{code,message:'Preview request failed.'}});
test('request/autostart accepts every frozen preview error mapping and legacy capability errors',async()=>{
 const mappings={preview_query_invalid:400,host_invalid:403,origin_invalid:403,fetch_metadata_invalid:403,run_not_found:404,method_not_allowed:405,instance_mismatch:409,preview_version_mismatch:409,preview_case_mismatch:409,preview_record_invalid:409,benchmark_unavailable:503,service_unavailable:503};
 for(const [code,status] of Object.entries(mappings))assert.equal(await autostartError({status,body:previewError(code),allow:status===405?'GET':null}),'预览不可用：'+(code==='instance_mismatch'?'instance_mismatch':'service_unavailable'),code);
 assert.equal(await autostartError({status:409,body:previewError('instance_mismatch','33333333-3333-4333-8333-333333333333')}),'预览不可用：instance_mismatch');
 assert.equal(await autostartError({status:503,body:{error:{code:'service_unavailable',message:'Service is temporarily unavailable.'}},capabilityError:true}),'预览不可用：service_unavailable');
});
test('request/autostart rejects malicious preview error envelopes as protocol_error',async()=>{
 const valid=previewError('run_not_found'),other='33333333-3333-4333-8333-333333333333';
 const invalid=[
  {status:404,body:previewError('instance_mismatch',other)},
  {status:409,body:previewError('run_not_found')},
  {status:418,body:previewError('service_unavailable')},
  ...['unknown','toString','__proto__',null,{},404].map(code=>({status:404,body:previewError(code)})),
  ...[null,123,{},'',other.toUpperCase(),'not-a-uuid'].map(instanceId=>({status:404,body:previewError('run_not_found',instanceId)})),
  {status:404,body:previewError('run_not_found',other)},
  {status:409,body:previewError('instance_mismatch',null)},
  {status:404,body:{...valid,protocolVersion:'1'}},
  {status:404,body:{...valid,extra:true}},
  {status:404,body:{...valid,error:{...valid.error,extra:true}}},
  {status:404,body:{...valid,error:{...valid.error,message:'private server detail'}}},
  {status:404,body:{error:valid.error}},
  {status:404,body:null},
  {status:405,body:previewError('method_not_allowed')},
  {status:405,body:previewError('method_not_allowed'),allow:'POST'}
 ];
 // Use an uppercase UUID containing letters, rather than the all-digit target.
 invalid.push({status:404,body:previewError('run_not_found','AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA')});
 for(const input of invalid)assert.equal(await autostartError(input),'预览不可用：protocol_error',JSON.stringify(input));
});
function harness(){const listeners=new Map(),timers=new Map(),sent=[],errors=[];let next=0,renders=0;const iframe={contentWindow:{postMessage:(d,o)=>sent.push({d,o})},listeners:new Map(),setAttribute(k,v){this[k]=v;},addEventListener(k,f){this.listeners.set(k,f);},removeEventListener(k){this.listeners.delete(k);},remove(){this.removed=true;}};
 const window={crypto:{getRandomValues(a){a.fill(1);return a;}},addEventListener(k,f){listeners.set(k,f);},removeEventListener(k){listeners.delete(k);},setTimeout(fn,ms){timers.set(++next,{fn,ms});return next;},clearTimeout(id){timers.delete(id);}};
 const session=host.createSession({window,document:{createElement:()=>iframe},stage:{replaceChildren(){}},target,generation:1,answer:minimal,contentDigest:'a'.repeat(64),onResult:()=>renders++,onError:c=>errors.push(c)});
 // Create objects in the same realm as the receiver (structured clone behavior).
 const message=(d,source=iframe.contentWindow,origin='null')=>listeners.get('message')?.({data:host.cloneMessage(d),source,origin});
 return {session,iframe,sent,errors,timers,message,hello:(boot='b'.repeat(32),source,origin)=>message({type:'preview.hello',v:1,boot},source,origin),load:()=>iframe.listeners.get('load')?.(),ack:()=>message({...sent.find(x=>x.d.type==='preview.init')?.d,type:'preview.ack'}),get renders(){return renders;}};}
for(const order of ['hello-first','load-first'])test('handshake '+order,()=>{const h=harness();if(order==='hello-first')h.hello();else h.load();assert.equal(h.sent.length,0);if(order==='hello-first')h.load();else h.hello();assert.equal(h.sent[0]?.d.type,'preview.init');h.ack();h.ack();assert.equal(h.sent.filter(x=>x.d.type==='preview.render').length,1);assert.equal(h.iframe.sandbox,'allow-scripts');assert.equal(h.iframe.src,'/preview-frame');});
test('handshake retry, reload, wrong source, fixed deadline, late events',()=>{const h=harness();h.hello();h.hello();assert.equal(h.sent.length,0);h.load();h.hello();assert.equal(h.sent.length,2);h.ack();h.hello('c'.repeat(32),{});assert.equal(h.errors.length,0);h.load();assert.deepEqual(h.errors,['frame_reloaded']);h.hello();h.ack();assert.equal(h.sent.filter(x=>x.d.type==='preview.render').length,1);
 const b=harness();b.hello();b.hello('c'.repeat(32));assert.deepEqual(b.errors,['frame_reloaded']);for(const initial of ['none','hello','load']){const t=harness();if(initial==='hello')t.hello();if(initial==='load')t.load();[...t.timers.values()].find(x=>x.ms===2000).fn();assert.deepEqual(t.errors,['handshake_timeout']);}
});
test('result duplicate/identity/generation and timeout',()=>{const h=harness();h.load();h.hello();h.ack();const {answer,...render}=h.sent.find(x=>x.d.type==='preview.render').d,result={...render,type:'preview.result',state:'rendered',errorCode:null};h.message({...result,generation:2});h.message({...result,channel:'c'.repeat(32)});assert.equal(h.renders,0);h.message(result);h.message(result);assert.equal(h.renders,1);h.session.destroy();h.message(result);assert.equal(h.renders,1);assert.equal(h.timers.size,0);const t=harness();t.load();t.hello();t.ack();[...t.timers.values()].find(x=>x.ms===3000).fn();assert.deepEqual(t.errors,['render_timeout']);});
test('fragment and bounded streaming reader',async()=>{
 const hash='#v=1&instanceId='+target.instanceId+'&runId='+target.runId;assert.equal(host.parseTarget(hash).runId,target.runId);for(const suffix of ['&x=1','%00','&runId='+target.runId])assert.equal(host.parseTarget(hash+suffix),null);
 const response=parts=>({headers:{get:k=>k==='content-type'?'application/json':null},body:{getReader(){let i=0;return {async read(){return i<parts.length?{done:false,value:new TextEncoder().encode(parts[i++])}:{done:true};},async cancel(){},releaseLock(){}};}}});assert.equal((await host.readJSON(response(['{"x":','1}']),10)).x,1);await assert.rejects(host.readJSON(response(['x'.repeat(11)]),10));await assert.rejects(host.readJSON(response(['{']),10));
});
test('no generated code/HTML/network execution primitives',()=>{const source=fs.readFileSync(new URL('../src/public/preview-frame.js',import.meta.url),'utf8');for(const word of ['innerHTML','outerHTML','document.write','eval(','new Function','fetch(','XMLHttpRequest','import(','location.'])assert.equal(source.includes(word),false,word);assert.equal(/<\/script/i.test(source),false);const template=fs.readFileSync(new URL('../src/public/preview-frame.html',import.meta.url),'utf8');assert.equal((template.match(/PREVIEW_FRAME_SCRIPT/g)??[]).length,1);});
test('token, original declaration and definition budgets are independent from expansion',()=>{
 for(const n of [16383,16384])assert.equal(frame.tokenize('.'.repeat(n)).length,n);rejection(()=>frame.tokenize('.'.repeat(16385)),'budget_exceeded');
 const ds=['display:block;','width:1px;','height:1px;','margin:0px;','padding:0px;','border-radius:1px;','overflow:hidden;','color:#FFFFFF;','background-color:#FFFFFF;','opacity:1;','fill:none;','stroke:none;','stroke-width:1;','transform:rotate(0deg);','transform-origin:center;','transform-box:fill-box;'];
 for(const n of [1023,1024,1025]){let remaining=n,css='',i=0;while(remaining){const count=Math.min(16,remaining);css+='.c'+i+++'{'+ds.slice(0,count).join('')+'}';remaining-=count;}if(n>1024)rejection(()=>frame.parseCSS(css),'budget_exceeded');else{const ast=frame.parseCSS(css);assert.equal(ast.declarations,n);assert.ok(ast.classes.reduce((sum,c)=>sum+c.expanded.length,0)>n);}}
 for(const n of [15,16,17]){const css=Array.from({length:n},(_,i)=>'@keyframes k'+i+'{0%{transform:rotate(0deg);}100%{transform:rotate(360deg);}}').join('');if(n>16)rejection(()=>frame.parseCSS(css),'budget_exceeded');else assert.equal(frame.parseCSS(css).keyframes.length,n);}
 const badWhitespace=['.x{transform:translateY(1 2px);}','.x{transform:rotate(1 2deg);}'];badWhitespace.forEach(css=>rejection(()=>frame.parseCSS(css),'css_invalid'));
});
test('attribute, aggregate points, animated-target and keyframe-reference accounting',()=>{
 const defs='@keyframes spin{0%{transform:rotate(0deg);}100%{transform:rotate(360deg);}}';
 const rule='.a{transform-origin:center;transform-box:fill-box;animation-name:spin;animation-duration:2s;animation-timing-function:linear;animation-iteration-count:infinite;animation-direction:normal;}';
 const svg=art=>'<svg xmlns="'+frame.SVG+'" viewBox="0 0 800 600">'+art+'</svg>';
 const document=(art,css='')=>minimal.replace('<style></style>','<style>'+css+'</style>').replace('<body></body>','<body>'+art+'</body>');
 const inputs=[],expected=[];
 for(const n of [8191,8192,8193]){inputs.push(document(svg('<polygon points="'+'0,0 1,1 2,2'+' '.repeat(n-11)+'"/>')));expected.push(n>8192?'budget_exceeded':null);}
 for(const total of [32767,32768,32769]){const overhead=frame.XHTML.length+frame.SVG.length+'0 0 800 600'.length;let remaining=total-overhead,art='';for(let i=0;i<5;i++){const length=Math.min(8192,remaining-(4-i)*11);remaining-=length;art+='<polygon points="'+'0,0 1,1 2,2'+' '.repeat(length-11)+'"/>';}inputs.push(document(svg(art)));expected.push(total>32768?'budget_exceeded':null);}
 for(const n of [2047,2048,2049]){let remaining=n,art='';while(remaining){const count=Math.min(256,remaining);art+='<polyline points="'+Array(count).fill('0,0').join(' ')+'"/>';remaining-=count;}inputs.push(document(svg(art)));expected.push(n>2048?'budget_exceeded':null);}
 for(const n of [15,16,17]){inputs.push(document(svg('<g class="a"/>'.repeat(n)),rule+defs));expected.push(n>16?'budget_exceeded':null);}
 inputs.push(document(svg('<g/>'),rule+defs));expected.push('reference_invalid');inputs.push(document(svg('<g class="a"/>'),rule));expected.push('reference_invalid');
 const parsed=xmlDocuments(inputs);for(const [i,d] of parsed.entries()){const fn=()=>frame.validateDocument(d);if(expected[i])rejection(fn,expected[i]);else fn();}
 const duplicates=xmlDocuments([document('<div class="x" class="y"/>'),document('<div>'),document('<div xmlns="'+frame.SVG+'"/>')]);assert.equal(duplicates[0].invalid,true);assert.equal(duplicates[1].invalid,true);rejection(()=>frame.validateDocument(duplicates[2]),'namespace_invalid');
});
test('API schema honors every state and binds instance, version and target',()=>{
 const base={protocolVersion:1,...target,status:'completed',caseSetVersion:'pelican-html-animated-v1',rubricVersion:'pelican-html-animated-v1',caseId:'pelican-html-animated',caseStatus:'completed',previewState:'ready',reason:null,answer:minimal,contentDigest:'a'.repeat(64)};
 const valid=d=>host.validPreview(host.cloneMessage(d),target);
 assert.equal(valid(base),true);for(const status of ['queued','running'])assert.equal(valid({...base,status,caseStatus:'queued',previewState:'pending',answer:null,contentDigest:null}),true);
 for(const status of ['failed','cancelled','timed_out'])assert.equal(valid({...base,status,previewState:'unavailable',reason:'run_'+status,answer:null,contentDigest:null}),true);
 for(const [previewState,reason] of [['too_large','preview_budget_exceeded'],['unavailable','answer_missing']])assert.equal(valid({...base,previewState,reason,answer:null,contentDigest:null}),true);
 for(const change of [{instanceId:'33333333-3333-4333-8333-333333333333'},{runId:target.instanceId},{rubricVersion:'pelican-svg-v2'},{caseStatus:'running'},{status:'failed'},{answer:''},{contentDigest:'A'.repeat(64)},{extra:true}])assert.equal(valid({...base,...change}),false);
});
test('frame handshake rejects foreign bindings; duplicate init/render are idempotent',()=>{
 const sent=[],listeners=new Map(),timers=new Map();let cleared=0,next=0;
 const parent={postMessage:(data,origin)=>sent.push({data,origin})};const root={replaceChildren(){cleared++;}};
 const context=vm.createContext({parent,TextEncoder,TextDecoder,Uint8Array,document:{getElementById:()=>root},crypto:{getRandomValues(a){a.fill(2);return a;}},performance:{now:()=>0},setInterval(fn,ms){timers.set(++next,{fn,ms});return next;},clearInterval(id){timers.delete(id);},addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:name=>listeners.delete(name)});
 vm.runInContext(fs.readFileSync(new URL('../src/public/preview-frame.js',import.meta.url),'utf8'),context);
 const boot=sent[0].data.boot,init={type:'preview.init',v:1,boot,channel:'c'.repeat(32),generation:1,...target};
 function deliver(d,source=parent,origin='http://127.0.0.1:4173'){const data=vm.runInContext('('+JSON.stringify(d)+')',context);listeners.get('message')({data,source,origin});}
 deliver(init,{});deliver(init,parent,'null');assert.equal(sent.length,1);deliver(init);deliver(init);assert.equal(sent.filter(x=>x.data.type==='preview.ack').length,2);deliver({...init,channel:'d'.repeat(32)});assert.equal(sent.length,3);
 const render={...init,type:'preview.render',contentDigest:'a'.repeat(64),answer:'&'};deliver(render);deliver(render);assert.equal(cleared,1);assert.equal(sent.filter(x=>x.data.type==='preview.result').length,2);assert.equal(sent.at(-1).data.errorCode,'document_invalid');deliver({...render,contentDigest:'b'.repeat(64)});assert.equal(cleared,1);assert.equal(sent.every(x=>x.origin==='http://127.0.0.1:4173'),true);listeners.get('pagehide')();assert.equal(timers.size,0);
});
