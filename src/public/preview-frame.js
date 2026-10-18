/* Fixed hash-authorized bootstrap; generated content is data only. */
(function(scope){
'use strict';
const ORIGIN='http://127.0.0.1:4173',XHTML='http://www.w3.org/1999/xhtml',SVG='http://www.w3.org/2000/svg';
const IDENT=/^[A-Za-z][A-Za-z0-9_-]{0,31}$/,UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CODES=['document_invalid','namespace_invalid','element_forbidden','attribute_forbidden','value_invalid','css_invalid','css_unsupported','reference_invalid','budget_exceeded','render_timeout','internal_error'];
const LIMITS=Object.freeze({sourceUnits:131072,sourceBytes:131072,elements:1024,nodes:4096,depth:24,attributes:16,attributeUnits:8192,totalAttributeUnits:32768,textUnits:16384,cssUnits:32768,cssBytes:32768,tokens:16384,rules:128,declarations:1024,keyframes:16,animated:16,svg:1,points:256,totalPoints:2048});
const ANIMATION=['animation-name','animation-duration','animation-timing-function','animation-iteration-count','animation-direction'];
const SHAPES={rect:['x','y','width','height','rx','ry'],circle:['cx','cy','r'],ellipse:['cx','cy','rx','ry'],line:['x1','y1','x2','y2'],polygon:['points'],polyline:['points']};
const PRESENTATION=['fill','stroke','stroke-width','stroke-linecap','stroke-linejoin','opacity'];
const bytes=s=>new TextEncoder().encode(s).length;
function fail(code){throw Object.assign(new Error(code),{code});}
function budget(key,value){if(value>LIMITS[key])fail('budget_exceeded');}
function sourceCheck(source){
 if(typeof source!=='string')fail('document_invalid');budget('sourceUnits',source.length);budget('sourceBytes',bytes(source));
 if(/[&]|<!|<\?|[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(source))fail('document_invalid');
 for(let i=0;i<source.length;i++){const c=source.charCodeAt(i);if(c>=0xd800&&c<=0xdbff){const next=source.charCodeAt(++i);if(!(next>=0xdc00&&next<=0xdfff))fail('document_invalid');}else if(c>=0xdc00&&c<=0xdfff)fail('document_invalid');}
}
function decimal(v,min,max,code='value_invalid'){if(!/^-?\d+(?:\.\d{1,3})?$/.test(v)||!Number.isFinite(Number(v))||Number(v)<min||Number(v)>max)fail(code);return Number(v);}
function positive(v,max,code='value_invalid'){if(v.startsWith('-'))fail(code);return decimal(v,0,max,code);}
const paint=(v,none=true)=>(none&&v==='none')||/^#[0-9a-fA-F]{6}$/.test(v);
function tokenize(css){
 budget('cssUnits',css.length);budget('cssBytes',bytes(css));const tokens=[];let i=0;
 while(i<css.length){if(/[ \t\r\n]/.test(css[i])){i++;continue;}const rest=css.slice(i);const m=/^-?\d+(?:\.\d+)?/.exec(rest)||/^[A-Za-z][A-Za-z0-9_-]*/.exec(rest);
 if(m){tokens.push({value:m[0],at:i});i+=m[0].length;}else if('.{}:;@%(),#'.includes(css[i])){tokens.push({value:css[i],at:i});i++;}else fail('css_invalid');budget('tokens',tokens.length);}
 return tokens;
}
function transformValue(tokens){
 const t=tokens.map(x=>x.value),name=t[0];if(!['rotate','translate','translateY'].includes(name)||t[1]!=='('||t.at(-1)!==')')fail('css_invalid');
 const unit=name==='rotate'?'deg':'px';
 if(name==='translate'){if(t.length!==8||t[3]!=='px'||t[4]!==','||t[6]!=='px')fail('css_invalid');}
 else if(t.length!==5||t[3]!==unit)fail('css_invalid');
 const nums=(name==='translate'?[t[2],t[5]]:[t[2]]).map(v=>decimal(v,name==='rotate'?-360:-64,name==='rotate'?360:64,'css_invalid'));
 return {value:name+'('+nums.map(v=>v+unit).join(',')+')'};
}
function propertyValue(prop,tokens){
 const vals=tokens.map(x=>x.value),value=vals.join('');const keyword=allowed=>{if(vals.length!==1||!allowed.includes(value))fail('css_invalid');return {value};};
 if(prop==='display')return keyword(['block','inline-block']);if(prop==='overflow')return keyword(['hidden']);
 if(['width','height','margin','padding','border-radius'].includes(prop)){if(vals.length!==2||vals[1]!=='px')fail('css_invalid');return {value:positive(vals[0],1024,'css_invalid')+'px'};}
 if(['background-color','color','fill','stroke'].includes(prop)){if(!tokens.every((t,i)=>i===0||t.at===tokens[i-1].at+tokens[i-1].value.length)||!paint(value,['fill','stroke'].includes(prop)))fail('css_invalid');return {value};}
 if(['opacity','stroke-width'].includes(prop)){if(vals.length!==1)fail('css_invalid');return {value:String(positive(value,prop==='opacity'?1:16,'css_invalid'))};}
 if(prop==='transform')return transformValue(tokens);
 if(prop==='transform-origin')return keyword(['center']);if(prop==='transform-box')return keyword(['fill-box']);
 if(prop==='animation-name'){if(vals.length!==1||!IDENT.test(value))fail('css_invalid');return {value};}
 if(prop==='animation-duration'){if(vals.length!==2||vals[1]!=='s'||vals[0].startsWith('-'))fail('css_invalid');return {value:decimal(vals[0],1,6,'css_invalid')+'s'};}
 if(prop==='animation-timing-function')return keyword(['linear','ease-in-out']);if(prop==='animation-iteration-count')return keyword(['infinite']);if(prop==='animation-direction')return keyword(['normal','alternate']);fail('css_invalid');
}
function expand(ds){return ds.flatMap(d=>{
 let props;if(d.property==='margin'||d.property==='padding')props=['top','right','bottom','left'].map(s=>d.property+'-'+s);
 else if(d.property==='border-radius')props=['top-left','top-right','bottom-right','bottom-left'].map(s=>'border-'+s+'-radius');else if(d.property==='overflow')props=['overflow-x','overflow-y'];else props=[d.property];return props.map(property=>({...d,property}));
});}
function parseCSS(css,check=()=>{}){
 const tokens=tokenize(css);let i=0,rules=0,declarationCount=0;const classes=[],keyframes=[];
 const peek=()=>tokens[i]?.value,take=v=>{const t=tokens[i++];if(!t||(v!==undefined&&t.value!==v))fail('css_invalid');return t;},ident=()=>{const v=take().value;if(!IDENT.test(v))fail('css_invalid');return v;};
 const rule=()=>{budget('rules',++rules);check();};
 function declarations(){take('{');const ds=[],seen=new Set();while(peek()!=='}'){check();const property=ident();if(seen.has(property))fail('css_invalid');seen.add(property);take(':');const value=[];while(peek()!==';'){if(peek()===undefined||['{','}'].includes(peek()))fail('css_invalid');value.push(take());}take(';');if(!value.length)fail('css_invalid');ds.push({property,...propertyValue(property,value)});budget('declarations',++declarationCount);}take('}');return ds;}
 while(i<tokens.length){rule();if(peek()==='.'){
 take('.');const name=ident();if(classes.some(x=>x.name===name))fail('css_invalid');const ds=declarations(),map=Object.fromEntries(ds.map(d=>[d.property,d.value]));
 if(ANIMATION.some(p=>p in map)&&(!ANIMATION.every(p=>p in map)||map['transform-origin']!=='center'||map['transform-box']!=='fill-box'||'transform' in map))fail('css_invalid');classes.push({kind:'class',name,declarations:ds,expanded:expand(ds),animation:map['animation-name']??null});
 }else{
 take('@');const at=take('keyframes'),nameToken=tokens[i];if(!nameToken||nameToken.at===at.at+at.value.length)fail('css_invalid');const name=ident();if(keyframes.some(x=>x.name===name))fail('css_invalid');budget('keyframes',keyframes.length+1);take('{');const frames=[];
 while(peek()!=='}'){rule();const percent=positive(take().value,100,'css_invalid');take('%');if(frames.length&&percent<=frames.at(-1).percent)fail('css_invalid');const ds=declarations();if(ds.length!==1||ds[0].property!=='transform')fail('css_invalid');frames.push({percent,declarations:ds,expanded:ds});if(frames.length>8)fail('css_invalid');}
 take('}');if(frames.length<2||frames[0].percent!==0||frames.at(-1).percent!==100)fail('css_invalid');keyframes.push({kind:'keyframes',name,frames});}}
 return {classes,keyframes,rules,declarations:declarationCount,tokens:tokens.length};
}
function validateDocument(doc,check=()=>{}){
 const counts={elements:0,nodes:0,totalAttributeUnits:0,textUnits:0,svg:0,totalPoints:0,animated:0};let style=null;const classElements=new Map();
 const children=n=>Array.from(n.childNodes);
 function structure(n,names){if(children(n).filter(x=>x.nodeType===1).map(x=>x.localName).join(',')!==names.join(','))fail('document_invalid');}
 function walk(node,depth,inSvg=false,inStyle=false){
 check();budget('nodes',++counts.nodes);if(node.nodeType===3){if(!inStyle)budget('textUnits',counts.textUnits+=node.nodeValue.length);return;}if(node.nodeType!==1)fail('document_invalid');
 budget('elements',++counts.elements);budget('depth',depth);const tag=node.localName,attrs=Array.from(node.attributes),parent=node.parentNode;
 if(node.prefix||node.nodeName!==tag)fail('namespace_invalid');const isSvg=inSvg||tag==='svg';if(node.namespaceURI!==(isSvg?SVG:XHTML))fail('namespace_invalid');let allowed=[];
 if(tag==='html'){if(depth!==1)fail('element_forbidden');allowed=['xmlns'];structure(node,['head','body']);if(node.getAttribute('xmlns')!==XHTML)fail('namespace_invalid');}
 else if(tag==='head'){if(parent.localName!=='html')fail('element_forbidden');structure(node,['title','style']);}
 else if(tag==='body'){if(parent.localName!=='html')fail('element_forbidden');}
 else if(tag==='style'){if(parent.localName!=='head')fail('element_forbidden');style=node;}
 else if(tag==='title'||tag==='desc'){if(!(isSvg||(tag==='title'&&parent.localName==='head')))fail('element_forbidden');if(!isSvg&&node.textContent!=='Pelican')fail('document_invalid');}
 else if(tag==='div'||tag==='span'){if(isSvg||!['body','div','span'].includes(parent.localName))fail('element_forbidden');allowed=['class'];}
 else if(tag==='svg'){if(inSvg||!['body','div','span'].includes(parent.localName))fail('element_forbidden');budget('svg',++counts.svg);allowed=['xmlns','viewBox','class'];if(node.getAttribute('xmlns')!==SVG)fail('namespace_invalid');if(node.getAttribute('viewBox')?.trim().replace(/\s+/g,' ')!=='0 0 800 600')fail('value_invalid');}
 else if(isSvg&&(tag==='g'||Object.hasOwn(SHAPES,tag)))allowed=['class',...PRESENTATION,...(SHAPES[tag]??[])];else fail('element_forbidden');
 if(isSvg&&tag!=='svg'&&!['svg','g'].includes(parent.localName))fail('element_forbidden');budget('attributes',attrs.length);
 for(const a of attrs){budget('attributeUnits',a.value.length);budget('totalAttributeUnits',counts.totalAttributeUnits+=a.value.length);if(a.name.includes(':')||(a.namespaceURI&&a.name!=='xmlns'))fail('namespace_invalid');if(!allowed.includes(a.name))fail('attribute_forbidden');const v=a.value,k=a.name;
 if(k==='class'){if(!IDENT.test(v))fail('value_invalid');if(!classElements.has(v))classElements.set(v,[]);classElements.get(v).push({tag,isSvg});}
 else if(k==='fill'||k==='stroke'){if(!paint(v))fail('value_invalid');}else if(k==='opacity')positive(v,1);else if(k==='stroke-width')positive(v,16);
 else if(k==='stroke-linecap'){if(!['butt','round','square'].includes(v))fail('value_invalid');}else if(k==='stroke-linejoin'){if(!['miter','round','bevel'].includes(v))fail('value_invalid');}
 else if(k==='points'){const pairs=v.trim().split(/\s+/);budget('points',pairs.length);budget('totalPoints',counts.totalPoints+=pairs.length);if(pairs.length<(tag==='polygon'?3:2))fail('value_invalid');for(const pair of pairs){const xy=pair.split(',');if(xy.length!==2)fail('value_invalid');xy.forEach(n=>positive(n,800));}}
 else if(!['xmlns','viewBox'].includes(k))positive(v,800);}
 const textOnly=['title','desc','style'].includes(tag)||Object.hasOwn(SHAPES,tag);
 if((tag==='svg'||tag==='g')&&children(node).some(n=>n.nodeType===3&&n.nodeValue.trim()))fail('document_invalid');
 for(const child of children(node)){if(textOnly&&child.nodeType!==3)fail('element_forbidden');if(child.nodeType===3&&(['html','head'].includes(tag)||Object.hasOwn(SHAPES,tag))&&child.nodeValue.trim())fail('document_invalid');walk(child,depth+1,isSvg,tag==='style');}
 }
 if(!doc.documentElement||doc.documentElement.localName!=='html')fail('document_invalid');for(const n of children(doc)){if(n.nodeType===3&&n.nodeValue.trim())fail('document_invalid');walk(n,1);}
 if(!style)fail('document_invalid');const ast=parseCSS(style.textContent,check),used=new Set();
 for(const cls of ast.classes){if(!cls.animation)continue;if(!ast.keyframes.some(k=>k.name===cls.animation))fail('reference_invalid');for(const el of classElements.get(cls.name)??[]){if(!el.isSvg||!(el.tag==='g'||Object.hasOwn(SHAPES,el.tag)))fail('reference_invalid');budget('animated',++counts.animated);used.add(cls.animation);}}
 for(const k of ast.keyframes)if(!used.has(k.name))fail('reference_invalid');return {doc,ast,counts};
}
const declarationsText=ds=>ds.map(d=>d.property+':'+d.value+';').join('');
function ruleText(r){return r.kind==='class'?'.'+r.name+'{'+declarationsText(r.expanded)+'}':'@keyframes '+r.name+'{'+r.frames.map(f=>f.percent+'%{'+declarationsText(f.expanded)+'}').join('')+'}';}
function numericEqual(a,b){const re=/^(-?\d+(?:\.\d+)?)(px|s|deg)?$/,x=re.exec(a),y=re.exec(b);return !!x&&!!y&&Number(x[1])===Number(y[1])&&x[2]===y[2];}
function semanticValue(p,e,a){
 a=a.trim();if(!a)return false;
 if(['background-color','color','fill','stroke'].includes(p)){if(e==='none')return a==='none';if(/^#[0-9a-f]{6}$/i.test(a))return a.toLowerCase()===e.toLowerCase();const m=/^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/.exec(a);return !!m&&m.slice(1).every((v,i)=>Number(v)===parseInt(e.slice(1+2*i,3+2*i),16));}
 if(p==='transform-origin')return ['center','center center','50% 50%','50% 50% 0px'].includes(a.replace(/\s+/g,' '));
 if(p==='transform'){const parse=v=>{const m=/^(rotate|translate|translateY)\((.*)\)$/.exec(v);return m?{name:m[1],args:m[2].split(',').map(x=>x.trim())}:null;};const x=parse(e),y=parse(a);return !!x&&!!y&&x.name===y.name&&x.args.length===y.args.length&&x.args.every((v,i)=>numericEqual(v,y.args[i]));}
 if(/^-?\d/.test(e))return numericEqual(e,a);return e===a;
}
function checkCSSOM(ast,Sheet=scope.CSSStyleSheet,check=()=>{}){
 let sheet;try{sheet=new Sheet();}catch{fail('css_unsupported');}
 function block(style,ds){if(style.length!==ds.length)fail('css_unsupported');const props=Array.from({length:style.length},(_,i)=>style.item(i));if(new Set(props).size!==ds.length||props.some(p=>!ds.some(d=>d.property===p)))fail('css_unsupported');for(const d of ds){check();if(style.getPropertyPriority(d.property)!==''||!semanticValue(d.property,d.value,style.getPropertyValue(d.property)))fail('css_unsupported');}}
 for(const r of [...ast.classes,...ast.keyframes]){check();let index;try{index=sheet.insertRule(ruleText(r),sheet.cssRules.length);}catch{fail('css_unsupported');}const a=sheet.cssRules[index];
 if(r.kind==='class'){if(a.type!==1||a.selectorText!=='.'+r.name)fail('css_unsupported');block(a.style,r.expanded);}else{if(a.type!==7||a.name!==r.name||a.cssRules.length!==r.frames.length)fail('css_unsupported');r.frames.forEach((f,i)=>{const child=a.cssRules[i];if(child.type!==8||!/^\d+(?:\.\d+)?%$/.test(child.keyText)||Number(child.keyText.slice(0,-1))!==f.percent)fail('css_unsupported');block(child.style,f.expanded);});}}
 return [...ast.classes,...ast.keyframes].map(ruleText).join('\n');
}
function render(source,root,env=scope){
 const start=env.performance.now(),check=()=>{if(env.performance.now()-start>250)fail('render_timeout');};sourceCheck(source);const doc=new env.DOMParser().parseFromString(source,'application/xml');check();if(doc.getElementsByTagName('parsererror').length)fail('document_invalid');const validated=validateDocument(doc,check),css=checkCSSOM(validated.ast,env.CSSStyleSheet,check);
 function copy(n){check();if(n.nodeType===3)return env.document.createTextNode(n.nodeValue);const el=env.document.createElementNS(n.namespaceURI,n.localName);for(const a of n.attributes)if(a.name!=='xmlns')el.setAttribute(a.name,a.value);for(const c of n.childNodes)el.append(copy(c));return el;}
 const fragment=env.document.createDocumentFragment(),style=env.document.createElement('style');style.textContent=css;fragment.append(style);const body=Array.from(doc.documentElement.childNodes).find(n=>n.nodeType===1&&n.localName==='body');for(const n of body.childNodes)fragment.append(copy(n));check();root.replaceChildren(fragment);check();return validated.counts;
}
function exact(o,keys){return o!==null&&typeof o==='object'&&!Array.isArray(o)&&[Object.prototype,null].includes(Object.getPrototypeOf(o))&&Object.keys(o).sort().join(',')===keys.slice().sort().join(',');}
const tupleKeys=['v','boot','channel','generation','instanceId','runId'];
function messageValid(d,type){
 if(type==='preview.hello')return exact(d,['type','v','boot'])&&d.type===type&&d.v===1&&typeof d.boot==='string'&&/^[0-9a-f]{32}$/.test(d.boot)&&bytes(JSON.stringify(d))<=2048;
 const extra=type==='preview.render'?['contentDigest','answer']:type==='preview.result'?['contentDigest','state','errorCode']:[];
 if(!['preview.init','preview.ack','preview.render','preview.result'].includes(type)||!exact(d,['type',...tupleKeys,...extra])||d.type!==type||d.v!==1||typeof d.boot!=='string'||!/^[0-9a-f]{32}$/.test(d.boot)||typeof d.channel!=='string'||!/^[0-9a-f]{32}$/.test(d.channel)||!Number.isSafeInteger(d.generation)||d.generation<1||typeof d.instanceId!=='string'||!UUID.test(d.instanceId)||typeof d.runId!=='string'||!UUID.test(d.runId))return false;
 if(extra.length&&!(typeof d.contentDigest==='string'&&/^[0-9a-f]{64}$/.test(d.contentDigest)))return false;
 if(type==='preview.render'&&(typeof d.answer!=='string'||d.answer.length>LIMITS.sourceUnits||bytes(d.answer)>LIMITS.sourceBytes))return false;
 if(type==='preview.result'&&!((d.state==='rendered'&&d.errorCode===null)||(d.state==='rejected'&&CODES.includes(d.errorCode))))return false;
 return bytes(JSON.stringify(d))<=(type==='preview.render'?819200:2048);
}
const tupleEqual=(a,b)=>tupleKeys.every(k=>a[k]===b[k]);
function startFrame(){
 if(scope.parent===scope)return;const boot=Array.from(scope.crypto.getRandomValues(new Uint8Array(16)),n=>n.toString(16).padStart(2,'0')).join('');let binding=null,digest=null,cached=null,timer;const root=scope.document.getElementById('preview-root'),start=scope.performance.now();const send=d=>scope.parent.postMessage(d,ORIGIN);
 const hello=()=>{if(binding||scope.performance.now()-start>=2000){scope.clearInterval(timer);return;}send({type:'preview.hello',v:1,boot});};
 function receive(e){if(e.source!==scope.parent||e.origin!==ORIGIN)return;const d=e.data;if(messageValid(d,'preview.init')&&d.boot===boot){if(binding&&!tupleEqual(binding,d))return;if(!binding){binding=Object.fromEntries(tupleKeys.map(k=>[k,d[k]]));scope.clearInterval(timer);}send({type:'preview.ack',...binding});return;}
 if(!binding||!messageValid(d,'preview.render')||!tupleEqual(binding,d))return;if(digest!==null){if(digest===d.contentDigest&&cached)send(cached);return;}digest=d.contentDigest;let errorCode=null;try{render(d.answer,root);}catch(error){root.replaceChildren();errorCode=CODES.includes(error.code)?error.code:'internal_error';}cached={type:'preview.result',...binding,contentDigest:digest,state:errorCode?'rejected':'rendered',errorCode};send(cached);}
 scope.addEventListener('message',receive);timer=scope.setInterval(hello,250);hello();scope.addEventListener('pagehide',()=>{scope.clearInterval(timer);scope.removeEventListener('message',receive);root.replaceChildren();},{once:true});
}
const api={LIMITS,CODES,ORIGIN,XHTML,SVG,sourceCheck,budget,tokenize,parseCSS,validateDocument,expand,ruleText,semanticValue,checkCSSOM,render,messageValid,tupleEqual};
if(typeof module!=='undefined'&&module.exports)module.exports=api;else if(scope.document)startFrame();
})(globalThis);
