const $ = id => document.getElementById(id);
const scoreKeys = ['correctness', 'consistency', 'constraint_adherence'];
const scoreLabels = ['正确性', '一致性', '约束遵循'];
const htmlVersion = 'pelican-html-animated-v1';
const cockpitVersion = 'pelican-cockpit-v1';
const cockpitPrompt = "创建一个 HTML，内容是 SVG 绘制一个鹈鹕骑自行车的 2D 动画，你不需要任何测试，不要有任何限制";
const cockpitSource = 'https://github.com/jlcodes99/cockpit-tools/tree/b0d88627';
const cockpitAnchors = ["正确性：1 无有意义的 HTML/SVG；2 仅鹈鹕或自行车可辨；3 两者可辨但骑行关系明显错误；4 主体与骑行关系清晰但有少量缺失或错位；5 HTML/SVG 清晰完整地表现鹈鹕骑自行车。","一致性：1 无可辨动画；2 运动与骑行主体无关或严重断续；3 存在可辨的 2D 骑行动画但协调不足；4 动画连续、主体协调，仅有轻微缺陷；5 动画自然连贯，骑行关系在运动中保持清晰。","约束遵循：1 未提供有意义的 HTML；2 HTML 有内容但基本未呈现 SVG 骑行主题；3 具备 HTML/SVG 主体但缺少可辨的 2D 动画；4 提示词主要要求满足，仅有轻微缺失；5 完整满足原始提示词。无需测试，不按旧严格 XHTML、CSS 或 SMIL 子集扣分；预览兼容性、网络阻断或基础设施失败不直接判为内容违规。"];
let cockpitSupported = false;
const htmlAnchors = ['正确性：1 两者均不可辨；2 仅一者可辨；3 两者可辨但骑行关系明显错误；4 有少量缺失或错位；5 鹈鹕、自行车和骑行关系清晰完整。','一致性：1 无可播放运动；2 运动脱离主体或严重不连续；3 仅车轮旋转或鹈鹕起伏正确；4 两者有效但有轻微协调或循环缺陷；5 旋转与轻柔起伏协调、连续循环。','约束遵循：1 缺失或畸形文档；2 文档完整但因内容或预算规则被拒绝；3 预览接受但多项要求未满足；4 仅一项轻微不符；5 完全遵循提示词和受支持子集。兼容性、超时或基础设施失败不能直接判为内容违规。'];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
let previewInstance = null;
const names = { idle:'未启动', queued:'排队中', running:'运行中', completed:'已完成', failed:'失败', timed_out:'超时', cancelled:'已取消', interrupted:'已中断' };
const labels = { 'pelican-cockpit':'鹈鹕骑自行车（Cockpit 原始提示词）', 'pelican-html-animated':'鹈鹕骑自行车（HTML/CSS 动画）', 'pelican-svg-animated':'鹈鹕骑自行车（动画）', 'pelican-svg':'鹈鹕骑自行车', 'instruction-following':'指令遵循', 'logic-grid':'逻辑网格', 'code-trace':'代码追踪' };
const state = { nonce:null, requestId:null, displayed:null, benchmarkKey:null, drafts:new Map(), urls:[], busy:false, polling:false, telemetryPolling:false, benchmarkAvailable:false, taskId:null, pinned:false, taskGeneration:0, tasksSupported:true, tasks:[], tasksStale:false, tasksTruncated:false, tasksSampled:null };
const format = v => Number.isFinite(v) ? new Intl.NumberFormat('zh-CN', { maximumFractionDigits:1 }).format(v) : '—';
const errors = { nonce_invalid:'验证已过期，请重试。', run_active:'已有基准运行，请稍后重试。', benchmark_busy:'已有基准运行，请稍后重试。', request_conflict:'请求冲突，请刷新后重试。', score_invalid:'评分无效，请检查题目版本与分数。', schema_invalid:'请求无效，请刷新后重试。', run_not_found:'运行不存在，请刷新后重试。', service_unavailable:'本地服务不可用，请检查服务。', benchmark_unavailable:'基准不可用，请检查 Codex CLI。', baseline_invalid:'请先完成全部评分。', task_not_found:'固定任务不在当前列表，已保留选择。', query_invalid:'任务查询无效。', telemetry_unavailable:'任务遥测暂不可用。', tasks_unavailable:'任务列表暂不可用。' };
function safeError(error) { return errors[error?.code] ?? '操作失败，请检查本地服务后重试。'; }
// A failed case carries its own classified code; saying why beats a generic banner.
const caseErrors = { upstream_stream_lost:'上游中转中断了生成流（已自动重试一次）。这不是本机环境问题，请稍后重试或换一个模型提供方。', process_failed:'Codex 进程执行失败，请检查本地运行环境。', timed_out:'运行超时，请稍后重试。', authentication_failed:'身份验证失败，请检查 Codex 登录状态或中转配置凭据。', rate_limited:'请求受到限流，请稍后重试。', upstream_stalled:'上游中转长时间没有任何输出（已自动重试一次）。这不是本机环境问题，请稍后重试或换一个模型提供方。', model_unavailable:'所选模型不可用，请检查模型配置。', malformed_output:'模型输出格式无效。', incomplete_output:'模型输出不完整。', answer_too_large:'回答超过大小限制。', output_too_large:'进程输出超过大小限制。', invalid_config:'模型或推理配置无效。' };
function caseErrorText(code) { return caseErrors[code] ?? ''; }
function message(text, error=false) { $('benchmark-message').textContent=text; $('benchmark-message').className='message'+(error?' error':''); }
const safeCount = v => Number.isSafeInteger(v) && v >= 0;
const validModel = v => typeof v === 'string' && v.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)?$/.test(v);
const effortLabels = { low:'low', medium:'medium', high:'high', xhigh:'xhigh', max:'max', ultra:'ultra', persistent:'persistent', none:'none' };
// Codex owns the reasoning vocabulary; an unfamiliar level is still a level, so it
// renders with its wire word instead of being reported as unknown.
const validEffort = v => typeof v === 'string' && v !== 'configured' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(v);
const effortLabel = v => effortLabels[v] ?? v;
const available = (v,source) => v?.state === 'available' && v.source === source && v.reason === 'none';
const utcTime = v => typeof v === 'string' && /(?:Z|\+00:00)$/.test(v) && Number.isFinite(Date.parse(v));
function validTurn(turn) {
  if(!available(turn,'turn_token_usage') || !['inputTokens','outputTokens','totalTokens'].every(k=>safeCount(turn[k])) || turn.totalTokens !== turn.inputTokens + turn.outputTokens) return false;
  if(!utcTime(turn.startedAt) || !utcTime(turn.completedAt) || !Number.isFinite(turn.elapsedSeconds) || turn.elapsedSeconds <= 0) return false;
  const seconds=(Date.parse(turn.completedAt)-Date.parse(turn.startedAt))/1000;
  return seconds>0 && Math.abs(seconds-turn.elapsedSeconds)<=0.000001;
}
function setTelemetry(value) {
  const data=value&&typeof value==='object'?value:{state:'unavailable'};
  const statuses={ok:'最近活动主会话',empty:'无主会话',ambiguous:'多主会话',unavailable:'不可用'};
  $('session-state').textContent=statuses[data.state]??'不可用';
  const turn=data.state==='ok'&&validTurn(data.lastCompletedTurn)?data.lastCompletedTurn:null;
  for (const [id,key] of [['input-tokens','inputTokens'],['output-tokens','outputTokens'],['total-tokens','totalTokens']]) $(id).textContent=turn?format(turn[key]):'—';
  const speed=data.turnAverageSpeed, rate=speed?.outputTokensPerSecond;
  const expected=turn?turn.outputTokens/turn.elapsedSeconds:null;
  const speedOk=turn&&available(speed,'completed_turn')&&speed.completedAt===turn.completedAt&&speed.includesToolsAndWait===true&&Number.isFinite(rate)&&rate>=0&&Math.abs(rate-expected)<=1e-9*Math.max(1,expected);
  const reason=speed?.reason??data.lastCompletedTurn?.reason;
  const detail={bootstrap_in_progress:'正在读取主会话历史',turn_incomplete:'当前回合尚未完成',turn_start_missing:'缺少回合开始记录',read_gap:'日志存在读取缺口',turn_ambiguous:'会话或回合无法唯一确认'}[reason]??'数据缺失或未通过校验';
  $('speed').textContent=speedOk?format(rate):'—';
  $('speed').title='最近完成回合平均输出 tokens/s，含工具及等待'+(speedOk?'':'；'+detail);
  const context=data.conversationContext;
  const contextOk=data.state==='ok'&&available(context,'turn_context')&&validModel(context.model)&&validEffort(context.reasoningEffort)&&utcTime(context.observedAt);
  $('conversation-context').textContent='最近活动主会话 · '+(contextOk?'日志模型 '+context.model+' · 推理强度 '+context.reasoningEffort+'('+effortLabel(context.reasoningEffort)+')':'日志模型 / 推理强度未知');
  $('session-id').textContent=data.state==='ok'&&typeof data.session?.id==='string'?'会话 '+data.session.id:'';
  $('telemetry-message').textContent=reason==='bootstrap_in_progress'?'正在读取主会话历史，完成后显示最近完成回合。':({ok:'显示最近完成回合的输入/输出/总计与均速；会话按主会话日志活动选择。',empty:'暂无活动主会话。',ambiguous:'多个候选主会话，暂不显示计数。',unavailable:'遥测不可用，请检查本地服务。'})[data.state]??'遥测不可用。';
  const connected=['ok','empty','ambiguous'].includes(data.state)||reason==='bootstrap_in_progress';
  $('connection').className='connection '+(connected?'ok':'error');
  $('connection').lastElementChild.textContent=connected?'已连接':'不可用';
}
const taskErrorText=code=>errors[code]??'任务遥测暂不可用。';
const shortId=id=>typeof id==='string'&&id.length>=8?id.slice(0,8):'未观测';
const localClock=value=>utcTime(value)?new Date(value).toLocaleTimeString('zh-CN',{hour12:false}):'未观测';
function lagText(value){ if(!utcTime(value))return '未观测'; const seconds=Math.max(0,(Date.now()-Date.parse(value))/1000); return seconds<60?Math.round(seconds)+' 秒':seconds<3600?Math.floor(seconds/60)+' 分':Math.floor(seconds/3600)+' 时'; }
const associationLabels={ current_turn:'当前回合', other_turn:'其他回合' };
function associationText(value){ return associationLabels[value]??'未知'; }
const associationRank=value=>value==='current_turn'?0:value==='other_turn'?1:2;
const agentStateLabels={ completed:'已完成', aborted:'已中止', in_progress:'日志未见结束' };
function agentStateText(value){ return agentStateLabels[value]??'未知'; }
function countText(usage,key){ if(!usage||usage[key]===null||usage[key]===undefined)return '未观测'; return safeCount(usage[key])?format(usage[key]):'未知'; }
function taskLabel(task){ const title=typeof task?.title==='string'?task.title.trim():''; const bounded=title.length>44?title.slice(0,44)+'…':title; return (bounded||'未命名任务')+' · '+shortId(task?.id); }
function shortModel(value){ const model=typeof value==='string'?value.trim():''; if(!model)return '未观测'; const parts=model.split('/'); const tail=parts[parts.length-1]; return tail.length>18?tail.slice(0,18)+'…':tail; }
function renderAgents(rows,truncated=false){
  const box=$('agents');
  const sorted=[...rows].filter(a=>a&&typeof a==='object').sort((x,y)=>associationRank(x.association)-associationRank(y.association)||String(y.updatedAt??'').localeCompare(String(x.updatedAt??'')));
  if(!sorted.length){ box.replaceChildren(element('p','agent-row muted','代理 · 未观测')); $('agents-meta').textContent='代理 · 未观测'; return; }
  let current=0,other=0,unknown=0;
  box.replaceChildren(...sorted.map(a=>{
    if(a.association==='current_turn')current++; else if(a.association==='other_turn')other++; else unknown++;
    const role=typeof a.role==='string'&&a.role.trim()?a.role.trim():'未知';
    const model=typeof a.model==='string'&&a.model.trim()?a.model.trim():'未观测';
    const effort=typeof a.effort==='string'&&a.effort.trim()?a.effort.trim():null;
    const detail=role+' · 日志模型 '+model+' · 推理强度 '+(effort?effort+'('+effortLabel(effort)+')':'未观测')+' · '+agentStateText(a.state)+' · '+associationText(a.association);
    const row=element('p','agent-row',role+' · '+shortModel(a.model)+' · '+agentStateText(a.state)+' · '+associationText(a.association));
    row.title=detail;
    return row;
  }));
  $('agents-meta').textContent='代理 '+sorted.length+' · 当前回合 '+current+' · 其他 '+other+' · 未知 '+unknown+(truncated?' · 列表可能已截断':'');
}
function renderTaskOptions(){
  const select=$('task-select'),items=state.tasks.map(t=>({id:t.id,label:taskLabel(t)}));
  if(state.pinned&&state.taskId&&!items.some(item=>item.id===state.taskId))items.unshift({id:state.taskId,label:'已固定 · 未在当前列表 · '+shortId(state.taskId)});
  select.replaceChildren(...items.map(item=>{ const option=document.createElement('option'); option.value=item.id; option.textContent=item.label; return option; }));
  if(state.taskId&&items.some(item=>item.id===state.taskId))select.value=state.taskId;
  select.disabled=items.length===0;
  const pin=$('task-pin');pin.textContent=state.pinned?'固定':'跟随';pin.setAttribute('aria-pressed',state.pinned?'true':'false');pin.title=state.pinned?'已固定当前任务；点击恢复跟随最近任务。':'正在跟随最近任务；点击固定当前任务。';
  if(!state.taskId&&state.tasksSupported)$('task-flags').textContent='任务列表 '+(state.tasksStale?'陈旧':'新鲜')+(state.tasksTruncated?' · 已截断':'')+' · 采样 '+localClock(state.tasksSampled);
}
function applyTaskList(list){
  const tasks=Array.isArray(list?.tasks)?list.tasks.filter(task=>uuid.test(task?.id??'')):[];
  state.tasks=tasks;state.tasksStale=list?.stale===true;state.tasksTruncated=list?.truncated===true;state.tasksSampled=typeof list?.sampledAt==='string'?list.sampledAt:null;
  const next=state.pinned?state.taskId:(tasks.length?tasks[0].id:null);
  if(next!==state.taskId){ state.taskId=next; state.taskGeneration++; resetTaskFields(); }
  renderTaskOptions();
}
function renderTaskLegacy(){
  $('task-title').textContent='任务 · 旧版服务未提供任务列表';
  $('task-flags').textContent='使用旧版跟随遥测。';
  $('current-turn').textContent='当前回合 · 未观测';
  renderAgents([]);
}
function resetTaskFields(note='正在读取任务遥测…'){
  $('task-title').textContent='任务 · 等待数据…';
  $('task-flags').textContent=note;
  $('current-turn').textContent='当前回合 · 未观测';
  renderAgents([]);
  setTelemetry({state:'unavailable'});
}
function renderTaskUnavailable(code){
  if(code==='task_not_found'&&state.pinned&&state.taskId){
    $('task-title').textContent='任务 · 已固定 · '+shortId(state.taskId)+' · 未在当前列表';
    $('task-flags').textContent='固定任务不在当前列表；已保留固定选择，不会自动跟随其他任务。';
  }else{
    $('task-title').textContent='任务 · 未观测';
    $('task-flags').textContent=code==='not_found'?'任务列表暂不可用：当前服务未提供任务接口。':'任务遥测暂不可用：'+taskErrorText(code);
  }
  $('current-turn').textContent='当前回合 · 未观测';
  renderAgents([]);
}
function renderTaskEmpty(){
  $('task-title').textContent='任务 · 未发现任务日志';
  $('task-flags').textContent='任务列表 '+(state.tasksStale?'陈旧':'新鲜')+(state.tasksTruncated?' · 已截断':'')+' · 采样 '+localClock(state.tasksSampled);
  $('current-turn').textContent='当前回合 · 未观测';
  renderAgents([]);
}
function renderTaskDetail(data,task){
  $('task-title').textContent='任务 · '+(typeof task.title==='string'&&task.title.trim()?task.title.trim():'未命名')+' · '+shortId(task.id)+' · '+(state.pinned?'已固定':'跟随');
  $('task-title').title=task.id;
  const stale=task.stale===true,truncated=task.truncated===true,updated=task.updatedAt;
  $('task-flags').textContent='可信时间 '+localClock(updated)+' · 日志滞后 '+lagText(updated)+' · '+(utcTime(updated)?stale?'陈旧':'新鲜':'未观测')+(truncated?' · 已截断':'')+' · 采样 '+localClock(data.sampledAt);
  const current=data.currentTurn;
  $('current-turn').textContent=current?('当前回合 · 输入 '+countText(current.usage,'inputTokens')+' · 输出 '+countText(current.usage,'outputTokens')+' · 合计 '+countText(current.usage,'totalTokens')+' · 更新 '+localClock(current.usageUpdatedAt)):'当前回合 · 未观测（日志未见进行中的回合）';
  $('current-turn').title='当前回合用量来自日志模型记录，不代表模型实际路由。';
  renderAgents(Array.isArray(data.agents)?data.agents:[],truncated);
}
function setTaskTelemetry(data){
  if(!data){ renderTaskLegacy(); return; }
  const task=data.task;
  if(task&&uuid.test(task.id??'')){ renderTaskDetail(data,task); return; }
  if(data.error){ renderTaskUnavailable(data.error); return; }
  if(data.state==='unavailable'){ renderTaskUnavailable('telemetry_unavailable'); return; }
  if(!state.tasksSupported){ renderTaskLegacy(); return; }
  if(data.state==='empty'){ renderTaskEmpty(); return; }
  renderTaskUnavailable('telemetry_unavailable');
}
function diagnosticsText(d){
  if(!d||typeof d!=='object')return '';
  const parts=[];
  if(utcTime(d.startedAt))parts.push('开始 '+localClock(d.startedAt));
  if(utcTime(d.finishedAt))parts.push('结束 '+localClock(d.finishedAt));
  const phases={ queued:'排队', starting:'启动', waiting:'等待响应', generating:'生成中', stopping:'停止中' };
  if(Object.hasOwn(phases,d.lastPhase))parts.push('阶段 '+phases[d.lastPhase]);
  const reasons={ completed:'正常完成', budget_exhausted:'预算耗尽', cancelled:'已取消', process_error:'进程错误', invalid_output:'输出无效' };
  if(Object.hasOwn(reasons,d.terminationReason))parts.push('结束原因 '+reasons[d.terminationReason]);
  if(Number.isFinite(d.timeoutMs)&&d.timeoutMs>=0)parts.push('总预算 '+format(d.timeoutMs/1000)+' 秒');
  if(Number.isFinite(d.elapsedMs)&&d.elapsedMs>=0)parts.push('已耗时 '+format(d.elapsedMs/1000)+' 秒');
  if(Number.isFinite(d.firstEventElapsedMs)&&d.firstEventElapsedMs>=0)parts.push('首个事件 '+format(d.firstEventElapsedMs/1000)+' 秒');
  if(Number.isFinite(d.lastEventElapsedMs)&&d.lastEventElapsedMs>=0)parts.push('最后事件 '+format(d.lastEventElapsedMs/1000)+' 秒');
  if(d.cleanupStatus==='confirmed')parts.push('清理已确认'); else if(d.cleanupStatus==='unconfirmed')parts.push('清理未确认，临时文件可能保留'); else if(d.cleanupStatus==='not_needed')parts.push('无需清理');
  if(d.configWarning==='timeout_config_invalid')parts.push('超时配置无效，已使用默认时长');
  return parts.length?'运行诊断 · '+parts.join(' · '):'';
}
function renderDiagnostics(d){ const text=diagnosticsText(d); return text?element('p','muted diagnostics',text):null; }
function wireTaskControls(){
  $('task-select').addEventListener('change',event=>{
    const id=event.target.value;
    if(!uuid.test(id)||id===state.taskId&&state.pinned)return;
    state.pinned=true;state.taskId=id;state.taskGeneration++;renderTaskOptions();
    resetTaskFields();
    telemetry();
  });
  $('task-pin').addEventListener('click',()=>{
    if(state.pinned){
      state.pinned=false;state.taskId=state.tasks.length?state.tasks[0].id:null;state.taskGeneration++;renderTaskOptions();
    }else{
      if(!state.taskId)return;
      state.pinned=true;state.taskGeneration++;renderTaskOptions();
    }
    resetTaskFields();
    telemetry();
  });
}
async function telemetry() {
  if(state.telemetryPolling)return;state.telemetryPolling=true;
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),8000);
  const entered=state.taskGeneration;
  try {
    let list=null,listError=null;
    if(state.tasksSupported){
      try {
        const r=await fetch('/api/tasks',{cache:'no-store',signal:controller.signal});
        const d=await r.json().catch(()=>({}));
        if(!r.ok){ const code=d?.error?.code??'tasks_unavailable'; if(r.status===404&&code==='not_found'){ if(entered===state.taskGeneration)state.tasksSupported=false; } else listError=code; }
        else list=d;
      }
      catch { listError='disconnected'; }
    }
    if(entered!==state.taskGeneration)return;
    if(list!==null)applyTaskList(list);
    const generation=state.taskGeneration,id=state.taskId;
    if(!state.tasksSupported){
      const r=await fetch('/api/telemetry',{cache:'no-store',signal:controller.signal});
      if(!r.ok)throw Error();
      const legacy=await r.json();
      if(generation===state.taskGeneration){ setTelemetry(legacy); setTaskTelemetry(null); }
      return;
    }
    if(id===null){
      setTelemetry({state:'unavailable'});
      if(list!==null)renderTaskEmpty(); else renderTaskUnavailable(listError??'tasks_unavailable');
      return;
    }
    const r=await fetch('/api/telemetry?taskId='+encodeURIComponent(id),{cache:'no-store',signal:controller.signal});
    if(generation!==state.taskGeneration)return;
    if(!r.ok){ const d=await r.json().catch(()=>({})); if(generation!==state.taskGeneration)return; setTelemetry({state:'unavailable'}); setTaskTelemetry({error:d?.error?.code??'disconnected'}); return; }
    const data=await r.json();
    if(generation!==state.taskGeneration)return;
    setTelemetry(data);setTaskTelemetry(data);
  }
  catch { if(entered===state.taskGeneration){ setTelemetry({state:'unavailable'}); setTaskTelemetry({error:'disconnected'}); } }
  finally { clearTimeout(timer);state.telemetryPolling=false; }
}
async function getNonce() { const r=await fetch('/api/nonce',{cache:'no-store',headers:{Accept:'application/json'}}); if(!r.ok)throw Error(); state.nonce=r.headers.get('X-Codex-Companion-Nonce'); if(!state.nonce)throw Error(); }
async function post(path,payload,retry=true) {
  if(!state.nonce)await getNonce();
  const r=await fetch(path,{method:'POST',cache:'no-store',headers:{'Content-Type':'application/json','X-Codex-Companion-Nonce':state.nonce},body:JSON.stringify(payload)});
  const d=await r.json().catch(()=>({}));
  if(r.status===403&&d.error?.code==='nonce_invalid'&&retry){state.nonce=null;return post(path,payload,false);}
  if(!r.ok)throw Object.assign(new Error('Request failed'),{code:d.error?.code}); return d;
}
function expectedIds(run) {
  if(run?.caseSetVersion===cockpitVersion&&run?.rubricVersion===cockpitVersion)return ['pelican-cockpit'];
  if(run?.caseSetVersion===htmlVersion&&run?.rubricVersion===htmlVersion)return ['pelican-html-animated'];
  if(run?.caseSetVersion==='pelican-svg-animated-v1'&&run?.rubricVersion==='pelican-svg-animated-v1')return ['pelican-svg-animated'];
  if(run?.caseSetVersion==='pelican-svg-v2'&&run?.rubricVersion==='pelican-svg-v2')return ['pelican-svg'];
  if(run?.caseSetVersion==='pelican-v1'&&run?.rubricVersion==='pelican-v1')return ['instruction-following','logic-grid','code-trace'];
  return [];
}
function isFullyScored(run) { const ids=expectedIds(run); return run?.status==='completed'&&ids.length>0&&run.caseResults?.length===ids.length&&ids.every(id=>{const c=run.caseResults.find(x=>x.caseId===id);return c?.status==='completed'&&scoreKeys.every(k=>Number.isInteger(c.scores?.[k])&&c.scores[k]>=1&&c.scores[k]<=5);}); }
function element(tag,className,text) {const el=document.createElement(tag);if(className)el.className=className;if(text!==undefined)el.textContent=text;return el;}
function revokePreviews(){for(const url of state.urls)URL.revokeObjectURL(url);state.urls=[];}
function parseSvg(answer, animated=false) {
  let source=String(answer).trim();
  if(source.startsWith('```')){const match=/^```(?:svg|xml)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i.exec(source);if(!match||match[1].includes('```'))return null;source=match[1].trim();}
  if(!source||/<!DOCTYPE|<!ENTITY/i.test(source))return null;
  if(animated&&(source.length>262144||new TextEncoder().encode(source).length>262144))return null;
  const doc=new DOMParser().parseFromString(source,'image/svg+xml');
  if(doc.querySelector('parsererror')||doc.documentElement.localName!=='svg'||doc.documentElement.namespaceURI!=='http://www.w3.org/2000/svg')return null;
  if(animated&&(doc.querySelectorAll('*').length>4096||doc.querySelectorAll('animateTransform').length>64))return null;
  // Reject active or externally referenced content even inside the isolated image.
  for(const node of doc.querySelectorAll('*')){
    if(['script','foreignObject','style','image','use','a','animate','animateMotion','set'].includes(node.localName))return null;
    if(node.localName==='animateTransform'){
      if(!animated||!safeAnimation(node))return null;
    }
    for(const attr of node.attributes){
      if(/^on/i.test(attr.name)||/href$/i.test(attr.localName))return null;
      const urls=String(attr.value).match(/url\s*\([^)]*\)/gi);
      if(urls&&urls.some(u=>!/^\s*url\s*\(\s*#[A-Za-z_][\w.-]*\s*\)\s*$/i.test(u)))return null;
      if(/@import/i.test(attr.value))return null;
    }
  }
  if([...doc.childNodes].some(n=>n.nodeType===7))return null;
  return source;
}
function safeAnimation(node) {
  const allowed=['attributeName','attributeType','type','from','to','values','begin','dur','repeatCount','fill','calcMode','additive','accumulate'];
  if([...node.attributes].some(a=>!allowed.includes(a.name))||node.children.length)return false;
  const parent=node.parentElement;
  if(!parent||!['g','path','rect','circle','ellipse','line','polygon','polyline'].includes(parent.localName)||parent.hasAttribute('transform')||[...parent.children].filter(n=>n.localName==='animateTransform').length!==1)return false;
  const get=k=>node.getAttribute(k);
  if(![null,'XML'].includes(get('attributeType'))||get('attributeName')!=='transform'||!['rotate','translate'].includes(get('type')))return false;
  const seconds=value=>/^(?:\d+(?:\.\d+)?|\.\d+)s$/.test(value??'')?Number(value.slice(0,-1)):NaN;
  const dur=seconds(get('dur')),begin=get('begin')===null?0:seconds(get('begin'));
  if(!(dur>=0.05&&dur<=60&&begin>=0&&begin<=60))return false;
  if(![null,'linear'].includes(get('calcMode'))||![null,'replace'].includes(get('additive'))||![null,'none'].includes(get('accumulate'))||![null,'remove','freeze'].includes(get('fill')))return false;
  const repeat=get('repeatCount');if(repeat!==null&&repeat!=='indefinite'&&(!/^[1-9]\d{0,3}$/.test(repeat)||Number(repeat)>1000))return false;
  const hasValues=get('values')!==null;
  if(hasValues&&(get('from')!==null||get('to')!==null))return false;
  const values=hasValues?get('values').split(';'):[get('from'),get('to')];
  if(values.length<2||values.length>32||values.some(v=>v===null))return false;
  let center=null;
  for(const value of values){
    if(!/^[\s,+.\deE-]+$/.test(value))return false;
    const nums=value.trim().split(/[\s,]+/).map(Number);
    if(nums.some(n=>!Number.isFinite(n)||Math.abs(n)>10000))return false;
    if(get('type')==='translate'){if(nums.length<1||nums.length>2)return false;}
    else{if(nums.length!==1&&nums.length!==3)return false;const next=nums.length===1?'0,0':nums.slice(1).join(',');if(center!==null&&center!==next)return false;center=next;}
  }
  return true;
}
function renderCase(run,ca) {
  const article=element('article','case');const head=element('div','case-head');head.append(element('strong','',labels[ca.caseId]??'未知题目'),element('span','case-state',names[ca.status]??'待运行'));article.append(head);
  if(ca.cleanupState==='temporary_directory_retained_process_exit_unconfirmed')article.append(element('p','message error','未确认进程已退出，临时文件已保留。'));
  if(ca.errorCode){const explanation=caseErrorText(ca.errorCode);if(explanation)article.append(element('p','message error',explanation));}const diagnostics=renderDiagnostics(ca.diagnostics);if(diagnostics)article.append(diagnostics);
  if(ca.caseId==='pelican-cockpit'){
    article.append(element('p','prompt',cockpitPrompt),element('p','muted','题集 / 评分版本：'+run.caseSetVersion+' / '+run.rubricVersion));
    const sourceLink=element('a','','原始提示词来源：jlcodes99/cockpit-tools · b0d88627 ↗');sourceLink.href=cockpitSource;sourceLink.target='_blank';sourceLink.rel='noopener noreferrer';article.append(sourceLink);
    article.append(element('p','muted','Web 仅展示源码与运行结果；请使用原生桌面的受控预览。预览阻断外部网络、离线运行且不加载动态外部资源，保留内联样式和 JavaScript。'));
  }
  if(ca.caseId==='pelican-html-animated'){
    const supported=previewInstance!==null&&uuid.test(run.runId)&&run.caseSetVersion===htmlVersion&&run.rubricVersion===htmlVersion;
    if(supported){const link=element('a','html-preview-link','打开独立 HTML 动画预览 ↗');link.href='http://127.0.0.1:4173/preview#v=1&instanceId='+previewInstance+'&runId='+run.runId;link.target='_blank';link.rel='noopener noreferrer';article.append(link);}
    else article.append(element('p','muted','当前服务不支持 HTML 动画预览'));
    article.append(element('p','muted','预览拒绝时仍可查看源码，并对已完成运行评分。'));
  }
  if(ca.answer){
    if(['pelican-svg','pelican-svg-animated'].includes(ca.caseId)){const svg=parseSvg(ca.answer,ca.caseId==='pelican-svg-animated');if(svg){const url=URL.createObjectURL(new Blob([svg],{type:'image/svg+xml'}));state.urls.push(url);const img=element('img','svg-preview');img.alt='鹈鹕骑自行车 SVG 预览';img.src=url;img.addEventListener('error',()=>{img.replaceWith(element('p','muted','预览不可用，请查看源码。'));URL.revokeObjectURL(url);},{once:true});article.append(img);}else article.append(element('p','muted','无法安全预览，请查看源码。'));}
    const source=element('details','source');source.append(element('summary','',['pelican-svg','pelican-svg-animated','pelican-html-animated','pelican-cockpit'].includes(ca.caseId)?'查看源码':'查看回答'),element('pre','answer',ca.answer));article.append(source);
  }
  if(run.status==='completed'&&ca.status==='completed'&&expectedIds(run).includes(ca.caseId)){
    if(ca.caseId==='pelican-html-animated'){const rubric=element('details','html-rubric');rubric.append(element('summary','','HTML 动画评分锚点（1–5 分）'));for(const text of htmlAnchors)rubric.append(element('p','muted',text));article.append(rubric);}
    if(ca.caseId==='pelican-cockpit'){const rubric=element('details','html-rubric');rubric.append(element('summary','','Cockpit 评分锚点（1–5 分）'));for(const text of cockpitAnchors)rubric.append(element('p','muted',text));article.append(rubric);}
    const grid=element('div','score-grid');const key=run.runId+':'+ca.caseId;const draft=state.drafts.get(key)??ca.scores;
    scoreKeys.forEach((k,i)=>{const label=element('label','',scoreLabels[i]);const select=element('select');select.dataset.run=run.runId;select.dataset.case=ca.caseId;select.dataset.score=k;for(let n=1;n<=5;n++){const option=element('option','',String(n));option.value=String(n);select.append(option);}select.value=String(draft?.[k]??1);label.append(select);grid.append(label);});
    const button=element('button','secondary save-score','保存评分');button.type='button';button.dataset.run=run.runId;button.dataset.case=ca.caseId;article.append(grid,button);
  }return article;
}
function renderBenchmark(data) {
  const run=data.activeRun??data.latestRun;state.displayed=run;
  const unavailable=data.available===false;state.benchmarkAvailable=!unavailable;
  const active=!!data.activeRun&&['queued','running'].includes(data.activeRun.status);
  state.requestId=data.activeRun?.requestId??state.requestId;
  $('benchmark-state').textContent=unavailable?'不可用':names[run?.status??data.status]??'未启动';$('run').disabled=state.busy||active||unavailable;$('cancel').classList.toggle('hidden',!active);
  revokePreviews();$('cases').replaceChildren(...(run?.caseResults??[]).map(c=>renderCase(run,c)));$('baseline-control').replaceChildren();
  if(run?.status==='completed'){if(isFullyScored(run)){const button=element('button','secondary baseline-button',run.runId===data.baseline?.runId?'当前基线':'设为基线');button.type='button';button.dataset.run=run.runId;button.disabled=run.runId===data.baseline?.runId;$('baseline-control').append(button);}else $('baseline-control').append(element('p','muted','全部题目评分后可设为基线。'));}
  const c=data.comparison;$('comparison').replaceChildren();
  if(c){const configured=run?.model==='configured'||run?.reasoningEffort==='configured';const box=element('div','comparison-box');box.append(element('strong','',configured||c.inconclusive||c.label==='inconclusive'?'基线比较 · 证据不足':'基线比较 · 可比较'),element('p','muted','前 '+(c.beforeCount??0)+' 次 / 后 '+(c.afterCount??0)+' 次完整评分'));const grid=element('div','comparison-grid');scoreKeys.forEach((k,i)=>{const item=element('div','comparison-item',scoreLabels[i]);const v=c.differences?.[k];item.append(element('strong','',configured||v==null?'—':(v>0?'+':'')+Number(v).toFixed(2)));grid.append(item);});box.append(grid);$('comparison').append(box);}
  if(unavailable){message('基准不可用，请检查本地服务。',true);return;}
  message(({completed:'已完成，请评分。',failed:'运行失败，请检查 CLI。',timed_out:'运行超时。',cancelled:'已取消。',interrupted:'运行已中断。',running:'运行中…',queued:'排队中…'})[run?.status]??'启动后运行一道固定题。');
}
const progressStages = { queued:'排队中', starting:'正在启动', waiting:'等待模型响应', generating:'正在生成', stopping:'正在停止' };
const progressEvents = new Set(['thread.started','turn.started','item.started','item.updated','item.completed','turn.completed','turn.failed','error']);
function updateProgress(data) {
  const progress=data.activeRun?.progress;
  const node=$('benchmark-progress');
  if(!progress||!Object.hasOwn(progressStages,progress.stage)||!Number.isFinite(progress.elapsedMs)||progress.elapsedMs<0){node.textContent='';return;}
  let text=progressStages[progress.stage]+' · 已耗时 '+format(progress.elapsedMs/1000)+' 秒';
  if(Number.isFinite(progress.budgetMs)&&progress.budgetMs>0)text+=' · 总预算 '+format(progress.budgetMs/1000)+' 秒';
  const event=progress.lastEvent;
  if(progressEvents.has(event?.type)&&utcTime(event.at))text+=' · 最近事件 '+event.type+' @ '+new Date(event.at).toLocaleTimeString('zh-CN',{hour12:false});
  node.textContent=text;
}
function benchmarkRenderKey(data) {
  const activeRun=data.activeRun?Object.fromEntries(Object.entries(data.activeRun).filter(([key])=>key!=='progress')):null;
  const defaults=data.defaults?{model:data.defaults.model,reasoningEffort:data.defaults.reasoningEffort}:null;
  return JSON.stringify({...data,activeRun,defaults});
}
async function loadBenchmark() {
  if(state.polling)return;state.polling=true;
  try{await capabilities();const r=await fetch('/api/benchmark',{cache:'no-store'});if(!r.ok)throw Error();const data=await r.json();updateProgress(data);const key=benchmarkRenderKey(data);if(key!==state.benchmarkKey){renderBenchmark(data);state.benchmarkKey=key;}}
  catch{state.benchmarkAvailable=false;$('run').disabled=true;setCockpitSupported(false);setPreviewInstance(null);state.benchmarkKey=null;$('benchmark-progress').textContent='';message('基准不可用，请检查本地服务。',true);}
  finally{state.polling=false;}
}
async function runBenchmark(){if($('mode').value==='cockpit'&&!cockpitSupported){message('当前服务不支持 Cockpit 模式',true);return;}if($('mode').value==='html-animated'&&!previewInstance){message('当前服务不支持 HTML 动画预览',true);return;}state.busy=true;$('run').disabled=true;state.requestId='ui_'+crypto.randomUUID().replaceAll('-','');try{await post('/api/benchmark/run',{requestId:state.requestId,model:$('model').value,reasoningEffort:$('effort').value,mode:$('mode').value});await loadBenchmark();}catch(e){message(safeError(e),true);}finally{state.busy=false;$('run').disabled=!state.benchmarkAvailable||['queued','running'].includes(state.displayed?.status);}}
async function cancelBenchmark(){if(!state.requestId)return;try{await post('/api/benchmark/cancel',{requestId:state.requestId});await loadBenchmark();}catch(e){message(safeError(e),true);}}
async function saveScore(button){const run=state.displayed;if(run?.runId!==button.dataset.run)return;const scores={};for(const select of $('cases').querySelectorAll('select[data-score]'))if(select.dataset.run===run.runId&&select.dataset.case===button.dataset.case)scores[select.dataset.score]=Number(select.value);button.disabled=true;try{await post('/api/benchmark/score',{runId:run.runId,caseId:button.dataset.case,rubricVersion:run.rubricVersion,scores});state.drafts.delete(run.runId+':'+button.dataset.case);state.benchmarkKey=null;await loadBenchmark();message('评分已保存。');}catch(e){message(safeError(e),true);}finally{button.disabled=false;}}
async function setBaseline(button){try{await post('/api/benchmark/baseline',{runId:button.dataset.run});await loadBenchmark();}catch(e){message(safeError(e),true);}}
document.addEventListener('change',event=>{const select=event.target;if(select.id==='mode'){updateModeMetadata();$('mode-prompt').textContent=select.value==='cockpit'?cockpitPrompt:select.value==='html-animated'?'鹈鹕骑自行车 · CSS 车轮旋转与轻柔起伏（严格 XML 文档）':select.value==='animated'?'鹈鹕骑自行车 · SVG 动画':'Generate an SVG of a pelican riding a bicycle';return;}if(!select.dataset.score)return;const key=select.dataset.run+':'+select.dataset.case;const scores={...(state.drafts.get(key)??{})};for(const input of $('cases').querySelectorAll('select[data-score]'))if(input.dataset.run===select.dataset.run&&input.dataset.case===select.dataset.case)scores[input.dataset.score]=Number(input.value);state.drafts.set(key,scores);});
document.addEventListener('click',event=>{const button=event.target.closest('button');if(!button||button.disabled)return;if(button.id==='run')runBenchmark();else if(button.id==='cancel')cancelBenchmark();else if(button.classList.contains('save-score'))saveScore(button);else if(button.classList.contains('baseline-button'))setBaseline(button);});
window.addEventListener('pagehide',revokePreviews);
function setPreviewInstance(instance){
  const changed=previewInstance!==instance;previewInstance=instance;
  $('html-mode').disabled=!previewInstance;$('html-capability').textContent=previewInstance?'HTML 动画使用受限 HTML/CSS 子集，在独立隔离窗口中预览。':'当前服务不支持 HTML 动画预览';
  if(changed){state.benchmarkKey=null;revokePreviews();const run=state.displayed;$('cases').replaceChildren(...(run?.caseResults??[]).map(c=>renderCase(run,c)));}
}
function updateModeMetadata(){
  const cockpit=$('mode').value==='cockpit';
  $('mode-source').href=cockpit?cockpitSource:'https://simonwillison.net/tags/pelican-riding-a-bicycle/';
  $('mode-source').textContent=cockpit?'原始提示词来源：jlcodes99/cockpit-tools · b0d88627 ↗':'原始题目来源 ↗';
  $('mode-version').textContent=cockpit?'题集 / 评分版本：'+cockpitVersion+'；独立版本，不与旧版本混合比较。':'';
}
function setCockpitSupported(supported){
  cockpitSupported=supported;$('cockpit-mode').disabled=!supported;
  $('cockpit-capability').textContent=supported?'Cockpit：Web 仅展示源码与运行结果，请使用原生桌面受控预览。外部网络阻断、离线运行，不加载动态外部资源；内联样式与 JavaScript 保留。':'当前服务不支持 Cockpit 模式；已有历史仍按自身版本展示与评分。';
}
async function capabilities(){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),5000);let instance=null,cockpit=false;
  try{const r=await fetch('/api/capabilities',{cache:'no-store',signal:controller.signal});if(!r.ok)throw Error();const d=await r.json();cockpit=d.product==='codex-companion'&&d.protocolVersion===1&&uuid.test(d.instanceId)&&Array.isArray(d.capabilities)&&[cockpitVersion,'cockpit-preview-source-v1'].every(c=>d.capabilities.includes(c));if(d.product==='codex-companion'&&d.protocolVersion===1&&uuid.test(d.instanceId)&&Array.isArray(d.capabilities)&&[htmlVersion,'isolated-html-preview-v1'].every(c=>d.capabilities.includes(c)))instance=d.instanceId;}catch{}finally{clearTimeout(timer);}
  setCockpitSupported(cockpit);setPreviewInstance(instance);
}
wireTaskControls();await telemetry();await loadBenchmark();await getNonce().catch(()=>{});setInterval(telemetry,1000);setInterval(loadBenchmark,1500);
