[CmdletBinding()]
param([switch]$ProductionEdge,[string]$EvidenceDirectory,[switch]$ProductionSecurityOnly,[string]$ProductionSecurityActions)
$ErrorActionPreference='Stop'
if($ProductionSecurityOnly){$ProductionEdge=$true}
$securityActions=@('file-chooser','download','popup','dialog','about','fragment','file','data','navigate','fetch')
if($ProductionSecurityActions){if(-not $ProductionEdge){throw 'ProductionSecurityActions requires ProductionEdge or ProductionSecurityOnly'};$selectedActions=$ProductionSecurityActions.Split(',');foreach($selectedAction in $selectedActions){if($selectedAction -notin (@('noop')+$securityActions)){throw 'Unsupported production security fixture action'}};$securityActions=$selectedActions}
$helper=@"
using System;using System.Net;using System.Net.Http;using System.Threading;using System.Threading.Tasks;
namespace CodexNative {
public sealed class PreviewFixtureHandler:HttpMessageHandler {
 public string Instance="11111111-1111-4111-8111-111111111111";public bool Supported=true;public bool Cockpit=false;public string CapabilityJson,SourceJson;public bool BlockSource;public readonly ManualResetEventSlim SourceEntered=new ManualResetEventSlim(false),SourceRelease=new ManualResetEventSlim(false);
 protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken token){
 if(request.RequestUri.AbsolutePath=="/api/benchmark/preview"){if(BlockSource)return Task.Run(delegate{SourceEntered.Set();if(!SourceRelease.Wait(10000,token))throw new TimeoutException("source barrier deadline");return new HttpResponseMessage(HttpStatusCode.OK){Content=new StringContent(SourceJson)};});return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK){Content=new StringContent(SourceJson)});}if(CapabilityJson!=null)return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK){Content=new StringContent(CapabilityJson)});if(request.RequestUri.AbsoluteUri!="http://127.0.0.1:4173/api/capabilities"||!request.Headers.Contains("Origin"))throw new Exception("Unexpected request");
 return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK){Content=new StringContent("{\"product\":\"codex-companion\",\"protocolVersion\":1,\"instanceId\":\""+Instance+"\",\"capabilities\":"+(Cockpit?"[\"pelican-cockpit-v1\",\"cockpit-preview-source-v1\"]":Supported?"[\"pelican-html-animated-v1\",\"isolated-html-preview-v1\"]":"[]")+"}")});}
}
public static class PreviewFixtures {  public static BrowserPreview Production(PreviewFixtureHandler h){return new BrowserPreview(h,null,null,false);} public static Task<string> Source(BrowserPreview p,PreviewTarget t){return (Task<string>)typeof(BrowserPreview).GetMethod("Source",System.Reflection.BindingFlags.Instance|System.Reflection.BindingFlags.NonPublic).Invoke(p,new object[]{t});} public static void Owner(string uri,uint[] ids){CockpitBrowserGuard.ValidateEndpointOwner(new Uri(uri),ids);} public static void InstallRevocationFixture(BrowserPreview p){typeof(BrowserPreview).GetField("guard",System.Reflection.BindingFlags.Instance|System.Reflection.BindingFlags.NonPublic).SetValue(p,p.BindGuard(null,null));} public static void Revoke(BrowserPreview p){var g=(CockpitBrowserGuard)typeof(BrowserPreview).GetField("guard",System.Reflection.BindingFlags.Instance|System.Reflection.BindingFlags.NonPublic).GetValue(p);typeof(CockpitBrowserGuard).GetMethod("Fail",System.Reflection.BindingFlags.Instance|System.Reflection.BindingFlags.NonPublic).Invoke(g,null);} public static Task<System.Collections.Generic.Dictionary<string,object>> Eval(BrowserPreview p,string expression){var g=(CockpitBrowserGuard)typeof(BrowserPreview).GetField("guard",System.Reflection.BindingFlags.Instance|System.Reflection.BindingFlags.NonPublic).GetValue(p);var sid=(string)typeof(CockpitBrowserGuard).GetField("session",System.Reflection.BindingFlags.Instance|System.Reflection.BindingFlags.NonPublic).GetValue(g);return (Task<System.Collections.Generic.Dictionary<string,object>>)typeof(CockpitBrowserGuard).GetMethod("Command",System.Reflection.BindingFlags.Instance|System.Reflection.BindingFlags.NonPublic).Invoke(g,new object[]{"Runtime.evaluate",new{expression=expression,returnByValue=true},sid});} public static bool Gate(){return CockpitBrowserGuard.ProductionGatePassed;}
 public static string AttachFixture(string type,string target,string parentFrame,string parentTarget,string parentSession,bool knownParent,bool waiting){
  using(var g=new CockpitBrowserGuard(delegate{},delegate{return new uint[0];},delegate(CancellationToken token){return Task.FromResult(new System.Collections.Generic.Dictionary<string,object>());},null)){
   var flags=System.Reflection.BindingFlags.Instance|System.Reflection.BindingFlags.NonPublic;
   foreach(var pair in new[]{new[]{"session","main-session"},new[]{"mainSession","main-session"},new[]{"frame","main-frame"},new[]{"mainTarget","main-target"}})typeof(CockpitBrowserGuard).GetField(pair[0],flags).SetValue(g,pair[1]);
   typeof(CockpitBrowserGuard).GetField("mounting",flags).SetValue(g,true);
   typeof(CockpitBrowserGuard).GetField("phase",flags).SetValue(g,Enum.Parse(typeof(CockpitBrowserGuard).GetField("phase",flags).FieldType,"Mounting"));
   ((System.Collections.Concurrent.ConcurrentDictionary<string,Task>)typeof(CockpitBrowserGuard).GetField("armed",flags).GetValue(g))["main-session"]=Task.FromResult(true);
   var ev=typeof(CockpitBrowserGuard).GetMethod("Event",flags);var json=new System.Web.Script.Serialization.JavaScriptSerializer();
   if(knownParent)ev.Invoke(g,new object[]{json.Deserialize<System.Collections.Generic.Dictionary<string,object>>(json.Serialize(new{method="Page.frameAttached",sessionId="main-session",@params=new{frameId="expected-iframe",parentFrameId="main-frame"}}))});
   ev.Invoke(g,new object[]{json.Deserialize<System.Collections.Generic.Dictionary<string,object>>(json.Serialize(new{method="Target.attachedToTarget",sessionId=parentSession,@params=new{sessionId="iframe-session",waitingForDebugger=waiting,targetInfo=new{type=type,targetId=target,url="about:srcdoc",parentFrameId=parentFrame,parentId=parentTarget}}}))});
   if(!g.Failed){var tasks=(System.Collections.Concurrent.ConcurrentDictionary<string,Task>)typeof(CockpitBrowserGuard).GetField("armed",flags).GetValue(g);if(!tasks["iframe-session"].Wait(10000))throw new TimeoutException("attach fixture arm deadline");}
   string note;g.TargetDiagnostics.TryGetValue("iframe-session",out note);return (g.Failed?"rejected;":"accepted;")+note;
  }
 }
 public static void ForceArmFailure(BrowserPreview p){p.GuardArmCheckpoint=delegate(string s){throw new System.IO.IOException("fixture arm failure");};}
 static Task<System.Collections.Generic.Dictionary<string,object>> Cdp(BrowserPreview p,string method,object args,string sid){var g=(CockpitBrowserGuard)typeof(BrowserPreview).GetField("guard",System.Reflection.BindingFlags.Instance|System.Reflection.BindingFlags.NonPublic).GetValue(p);if(sid==null)sid=(string)typeof(CockpitBrowserGuard).GetField("session",System.Reflection.BindingFlags.Instance|System.Reflection.BindingFlags.NonPublic).GetValue(g);return (Task<System.Collections.Generic.Dictionary<string,object>>)typeof(CockpitBrowserGuard).GetMethod("Command",System.Reflection.BindingFlags.Instance|System.Reflection.BindingFlags.NonPublic).Invoke(g,new object[]{method,args,sid});}
 public static Task<System.Collections.Generic.Dictionary<string,object>> EvalContext(BrowserPreview p,string expression,int contextId,string sid){return Cdp(p,"Runtime.evaluate",new{expression=expression,contextId=contextId,returnByValue=true},sid);}
 public static Task<System.Collections.Generic.Dictionary<string,object>> Screenshot(BrowserPreview p){return Cdp(p,"Page.captureScreenshot",new{format="png",fromSurface=true},null);}
 public static Task<System.Collections.Generic.Dictionary<string,object>> FrameTree(BrowserPreview p){return Cdp(p,"Page.getFrameTree",new{},null);}
 public static System.Collections.Generic.Dictionary<string,string> AttachDiagnostics(BrowserPreview p){var g=(CockpitBrowserGuard)typeof(BrowserPreview).GetField("guard",System.Reflection.BindingFlags.Instance|System.Reflection.BindingFlags.NonPublic).GetValue(p);return new System.Collections.Generic.Dictionary<string,string>(g.TargetDiagnostics);}
 public static System.Collections.Generic.Dictionary<int,string> Contexts(BrowserPreview p){var g=(CockpitBrowserGuard)typeof(BrowserPreview).GetField("guard",System.Reflection.BindingFlags.Instance|System.Reflection.BindingFlags.NonPublic).GetValue(p);return new System.Collections.Generic.Dictionary<int,string>(g.DefaultContexts);}
 public static async Task<System.Collections.Generic.Dictionary<string,object>> AnimationState(BrowserPreview p){
  var flags=System.Reflection.BindingFlags.Instance|System.Reflection.BindingFlags.NonPublic;var g=(CockpitBrowserGuard)typeof(BrowserPreview).GetField("guard",flags).GetValue(p);string mainFrame=(string)typeof(CockpitBrowserGuard).GetField("frame",flags).GetValue(g),mainSession=(string)typeof(CockpitBrowserGuard).GetField("session",flags).GetValue(g);
  var contexts=Contexts(p);var summaries=new System.Collections.Generic.List<object>();foreach(var pair in contexts){int split=pair.Value.IndexOf(";frame=",StringComparison.Ordinal);summaries.Add(new{contextId=pair.Key,mainFrame=split>=0&&pair.Value.Substring(split+7)==mainFrame,mainSession=split>=8&&pair.Value.Substring(8,split-8)==mainSession});}
  var targetStates=new System.Collections.Generic.List<object>();var armed=(System.Collections.Concurrent.ConcurrentDictionary<string,Task>)typeof(CockpitBrowserGuard).GetField("armed",flags).GetValue(g);foreach(var pair in armed){string note;g.TargetDiagnostics.TryGetValue(pair.Key,out note);targetStates.Add(new{mainSession=pair.Key==mainSession,waitingForDebugger=note!=null&&note.Contains("waitingForDebugger=True"),armedComplete=pair.Value.Status==TaskStatus.RanToCompletion,armedFaulted=pair.Value.IsFaulted});}
  var result=new System.Collections.Generic.Dictionary<string,object>{{"contextAvailable",false},{"defaultContextCount",contexts.Count},{"defaultContexts",summaries},{"targetStates",targetStates}};
  var parent=await Eval(p,"(()=>({ready:document.readyState,visibility:document.visibilityState,hidden:document.hidden,rafType:typeof requestAnimationFrame,now:performance.now(),reducedMotion:matchMedia('(prefers-reduced-motion: reduce)').matches}))()");object parentRemote;if(parent.TryGetValue("result",out parentRemote)){object parentValue;if(((System.Collections.Generic.Dictionary<string,object>)parentRemote).TryGetValue("value",out parentValue))result["parentDom"]=parentValue;}
  string iframeSession=null;foreach(var pair in armed){string note;g.TargetDiagnostics.TryGetValue(pair.Key,out note);if(pair.Key!=mainSession&&pair.Value.Status==TaskStatus.RanToCompletion&&note!=null&&note.Contains("firstScriptProtection=trusted CSP/Lockdown prefix")){if(iframeSession!=null)throw new Exception("Ambiguous armed iframe session");iframeSession=pair.Key;}}
  result["armedIframeSessionObserved"]=iframeSession!=null;result["contextLookup"]="armed iframe session default context";if(iframeSession==null)return result;
  var probe=await Cdp(p,"Runtime.evaluate",new{expression="(()=>{const e=document.getElementById('dot');return {ready:document.readyState,cx:e?e.getAttribute('cx'):null,ticks:typeof globalThis.fixtureTicks==='number'?globalThis.fixtureTicks:null,paused:globalThis.fixturePaused===true,started:globalThis.fixtureStarted===true,visibility:document.visibilityState,hidden:document.hidden,rafType:typeof requestAnimationFrame,now:performance.now(),reducedMotion:matchMedia('(prefers-reduced-motion: reduce)').matches,scriptExceptionCount:Array.isArray(globalThis.fixtureErrors)?globalThis.fixtureErrors.length:null};})()",returnByValue=true},iframeSession);result["contextAvailable"]=true;result["scriptException"] = probe.ContainsKey("exceptionDetails");object remote;if(probe.TryGetValue("result",out remote)){object value;if(((System.Collections.Generic.Dictionary<string,object>)remote).TryGetValue("value",out value))result["dom"]=value;}return result;
 }
 public static bool Allow(string s,string f,string m,string u){return CockpitBrowserGuard.AllowsRequest(s,f,m,u);}
 public static string Endpoint(string text){return CockpitBrowserGuard.Endpoint(text).AbsoluteUri;}
 public static string Mount(string html){return CockpitBrowserGuard.MountExpression(html);}
 public static string Document(string html){return CockpitBrowserGuard.Document(html);}
 public static BrowserPreview Create(PreviewFixtureHandler handler,string exe,string args){return new BrowserPreview(handler,exe,args,true);}
 public static string Url(PreviewTarget target){return BrowserPreview.Url(target);}
 public static string Quote(string text){return BrowserPreview.Quote(text);}
 public static string Extract(string text){return BrowserPreview.ExtractHtml(text);}
 public static void Presentation(PreviewTarget t,string presentation,bool capture,string digest){t.Presentation=(PreviewPresentation)Enum.Parse(typeof(PreviewPresentation),presentation);t.CaptureFrames=capture;t.ContentDigest=digest;}
 public static int PresentationValue(PreviewTarget t){return (int)t.Presentation;}
 public static Task<bool> Click(BrowserPreview p,PreviewTarget shown,long operation,double x,double y){return p.ClickAsync(shown,operation,x,y);}
 public static Task DisposeAsync(BrowserPreview p){return Task.Run(delegate{p.Dispose();});}
 public static void MutateTarget(PreviewTarget t,string name){var field=typeof(PreviewTarget).GetField(name,System.Reflection.BindingFlags.Instance|System.Reflection.BindingFlags.Public|System.Reflection.BindingFlags.NonPublic);object value=field.GetValue(t);field.SetValue(t,field.FieldType==typeof(string)?(object)"changed":field.FieldType==typeof(int)?(object)((int)value+1):field.FieldType==typeof(bool)?(object)!(bool)value:(object)PreviewPresentation.Detached);}
 public static async Task<string> InputPairTimeout(){int kills=0,calls=0;var clock=System.Diagnostics.Stopwatch.StartNew();using(var g=new CockpitBrowserGuard(delegate{kills++;},delegate{return new uint[0];},async delegate(CancellationToken token){calls++;await Task.Delay(950,token);return new System.Collections.Generic.Dictionary<string,object>();},null)){PrepareGuard(g,"Ready");try{await g.ClickAsync(25,25,CancellationToken.None,delegate(Action send){send();});return "unexpected";}catch{return "elapsed="+clock.ElapsedMilliseconds+";failed="+g.Failed+";killed="+kills+";calls="+calls;}}}
 internal static readonly System.Reflection.BindingFlags Private=System.Reflection.BindingFlags.Instance|System.Reflection.BindingFlags.NonPublic;
 internal static void SetGuard(CockpitBrowserGuard g,string name,object value){typeof(CockpitBrowserGuard).GetField(name,Private).SetValue(g,value);}
 internal static void PrepareGuard(CockpitBrowserGuard g,string phase){foreach(var pair in new[]{new[]{"session","main-session"},new[]{"mainSession","main-session"},new[]{"frame","main-frame"},new[]{"mainTarget","main-target"},new[]{"mainLoader","main-loader"}})SetGuard(g,pair[0],pair[1]);SetGuard(g,"phase",Enum.Parse(typeof(CockpitBrowserGuard).GetField("phase",Private).FieldType,phase));SetGuard(g,"mounting",phase=="Mounting");SetGuard(g,"downloadDenied",true);((System.Collections.Generic.HashSet<string>)typeof(CockpitBrowserGuard).GetField("chooserArmed",Private).GetValue(g)).Add("main-session");((System.Collections.Concurrent.ConcurrentDictionary<string,Task>)typeof(CockpitBrowserGuard).GetField("armed",Private).GetValue(g))["main-session"]=Task.FromResult(true);if(phase=="Ready")SetGuard(g,"inputReady",1);}
 internal static void GuardEvent(CockpitBrowserGuard g,string method,string sid,object args){var json=new System.Web.Script.Serialization.JavaScriptSerializer();typeof(CockpitBrowserGuard).GetMethod("Event",Private).Invoke(g,new object[]{json.Deserialize<System.Collections.Generic.Dictionary<string,object>>(json.Serialize(new{method=method,sessionId=sid,@params=args}))});}
 public static bool MountReadbackFixture(string scenario){using(var g=new CockpitBrowserGuard(delegate{},delegate{return new uint[0];},delegate(CancellationToken t){return Task.FromResult(new System.Collections.Generic.Dictionary<string,object>());},null)){PrepareGuard(g,"Mounting");GuardEvent(g,"Page.frameAttached","main-session",new{frameId="expected-iframe",parentFrameId="main-frame"});SetGuard(g,"childSession","child-session");SetGuard(g,"iframeTarget","expected-iframe");((System.Collections.Concurrent.ConcurrentDictionary<string,Task>)typeof(CockpitBrowserGuard).GetField("armed",Private).GetValue(g))["child-session"]=Task.FromResult(true);((System.Collections.Generic.HashSet<string>)typeof(CockpitBrowserGuard).GetField("chooserArmed",Private).GetValue(g)).Add("child-session");if(scenario!="missing_loader")GuardEvent(g,"Page.frameStartedNavigating","main-session",new{frameId="expected-iframe",url="about:srcdoc",loaderId="child-loader"});var main=new System.Collections.Generic.Dictionary<string,object>{{"frameTree",new System.Collections.Generic.Dictionary<string,object>{{"frame",new System.Collections.Generic.Dictionary<string,object>{{"id","main-frame"},{"url","about:blank"},{"loaderId","main-loader"}}},{"childFrames",new object[0]}}}};var child=new System.Collections.Generic.Dictionary<string,object>{{"frameTree",new System.Collections.Generic.Dictionary<string,object>{{"frame",new System.Collections.Generic.Dictionary<string,object>{{"id","expected-iframe"},{"url","about:srcdoc"},{"loaderId",scenario=="wrong_loader"?"other-loader":"child-loader"}}},{"childFrames",new object[0]}}}};bool result=false,thrown=false;try{result=(bool)typeof(CockpitBrowserGuard).GetMethod("ConfirmMount",Private).Invoke(g,new object[]{main,child,scenario!="not_ready"});}catch(System.Reflection.TargetInvocationException){thrown=true;}if(scenario=="missed_events"){if(!result||!g.InputReady)throw new Exception("attested initial OOPIF rejected");GuardEvent(g,"Page.frameRequestedNavigation","child-session",new{frameId="expected-iframe",url="about:srcdoc"});return g.Failed&&!g.InputReady;}return scenario=="wrong_loader"?thrown&&!g.InputReady:!thrown&&!result&&!g.InputReady;}}
 internal static System.Collections.Generic.Dictionary<string,object> AuditGuard(CockpitBrowserGuard g){return g==null?new System.Collections.Generic.Dictionary<string,object>{{"guardAvailable",false}}:new System.Collections.Generic.Dictionary<string,object>{{"guardAvailable",true},{"inputReady",g.InputReady},{"failed",g.Failed},{"stage",g.SecurityState},{"blockedRequests",g.BlockedRequests},{"externalRequests",g.ExternalRequests},{"securityEvents",new System.Collections.Generic.Dictionary<string,int>(g.SecurityEvents)},{"trace",g.SecurityTrace.ToArray()}};}
 public static System.Collections.Generic.Dictionary<string,object> GuardAudit(BrowserPreview p){return AuditGuard((CockpitBrowserGuard)typeof(BrowserPreview).GetField("guard",Private).GetValue(p));}
 public static Task<System.Collections.Generic.Dictionary<string,object>> FixtureActionState(BrowserPreview p){var g=(CockpitBrowserGuard)typeof(BrowserPreview).GetField("guard",Private).GetValue(p);string sid=(string)typeof(CockpitBrowserGuard).GetField("childSession",Private).GetValue(g);return Cdp(p,"Runtime.evaluate",new{expression="(()=>({clicked:globalThis.fixtureClicked===true,files:document.getElementById('fixture-file')?document.getElementById('fixture-file').files.length:0,errors:Array.isArray(globalThis.fixtureErrors)?globalThis.fixtureErrors.length:0}))()",returnByValue=true},sid);}
 static string TargetRole(string id,string main,string child){return id==null?"none":id==main?"main":id==child?"child":"unknown";}
 static string TargetUrlCategory(string url){if(url==null)return "missing";if(url=="")return "empty";if(url=="about:blank")return "blank";if(url=="about:srcdoc")return "srcdoc";foreach(string scheme in new[]{"about:","edge:","chrome:","chrome-extension:","data:","blob:","file:","http:","https:"})if(url.StartsWith(scheme,StringComparison.OrdinalIgnoreCase))return scheme.Substring(0,scheme.Length-1);return "other";}
 static string TargetInternalPageCategory(string url){Uri uri;if(url==null||!Uri.TryCreate(url,UriKind.Absolute,out uri)||(uri.Scheme!="edge"&&uri.Scheme!="chrome"))return "none";switch(uri.Host){case "downloads":return "downloads";case "newtab":case "new-tab-page":case "new-tab-page-third-party":return "newtab";case "welcome":case "welcome2":case "fre":case "onboarding":case "first-run":return "welcome";case "privacy":return "privacy";case "signin":case "sign-in":case "signin-dice-web-intercept":case "profile-picker":case "sync":return "signin";case "settings":if(uri.AbsolutePath.StartsWith("/onStartup",StringComparison.Ordinal)||uri.AbsolutePath.StartsWith("/startHomeNTP",StringComparison.Ordinal))return "startupsettings";if(uri.AbsolutePath.StartsWith("/privacy",StringComparison.Ordinal))return "privacy";if(uri.AbsolutePath.StartsWith("/profiles",StringComparison.Ordinal))return "signin";return "settings";default:return "other";}}
 static object[] AuditTargets(CockpitBrowserGuard g,System.Collections.Generic.Dictionary<string,object> r){object list;if(!r.TryGetValue("targetInfos",out list)||!(list is System.Collections.IEnumerable)||list is string)throw new Exception("Missing owned target list");var result=new System.Collections.Generic.List<object>();var seen=new System.Collections.Generic.HashSet<string>();var targetGate=typeof(CockpitBrowserGuard).GetField("targets",Private).GetValue(g);lock(targetGate){string main=(string)typeof(CockpitBrowserGuard).GetField("mainTarget",Private).GetValue(g),child=(string)typeof(CockpitBrowserGuard).GetField("iframeTarget",Private).GetValue(g);var armed=(System.Collections.Concurrent.ConcurrentDictionary<string,Task>)typeof(CockpitBrowserGuard).GetField("armed",Private).GetValue(g);foreach(object node in (System.Collections.IEnumerable)list){var item=node as System.Collections.Generic.Dictionary<string,object>;object value;if(item==null||!item.TryGetValue("targetId",out value)||!(value is string)||!seen.Add((string)value)||result.Count>=128)throw new Exception("Invalid owned target list");string id=(string)value,role=TargetRole(id,main,child);string type=item.TryGetValue("type",out value)?value as string:null;switch(type){case "page":case "iframe":case "worker":case "service_worker":case "shared_worker":case "background_page":case "browser":case "tab":case "webview":case "other":break;default:type="unknown";break;}string url=item.TryGetValue("url",out value)?value as string:null;object attached=item.TryGetValue("attached",out value)&&value is bool?value:null;string opener=item.TryGetValue("openerId",out value)?value as string:null,parent=item.TryGetValue("parentId",out value)?value as string:null,parentFrame=item.TryGetValue("parentFrameId",out value)?value as string:null;string sid=role=="main"?(string)typeof(CockpitBrowserGuard).GetField("mainSession",Private).GetValue(g):role=="child"?(string)typeof(CockpitBrowserGuard).GetField("childSession",Private).GetValue(g):null;Task arm;string armState=sid!=null&&armed.TryGetValue(sid,out arm)?arm.Status.ToString():"missing";result.Add(new System.Collections.Generic.Dictionary<string,object>{{"targetId",id},{"type",type},{"urlCategory",TargetUrlCategory(url)},{"internalPageCategory",TargetInternalPageCategory(url)},{"attached",attached},{"guardRole",role},{"guardAccepted",role=="main"||role=="child"},{"guardArm",armState},{"openerRole",TargetRole(opener,main,child)},{"parentRole",TargetRole(parent,main,child)},{"parentFrameRole",TargetRole(parentFrame,(string)typeof(CockpitBrowserGuard).GetField("frame",Private).GetValue(g),(string)typeof(CockpitBrowserGuard).GetField("childFrame",Private).GetValue(g))}});}}return result.ToArray();}
 public static async Task<object[]> TargetInventory(BrowserPreview p){var g=(CockpitBrowserGuard)typeof(BrowserPreview).GetField("guard",Private).GetValue(p);var r=await (Task<System.Collections.Generic.Dictionary<string,object>>)typeof(CockpitBrowserGuard).GetMethod("Command",Private).Invoke(g,new object[]{"Target.getTargets",new{},null});return AuditTargets(g,r);}
 public static async Task<string[]> TargetIds(BrowserPreview p){var inventory=await TargetInventory(p);var ids=new System.Collections.Generic.List<string>();foreach(object node in inventory)ids.Add((string)((System.Collections.Generic.Dictionary<string,object>)node)["targetId"]);return ids.ToArray();}
 public static bool TargetInventoryFixture(){using(var g=new CockpitBrowserGuard(delegate{},delegate{return new uint[0];},delegate(CancellationToken t){return Task.FromResult(new System.Collections.Generic.Dictionary<string,object>());},null)){PrepareGuard(g,"Ready");var r=new System.Collections.Generic.Dictionary<string,object>{{"targetInfos",new object[]{new System.Collections.Generic.Dictionary<string,object>{{"targetId","main-target"},{"type","page"},{"url","about:blank"},{"attached",true}},new System.Collections.Generic.Dictionary<string,object>{{"targetId","unknown-target"},{"type","tab"},{"url","edge://fixture-private-path"},{"attached",false},{"openerId","main-target"}},new System.Collections.Generic.Dictionary<string,object>{{"targetId","unknown-worker"},{"type","worker"},{"url","https://fixture.invalid/private?token=redacted"},{"attached",true}}}}};var inventory=AuditTargets(g,r);var main=(System.Collections.Generic.Dictionary<string,object>)inventory[0];var tab=(System.Collections.Generic.Dictionary<string,object>)inventory[1];var worker=(System.Collections.Generic.Dictionary<string,object>)inventory[2];string serialized=new System.Web.Script.Serialization.JavaScriptSerializer().Serialize(inventory);return inventory.Length==3&&(string)main["guardRole"]=="main"&&(bool)main["guardAccepted"]&&(string)main["guardArm"]=="RanToCompletion"&&(string)tab["urlCategory"]=="edge"&&(string)tab["internalPageCategory"]=="other"&&(string)tab["openerRole"]=="main"&&!(bool)tab["guardAccepted"]&&!(bool)worker["guardAccepted"]&&(string)worker["urlCategory"]=="https"&&TargetInternalPageCategory("edge://downloads/private?token=redacted")=="downloads"&&TargetInternalPageCategory("edge://newtab/private")=="newtab"&&TargetInternalPageCategory("https://downloads/private")=="none"&&!serialized.Contains("fixture-private-path")&&!serialized.Contains("token=");}}
 public static async Task<int> OwnedTargetCount(BrowserPreview p){return (await TargetIds(p)).Length;}
 public static PreviewProcessIdentity[] MemberIdentities(uint[] ids){var result=new System.Collections.Generic.List<PreviewProcessIdentity>();foreach(uint pid in ids)result.Add(ProcessIdentity(pid));return result.ToArray();}
 static PreviewProcessIdentity ProcessIdentity(uint pid){var result=new PreviewProcessIdentity{Pid=pid};try{using(var process=System.Diagnostics.Process.GetProcessById((int)pid)){if(process.HasExited){result.State="exited";return result;}result.StartUtcTicks=process.StartTime.ToUniversalTime().Ticks;result.State=process.HasExited?"exited":"running";}}catch(ArgumentException){result.State="missing";}catch(Exception e){result.State="unverified";result.ErrorType=e.GetType().FullName;}return result;}
 public static PreviewProcessObservation[] ObserveMemberCleanup(PreviewProcessIdentity[] before){var result=new System.Collections.Generic.List<PreviewProcessObservation>();foreach(var old in before){var current=ProcessIdentity(old.Pid);string status;if(current.State=="missing"||current.State=="exited")status=current.State;else if(current.State=="unverified"||old.State=="unverified")status="unverified";else if(old.State=="missing"||old.State=="exited")status="pid_reused_after_initial_exit";else if(old.StartUtcTicks.HasValue&&current.StartUtcTicks.HasValue)status=old.StartUtcTicks==current.StartUtcTicks?"owned_alive":"pid_reused";else status="unverified";result.Add(new PreviewProcessObservation{Pid=old.Pid,BeforeStartUtcTicks=old.StartUtcTicks,AfterStartUtcTicks=current.StartUtcTicks,BeforeState=old.State,AfterState=current.State,Status=status,ErrorType=current.ErrorType??old.ErrorType});}return result.ToArray();}
 public static bool ProcessIdentityFixture(){var own=ProcessIdentity((uint)System.Diagnostics.Process.GetCurrentProcess().Id);if(own.State!="running"||!own.StartUtcTicks.HasValue)return false;var live=ObserveMemberCleanup(new[]{own});var reused=ObserveMemberCleanup(new[]{new PreviewProcessIdentity{Pid=own.Pid,State="running",StartUtcTicks=own.StartUtcTicks.Value-1}});var unverified=ObserveMemberCleanup(new[]{new PreviewProcessIdentity{Pid=own.Pid,State="unverified"}});return live.Length==1&&live[0].Status=="owned_alive"&&live[0].BeforeStartUtcTicks==live[0].AfterStartUtcTicks&&reused[0].Status=="pid_reused"&&unverified[0].Status=="unverified";}
 public static bool ForeignCleanupMember(BrowserPreview p){var handles=(System.Collections.Generic.List<IntPtr>)typeof(BrowserPreview).GetField("processHandles",Private).GetValue(p);int count=handles.Count;IntPtr handle=(IntPtr)typeof(BrowserPreview).GetMethod("CleanupMember",Private).Invoke(p,new object[]{(uint)System.Diagnostics.Process.GetCurrentProcess().Id});if(handle!=IntPtr.Zero){CloseFixtureHandle(handle);return false;}return handles.Count==count&&!System.Diagnostics.Process.GetCurrentProcess().HasExited;}
 [System.Runtime.InteropServices.DllImport("kernel32.dll",EntryPoint="CloseHandle")]static extern bool CloseFixtureHandle(IntPtr handle);
 public static async Task<int> SecurityFixtures(){int checks=0;Action<bool,string> verify=delegate(bool ok,string text){if(!ok)throw new Exception(text);checks++;};
  foreach(string unsupported in new[]{"Browser.setDownloadBehavior","Page.setInterceptFileChooserDialog"}){int kills=0;using(var g=new CockpitBrowserGuard(delegate{kills++;},delegate{return new uint[0];},delegate(CancellationToken t){return Task.FromResult(new System.Collections.Generic.Dictionary<string,object>());},null)){g.CommandCheckpoint=delegate(string method,object args,string sid){if(method==unsupported)throw new System.IO.IOException("fixture unsupported protection");};bool failed=false;try{if(unsupported=="Browser.setDownloadBehavior")await (Task)typeof(CockpitBrowserGuard).GetMethod("DenyDownloads",Private).Invoke(g,null);else await (Task)typeof(CockpitBrowserGuard).GetMethod("Arm",Private).Invoke(g,new object[]{"main-session","page"});}catch{failed=true;}verify(failed&&g.Failed&&!g.InputReady&&kills==1,"unsupported protection enabled input");}}
  foreach(string method in new[]{"Page.fileChooserOpened","Browser.downloadWillBegin","Browser.downloadProgress","Page.downloadWillBegin","Page.downloadProgress","Page.javascriptDialogOpening","Page.windowOpen","Target.detachedFromTarget","Inspector.detached","Inspector.targetCrashed"}){int kills=0;using(var g=new CockpitBrowserGuard(delegate{kills++;},delegate{return new uint[0];},delegate(CancellationToken t){return Task.FromResult(new System.Collections.Generic.Dictionary<string,object>());},null)){PrepareGuard(g,"Ready");GuardEvent(g,method,method.StartsWith("Browser.")?null:"main-session",new{});verify(g.Failed&&!g.InputReady&&kills==1,"security event not revoked: "+method);GuardEvent(g,method,"main-session",new{});verify(kills==1,"duplicate event terminated twice");}}
  foreach(string method in new[]{"Page.frameRequestedNavigation","Page.frameScheduledNavigation","Page.frameStartedNavigating","Page.frameNavigated","Page.navigatedWithinDocument"})foreach(string url in new[]{"about:blank","about:srcdoc","about:blank#fragment","file:///fixture-never-read","http://127.0.0.1:9/fixture-never-send"})using(var g=new CockpitBrowserGuard(delegate{},delegate{return new uint[0];},delegate(CancellationToken t){return Task.FromResult(new System.Collections.Generic.Dictionary<string,object>());},null)){PrepareGuard(g,"Ready");GuardEvent(g,method,"main-session",method=="Page.frameNavigated"?(object)new{frame=new{id="main-frame",url=url,loaderId="new-loader"}}:new{frameId="main-frame",url=url});verify(g.Failed&&!g.InputReady,"Ready navigation accepted");}
  using(var g=new CockpitBrowserGuard(delegate{},delegate{return new uint[0];},delegate(CancellationToken t){return Task.FromResult(new System.Collections.Generic.Dictionary<string,object>());},null)){PrepareGuard(g,"Ready");GuardEvent(g,"Runtime.consoleAPICalled","unknown-session",new{});verify(g.Failed&&!g.InputReady,"unknown session accepted");}
  using(var g=new CockpitBrowserGuard(delegate{},delegate{return new uint[0];},delegate(CancellationToken t){return Task.FromResult(new System.Collections.Generic.Dictionary<string,object>());},null)){PrepareGuard(g,"Ready");GuardEvent(g,"Page.frameAttached","main-session",new{frameId="new-child",parentFrameId="main-frame"});verify(g.Failed,"Ready frame attach accepted");}
  using(var g=new CockpitBrowserGuard(delegate{},delegate{return new uint[0];},delegate(CancellationToken t){return Task.FromResult(new System.Collections.Generic.Dictionary<string,object>());},null)){PrepareGuard(g,"Mounting");GuardEvent(g,"Page.frameNavigated","main-session",new{frame=new{id="main-frame",url="about:blank",loaderId="mount-loader"}});verify(!g.Failed,"one mount commit rejected");GuardEvent(g,"Page.frameNavigated","main-session",new{frame=new{id="main-frame",url="about:blank",loaderId="mount-loader"}});verify(g.Failed,"repeated mount commit accepted");}
  foreach(string missing in new[]{"downloadDenied","mainLoader"})using(var g=new CockpitBrowserGuard(delegate{},delegate{return new uint[0];},delegate(CancellationToken t){return Task.FromResult(new System.Collections.Generic.Dictionary<string,object>());},null)){PrepareGuard(g,"Preparing");SetGuard(g,missing,missing=="downloadDenied"?(object)false:null);bool failed=false;try{await g.MountAsync("<html></html>");}catch{failed=true;}verify(failed&&!g.InputReady&&g.Failed,"unprepared Mount enabled input");}
  var records=new System.Collections.Generic.List<string>();var response=new ThreadLocal<System.Collections.Generic.Dictionary<string,object>>();CockpitBrowserGuard mountingGuard=null;
  using(var g=new CockpitBrowserGuard(delegate{},delegate{return new uint[0];},delegate(CancellationToken t){return Task.FromResult(response.Value??new System.Collections.Generic.Dictionary<string,object>());},null)){mountingGuard=g;g.CommandCheckpoint=delegate(string method,object args,string sid){lock(records)records.Add(method+"/"+sid);response.Value=new System.Collections.Generic.Dictionary<string,object>();if(method=="Page.getFrameTree"){var child=new System.Collections.Generic.Dictionary<string,object>{{"id","expected-iframe"},{"url","about:srcdoc"},{"loaderId","child-loader"}};var main=new System.Collections.Generic.Dictionary<string,object>{{"id","main-frame"},{"url","about:blank"},{"loaderId","main-loader"}};response.Value["frameTree"]=new System.Collections.Generic.Dictionary<string,object>{{"frame",sid=="main-session"?main:child}};}if(method=="Runtime.evaluate"&&args.GetType().GetProperty("expression").GetValue(args,null).ToString().Contains("codex-cockpit-generated")){GuardEvent(mountingGuard,"Page.frameAttached","main-session",new{frameId="expected-iframe",parentFrameId="main-frame"});GuardEvent(mountingGuard,"Target.attachedToTarget","main-session",new{sessionId="child-session",waitingForDebugger=true,targetInfo=new{type="iframe",targetId="expected-iframe",url="about:srcdoc",parentFrameId="main-frame",parentId="main-target"}});GuardEvent(mountingGuard,"Page.frameNavigated","child-session",new{frame=new{id="expected-iframe",url="about:srcdoc",loaderId="child-loader"}});GuardEvent(mountingGuard,"Page.frameStoppedLoading","child-session",new{frameId="expected-iframe"});}};
   await (Task)typeof(CockpitBrowserGuard).GetMethod("DenyDownloads",Private).Invoke(g,null);await (Task)typeof(CockpitBrowserGuard).GetMethod("Arm",Private).Invoke(g,new object[]{"main-session","page"});PrepareGuard(g,"Preparing");await g.MountAsync("<html><body>fixture</body></html>");verify(g.InputReady&&!g.Failed,"bounded protected Mount never ready");string[] calls;lock(records)calls=records.ToArray();verify(Array.IndexOf(calls,"Browser.setDownloadBehavior/")==0&&Array.IndexOf(calls,"Page.setInterceptFileChooserDialog/main-session")<Array.IndexOf(calls,"Page.setDocumentContent/main-session"),"download/chooser protection late");verify(Array.IndexOf(calls,"Page.setInterceptFileChooserDialog/child-session")<Array.IndexOf(calls,"Runtime.runIfWaitingForDebugger/child-session"),"child resumed before chooser protection");GuardEvent(g,"Page.frameNavigated","child-session",new{frame=new{id="expected-iframe",url="about:srcdoc",loaderId="child-loader"}});verify(!g.InputReady&&g.Failed,"Ready retained mounting whitelist");}
  response.Dispose();foreach(string scenario in new[]{"missed_events","missing_loader","wrong_loader","not_ready"})verify(MountReadbackFixture(scenario),"initial tree readback boundary failed: "+scenario);return checks;
 }
 public static bool FrameContract(){var t=new PreviewTarget{InstanceId="instance",RunId="run",Mode="cockpit",Version="pelican-cockpit-v1",ServiceGeneration=1,WindowGeneration=2,SelectionGeneration=3,Presentation=PreviewPresentation.Inline,CaptureFrames=true,ContentDigest="digest"};byte[] b={255,216,255,217};var f=new PreviewFrame(7,t,9,b);t.RunId="mutated";t.ContentDigest="changed";b[0]=0;var copy=f.Target;copy.RunId="again";f.EncodedBytes[0]=0;return f.OperationGeneration==7&&f.Sequence==9&&f.Target.RunId=="run"&&f.Target.ServiceGeneration==1&&f.Target.WindowGeneration==2&&f.Target.SelectionGeneration==3&&f.Target.Presentation==PreviewPresentation.Inline&&f.Target.CaptureFrames&&f.Target.ContentDigest=="digest"&&f.EncodedBytes[0]==255;}
 internal static System.Collections.Generic.Dictionary<string,object> CaptureValue(object value){return new System.Collections.Generic.Dictionary<string,object>{{"result",new System.Collections.Generic.Dictionary<string,object>{{"value",value}}}};}
 internal static System.Collections.Generic.Dictionary<string,object> CaptureSize(double width,double height){return CaptureGeometry(width,height,960,600);}
 internal static System.Collections.Generic.Dictionary<string,object> CaptureGeometry(double width,double height,double viewportWidth,double viewportHeight){return CaptureValue(new System.Collections.Generic.Dictionary<string,object>{{"width",width},{"height",height},{"viewportWidth",viewportWidth},{"viewportHeight",viewportHeight}});}
 public static string CaptureMeasureExpression(){return CockpitBrowserGuard.CaptureMeasure;}
 public static async Task<int> CaptureViewportFixtures(){
  int checks=0;Action<bool,string> verify=delegate(bool ok,string message){checks++;if(!ok)throw new Exception(message);};
  foreach(string scenario in new[]{"zoomIdentity","zoomBody100","zoomTall","zoomFractional","zoomInteger","zoomRootFractional","zoomPersistent","missingViewport","zeroViewport","infiniteViewport","oversizedViewport","normalizedOversized"}){
   int measured=0,fitted=0,kills=0;double fittedWidth=960,fittedHeight=600;bool threw=false;var response=new System.Collections.Generic.Dictionary<string,object>();
   using(var g=CaptureGuard(delegate(CancellationToken token){return Task.FromResult(response);},delegate{kills++;})){
    g.CommandCheckpoint=delegate(string method,object args,string sid){response=new System.Collections.Generic.Dictionary<string,object>();if(method=="Emulation.setDeviceMetricsOverride")return;verify(method=="Runtime.evaluate","unexpected viewport command");string expression=(string)args.GetType().GetProperty("expression").GetValue(args,null);
     if(sid=="capture-child-session"){
      measured++;double viewportWidth=measured==1?961.4678955078125:fittedWidth+.38531494140625,viewportHeight=fittedHeight;
      double width=viewportWidth,height=viewportHeight;
      if(scenario=="zoomTall"&&measured==1)height=723.109375;
      if((scenario=="zoomFractional"||scenario=="zoomRootFractional")&&measured==1)width+=.125;
      if(scenario=="zoomInteger"&&measured==1)width+=1;
      if(scenario=="zoomPersistent")height+=.125;
      if(scenario=="zeroViewport")viewportWidth=0;
      if(scenario=="infiniteViewport")viewportHeight=Double.PositiveInfinity;
      if(scenario=="oversizedViewport")viewportWidth=4097;
      if(scenario=="normalizedOversized"){viewportWidth=1;width=4096;}
      response=CaptureGeometry(width,height,viewportWidth,viewportHeight);
      if(scenario=="missingViewport")((System.Collections.Generic.Dictionary<string,object>)((System.Collections.Generic.Dictionary<string,object>)response["result"])["value"]).Remove("viewportWidth");
     }else{
      fitted++;verify(sid=="main-session","viewport fit changed session");var match=System.Text.RegularExpressions.Regex.Match(expression,@"const \[w,h,s\]=(\[[^\]]+\]);");verify(match.Success,"viewport fit dimensions missing");var dimensions=new System.Web.Script.Serialization.JavaScriptSerializer().Deserialize<double[]>(match.Groups[1].Value);fittedWidth=dimensions[0];fittedHeight=dimensions[1];double scale=Math.Min(960/fittedWidth,600/fittedHeight);response=CaptureValue(new System.Collections.Generic.Dictionary<string,object>{{"left",(960-fittedWidth*scale)/2},{"top",(600-fittedHeight*scale)/2},{"width",fittedWidth*scale},{"height",fittedHeight*scale}});
     }
    };
    try{await g.ConfigureCaptureAsync();}catch{threw=true;}
    bool valid=scenario=="zoomIdentity"||scenario=="zoomBody100"||scenario=="zoomTall"||scenario=="zoomFractional"||scenario=="zoomInteger"||scenario=="zoomRootFractional";
    verify(threw!=valid&&g.Failed!=valid&&g.InputReady==valid&&kills==(valid?0:1),"viewport fail-closed outcome: "+scenario);
    verify(fitted<=2&&measured<=3,"viewport normalization polled: "+scenario);
    if(scenario=="zoomIdentity"||scenario=="zoomBody100")verify(fitted==0&&measured==1,"viewport tail changed identity frame");
    if(scenario=="zoomTall")verify(fitted==1&&fittedWidth==960&&fittedHeight==724,"zoom footer overflow cropped");
    if(scenario=="zoomFractional"||scenario=="zoomInteger"||scenario=="zoomRootFractional")verify(fitted==1&&fittedWidth==961,"positive intrinsic overflow discarded");
    if(scenario=="zoomPersistent")verify(fitted==2&&measured==3,"persistent fractional growth accepted");
   }
  }
  return checks;
 }
 internal static void PrepareCapture(CockpitBrowserGuard g){PrepareGuard(g,"Ready");SetGuard(g,"childSession","capture-child-session");SetGuard(g,"childFrame","capture-child-frame");SetGuard(g,"iframeTarget","capture-child-frame");SetGuard(g,"childLoader","capture-child-loader");((System.Collections.Concurrent.ConcurrentDictionary<string,Task>)typeof(CockpitBrowserGuard).GetField("armed",Private).GetValue(g))["capture-child-session"]=Task.FromResult(true);((System.Collections.Generic.HashSet<string>)typeof(CockpitBrowserGuard).GetField("chooserArmed",Private).GetValue(g)).Add("capture-child-session");}
 internal static CockpitBrowserGuard CaptureGuard(Func<CancellationToken,Task<System.Collections.Generic.Dictionary<string,object>>> command,Action terminate){var g=new CockpitBrowserGuard(terminate,delegate{return new uint[0];},command,null);PrepareCapture(g);return g;}
 public static async Task<byte[]> CaptureBytes(string data){using(var g=CaptureGuard(delegate(CancellationToken token){var result=CaptureSize(960,600);result["data"]=data;return Task.FromResult(result);},delegate{})){await g.ConfigureCaptureAsync();return await g.CaptureAsync();}}
 public static async Task<string> CaptureTimeout(){int killed=0;var watch=System.Diagnostics.Stopwatch.StartNew();using(var g=CaptureGuard(delegate(CancellationToken token){return new TaskCompletionSource<System.Collections.Generic.Dictionary<string,object>>().Task;},delegate{Interlocked.Increment(ref killed);})){try{await g.CaptureAsync();return "unexpected";}catch{return "elapsed="+watch.ElapsedMilliseconds+";failed="+g.Failed+";killed="+killed;}}}
 public static async Task<bool> NormalCommandBudget(){using(var g=CaptureGuard(async delegate(CancellationToken token){await Task.Delay(1800,token);return CaptureSize(960,600);},delegate{})){await g.ConfigureCaptureAsync();return !g.Failed;}}
 public static async Task<int> CaptureFitFixtures(){int checks=0;Action<bool,string> verify=delegate(bool ok,string message){checks++;if(!ok)throw new Exception(message);};foreach(string scenario in new[]{"identity","smaller","tall","wide","both","correction","persistent","zero","negative","nan","infinite","oversizedWidth","oversizedHeight","missing","exception","badFrame","identityLost"}){int measured=0,fitted=0,kills=0,commands=0,metrics=0,inputs=0;double fittedWidth=0,fittedHeight=0;bool threw=false;var response=new System.Collections.Generic.Dictionary<string,object>();using(var g=CaptureGuard(delegate(CancellationToken token){return Task.FromResult(response);},delegate{kills++;})){if(scenario=="identityLost")SetGuard(g,"iframeTarget","unexpected-frame");g.CommandCheckpoint=delegate(string method,object args,string sid){commands++;response=new System.Collections.Generic.Dictionary<string,object>();if(method=="Emulation.setDeviceMetricsOverride"){metrics++;verify(sid=="main-session"&&(int)args.GetType().GetProperty("width").GetValue(args,null)==960&&(int)args.GetType().GetProperty("height").GetValue(args,null)==600,"capture metrics changed");}else if(method=="Runtime.evaluate"){string expression=(string)args.GetType().GetProperty("expression").GetValue(args,null);verify((bool)args.GetType().GetProperty("returnByValue").GetValue(args,null),"capture measurement not by value");if(sid=="capture-child-session"){measured++;verify(!expression.Contains("f.style")&&!expression.Contains("replaceChildren")&&!expression.Contains("documentElement.style"),"capture changed child document");double width=scenario=="wide"||scenario=="both"?1540.25:scenario=="smaller"?800:960,height=scenario=="tall"||scenario=="both"||scenario=="correction"||scenario=="persistent"||scenario=="badFrame"?723.109375:scenario=="smaller"?500:600;if(scenario=="correction"&&measured>1)height=800.25;if(scenario=="persistent")height+=measured*80;if(scenario=="zero")height=0;if(scenario=="negative")width=-1;if(scenario=="nan")height=Double.NaN;if(scenario=="infinite")width=Double.PositiveInfinity;if(scenario=="oversizedWidth")width=4096.01;if(scenario=="oversizedHeight")height=4097;response=CaptureGeometry(width,height,fitted==0?960:fittedWidth,fitted==0?600:fittedHeight);if(scenario=="missing")response=CaptureValue(new System.Collections.Generic.Dictionary<string,object>{{"width",960}});if(scenario=="exception")response["exceptionDetails"]=new object();}else{fitted++;verify(sid=="main-session"&&expression.Contains("getElementById('codex-cockpit-generated')")&&expression.Contains("Object.assign(f.style")&&!expression.Contains("srcdoc=")&&!expression.Contains("sandbox")&&!expression.Contains("location"),"capture mutated untrusted frame or permissions");var match=System.Text.RegularExpressions.Regex.Match(expression,@"const \[w,h,s\]=(\[[^\]]+\]);");verify(match.Success,"fit dimensions missing");var dimensions=new System.Web.Script.Serialization.JavaScriptSerializer().Deserialize<double[]>(match.Groups[1].Value);fittedWidth=dimensions[0];fittedHeight=dimensions[1];double scale=Math.Min(960/fittedWidth,600/fittedHeight),left=(960-fittedWidth*scale)/2,top=(600-fittedHeight*scale)/2;verify(Math.Abs(dimensions[2]-scale)<.0000001&&fittedWidth>=960&&fittedHeight>=600&&fittedWidth<=4096&&fittedHeight<=4096,"nonuniform/unbounded capture fit");response=CaptureValue(new System.Collections.Generic.Dictionary<string,object>{{"left",scenario=="badFrame"?-1:left},{"top",top},{"width",fittedWidth*scale},{"height",fittedHeight*scale}});}}else if(method=="Input.dispatchMouseEvent"){inputs++;verify(sid=="main-session"&&(double)args.GetType().GetProperty("x").GetValue(args,null)==110&&(double)args.GetType().GetProperty("y").GetValue(args,null)==135,"identity click coordinates changed");}else verify(false,"unexpected capture configuration command");};try{await g.ConfigureCaptureAsync();if(scenario=="identity")await g.ClickAsync(110,135,CancellationToken.None,delegate(Action send){send();});}catch{threw=true;}bool valid=scenario=="identity"||scenario=="smaller"||scenario=="tall"||scenario=="wide"||scenario=="both"||scenario=="correction";verify(threw!=valid&&g.Failed!=valid&&g.InputReady==valid&&kills==(valid?0:1),"capture fit fail-closed outcome: "+scenario);verify(fitted<=2&&measured<=3&&metrics==(scenario=="identityLost"?0:1),"unbounded fit attempts: "+scenario);if(scenario=="identity"||scenario=="smaller")verify(fitted==0&&measured==1&&commands==(scenario=="identity"?4:2)&&inputs==(scenario=="identity"?2:0),"identity frame styles/position changed");if(scenario=="tall")verify(fitted==1&&fittedHeight==724&&fittedWidth==960&&694.3125*600/fittedHeight<600,"tall footer/button cropped");if(scenario=="wide")verify(fitted==1&&fittedWidth==1541&&fittedHeight==600,"wide document was not fit");if(scenario=="both")verify(fitted==1&&fittedWidth==1541&&fittedHeight==724,"two-dimensional document fit missing");if(scenario=="correction")verify(fitted==2&&measured==3&&fittedHeight==801,"one bounded layout correction missing");if(scenario=="persistent")verify(fitted==2&&measured==3,"persistent layout change accepted or polled");}}return checks;}
 public static void InstallCaptureFixture(BrowserPreview p,Func<CancellationToken,Task<System.Collections.Generic.Dictionary<string,object>>> command){var flags=System.Reflection.BindingFlags.Instance|System.Reflection.BindingFlags.NonPublic;var g=p.BindGuard(command,null);PrepareCapture(g);typeof(BrowserPreview).GetField("guard",flags).SetValue(p,g);var t=BrowserPreview.Copy((PreviewTarget)typeof(BrowserPreview).GetField("current",flags).GetValue(p));t.Mode="cockpit";t.Version="pelican-cockpit-v1";t.CaptureFrames=true;t.Presentation=PreviewPresentation.Inline;t.ContentDigest="fixture-digest";typeof(BrowserPreview).GetField("current",flags).SetValue(p,t);}
 public static void InstallBadCapture(BrowserPreview p,string scenario){InstallCaptureFixture(p,delegate(CancellationToken token){return scenario=="timeout"?new TaskCompletionSource<System.Collections.Generic.Dictionary<string,object>>().Task:Task.FromResult(new System.Collections.Generic.Dictionary<string,object>{{"data",scenario=="oversized"?new string('A',1398108):"not-base64"}});});}
}
public sealed class PreviewProcessIdentity {public uint Pid;public long? StartUtcTicks;public string State,ErrorType;}
public sealed class PreviewProcessObservation {public uint Pid;public long? BeforeStartUtcTicks,AfterStartUtcTicks;public string BeforeState,AfterState,Status,ErrorType;}
public sealed class PreviewCleanupExitFixture:IDisposable {
 readonly BrowserPreview preview;readonly CockpitBrowserGuard killer;public bool CheckpointReached,OwnedJobEmpty,RootHandlesSignaled;
 public PreviewCleanupExitFixture(BrowserPreview p){preview=p;killer=p.BindGuard(null,null);p.LaunchCheckpoint=Check;}
 void Check(string stage,long generation,uint pid){if(stage!="before_cleanup_member_open"||CheckpointReached)return;CheckpointReached=true;killer.Revoke();var watch=System.Diagnostics.Stopwatch.StartNew();while(Members().Length>0&&watch.ElapsedMilliseconds<3000)Thread.Sleep(10);OwnedJobEmpty=Members().Length==0;RootHandlesSignaled=true;foreach(IntPtr handle in (System.Collections.Generic.List<IntPtr>)typeof(BrowserPreview).GetField("processHandles",PreviewFixtures.Private).GetValue(preview))RootHandlesSignaled=WaitForSingleObject(handle,1000)==0&&RootHandlesSignaled;if(!OwnedJobEmpty||!RootHandlesSignaled)throw new System.IO.IOException("Fixture owned exit not proven");Thread.Sleep(100);}
 uint[] Members(){return (uint[])typeof(BrowserPreview).GetMethod("Members",PreviewFixtures.Private).Invoke(preview,null);}
 public void Dispose(){preview.LaunchCheckpoint=null;killer.Dispose();}
 [System.Runtime.InteropServices.DllImport("kernel32.dll")]static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
}
public sealed class PreviewSecurityWitness {
 readonly CockpitBrowserGuard guard;
 public PreviewSecurityWitness(BrowserPreview p){guard=(CockpitBrowserGuard)typeof(BrowserPreview).GetField("guard",PreviewFixtures.Private).GetValue(p);}
 public System.Collections.Generic.Dictionary<string,object> Audit(){return PreviewFixtures.AuditGuard(guard);}
}
public sealed class PreviewCanary:IDisposable {
 readonly System.Net.Sockets.TcpListener listener=new System.Net.Sockets.TcpListener(IPAddress.Loopback,0);readonly Task worker;int count,stopped;public readonly string Url;
 public PreviewCanary(){listener.Start();Url="http://127.0.0.1:"+((IPEndPoint)listener.LocalEndpoint).Port;worker=Task.Run(async delegate{try{while(Volatile.Read(ref stopped)==0){using(var client=await listener.AcceptTcpClientAsync()){Interlocked.Increment(ref count);}}}catch(System.Net.Sockets.SocketException){if(Volatile.Read(ref stopped)==0)throw;}catch(ObjectDisposedException){if(Volatile.Read(ref stopped)==0)throw;}});}
 public int Count {get{return Volatile.Read(ref count);}}
 public void Dispose(){if(Interlocked.Exchange(ref stopped,1)!=0)return;listener.Stop();if(!worker.Wait(3000))throw new TimeoutException("canary cleanup deadline");}
}
public sealed class PreviewInputFixture:IDisposable {
 readonly BrowserPreview preview;readonly CockpitBrowserGuard guard;readonly object sync=new object();readonly ThreadLocal<string> command=new ThreadLocal<string>();readonly System.Collections.Generic.List<string> records=new System.Collections.Generic.List<string>();readonly TaskCompletionSource<bool> captureRelease=new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously),pressRelease=new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);int active,maxActive,captures;bool disposed;
 public readonly ManualResetEventSlim CaptureEntered=new ManualResetEventSlim(false),PressEntered=new ManualResetEventSlim(false);public bool HoldCapture,HoldPress,FailPress;public readonly PreviewTarget Target;public readonly long Operation;
 public PreviewInputFixture(BrowserPreview p,bool publishFrame){preview=p;var flags=PreviewFixtures.Private;var gate=typeof(BrowserPreview).GetField("gate",flags).GetValue(p);lock(gate){var old=(CockpitBrowserGuard)typeof(BrowserPreview).GetField("guard",flags).GetValue(p);if(old!=null)old.Dispose();guard=p.BindGuard(Wait,null);PreviewFixtures.PrepareGuard(guard,"Ready");guard.CommandCheckpoint=Record;Target=BrowserPreview.Copy(p.Snapshot.Target);Target.Mode="cockpit";Target.Version="pelican-cockpit-v1";Target.Presentation=PreviewPresentation.Inline;Target.CaptureFrames=true;Target.ContentDigest="fixture-digest";Operation=p.Snapshot.OperationGeneration;foreach(string name in new[]{"desired","current"})typeof(BrowserPreview).GetField(name,flags).SetValue(p,BrowserPreview.Copy(Target));typeof(BrowserPreview).GetField("snapshot",flags).SetValue(p,new PreviewSnapshot{OperationGeneration=Operation,Target=BrowserPreview.Copy(Target),State="open",CleanupState="active"});typeof(BrowserPreview).GetField("guard",flags).SetValue(p,guard);typeof(BrowserPreview).GetField("nextCaptureAt",flags).SetValue(p,Int64.MaxValue);p.FrameReady+=Frame;if(publishFrame)typeof(BrowserPreview).GetMethod("PublishFrame",flags).Invoke(p,new object[]{Operation,Target,new byte[]{255,216,255,217}});}}
 void Frame(PreviewFrame frame){}
 void Record(string method,object args,string sid){string type=method=="Input.dispatchMouseEvent"?(string)args.GetType().GetProperty("type").GetValue(args,null):method;command.Value=type;lock(sync)records.Add(new System.Web.Script.Serialization.JavaScriptSerializer().Serialize(new{method=method,args=args,session=sid}));}
 async Task<System.Collections.Generic.Dictionary<string,object>> Wait(CancellationToken token){string type=command.Value;lock(sync){active++;maxActive=Math.Max(active,maxActive);}try{if(type=="Page.captureScreenshot"){Interlocked.Increment(ref captures);CaptureEntered.Set();if(HoldCapture)await AwaitRelease(captureRelease.Task,token);}if(type=="mousePressed"){PressEntered.Set();if(FailPress)throw new System.IO.IOException("fixture input failure");if(HoldPress)await AwaitRelease(pressRelease.Task,token);}return new System.Collections.Generic.Dictionary<string,object>{{"data",Convert.ToBase64String(new byte[]{255,216,255,217})}};}finally{lock(sync)active--;}}
 static async Task AwaitRelease(Task task,CancellationToken token){if(await Task.WhenAny(task,Task.Delay(Timeout.Infinite,token))!=task)token.ThrowIfCancellationRequested();await task;}
 public string[] Records {get{lock(sync)return records.ToArray();}}public int MaxActive {get{lock(sync)return maxActive;}}public int Captures {get{return Volatile.Read(ref captures);}}
 public Task<bool> Click(PreviewTarget shown,long operation,double x,double y){return preview.ClickAsync(shown,operation,x,y);}
 public PreviewTarget CopyTarget(){return BrowserPreview.Copy(Target);}public void State(string state){var flags=PreviewFixtures.Private;var gate=typeof(BrowserPreview).GetField("gate",flags).GetValue(preview);lock(gate){var s=(PreviewSnapshot)typeof(BrowserPreview).GetField("snapshot",flags).GetValue(preview);s.State=state;}}
 public void Ready(bool ready){PreviewFixtures.SetGuard(guard,"inputReady",ready?1:0);}public void RejectInteraction(){PreviewFixtures.GuardEvent(guard,"Page.windowOpen","main-session",new{});}public void LiveIdentity(string name,bool valid){var flags=PreviewFixtures.Private;var gate=typeof(BrowserPreview).GetField("gate",flags).GetValue(preview);lock(gate){var t=CopyTarget();if(!valid)t.ContentDigest="changed-live";if(name=="snapshot")((PreviewSnapshot)typeof(BrowserPreview).GetField("snapshot",flags).GetValue(preview)).Target=t;else typeof(BrowserPreview).GetField(name,flags).SetValue(preview,t);}}
 public void BeginCapture(){typeof(BrowserPreview).GetField("nextCaptureAt",PreviewFixtures.Private).SetValue(preview,0L);}public void ReleaseCapture(){captureRelease.TrySetResult(true);}public void ReleasePress(){pressRelease.TrySetResult(true);}
 public void Dispose(){if(disposed)return;disposed=true;ReleaseCapture();ReleasePress();preview.FrameReady-=Frame;guard.Dispose();command.Dispose();}
}
public sealed class PreviewInputFailureBarrier:IDisposable {
 public readonly ManualResetEventSlim Entered=new ManualResetEventSlim(false),Release=new ManualResetEventSlim(false);readonly BrowserPreview preview;
 public PreviewInputFailureBarrier(BrowserPreview p){preview=p;p.LaunchCheckpoint=Check;}
 void Check(string stage,long generation,uint pid){if(stage!="before_input_failure"||generation!=1)return;Entered.Set();if(!Release.Wait(10000))throw new TimeoutException("input failure barrier deadline");}
 public void Dispose(){Release.Set();preview.LaunchCheckpoint=null;}
}
public sealed class PreviewGuardFailureBarrier:IDisposable {
 public readonly ManualResetEventSlim Entered=new ManualResetEventSlim(false),Release=new ManualResetEventSlim(false);readonly BrowserPreview preview;
 public PreviewGuardFailureBarrier(BrowserPreview p){preview=p;p.LaunchCheckpoint=Check;}
 void Check(string stage,long generation,uint pid){if(stage!="before_guard_failure"||generation!=1)return;Entered.Set();if(!Release.Wait(10000))throw new TimeoutException("guard failure barrier deadline");}
 public void Dispose(){Release.Set();preview.LaunchCheckpoint=null;}
}
public sealed class PreviewFrameSink:IDisposable {
 readonly BrowserPreview preview;readonly object sync=new object();readonly System.Diagnostics.Stopwatch clock=System.Diagnostics.Stopwatch.StartNew();int count;long firstAt=-1,lastAt=-1;byte[] first,last;long operation;string digest;bool tooFast;
 public PreviewFrameSink(BrowserPreview p){preview=p;p.FrameReady+=Frame;}
 void Frame(PreviewFrame f){lock(sync){long now=clock.ElapsedMilliseconds;if(lastAt>=0&&now-lastAt<195)tooFast=true;lastAt=now;if(first==null){first=f.EncodedBytes;firstAt=now;}last=f.EncodedBytes;operation=f.OperationGeneration;digest=f.Target.ContentDigest;count++;}}
 public int Count {get{lock(sync)return count;}}public bool TooFast{get{lock(sync)return tooFast;}}public byte[] First{get{lock(sync)return first==null?null:(byte[])first.Clone();}}public byte[] Last{get{lock(sync)return last==null?null:(byte[])last.Clone();}}public long Operation{get{lock(sync)return operation;}}public string Digest{get{lock(sync)return digest;}}
 public long FirstAt {get{lock(sync)return firstAt;}}public long LastAt {get{lock(sync)return lastAt;}}
 public void Dispose(){preview.FrameReady-=Frame;}
}
public sealed class PreviewGuardCatchBarrier:IDisposable {
 public readonly ManualResetEventSlim CommandEntered=new ManualResetEventSlim(false),Entered=new ManualResetEventSlim(false),Release=new ManualResetEventSlim(false); readonly CancellationTokenSource cancel=new CancellationTokenSource(); readonly CockpitBrowserGuard oldGuard; public readonly Task Command; public bool Failed {get{return oldGuard.Failed;}}
 public PreviewGuardCatchBarrier(BrowserPreview preview):this(preview,false){}
 public PreviewGuardCatchBarrier(BrowserPreview preview,bool capture):this(preview,capture,false){}
 public PreviewGuardCatchBarrier(BrowserPreview preview,bool capture,bool input){oldGuard=preview.BindGuard(Wait,Check);var flags=System.Reflection.BindingFlags.Instance|System.Reflection.BindingFlags.NonPublic;typeof(BrowserPreview).GetField("guard",flags).SetValue(preview,oldGuard);if(capture){typeof(CockpitBrowserGuard).GetField("session",flags).SetValue(oldGuard,"capture-session");typeof(CockpitBrowserGuard).GetField("frame",flags).SetValue(oldGuard,"capture-frame");}if(input)PreviewFixtures.PrepareGuard(oldGuard,"Ready");Command=Task.Run(async delegate{try{if(capture)await oldGuard.CaptureAsync();else if(input)await oldGuard.ClickAsync(25,25,CancellationToken.None,delegate(Action send){send();});else await (Task<System.Collections.Generic.Dictionary<string,object>>)typeof(CockpitBrowserGuard).GetMethod("Command",flags).Invoke(oldGuard,new object[]{"fixture.cancel",new{},null});}catch(OperationCanceledException){}});}
 async Task<System.Collections.Generic.Dictionary<string,object>> Wait(CancellationToken token){using(var linked=CancellationTokenSource.CreateLinkedTokenSource(token,cancel.Token)){CommandEntered.Set();await Task.Delay(Timeout.Infinite,linked.Token);return null;}}
 void Check(){Entered.Set();if(!Release.Wait(10000))throw new TimeoutException("guard catch barrier deadline");}
 public void Cancel(){Task.Run(delegate{cancel.Cancel();});} public void Dispose(){Release.Set();oldGuard.Dispose();if(!Command.Wait(10000))throw new TimeoutException("guard catch did not drain");cancel.Dispose();}
}
public sealed class PreviewCaptureBarrier:IDisposable {
 public readonly ManualResetEventSlim Entered=new ManualResetEventSlim(false);readonly TaskCompletionSource<System.Collections.Generic.Dictionary<string,object>> result=new TaskCompletionSource<System.Collections.Generic.Dictionary<string,object>>();int active,maxActive,calls;
 public int MaxActive {get{return Volatile.Read(ref maxActive);}}public int Calls {get{return Volatile.Read(ref calls);}}
 public PreviewCaptureBarrier(BrowserPreview p){PreviewFixtures.InstallCaptureFixture(p,Wait);}
 async Task<System.Collections.Generic.Dictionary<string,object>> Wait(CancellationToken token){int now=Interlocked.Increment(ref active);Interlocked.Exchange(ref maxActive,Math.Max(now,maxActive));Interlocked.Increment(ref calls);Entered.Set();try{return await result.Task;}finally{Interlocked.Decrement(ref active);}}
 public void Release(){result.TrySetResult(new System.Collections.Generic.Dictionary<string,object>{{"data",Convert.ToBase64String(new byte[]{255,216,255,217})}});}public void Dispose(){Release();}
}
public sealed class PreviewLaunchBarrier:IDisposable {
 public readonly ManualResetEventSlim Entered=new ManualResetEventSlim(false),Release=new ManualResetEventSlim(false);
 public uint StalePid;public int StaleResumes;readonly string stage;
 public PreviewLaunchBarrier(BrowserPreview preview,string checkpoint){stage=checkpoint;preview.LaunchCheckpoint=Check;}
 void Check(string checkpoint,long generation,uint pid){if(generation!=1)return;if(checkpoint=="after_resume"){Interlocked.Increment(ref StaleResumes);return;}if(checkpoint!=stage)return;StalePid=pid;Entered.Set();if(!Release.Wait(10000))throw new TimeoutException("launch barrier deadline");}
 public void Dispose(){Release.Set();}
}
public sealed class PreviewCaptureFailureBarrier:IDisposable {
 public readonly ManualResetEventSlim Entered=new ManualResetEventSlim(false),Release=new ManualResetEventSlim(false);readonly BrowserPreview preview;
 public PreviewCaptureFailureBarrier(BrowserPreview p){preview=p;p.LaunchCheckpoint=Check;PreviewFixtures.InstallBadCapture(p,"malformed");}
 void Check(string stage,long generation,uint pid){if(stage!="before_capture_failure"||generation!=1)return;Entered.Set();if(!Release.Wait(10000))throw new TimeoutException("capture failure barrier deadline");}
 public void Dispose(){Release.Set();preview.LaunchCheckpoint=null;}
}
}
"@
$fixtureRoot=Join-Path ([IO.Path]::GetTempPath()) ('codex-native-preview-selftest-'+[Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixtureRoot|Out-Null
$helperPath=Join-Path $fixtureRoot 'Helper.cs'
[IO.File]::WriteAllText($helperPath,$helper)
$script:checks=0
function Assert($ok,$message){if(-not $ok){throw $message};$script:checks++}
function Await($task,[string]$stage='unspecified'){try{if(-not $task.Wait(12000)){throw 'preview fixture deadline'};return $task.Result}catch{$cause=$_.Exception.GetBaseException();throw ('PREVIEW_AWAIT_FAILURE;stage='+$stage+';type='+$cause.GetType().FullName+';message='+$cause.Message)}}
function Field($controller,$name){return $controller.GetType().GetField($name,[Reflection.BindingFlags]'Instance,NonPublic').GetValue($controller)}
function Members($controller){return $controller.GetType().GetMethod('Members',[Reflection.BindingFlags]'Instance,NonPublic').Invoke($controller,@())}
function MemberIdentities($members){return [CodexNative.PreviewFixtures]::MemberIdentities([uint32[]]$members)}
$script:memberIdentityProof=New-Object 'Collections.Generic.List[object]'
$script:memberIdentityEvidencePath=Join-Path $(if($EvidenceDirectory){[IO.Path]::GetFullPath($EvidenceDirectory)}else{[IO.Path]::GetTempPath()}) ('native-preview-process-identity-evidence-'+[Guid]::NewGuid().ToString('N')+'.json')
function AssertMemberIdentities($before,[string]$message,$controller,[string]$profile,[switch]$Alive){
 $identityObservationFailure=$null;$observations=@()
 $record=[ordered]@{stage=$message;expected=$(if($Alive){'owned_alive'}else{'exited_or_pid_reused'});before=@($before);observations=@();failure=$null;profile=$profile}
 try{
  $observations=@([CodexNative.PreviewFixtures]::ObserveMemberCleanup([CodexNative.PreviewProcessIdentity[]]$before));$record.observations=$observations
  $unexpected=@($observations|Where-Object{if($Alive){$_.Status -ne 'owned_alive'}else{$_.Status -in @('owned_alive','unverified')}})
  if($unexpected.Count){$record.failure=@{type='ProcessIdentityAssertion';message=$message;members=$unexpected}}
  if($controller){$state=$controller.Snapshot;$record.state=$state.State;$record.error=$state.ErrorCode;$record.cleanup=$state.CleanupState;$record.cleanupDiagnostic=Field $controller 'CleanupDiagnostic';$record.currentJobMemberCount=@(Members $controller).Count}
  $record.profileRemoved=($null -eq $profile -or $profile -eq '' -or -not (Test-Path -LiteralPath $profile))
 }catch{$record.failure=@{type=$_.Exception.GetBaseException().GetType().FullName;message=$_.Exception.GetBaseException().Message};$identityObservationFailure=$_}
 $script:memberIdentityProof.Add($record);[IO.File]::WriteAllText($script:memberIdentityEvidencePath,(ConvertTo-Json -Depth 12 -InputObject $script:memberIdentityProof.ToArray()))
 if($script:memberIdentityProof.Count -eq 1){Write-Output ('PROCESS_IDENTITY_EVIDENCE='+$script:memberIdentityEvidencePath)}
 if($record.failure){Write-Output ('PROCESS_IDENTITY_FAILURE='+(ConvertTo-Json -Compress -Depth 12 $record))}
 if($identityObservationFailure){throw $identityObservationFailure}
 foreach($observation in $observations){Assert $(if($Alive){$observation.Status -eq 'owned_alive'}else{$observation.Status -notin @('owned_alive','unverified')}) ($message+' / '+$observation.Pid+' / '+$observation.Status)}
}
function Target($run='22222222-2222-4222-8222-222222222222'){
 $t=New-Object CodexNative.PreviewTarget;$t.InstanceId='11111111-1111-4111-8111-111111111111';$t.RunId=$run;$t.ServiceGeneration=1;$t.WindowGeneration=2;$t.SelectionGeneration=3;return $t
}
$controllers=New-Object 'Collections.Generic.List[System.IDisposable]'
$cleanupRaceExecutable=$null
try {
 Add-Type -Path (Join-Path $PSScriptRoot '../scripts/native/BrowserPreview.cs'),(Join-Path $PSScriptRoot '../scripts/native/CockpitBrowserGuard.cs'),$helperPath -ReferencedAssemblies System.dll,System.Core.dll,System.Net.Http.dll,System.Web.Extensions.dll
 # Inspect both real Edge argument constructions without launching a browser.
 $productionSource=[IO.File]::ReadAllText((Join-Path $PSScriptRoot '../scripts/native/BrowserPreview.cs'))
 $smokeSource=[IO.File]::ReadAllText((Join-Path $PSScriptRoot '../scripts/html-preview-smoke.ps1'))
 $productionArguments=@($productionSource -split [Environment]::NewLine | Where-Object { $_.Contains('string args=fixtureExecutable!=null?fixtureArguments:') })
 $smokeArguments=@($smokeSource -split [Environment]::NewLine | Where-Object { $_.TrimStart().StartsWith('$edgeArguments=') })
 Assert ($productionArguments.Count -eq 1 -and $productionArguments[0].Contains(' --disable-extensions')) 'production Edge arguments must disable extensions'
 Assert ($productionArguments[0].Contains('(Cockpit(t)?"about:blank":Quote("--app="+Url(t)))')) 'Cockpit positional blank and legacy app URL required'
 Assert (-not $productionArguments[0].Contains('--app=about:blank')) 'Cockpit app-mode blank startup forbidden'
 $cockpitFlags=$productionArguments[0].Substring($productionArguments[0].IndexOf('+(Cockpit(t)?'))
 Assert ($cockpitFlags.Contains('Quote("--host-resolver-rules=MAP * ~NOTFOUND")') -and $cockpitFlags.Contains('--force-webrtc-ip-handling-policy=disable_non_proxied_udp') -and $cockpitFlags.Contains(':"")')) 'Cockpit-only DNS and WebRTC flags required'
 Assert ($smokeArguments.Count -eq 1 -and $smokeArguments[0].Contains(' --disable-extensions ')) 'smoke Edge arguments must disable extensions'
 $t=Target
 Assert ([CodexNative.PreviewFixtures]::PresentationValue($t) -eq 0) 'legacy target presentation changed'
 Assert ([CodexNative.PreviewFixtures]::FrameContract()) 'frame contract failed to copy identity or bytes'
 Assert ([CodexNative.PreviewFixtures]::Url($t) -eq 'http://127.0.0.1:4173/preview#v=1&instanceId=11111111-1111-4111-8111-111111111111&runId=22222222-2222-4222-8222-222222222222') 'URL contract'
 foreach($bad in @('ABCDEFAB-1111-4111-8111-111111111111','../../file','22222222-2222-4222-8222-222222222222&extra=1')){
  $invalid=Target $bad;$rejected=$false;try{[CodexNative.PreviewFixtures]::Url($invalid)|Out-Null}catch{$rejected=$true};Assert $rejected 'invalid identity accepted'
 }
 Assert ([CodexNative.PreviewFixtures]::Quote('a b') -eq '"a b"') 'space quoting'
 $exe=Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
 $args='-NoProfile -NonInteractive -WindowStyle Hidden -Command "Start-Sleep -Seconds 60"'
 Assert ([CodexNative.PreviewFixtures]::Gate()) 'approved production guard gate disabled'
 foreach($url in @('http://127.0.0.1:4173/api/capabilities','http://127.0.0.1:4173/preview','ws://127.0.0.1:9222/devtools/browser/fixture','https://example.com/')){Assert (-not [CodexNative.PreviewFixtures]::Allow('trusted','top','GET',$url)) 'browser request escaped deny-all policy'}
 Assert ([CodexNative.PreviewFixtures]::Endpoint("12345`n/devtools/browser/test-123") -eq 'ws://127.0.0.1:12345/devtools/browser/test-123') 'CDP endpoint contract'
 foreach($bad in @("0`n/devtools/browser/x","12345`n//evil.test")){$reject=$false;try{[CodexNative.PreviewFixtures]::Endpoint($bad)|Out-Null}catch{$reject=$true};Assert $reject 'unsafe CDP endpoint accepted'}
 $doc=[CodexNative.PreviewFixtures]::Document('<html><script>window.fixture=1</script></html>');Assert ($doc.IndexOf('Content-Security-Policy') -lt $doc.IndexOf('window.fixture')) 'CSP installed after generated script'
 Assert ($doc.Contains("connect-src 'none'") -and $doc.Contains('RTCPeerConnection')) 'network controls absent'
 # Replay expected and unknown iframe attachments without a browser.
 foreach($paused in @($false,$true)){
  $attach=[CodexNative.PreviewFixtures]::AttachFixture('iframe','expected-iframe','main-frame','main-target','main-session',$true,$paused)
  Assert ($attach.StartsWith('accepted;')) ('expected iframe rejected: '+$attach)
  Assert ($attach.Contains('waitingForDebugger='+$paused) -and $attach.Contains('firstScriptProtection=trusted CSP/Lockdown prefix') -and $attach.Contains('cdpBeforeFirstScript=not asserted')) 'iframe protection diagnostic is misleading'
 }
 foreach($case in @(
  @('iframe','unknown-target','main-frame','main-target','main-session',$true),
  @('iframe','expected-iframe','main-frame','main-target','main-session',$false),
  @('iframe','expected-iframe','unknown-frame','main-target','main-session',$true),
  @('iframe','expected-iframe',$null,'main-target','main-session',$true),
  @('iframe','expected-iframe','main-frame','unknown-target','main-session',$true),
  @('iframe','expected-iframe','main-frame',$null,'main-session',$true),
  @('iframe','expected-iframe','main-frame','main-target','unknown-session',$true),
  @('worker','expected-iframe','main-frame','main-target','main-session',$true)
 )){
  foreach($paused in @($false,$true)){
   $attach=[CodexNative.PreviewFixtures]::AttachFixture($case[0],$case[1],$case[2],$case[3],$case[4],$case[5],$paused)
   Assert ($attach.StartsWith('rejected;')) ('unknown target or parent accepted: '+$attach)
  }
 }
 Assert ($doc.StartsWith([CodexNative.PreviewFixtures]::Document(''))) 'trusted prefix absent before generated script'
 $mount=[CodexNative.PreviewFixtures]::Mount('<html>";throw 1;//</html>');Assert ($mount.Contains('sandbox') -and -not $mount.Contains('allow-same-origin')) 'opaque sandbox absent'
 Assert ($mount.Contains("camera 'none'; microphone 'none'; geolocation 'none'")) 'iframe permissions not disabled'
 $fence=([char]96).ToString()*3;$fixtureHtml='<html><body>fixture</body></html>'
 foreach($sourceText in @($fixtureHtml,('  '+$fixtureHtml+'  '),($fence+'html'+[char]10+$fixtureHtml+[char]10+$fence),('Leading explanation'+[char]10+$fence+'html'+[char]10+$fixtureHtml+[char]10+$fence+[char]10+'Trailing explanation'),('Explanation'+[char]13+[char]10+$fence+'HTML'+[char]13+[char]10+'<!DOCTYPE HTML><HTML><BODY>fixture</BODY></HTML>'+[char]13+[char]10+$fence))) {
  $html=[CodexNative.PreviewFixtures]::Extract($sourceText);Assert ($html.StartsWith('<') -and $html.ToLowerInvariant().EndsWith('</html>')) 'valid unique HTML extraction rejected'
 }
 foreach($sourceText in @('',($fence+'html'+[char]10+$fence),($fence+'javascript'+[char]10+$fixtureHtml+[char]10+$fence),($fence+'html'+[char]10+$fixtureHtml),($fence+'html'+[char]10+$fixtureHtml+[char]10+$fence+[char]10+$fence+'html'+[char]10+$fixtureHtml+[char]10+$fence),($fence+'html'+[char]10+$fence+'html'+[char]10+$fixtureHtml+[char]10+$fence+[char]10+$fence),($fixtureHtml+[char]10+$fence+'html'+[char]10+$fixtureHtml+[char]10+$fence),($fence+'html'+[char]10+$fixtureHtml+[char]10+$fence+[char]10+$fixtureHtml),($fence+'html'+[char]10+'<html><body>incomplete</body>'+[char]10+$fence),'<html><body>incomplete</body>',('<html>'+('x'*131073)+'</html>'),($fixtureHtml+$fixtureHtml))) {
  $rejected=$false;try{[CodexNative.PreviewFixtures]::Extract($sourceText)|Out-Null}catch{$rejected=$true};Assert $rejected 'ambiguous HTML extraction accepted'
 }
 $ct=Target;$ct.Mode='cockpit';$ct.Version='pelican-cockpit-v1'
 foreach($invalid in @('inline-legacy','inline-no-capture','capture-legacy','invalid-enum')) {
  $bad=Target
  if($invalid -ne 'inline-legacy' -and $invalid -ne 'capture-legacy'){$bad.Mode=$ct.Mode;$bad.Version=$ct.Version}
  $presentation=if($invalid -eq 'capture-legacy'){'Detached'}elseif($invalid -eq 'invalid-enum'){'2'}else{'Inline'}
  [CodexNative.PreviewFixtures]::Presentation($bad,$presentation,($invalid -ne 'inline-no-capture'),$null)
  $probe=[CodexNative.PreviewFixtures]::Create((New-Object CodexNative.PreviewFixtureHandler),$exe,$args);$controllers.Add($probe)
  $rejected=$false;try{$null=$probe.SetTargetAsync($bad,[CodexNative.PreviewOpenReason]::ExplicitOpen)}catch{$rejected=$true};Assert ($rejected -and (Field $probe 'job') -eq [IntPtr]::Zero) 'invalid presentation accepted'
 }
 function SourceBody($answer='<html><body>fixture</body></html>') {
  $sha=[Security.Cryptography.SHA256]::Create();try{$digest=([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($answer)))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}
  return @{instanceId=$ct.InstanceId;runId=$ct.RunId;caseSetVersion='pelican-cockpit-v1';rubricVersion='pelican-cockpit-v1';caseId='pelican-cockpit';previewState='ready';status='completed';caseStatus='completed';answer=$answer;contentDigest=$digest}
 }
 $cg=[CodexNative.PreviewFixtures]::Create((New-Object CodexNative.PreviewFixtureHandler),$exe,$args);$controllers.Add($cg);$cs=Await ($cg.SetTargetAsync($ct,[CodexNative.PreviewOpenReason]::ExplicitOpen));Assert ($cs.State -eq 'error' -and $cs.ErrorCode -eq 'capability_missing') 'Cockpit accepted old capability'
 # A missing executable proves the real enabled gate reaches Launch without starting a browser.
 $ch=New-Object CodexNative.PreviewFixtureHandler;$ch.Cockpit=$true;$ch.SourceJson=ConvertTo-Json -Compress (SourceBody);$cg2=[CodexNative.PreviewFixtures]::Create($ch,(Join-Path $fixtureRoot 'missing-cockpit.exe'),$args);$controllers.Add($cg2);$cs2=Await ($cg2.SetTargetAsync($ct,[CodexNative.PreviewOpenReason]::ExplicitOpen));Assert ($cs2.State -eq 'error' -and $cs2.ErrorCode -eq 'launch_failed') 'enabled production gate did not reach launch'
 Assert ($cs2.CleanupState -eq 'cleaned' -and (Members $cg2).Length -eq 0 -and (Field $cg2 'job') -eq [IntPtr]::Zero -and $null -eq (Field $cg2 'directory')) 'enabled gate launch failure retained resources'

 # Source contract: deterministic fixtures, no Edge or model calls.
 $sh=New-Object CodexNative.PreviewFixtureHandler;$sc=[CodexNative.PreviewFixtures]::Create($sh,$exe,$args);$controllers.Add($sc)
 $body=SourceBody;$sh.SourceJson=ConvertTo-Json -Compress $body
 Assert ((Await ([CodexNative.PreviewFixtures]::Source($sc,$ct))) -ceq $body.answer) 'valid source rejected'
 $leading='The animation is below.'+[char]10+$fence+'html'+[char]10+$fixtureHtml+[char]10+$fence
 $body=SourceBody $leading;$sh.SourceJson=ConvertTo-Json -Compress $body
 Assert ((Await ([CodexNative.PreviewFixtures]::Source($sc,$ct))) -ceq $fixtureHtml) 'leading prose regression still fails'
 [CodexNative.PreviewFixtures]::Presentation($ct,'Detached',$false,$body.contentDigest)
 Assert ((Await ([CodexNative.PreviewFixtures]::Source($sc,$ct))) -ceq $fixtureHtml) 'valid target digest rejected'
 [CodexNative.PreviewFixtures]::Presentation($ct,'Detached',$false,('0'*64));$rejected=$false;try{$null=Await ([CodexNative.PreviewFixtures]::Source($sc,$ct))}catch{$rejected=$true};Assert $rejected 'target digest mismatch accepted'
 [CodexNative.PreviewFixtures]::Presentation($ct,'Detached',$false,$null)
 foreach($mutation in @('instanceId','runId','caseSetVersion','rubricVersion','caseId','contentDigest','previewState','status','caseStatus','oversized','responseOversized')){
  $body=SourceBody
  if($mutation -eq 'oversized'){$body=SourceBody ('<html>'+('x'*131073)+'</html>')}
  elseif($mutation -eq 'responseOversized'){$body.extra='x'*1048577}
  elseif($mutation -eq 'previewState'){$body[$mutation]='pending'}
  else{$body[$mutation]='wrong'}
  $sh.SourceJson=ConvertTo-Json -Compress $body;$rejected=$false
  try{$null=Await ([CodexNative.PreviewFixtures]::Source($sc,$ct))}catch{$rejected=$true}
  Assert $rejected ('invalid source accepted: '+$mutation)
 }
 foreach($scenario in @('unavailable','identity','digest','html','targetDigest')) {
  $h=New-Object CodexNative.PreviewFixtureHandler;$h.Cockpit=$true;$body=SourceBody;$sourceTarget=Target;$sourceTarget.Mode=$ct.Mode;$sourceTarget.Version=$ct.Version
  if($scenario -eq 'identity'){$body.runId='wrong'}elseif($scenario -eq 'digest'){$body.contentDigest='wrong'}elseif($scenario -eq 'html'){$body=SourceBody 'explanation without document'}elseif($scenario -eq 'targetDigest'){[CodexNative.PreviewFixtures]::Presentation($sourceTarget,'Detached',$false,('0'*64))}
  $h.SourceJson=if($scenario -eq 'unavailable'){'{broken'}else{ConvertTo-Json -Compress $body}
  $noLaunch=[CodexNative.PreviewFixtures]::Create($h,(Join-Path $fixtureRoot 'source-must-not-launch.exe'),$args);$controllers.Add($noLaunch);$r=Await ($noLaunch.SetTargetAsync($sourceTarget,[CodexNative.PreviewOpenReason]::ExplicitOpen))
  $expected=@{unavailable='source_unavailable';identity='source_identity_mismatch';digest='source_digest_mismatch';html='source_html_ambiguous';targetDigest='source_digest_mismatch'}[$scenario]
  Assert ($r.State -eq 'error' -and $r.ErrorCode -eq $expected -and $r.CleanupState -eq 'not_started') ('wrong early source failure: '+$scenario)
  Assert ((Field $noLaunch 'job') -eq [IntPtr]::Zero -and $null -eq (Field $noLaunch 'directory')) 'source failure created owned resources'
 }
 $jpeg=[Convert]::ToBase64String([byte[]]@(255,216,255,217));$capture=Await ([CodexNative.PreviewFixtures]::CaptureBytes($jpeg));Assert ($capture.Length -eq 4 -and $capture[0] -eq 255) 'capture fixture failed'
 foreach($data in @('', 'not-base64',([Convert]::ToBase64String([byte[]]@(1,2,3,4))),([Convert]::ToBase64String((New-Object byte[] 1048577))))) {
  $rejected=$false;try{$null=Await ([CodexNative.PreviewFixtures]::CaptureBytes($data))}catch{$rejected=$true};Assert $rejected 'invalid or oversized capture accepted'
 }
 $timeout=Await ([CodexNative.PreviewFixtures]::CaptureTimeout());Assert ($timeout -match 'failed=True;killed=1') 'capture timeout did not revoke once';$elapsed=[int]([regex]::Match($timeout,'elapsed=(\d+)').Groups[1].Value);Assert ($elapsed -ge 1300 -and $elapsed -lt 4000) 'capture deadline exceeded 1500ms budget'
 Assert (Await ([CodexNative.PreviewFixtures]::NormalCommandBudget())) 'normal CDP command incorrectly uses screenshot budget'
 $captureGeometryHarness=@'
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const expression = fs.readFileSync(process.argv[2], 'utf8');
let checks = 0;
function verify(actual, expected, label) { checks++; assert.equal(actual, expected, label); }
function geometry(options = {}) {
  const vw = options.vw ?? 961.4678955078125, vh = options.vh ?? 600;
  const rootWidth = options.rootWidth ?? vw, rootHeight = options.rootHeight ?? 170.58485412597656;
  const bodyRight = options.bodyRight ?? vw - 7.9988532066345215;
  const bodyBottom = options.bodyBottom ?? 162.58601140975952;
  const style = {
    transform: 'none', zoom: '1', writingMode: 'horizontal-tb', cssFloat: 'none', position: 'static',
    rotate: 'none', scale: 'none', translate: 'none', boxSizing: 'content-box',
    marginLeft: '0px', marginRight: '0px', marginTop: '0px', marginBottom: '0px',
    paddingLeft: '0px', paddingRight: '0px', paddingTop: '0px', paddingBottom: '0px',
    borderLeftWidth: '0px', borderRightWidth: '0px', borderTopWidth: '0px', borderBottomWidth: '0px',
    ...(options.style || {}),
  };
  const typed = {width: 'auto', height: 'auto', 'min-width': 'auto', 'max-width': 'none', 'min-height': 'auto', 'max-height': 'none', ...(options.typed || {})};
  const root = {
    clientWidth: Math.round(vw), clientHeight: Math.round(vh),
    scrollWidth: options.rootScrollWidth ?? Math.round(vw), scrollHeight: options.rootScrollHeight ?? Math.round(vh),
    getBoundingClientRect: () => ({left: 0, top: 0, right: rootWidth, bottom: rootHeight, width: rootWidth, height: rootHeight}),
    computedStyleMap: () => ({get: key => typed[key]}),
  };
  const body = {
    clientWidth: Math.round(bodyRight - (options.bodyLeft ?? 8)), clientHeight: Math.round(bodyBottom - (options.bodyTop ?? 8)),
    scrollWidth: options.bodyScrollWidth ?? Math.round(bodyRight - (options.bodyLeft ?? 8)), scrollHeight: options.bodyScrollHeight ?? Math.round(bodyBottom - (options.bodyTop ?? 8)),
    getBoundingClientRect: () => ({left: options.bodyLeft ?? 8, top: options.bodyTop ?? 8, right: bodyRight, bottom: bodyBottom, width: bodyRight - (options.bodyLeft ?? 8), height: bodyBottom - (options.bodyTop ?? 8)}),
  };
  if (options.noTyped) delete root.computedStyleMap;
  return vm.runInNewContext(expression, {document: {documentElement: root, body}, getComputedStyle: () => style});
}
for (const vw of [960, 961.4678955078125, 962.38531494140625, 963.302734375]) {
  const measured = geometry({vw});
  verify(measured.viewportWidth, vw, 'root auto exact viewport baseline');
  verify(measured.width, vw, 'root viewport tail is not overflow');
  const full = geometry({vw, rootHeight: 600.459, vh: 600.459, bodyLeft: 0, bodyTop: 0, bodyRight: vw, bodyBottom: 600.459, typed: {width: '100%', height: '100%'}});
  verify(full.width, vw, 'margin-zero 100% body viewport width');
  verify(full.height, 600.459, 'margin-zero 100% body viewport height');
  for (const delta of [.125, 1]) {
    verify(geometry({vw, bodyRight: vw + delta}).width, vw + delta, 'positive fractional/integer body overflow');
    verify(geometry({vw, rootHeight: 600 + delta}).height, 600 + delta, 'positive fractional/integer root height');
    const explicit = geometry({vw, rootWidth: Math.round(vw) + delta, typed: {width: (Math.round(vw) + delta) + 'px'}});
    verify(explicit.viewportWidth, Math.round(vw), 'explicit root width cannot become viewport baseline');
    verify(explicit.width, Math.round(vw) + delta, 'positive explicit root overflow');
  }
}
verify(geometry({rootHeight: 723.109375, bodyBottom: 694.3125}).height, 723.109375, 'pelican footer/button height');
verify(geometry({rootScrollWidth: 962}).width, 962, 'positive scroll overflow retained');
verify(geometry({bodyScrollWidth: 1100}).width, 1100, 'positive body scroll overflow retained');
verify(geometry({rootWidth: 945.4678955078125, style: {marginLeft: '8px', marginRight: '8px'}}).viewportWidth, 961.4678955078125, 'root auto margins included in viewport baseline');
verify(geometry({typed: {'min-width': '961.125px'}}).viewportWidth, 961, 'min-width constraint not accepted as viewport');
verify(geometry({rootWidth: 961.125, typed: {'min-width': '961.125px'}}).width, 961.125, 'constrained fractional root overflow retained');
verify(geometry({bodyLeft: 0, bodyTop: 0, bodyRight: 961.4678955078125, bodyBottom: 600.125}).height, 600.125, 'margin-zero body min-height viewport overflow retained');
verify(geometry({typed: {'max-width': '961.125px'}}).viewportWidth, 961, 'max-width constraint not accepted as viewport');
verify(geometry({style: {transform: 'scale(1.01)'}}).viewportWidth, 961, 'root transform not accepted as viewport');
verify(geometry({style: {zoom: '1.1'}}).viewportWidth, 961, 'root CSS zoom not accepted as viewport');
verify(geometry({noTyped: true}).viewportWidth, 961, 'missing Typed OM does not hide overflow');
verify(geometry({noTyped: true, rootWidth: 961.125}).width, 961.125, 'missing Typed OM positive fractional root overflow retained');
console.log('CAPTURE_GEOMETRY_JS_FIXTURES=' + checks);
'@
 $captureGeometryPath=Join-Path $fixtureRoot 'CaptureGeometry.cjs';$captureMeasurePath=Join-Path $fixtureRoot 'CaptureMeasure.js';[IO.File]::WriteAllText($captureGeometryPath,$captureGeometryHarness);[IO.File]::WriteAllText($captureMeasurePath,[CodexNative.PreviewFixtures]::CaptureMeasureExpression());& node $captureGeometryPath $captureMeasurePath;Assert ($LASTEXITCODE -eq 0) 'capture geometry expression regression failed'
 $captureFitChecks=Await ([CodexNative.PreviewFixtures]::CaptureFitFixtures());$captureViewportChecks=Await ([CodexNative.PreviewFixtures]::CaptureViewportFixtures());Assert ($captureFitChecks -ge 137 -and $captureViewportChecks -ge 50) 'capture content fit coverage incomplete';Write-Output ('CAPTURE_FIT_FIXTURES='+$captureFitChecks);Write-Output ('CAPTURE_VIEWPORT_FIXTURES='+$captureViewportChecks)
 $securityChecks=Await ([CodexNative.PreviewFixtures]::SecurityFixtures());Assert ($securityChecks -ge 50) 'security fixture checks incomplete';Write-Output ('INPUT_SECURITY_FIXTURES='+$securityChecks)
 Assert ([CodexNative.PreviewFixtures]::TargetInventoryFixture()) 'target audit exposed URLs or accepted unknown tab/worker'
 Assert ([CodexNative.PreviewFixtures]::ProcessIdentityFixture()) 'process cleanup identity accepted owned live/unverified process or rejected PID reuse'
 $pairTimeout=Await ([CodexNative.PreviewFixtures]::InputPairTimeout());Assert ($pairTimeout -match 'failed=True;killed=1;calls=2') 'input pair timeout did not revoke once';$pairElapsed=[int]([regex]::Match($pairTimeout,'elapsed=(\d+)').Groups[1].Value);Assert ($pairElapsed -ge 1300 -and $pairElapsed -lt 3500) 'input commands each received an independent deadline'
 # Fixed input requires the exact published Inline frame and keeps a single slot.
 foreach($publish in @($false,$true)) {
  $input=[CodexNative.PreviewFixtures]::Create((New-Object CodexNative.PreviewFixtureHandler),$exe,$args);$controllers.Add($input);$null=Await ($input.SetTargetAsync((Target),[CodexNative.PreviewOpenReason]::ExplicitOpen));$inputDir=Field $input 'directory';$inputJob=Field $input 'job';$fixture=New-Object CodexNative.PreviewInputFixture $input,$publish
  try {
   if(-not $publish){Assert (-not (Await ($fixture.Click($fixture.Target,$fixture.Operation,25,25)))) 'input accepted before first frame';continue}
   foreach($field in @('InstanceId','RunId','Mode','Version','ServiceGeneration','WindowGeneration','SelectionGeneration','Presentation','CaptureFrames','ContentDigest')){$bad=$fixture.CopyTarget();[CodexNative.PreviewFixtures]::MutateTarget($bad,$field);Assert (-not (Await ($fixture.Click($bad,$fixture.Operation,25,25)))) ('mismatched shown identity accepted: '+$field)}
   foreach($xy in @(@(-1,25),@(960,25),@(25,-1),@(25,600),@([double]::NaN,25),@([double]::PositiveInfinity,25),@(25,[double]::NaN),@(25,[double]::NegativeInfinity))){Assert (-not (Await ($fixture.Click($fixture.Target,$fixture.Operation,[double]$xy[0],[double]$xy[1])))) 'invalid coordinate accepted'}
   Assert (-not (Await ($fixture.Click($null,$fixture.Operation,25,25)))) 'null shown target accepted';Assert (-not (Await ($fixture.Click($fixture.Target,$fixture.Operation-1,25,25)))) 'old operation accepted'
   foreach($state in @('starting','error','closed')){$fixture.State($state);Assert (-not (Await ($fixture.Click($fixture.Target,$fixture.Operation,25,25)))) ('input accepted in '+$state)};$fixture.State('open')
   $fixture.Ready($false);Assert (-not (Await ($fixture.Click($fixture.Target,$fixture.Operation,25,25)))) 'unprotected guard accepted input';$fixture.Ready($true)
   foreach($source in @('desired','current','snapshot','publishedFrameTarget')){$fixture.LiveIdentity($source,$false);Assert (-not (Await ($fixture.Click($fixture.Target,$fixture.Operation,25,25)))) ('mismatched live identity accepted: '+$source);$fixture.LiveIdentity($source,$true)}
   $fixture.HoldCapture=$true;$fixture.BeginCapture();Assert ($fixture.CaptureEntered.Wait(10000)) 'input queue capture barrier unavailable';$shown=$fixture.CopyTarget();$accepted=$fixture.Click($shown,$fixture.Operation,95.5,55.25);$shown.RunId='33333333-3333-4333-8333-333333333333';Assert (-not $accepted.IsCompleted) 'queued click was not retained'
   for($i=0;$i -lt 100;$i++){Assert (-not (Await ($fixture.Click($fixture.Target,$fixture.Operation,25,25)))) 'busy input queue accepted a second request'}
   $fixture.ReleaseCapture();Assert (Await $accepted) 'valid fixed click pair did not complete';$inputRecords=@($fixture.Records|ForEach-Object{$_|ConvertFrom-Json}|Where-Object{$_.method -eq 'Input.dispatchMouseEvent'})
   Assert ($inputRecords.Count -eq 2 -and $inputRecords[0].args.type -eq 'mousePressed' -and $inputRecords[1].args.type -eq 'mouseReleased') 'input did not send the fixed pair'
   foreach($record in $inputRecords){Assert ($record.session -eq 'main-session' -and $record.args.x -eq 95.5 -and $record.args.y -eq 55.25 -and $record.args.button -eq 'left' -and $record.args.clickCount -eq 1) 'fixed click args or owned main session changed'}
   Assert ($inputRecords[0].args.buttons -eq 1 -and $inputRecords[1].args.buttons -eq 0 -and $fixture.MaxActive -eq 1 -and $fixture.Captures -ge 1) 'capture/input overlapped or button state invalid'
   Assert ($input.Snapshot.OperationGeneration -eq $fixture.Operation -and (Field $input 'job') -eq $inputJob -and (Field $input 'directory') -eq $inputDir) 'input reopened or changed generation'
  } finally {$fixture.ReleaseCapture();$fixture.ReleasePress();$null=Await ($input.StopAsync('input-fixture-finally'));$fixture.Dispose();$input.Dispose()}
 }
 # Lifecycle changes revoke queued input and terminate the old Job after a press.
 foreach($stage in @('queued','pressed')){foreach($operation in @('stop','target','dispose')){
  $input=[CodexNative.PreviewFixtures]::Create((New-Object CodexNative.PreviewFixtureHandler),$exe,$args);$controllers.Add($input);$null=Await ($input.SetTargetAsync((Target),[CodexNative.PreviewOpenReason]::ExplicitOpen));$oldInputDir=Field $input 'directory';$oldInputMembers=@(Members $input);$oldInputIdentities=@(MemberIdentities $oldInputMembers);$fixture=New-Object CodexNative.PreviewInputFixture $input,$true
  try {
   if($stage -eq 'queued'){$fixture.HoldCapture=$true;$fixture.BeginCapture();Assert ($fixture.CaptureEntered.Wait(10000)) 'queued input capture barrier unavailable'}else{$fixture.HoldPress=$true}
   $accepted=$fixture.Click($fixture.Target,$fixture.Operation,25,25);if($stage -eq 'pressed'){Assert ($fixture.PressEntered.Wait(10000)) 'input press barrier unavailable'}
   if($operation -eq 'dispose'){$latest=[CodexNative.PreviewFixtures]::DisposeAsync($input)}elseif($operation -eq 'target'){$latest=$input.SetTargetAsync((Target '33333333-3333-4333-8333-333333333333'),[CodexNative.PreviewOpenReason]::ExplicitOpen)}else{$latest=$input.StopAsync('input-lifecycle')}
   Assert (-not (Await $accepted)) 'lifecycle change completed stale input true';$fixture.ReleaseCapture();$fixture.ReleasePress();$r=Await $latest
   $inputRecords=@($fixture.Records|ForEach-Object{$_|ConvertFrom-Json}|Where-Object{$_.method -eq 'Input.dispatchMouseEvent'});Assert ($inputRecords.Count -eq $(if($stage -eq 'queued'){0}else{1}) -and @($inputRecords|Where-Object{$_.args.type -eq 'mouseReleased'}).Count -eq 0) 'revoked input sent release or queued press'
   Assert (-not (Test-Path -LiteralPath $oldInputDir)) ('input lifecycle retained profile: '+$stage+'/'+$operation);AssertMemberIdentities $oldInputIdentities 'input lifecycle retained old Job member' $input $oldInputDir
   if($operation -eq 'target'){Assert ($r.State -eq 'open' -and $r.OperationGeneration -eq 2 -and @((Members $input)).Count -gt 0) 'input cancellation corrupted replacement Job'}else{Assert ((Field $input 'job') -eq [IntPtr]::Zero) 'input stop/dispose retained Job handle'}
  } finally {$fixture.ReleaseCapture();$fixture.ReleasePress();$null=Await ($input.StopAsync('input-lifecycle-finally'));$fixture.Dispose();$input.Dispose()}
 }}
 foreach($late in @($false,$true)){
  $input=[CodexNative.PreviewFixtures]::Create((New-Object CodexNative.PreviewFixtureHandler),$exe,$args);$controllers.Add($input);$null=Await ($input.SetTargetAsync((Target),[CodexNative.PreviewOpenReason]::ExplicitOpen));$oldInputDir=Field $input 'directory';$oldInputMembers=@(Members $input);$oldInputIdentities=@(MemberIdentities $oldInputMembers);$fixture=New-Object CodexNative.PreviewInputFixture $input,$true;$fixture.FailPress=$true;$barrier=if($late){New-Object CodexNative.PreviewInputFailureBarrier $input}else{$null}
  try {
   $accepted=$fixture.Click($fixture.Target,$fixture.Operation,25,25)
   if($late){Assert ($barrier.Entered.Wait(10000)) 'late input failure barrier unavailable';$latest=$input.SetTargetAsync((Target '33333333-3333-4333-8333-333333333333'),[CodexNative.PreviewOpenReason]::ExplicitOpen);$barrier.Release.Set();$r=Await $latest;Assert ($r.State -eq 'open' -and $r.OperationGeneration -eq 2 -and $null -eq $r.ErrorCode) 'old input catch suppressed new intent';$r=Await ($input.SetTargetAsync((Target '33333333-3333-4333-8333-333333333333'),[CodexNative.PreviewOpenReason]::FollowSelection));Assert ($r.State -eq 'open') 'old input catch cleared new intent'}else{$watch=[Diagnostics.Stopwatch]::StartNew();while($input.Snapshot.State -ne 'error' -and $watch.ElapsedMilliseconds -lt 8000){Start-Sleep -Milliseconds 25};Assert ($input.Snapshot.State -eq 'error' -and $input.Snapshot.ErrorCode -eq 'preview_input_failed' -and $input.Snapshot.CleanupState -eq 'cleaned') 'current input error was not reported';$r=Await ($input.SetTargetAsync((Target),[CodexNative.PreviewOpenReason]::FollowSelection));Assert ($r.State -eq 'closed') 'input error auto reopened on follow'}
   Assert (-not (Await $accepted)) 'failed input completed true';Assert (-not (Test-Path -LiteralPath $oldInputDir)) 'input failure retained old profile';AssertMemberIdentities $oldInputIdentities 'input failure retained old process' $input $oldInputDir
  } finally {if($barrier){$barrier.Dispose()};$null=Await ($input.StopAsync('input-failure-finally'));$fixture.Dispose();$input.Dispose()}
 }
 # A Ready security event may arrive after Click returned; an old Observe must not clear newer intent.
 foreach($operation in @('current','target','stop')) {
  $observeRace=[CodexNative.PreviewFixtures]::Create((New-Object CodexNative.PreviewFixtureHandler),$exe,$args);$controllers.Add($observeRace);$null=Await ($observeRace.SetTargetAsync((Target),[CodexNative.PreviewOpenReason]::ExplicitOpen));$observeDir=Field $observeRace 'directory';$observeMembers=@(Members $observeRace);$observeIdentities=@(MemberIdentities $observeMembers);$observeFixture=New-Object CodexNative.PreviewInputFixture $observeRace,$true;$observeBarrier=if($operation -eq 'current'){$null}else{New-Object CodexNative.PreviewGuardFailureBarrier $observeRace}
  try {
   $observeFixture.RejectInteraction()
   if($operation -eq 'current') {
    $watch=[Diagnostics.Stopwatch]::StartNew();while($observeRace.Snapshot.State -ne 'error' -and $watch.ElapsedMilliseconds -lt 8000){Start-Sleep -Milliseconds 25};$r=$observeRace.Snapshot
    Assert ($r.State -eq 'error' -and $r.ErrorCode -eq 'preview_input_failed' -and $r.CleanupState -eq 'cleaned') 'late Ready security event did not report input failure'
    $r=Await ($observeRace.SetTargetAsync((Target),[CodexNative.PreviewOpenReason]::FollowSelection));Assert ($r.State -eq 'closed') 'Ready security rejection reopened on follow'
   } else {
    Assert ($observeBarrier.Entered.Wait(10000)) 'guard Observe did not reach intent barrier'
    if($operation -eq 'target'){$latest=$observeRace.SetTargetAsync((Target '33333333-3333-4333-8333-333333333333'),[CodexNative.PreviewOpenReason]::ExplicitOpen)}else{$latest=$observeRace.StopAsync('guard-observe-race')}
    $observeBarrier.Release.Set();$r=Await $latest
    Assert ($r.OperationGeneration -eq 2 -and $r.State -eq $(if($operation -eq 'target'){'open'}else{'closed'}) -and $null -eq $r.ErrorCode) ('old guard Observe suppressed newer intent: '+$operation)
    if($operation -eq 'target') {
     $observeNewMembers=@(Members $observeRace);$observeNewIdentities=@(MemberIdentities $observeNewMembers);Assert ($observeNewMembers.Count -gt 0) 'old guard Observe killed replacement Job'
     $r=Await ($observeRace.SetTargetAsync((Target '33333333-3333-4333-8333-333333333333'),[CodexNative.PreviewOpenReason]::FollowSelection));Assert ($r.State -eq 'open') 'old guard Observe cleared newer follow intent'
     AssertMemberIdentities $observeNewIdentities 'late guard failure killed new Job member' $observeRace $null -Alive
    }else{Assert ((Field $observeRace 'job') -eq [IntPtr]::Zero) 'guard Observe Stop retained Job handle'}
   }
   Assert (-not (Test-Path -LiteralPath $observeDir)) 'guard Observe retained old profile';AssertMemberIdentities $observeIdentities 'guard Observe retained old Job member' $observeRace $observeDir
  } finally {if($observeBarrier){$observeBarrier.Dispose()};$null=Await ($observeRace.StopAsync('guard-observe-finally'));$observeFixture.Dispose();$observeRace.Dispose()}
 }
 $blockedHandler=New-Object CodexNative.PreviewFixtureHandler;$blockedHandler.Cockpit=$true;$blockedHandler.SourceJson=ConvertTo-Json -Compress (SourceBody);$blockedHandler.BlockSource=$true
 $blockedSource=[CodexNative.PreviewFixtures]::Create($blockedHandler,(Join-Path $fixtureRoot 'source-barrier-must-not-launch.exe'),$args);$controllers.Add($blockedSource)
 try{$stale=$blockedSource.SetTargetAsync($ct,[CodexNative.PreviewOpenReason]::ExplicitOpen);Assert ($blockedHandler.SourceEntered.Wait(10000)) 'source did not reach barrier';$latest=$blockedSource.StopAsync('source-barrier');$blockedHandler.SourceRelease.Set();$null=Await $stale;$r=Await $latest;Assert ($r.State -eq 'closed' -and $r.OperationGeneration -eq 2 -and $null -eq (Field $blockedSource 'directory') -and (Field $blockedSource 'job') -eq [IntPtr]::Zero) 'late source launched after Stop'}finally{$blockedHandler.SourceRelease.Set();$null=Await ($blockedSource.StopAsync('source-barrier-finally'));$blockedSource.Dispose()}
 foreach($scenario in @('malformed','oversized','timeout')) {
  $captureFailure=[CodexNative.PreviewFixtures]::Create((New-Object CodexNative.PreviewFixtureHandler),$exe,$args);$controllers.Add($captureFailure);$null=Await ($captureFailure.SetTargetAsync((Target),[CodexNative.PreviewOpenReason]::ExplicitOpen));$captureDir=Field $captureFailure 'directory';$captureMembers=@(Members $captureFailure);$captureIdentities=@(MemberIdentities $captureMembers)
  [CodexNative.PreviewFixtures]::InstallBadCapture($captureFailure,$scenario);$watch=[Diagnostics.Stopwatch]::StartNew();while($captureFailure.Snapshot.State -ne 'error' -and $watch.ElapsedMilliseconds -lt 8000){Start-Sleep -Milliseconds 25}
  Assert ($captureFailure.Snapshot.State -eq 'error' -and $captureFailure.Snapshot.ErrorCode -eq 'preview_capture_failed') ('capture failure has wrong error: '+$scenario)
  Assert ($captureFailure.Snapshot.CleanupState -eq 'cleaned' -and -not (Test-Path -LiteralPath $captureDir)) ('capture failure retained profile: '+$scenario)
  AssertMemberIdentities $captureIdentities 'capture failure retained owned process' $captureFailure $captureDir
  $r=Await ($captureFailure.SetTargetAsync((Target),[CodexNative.PreviewOpenReason]::FollowSelection));Assert ($r.State -eq 'closed') 'capture failure reopened on polling'
 }
 foreach($operation in @('stop','target')) {
  $captureRace=[CodexNative.PreviewFixtures]::Create((New-Object CodexNative.PreviewFixtureHandler),$exe,$args);$controllers.Add($captureRace);$null=Await ($captureRace.SetTargetAsync((Target),[CodexNative.PreviewOpenReason]::ExplicitOpen));$oldCaptureDir=Field $captureRace 'directory';$oldCaptureMembers=@(Members $captureRace);$oldCaptureIdentities=@(MemberIdentities $oldCaptureMembers);$sink=New-Object CodexNative.PreviewFrameSink $captureRace;$captureBarrier=New-Object CodexNative.PreviewCaptureBarrier $captureRace
  try{Assert ($captureBarrier.Entered.Wait(10000)) 'worker capture did not reach barrier';if($operation -eq 'stop'){$latest=$captureRace.StopAsync('capture-race')}else{$latest=$captureRace.SetTargetAsync((Target '33333333-3333-4333-8333-333333333333'),[CodexNative.PreviewOpenReason]::ExplicitOpen)};$captureBarrier.Release();$r=Await $latest;Assert ($sink.Count -eq 0 -and $captureBarrier.MaxActive -eq 1 -and $captureBarrier.Calls -eq 1) 'late frame emitted or capture requests overlapped';Assert (-not (Test-Path -LiteralPath $oldCaptureDir)) 'capture race retained old directory';AssertMemberIdentities $oldCaptureIdentities 'capture race retained old process' $captureRace $oldCaptureDir;Assert ($r.OperationGeneration -eq 2 -and $r.State -eq $(if($operation -eq 'stop'){'closed'}else{'open'})) 'capture race corrupted latest state'}finally{$captureBarrier.Dispose();$sink.Dispose();$null=Await ($captureRace.StopAsync('capture-race-finally'));$captureRace.Dispose()}
 }
 # A late capture failure must not suppress a newer explicit-open intent.
 foreach($operation in @('target','stop')) {
  $failureRace=[CodexNative.PreviewFixtures]::Create((New-Object CodexNative.PreviewFixtureHandler),$exe,$args);$controllers.Add($failureRace);$null=Await ($failureRace.SetTargetAsync((Target),[CodexNative.PreviewOpenReason]::ExplicitOpen));$failureDir=Field $failureRace 'directory';$failureMembers=@(Members $failureRace);$failureIdentities=@(MemberIdentities $failureMembers);$failureSink=New-Object CodexNative.PreviewFrameSink $failureRace;$failureBarrier=New-Object CodexNative.PreviewCaptureFailureBarrier $failureRace
  try {
   Assert ($failureBarrier.Entered.Wait(10000)) 'capture failure did not reach intent barrier'
   if($operation -eq 'target'){$latest=$failureRace.SetTargetAsync((Target '33333333-3333-4333-8333-333333333333'),[CodexNative.PreviewOpenReason]::ExplicitOpen)}else{$latest=$failureRace.StopAsync('capture-failure-race')}
   $failureBarrier.Release.Set();$r=Await $latest
   Assert ($r.OperationGeneration -eq 2 -and $r.State -eq $(if($operation -eq 'target'){'open'}else{'closed'})) ('late capture failure suppressed newer intent: '+$operation+';generation='+$r.OperationGeneration+';state='+$r.State)
   Assert ($failureSink.Count -eq 0 -and -not (Test-Path -LiteralPath $failureDir)) 'late capture failure emitted a frame or retained old profile'
   AssertMemberIdentities $failureIdentities 'late capture failure retained owned process' $failureRace $failureDir
   if($operation -eq 'target'){$r=Await ($failureRace.SetTargetAsync((Target '33333333-3333-4333-8333-333333333333'),[CodexNative.PreviewOpenReason]::FollowSelection));Assert ($r.State -eq 'open') 'late capture failure lost new intent on polling'}
  } finally {$failureBarrier.Dispose();$failureSink.Dispose();$null=Await ($failureRace.StopAsync('capture-failure-race-finally'));$failureRace.Dispose()}
 }
 # Native TCP listener ownership accepts only loopback PID members.
 $listener=New-Object Net.Sockets.TcpListener ([Net.IPAddress]::Loopback),0;$listener.Start()
 try{$uri='ws://127.0.0.1:'+ $listener.LocalEndpoint.Port +'/devtools/browser/test';[CodexNative.PreviewFixtures]::Owner($uri,[uint32[]]@($PID));$rejected=$false;try{[CodexNative.PreviewFixtures]::Owner($uri,[uint32[]]@(0))}catch{$rejected=$true};Assert $rejected 'foreign listener accepted'}finally{$listener.Stop()}
 $rejected=$false;try{[CodexNative.PreviewFixtures]::Owner($uri,[uint32[]]@($PID))}catch{$rejected=$true};Assert $rejected 'absent listener accepted'
 foreach($single in @('pelican-cockpit-v1','cockpit-preview-source-v1')){
  $h=New-Object CodexNative.PreviewFixtureHandler;$h.CapabilityJson=ConvertTo-Json -Compress @{product='codex-companion';protocolVersion=1;instanceId=$ct.InstanceId;capabilities=@($single)}
  $one=[CodexNative.PreviewFixtures]::Create($h,$exe,$args);$controllers.Add($one);$r=Await ($one.SetTargetAsync($ct,[CodexNative.PreviewOpenReason]::ExplicitOpen));Assert ($r.ErrorCode -eq 'capability_missing' -and (Members $one).Length -eq 0) 'single Cockpit capability launched'
 }

 $revoked=[CodexNative.PreviewFixtures]::Create((New-Object CodexNative.PreviewFixtureHandler),$exe,$args);$controllers.Add($revoked)
 $null=Await ($revoked.SetTargetAsync((Target),[CodexNative.PreviewOpenReason]::ExplicitOpen));$revokedDir=Field $revoked 'directory'
 [CodexNative.PreviewFixtures]::InstallRevocationFixture($revoked);[CodexNative.PreviewFixtures]::Revoke($revoked)
 $watch=[Diagnostics.Stopwatch]::StartNew();while($revoked.Snapshot.State -ne 'error' -and $watch.ElapsedMilliseconds -lt 8000){Start-Sleep -Milliseconds 25}
 Assert ($revoked.Snapshot.State -eq 'error' -and $revoked.Snapshot.ErrorCode -eq 'guard_environment_unavailable') 'guard failure reported ordinary closure'
 Assert ($revoked.Snapshot.CleanupState -eq 'cleaned' -and -not (Test-Path -LiteralPath $revokedDir)) 'guard failure did not clean up'
 $r=Await ($revoked.SetTargetAsync((Target),[CodexNative.PreviewOpenReason]::FollowSelection));Assert ($r.State -eq 'closed') 'revoked guard auto reopened'
 if($ProductionEdge){
  if(-not $ProductionSecurityOnly){
  $eh=New-Object CodexNative.PreviewFixtureHandler;$eh.Cockpit=$true
  $html='<html><body><svg><circle id="dot" r="20" cy="40" cx="40"/></svg><button id="toggle" style="position:fixed;left:20px;top:100px;width:180px;height:70px" onclick="globalThis.fixturePaused=!globalThis.fixturePaused;this.textContent=globalThis.fixturePaused?&quot;Resume&quot;:&quot;Pause&quot;">Pause</button><script>globalThis.fixtureErrors=[];globalThis.fixtureStarted=true;globalThis.fixturePaused=false;globalThis.fixtureTicks=0;addEventListener("error",()=>fixtureErrors.push("script"));addEventListener("unhandledrejection",()=>fixtureErrors.push("promise"));let n=0;function tick(){if(!globalThis.fixturePaused){globalThis.fixtureTicks=++n;document.getElementById("dot").setAttribute("cx",40+(n%100))}requestAnimationFrame(tick)}tick()</script></body></html>'
  $eh.SourceJson=ConvertTo-Json -Compress (SourceBody $html)
  $edge=[CodexNative.PreviewFixtures]::Production($eh);$controllers.Add($edge)
  $r=Await ($edge.SetTargetAsync($ct,[CodexNative.PreviewOpenReason]::ExplicitOpen));if($r.State -eq 'error'){Write-Output ("PRODUCTION_FAILURE_CLEANUP="+$r.CleanupState+";JOB_MEMBERS="+@(Members $edge).Count+";DIRECTORY_NULL="+($null -eq (Field $edge 'directory')))};Assert ($r.State -in @('starting','open')) ('production fixture failed '+$r.ErrorCode+' / '+(Field $edge 'GuardDiagnostic'))
  $edgeDir=Field $edge 'directory';$edgeMembers=@(Members $edge);$edgeIdentities=@(MemberIdentities $edgeMembers)
  $expression='(()=>{const f=document.querySelector("iframe");return !!f&&f.getAttribute("sandbox")==="allow-scripts";})()'
  $evaluation=Await ([CodexNative.PreviewFixtures]::Eval($edge,$expression));Assert ($evaluation.result.value -eq $true) 'production sandbox absent'
  [CodexNative.PreviewFixtures]::Revoke($edge)
  $watch=[Diagnostics.Stopwatch]::StartNew();while($edge.Snapshot.State -ne 'error' -and $watch.ElapsedMilliseconds -lt 8000){Start-Sleep -Milliseconds 25}
  Assert ($edge.Snapshot.State -eq 'error' -and $edge.Snapshot.ErrorCode -eq 'guard_environment_unavailable') 'asynchronous revocation misreported closed'
  Assert ($edge.Snapshot.CleanupState -eq 'cleaned' -and -not (Test-Path -LiteralPath $edgeDir)) 'production revoked profile retained'
  AssertMemberIdentities $edgeIdentities 'production Job survived revocation' $edge $edgeDir
  $inlineTarget=Target;$inlineTarget.Mode=$ct.Mode;$inlineTarget.Version=$ct.Version;$body=SourceBody ('Animation source.'+[char]10+$fence+'html'+[char]10+$html+[char]10+$fence);$eh.SourceJson=ConvertTo-Json -Compress $body
  [CodexNative.PreviewFixtures]::Presentation($inlineTarget,'Inline',$true,$body.contentDigest);$inline=[CodexNative.PreviewFixtures]::Production($eh);$controllers.Add($inline);$sink=New-Object CodexNative.PreviewFrameSink $inline
  try {
   $r=Await ($inline.SetTargetAsync($inlineTarget,[CodexNative.PreviewOpenReason]::ExplicitOpen));Assert ($r.State -eq 'open' -and $null -eq $r.ErrorCode) ('headless capture failed '+$r.ErrorCode+' / '+(Field $inline 'GuardDiagnostic'))
   $inlineDir=Field $inline 'directory';$inlineJob=Field $inline 'job';$inlineMembers=@(Members $inline);$inlineIdentities=@(MemberIdentities $inlineMembers);Assert ($inlineMembers.Count -gt 0) 'headless preview has no owned Job'
   $watch=[Diagnostics.Stopwatch]::StartNew();while($sink.Count -lt 4 -and $watch.ElapsedMilliseconds -lt 6000){Start-Sleep -Milliseconds 25}
   $stateBefore=$null;$stateAfter=$null;$loadedAt=-1;$baselineAt=-1;$baselineCount=0;$baselineFrame=$null;$motionFrame=$null;$pixelsChanged=$false
   while($watch.ElapsedMilliseconds -lt 10000) {
    $probeState=Await ([CodexNative.PreviewFixtures]::AnimationState($inline))
    if($loadedAt -lt 0 -and $probeState.contextAvailable -and $probeState.dom.ready -in @('interactive','complete') -and $probeState.dom.started -eq $true -and $null -ne $probeState.dom.cx -and $null -ne $probeState.dom.ticks){$loadedAt=$watch.ElapsedMilliseconds}
    if($loadedAt -ge 0 -and $baselineAt -lt 0 -and $watch.ElapsedMilliseconds-$loadedAt -ge 1000){$baselineFrame=$sink.Last;$baselineCount=$sink.Count;$baselineAt=$watch.ElapsedMilliseconds;$stateBefore=$probeState}
    if($baselineAt -ge 0 -and $watch.ElapsedMilliseconds-$baselineAt -ge 1000 -and $sink.Count -gt $baselineCount){$motionFrame=$sink.Last;$stateAfter=$probeState;$pixelsChanged=[Convert]::ToBase64String($baselineFrame) -ne [Convert]::ToBase64String($motionFrame);if($pixelsChanged -and $stateAfter.dom.ticks -gt $stateBefore.dom.ticks){break}}
    Start-Sleep -Milliseconds 250
   }
   Assert ($sink.Count -ge 4 -and -not $sink.TooFast) 'headless preview did not stream at bounded cadence'
   Assert ($sink.Operation -eq $r.OperationGeneration -and $sink.Digest -eq $body.contentDigest) 'headless frame identity missing'
   Assert ($sink.First.Length -le 1048576 -and $sink.Last.Length -le 1048576 -and $sink.Last[0] -eq 255 -and $sink.Last[1] -eq 216) 'headless screenshot byte contract failed'
   $motionVerified=$loadedAt -ge 0 -and $baselineAt-$loadedAt -ge 1000 -and $stateAfter.dom.ticks -gt $stateBefore.dom.ticks -and $pixelsChanged
   Write-Output ('HEADLESS_ANIMATION_STATE='+(ConvertTo-Json -Compress -Depth 10 @{count=$sink.Count;elapsedMs=$watch.ElapsedMilliseconds;loadedAtMs=$loadedAt;baselineAtMs=$baselineAt;baselineCount=$baselineCount;firstAtMs=$sink.FirstAt;lastAtMs=$sink.LastAt;pixelsChanged=$pixelsChanged;motionVerified=$motionVerified;stateBefore=$stateBefore;stateAfter=$stateAfter;lastProbeState=$probeState}))
   if(-not $motionVerified -or $EvidenceDirectory) {
    $evidenceBase=if($EvidenceDirectory){[IO.Path]::GetFullPath($EvidenceDirectory)}else{[IO.Path]::GetTempPath()};$evidencePath=Join-Path $evidenceBase ('native-preview-inline-evidence-'+[Guid]::NewGuid().ToString('N'));[IO.Directory]::CreateDirectory($evidencePath)|Out-Null
    $firstPath=Join-Path $evidencePath 'first.jpg';$lastPath=Join-Path $evidencePath 'last.jpg';[IO.File]::WriteAllBytes($firstPath,$sink.First);[IO.File]::WriteAllBytes($lastPath,$sink.Last)
    $proof=[ordered]@{count=$sink.Count;elapsedMs=$watch.ElapsedMilliseconds;loadedAtMs=$loadedAt;baselineAtMs=$baselineAt;baselineCount=$baselineCount;firstAtMs=$sink.FirstAt;lastAtMs=$sink.LastAt;pixelsChanged=$pixelsChanged;motionVerified=$motionVerified;firstLength=$sink.First.Length;lastLength=$sink.Last.Length;firstSha256=(Get-FileHash -LiteralPath $firstPath -Algorithm SHA256).Hash;lastSha256=(Get-FileHash -LiteralPath $lastPath -Algorithm SHA256).Hash;stateBefore=$stateBefore;stateAfter=$stateAfter;lastProbeState=$probeState;cleanupBeforeStop=$inline.Snapshot.CleanupState;firstJpeg=$firstPath;lastJpeg=$lastPath}
    if($baselineFrame){$baselinePath=Join-Path $evidencePath 'baseline.jpg';[IO.File]::WriteAllBytes($baselinePath,$baselineFrame);$proof['baselineJpeg']=$baselinePath;$proof['baselineLength']=$baselineFrame.Length;$proof['baselineSha256']=(Get-FileHash -LiteralPath $baselinePath -Algorithm SHA256).Hash}
    if($motionFrame){$motionPath=Join-Path $evidencePath 'motion.jpg';[IO.File]::WriteAllBytes($motionPath,$motionFrame);$proof['motionJpeg']=$motionPath;$proof['motionLength']=$motionFrame.Length;$proof['motionSha256']=(Get-FileHash -LiteralPath $motionPath -Algorithm SHA256).Hash}
    [IO.File]::WriteAllText((Join-Path $evidencePath 'frames.json'),(ConvertTo-Json -Depth 10 $proof));Write-Output ('HEADLESS_PIXEL_EVIDENCE='+(ConvertTo-Json -Compress -Depth 10 $proof))
   }
   Assert $motionVerified 'headless animation did not show loaded baseline then changing ticks and pixels'
   $playOperation=$r.OperationGeneration;$beforePauseCount=$sink.Count;Assert (Await ([CodexNative.PreviewFixtures]::Click($inline,$inlineTarget,$playOperation,110,135))) 'fixed artwork pause click did not complete'
   Start-Sleep -Milliseconds 800;$pauseBefore=Await ([CodexNative.PreviewFixtures]::AnimationState($inline));$pauseFrame=$sink.Last;$pauseCount=$sink.Count;Start-Sleep -Milliseconds 1200;$pauseAfter=Await ([CodexNative.PreviewFixtures]::AnimationState($inline));$pauseFrameAfter=$sink.Last
   $pauseVerified=$pauseBefore.dom.paused -eq $true -and $pauseAfter.dom.paused -eq $true -and $pauseBefore.dom.ticks -eq $pauseAfter.dom.ticks -and $pauseBefore.dom.cx -eq $pauseAfter.dom.cx -and ([Convert]::ToBase64String($pauseFrame) -ceq [Convert]::ToBase64String($pauseFrameAfter)) -and $sink.Count-$pauseCount -ge 3
   Assert $pauseVerified 'pause did not stop artwork ticks/pixels while frame delivery continued'
   Assert ($inline.Snapshot.OperationGeneration -eq $playOperation -and (Field $inline 'directory') -eq $inlineDir -and (Field $inline 'job') -eq $inlineJob) 'pause changed the owned preview identity'
   Assert (Await ([CodexNative.PreviewFixtures]::Click($inline,$inlineTarget,$playOperation,110,135))) 'fixed artwork resume click did not complete';Start-Sleep -Milliseconds 1200;$resumeState=Await ([CodexNative.PreviewFixtures]::AnimationState($inline));$resumeFrame=$sink.Last;$resumeVerified=$resumeState.dom.paused -eq $false -and $resumeState.dom.ticks -gt $pauseAfter.dom.ticks -and ([Convert]::ToBase64String($resumeFrame) -cne [Convert]::ToBase64String($pauseFrameAfter));Assert $resumeVerified 'resume did not restore actual artwork motion'
   $inputAudit=[CodexNative.PreviewFixtures]::GuardAudit($inline);Assert ($inputAudit.inputReady -and -not $inputAudit.failed -and $inputAudit.externalRequests -eq 0 -and $resumeState.dom.scriptExceptionCount -eq 0) 'normal artwork input produced security/network/script errors'
   $inputProof=[ordered]@{pauseVerified=$pauseVerified;resumeVerified=$resumeVerified;operation=$playOperation;beforePauseCount=$beforePauseCount;pauseBaselineCount=$pauseCount;afterCount=$sink.Count;pauseBefore=$pauseBefore;pauseAfter=$pauseAfter;resumeState=$resumeState;guard=$inputAudit;realModelCalls=0}
   Write-Output ('ARTWORK_INPUT_STATE='+(ConvertTo-Json -Compress -Depth 12 $inputProof))
   if($EvidenceDirectory){$inputEvidence=Join-Path ([IO.Path]::GetFullPath($EvidenceDirectory)) ('native-preview-input-evidence-'+[Guid]::NewGuid().ToString('N'));[IO.Directory]::CreateDirectory($inputEvidence)|Out-Null;[IO.File]::WriteAllBytes((Join-Path $inputEvidence 'pause-before.jpg'),$pauseFrame);[IO.File]::WriteAllBytes((Join-Path $inputEvidence 'pause-after.jpg'),$pauseFrameAfter);[IO.File]::WriteAllBytes((Join-Path $inputEvidence 'resume.jpg'),$resumeFrame);[IO.File]::WriteAllText((Join-Path $inputEvidence 'input.json'),(ConvertTo-Json -Depth 12 $inputProof));Write-Output ('ARTWORK_INPUT_EVIDENCE='+$inputEvidence)}
   $r=Await ($inline.SetTargetAsync($inlineTarget,[CodexNative.PreviewOpenReason]::FollowSelection));Assert ((Field $inline 'directory') -eq $inlineDir -and (Field $inline 'job') -eq $inlineJob) 'repeated inline target recreated Job'
   $inlineTarget.SelectionGeneration++;$r=Await ($inline.SetTargetAsync($inlineTarget,[CodexNative.PreviewOpenReason]::FollowSelection));$watch.Restart();while($sink.Operation -ne $r.OperationGeneration -and $watch.ElapsedMilliseconds -lt 3000){Start-Sleep -Milliseconds 25};Assert ($sink.Operation -eq $r.OperationGeneration -and (Field $inline 'directory') -eq $inlineDir) 'selection refresh did not reuse stream with new operation'
   [CodexNative.PreviewFixtures]::Presentation($inlineTarget,'Detached',$true,$body.contentDigest);$r=Await ($inline.SetTargetAsync($inlineTarget,[CodexNative.PreviewOpenReason]::ExplicitOpen));Assert ($r.State -in @('starting','open') -and $null -eq $r.ErrorCode) ('inline to detached failed '+$r.ErrorCode+';cleanup='+$r.CleanupState+';diagnostic='+(Field $inline 'GuardDiagnostic'))
   Assert (-not (Test-Path -LiteralPath $inlineDir) -and (Field $inline 'directory') -ne $inlineDir) 'presentation switch retained old profile'
   AssertMemberIdentities $inlineIdentities 'headless Job survived detached switch' $inline $inlineDir
   $detachedDir=Field $inline 'directory';$detachedJob=Field $inline 'job';$r=Await ($inline.SetTargetAsync($inlineTarget,[CodexNative.PreviewOpenReason]::ExplicitOpen));Assert ((Field $inline 'directory') -eq $detachedDir -and (Field $inline 'job') -eq $detachedJob) 'repeated detached target recreated Job'
   $r=Await ($inline.StopAsync('inline-production'));Assert ($r.State -eq 'closed' -and $r.CleanupState -eq 'cleaned' -and -not (Test-Path -LiteralPath $detachedDir)) 'inline production cleanup failed'
  } finally {$sink.Dispose();$null=Await ($inline.StopAsync('inline-production-finally'));$inline.Dispose()}
  }
  # Trusted input attempts stay in the sandbox/deny-all boundary or revoke the owned Job.
  $canary=New-Object CodexNative.PreviewCanary;$securityProof=New-Object 'Collections.Generic.List[object]'
  $securityPath=if($EvidenceDirectory){Join-Path ([IO.Path]::GetFullPath($EvidenceDirectory)) ('native-preview-security-input-evidence-'+[Guid]::NewGuid().ToString('N')+'.json')}else{$null}
  try {
   foreach($action in $securityActions) {
    $downloadName='codex-preview-denied-'+[Guid]::NewGuid().ToString('N')+'.txt';$downloadPath=Join-Path ([Environment]::GetFolderPath('UserProfile')) ('Downloads/'+$downloadName);Assert (-not (Test-Path -LiteralPath $downloadPath)) 'malicious download fixture name already exists'
    $actionScript=switch($action){
     'noop' {'void 0'}
     'file-chooser' {'document.getElementById("fixture-file").click()'}
     'download' {'const a=document.createElement("a");a.href="data:text/plain,denied-fixture";a.download="'+$downloadName+'";a.click()'}
     'popup' {'window.open("'+$canary.Url+'/popup","_blank")'}
     'dialog' {'alert("denied fixture dialog")'}
     'about' {'location.href="about:blank"'}
     'fragment' {'location.hash="denied-fixture"'}
     'file' {'location.href="file:///codex-fixture-does-not-exist"'}
     'data' {'location.href="data:text/plain,denied-fixture"'}
     'navigate' {'location.href="'+$canary.Url+'/navigation"'}
     'fetch' {'fetch("'+$canary.Url+'/fetch").catch(()=>{})'}
    }
    $actionHtml='<html><body><input id="fixture-file" type="file" style="display:none"><button style="position:fixed;left:20px;top:100px;width:180px;height:70px" onclick="fixtureClicked=true;try{'+$actionScript.Replace('"','&quot;')+'}catch(e){fixtureErrors.push(&quot;blocked&quot;)}">Fixture</button><script>globalThis.fixtureClicked=false;globalThis.fixtureErrors=[];addEventListener("error",()=>fixtureErrors.push("script"));addEventListener("unhandledrejection",()=>fixtureErrors.push("promise"));</script></body></html>'
    $actionBody=SourceBody $actionHtml;$actionHandler=New-Object CodexNative.PreviewFixtureHandler;$actionHandler.Cockpit=$true;$actionHandler.SourceJson=ConvertTo-Json -Compress $actionBody;$actionTarget=Target;$actionTarget.Mode=$ct.Mode;$actionTarget.Version=$ct.Version;[CodexNative.PreviewFixtures]::Presentation($actionTarget,'Inline',$true,$actionBody.contentDigest)
    $actionPreview=[CodexNative.PreviewFixtures]::Production($actionHandler);$controllers.Add($actionPreview);$actionSink=New-Object CodexNative.PreviewFrameSink $actionPreview;$actionDir=$null;$actionMembers=@();$actionMemberIdentities=@();$actionFailure=$null;$cleanupFailures=New-Object 'Collections.Generic.List[object]';$actionRecord=[ordered]@{action=$action;realModelCalls=0;osDialogObservation='headless; desktop acceptance remains with root'};$actionStage='open';Write-Output ('SECURITY_INPUT_BEGIN='+$action)
    try {
     $actionOpen=Await ($actionPreview.SetTargetAsync($actionTarget,[CodexNative.PreviewOpenReason]::ExplicitOpen)) ('security-'+$action+'-open');Assert ($actionOpen.State -eq 'open' -and $actionSink.Count -ge 1) ('security click fixture failed to open: '+$action+' / '+(Field $actionPreview 'GuardDiagnostic'))
     $actionDir=Field $actionPreview 'directory';$actionMembers=@(Members $actionPreview);$actionMemberIdentities=@([CodexNative.PreviewFixtures]::MemberIdentities([uint32[]]$actionMembers));$actionRecord.ownedMemberIdentities=$actionMemberIdentities;$actionRecord.ownedProfile=$actionDir;$witness=New-Object CodexNative.PreviewSecurityWitness $actionPreview;$beforeAction=$witness.Audit();$actionStage='targets-baseline';$initialInventory=@(Await ([CodexNative.PreviewFixtures]::TargetInventory($actionPreview)) ('security-'+$action+'-targets-initial'));$initialTargets=@($initialInventory|ForEach-Object{$_.targetId});Start-Sleep -Milliseconds 2000;$beforeInventory=@(Await ([CodexNative.PreviewFixtures]::TargetInventory($actionPreview)) ('security-'+$action+'-targets-before'));$beforeTargets=@($beforeInventory|ForEach-Object{$_.targetId});$actionRecord.baselineQuietMilliseconds=2000;$actionRecord.targetInventoryInitial=$initialInventory;$actionRecord.targetInventoryBefore=$beforeInventory;$actionRecord.newTargetInventoryBeforeClick=@($beforeInventory|Where-Object{$_.targetId -notin $initialTargets});$actionRecord.targetIdsBefore=$beforeTargets;Assert ($beforeAction.inputReady -and $beforeAction.stage -match 'downloadDenied=True;childChooser=True') 'security input protection not ready'
     $actionStage='click';$clickCompleted=Await ([CodexNative.PreviewFixtures]::Click($actionPreview,$actionTarget,$actionOpen.OperationGeneration,110,135)) ('security-'+$action+'-click');Start-Sleep -Milliseconds 1000;$afterAction=$witness.Audit();$actionState=$actionPreview.Snapshot
     $actionRecord.clickPairCompleted=$clickCompleted;$actionRecord.state=$actionState.State;$actionRecord.error=$actionState.ErrorCode;$actionRecord.revoked=$afterAction.failed;$actionRecord.guard=$afterAction;$actionRecord.canaryConnections=$canary.Count;$actionRecord.downloadSeen=(Test-Path -LiteralPath $downloadPath)
     if($afterAction.failed){$watch=[Diagnostics.Stopwatch]::StartNew();while($actionPreview.Snapshot.State -ne 'error' -and $watch.ElapsedMilliseconds -lt 6000){Start-Sleep -Milliseconds 25};$actionState=$actionPreview.Snapshot;$actionRecord.state=$actionState.State;$actionRecord.error=$actionState.ErrorCode;Assert ($actionState.State -eq 'error' -and $actionState.ErrorCode -in @('preview_input_failed','guard_environment_unavailable')) ('revoked security click has wrong state: '+$action)}else{
      Assert ($actionState.State -eq 'open') ('sandbox-denied click lost live preview: '+$action);$actionStage='dom';$dom=Await ([CodexNative.PreviewFixtures]::FixtureActionState($actionPreview)) ('security-'+$action+'-dom');$actionRecord.dom=$dom.result.value;$actionStage='targets';$afterInventory=@(Await ([CodexNative.PreviewFixtures]::TargetInventory($actionPreview)) ('security-'+$action+'-targets'));$afterTargets=@($afterInventory|ForEach-Object{$_.targetId});$actionRecord.targetInventoryAfter=$afterInventory;$actionRecord.targetIdsAfter=$afterTargets;$actionRecord.newTargetIds=@($afterTargets|Where-Object{$_ -notin $beforeTargets});$actionRecord.newTargetInventory=@($afterInventory|Where-Object{$_.targetId -notin $beforeTargets});Assert ($dom.result.value.clicked -eq $true -and $dom.result.value.files -eq 0 -and @($actionRecord.newTargetIds).Count -eq 0) ('security action bypassed sandbox: '+$action)
     }
     Assert ($canary.Count -eq 0 -and -not (Test-Path -LiteralPath $downloadPath)) ('security click created download or canary request: '+$action)
    } catch {$actionFailure=$_;$actionRecord.failureStage=$actionStage;$actionRecord.failureType=$_.Exception.GetBaseException().GetType().FullName;$actionRecord.failureMessage=$_.Exception.GetBaseException().Message} finally {
     $actionStop=$null;$actionRecord.cleanup='unverified';$actionRecord.profileRemoved=$false;$actionRecord.jobMembersAfter=$null
     try{$actionSink.Dispose()}catch{$cleanupFailures.Add(@{stage='sink-dispose';type=$_.Exception.GetBaseException().GetType().FullName;message=$_.Exception.GetBaseException().Message})}
     try{$actionStop=Await ($actionPreview.StopAsync('security-input-finally')) ('security-'+$action+'-cleanup-stop');$actionRecord.cleanup=$actionStop.CleanupState}catch{$cleanupFailures.Add(@{stage='stop';type=$_.Exception.GetBaseException().GetType().FullName;message=$_.Exception.GetBaseException().Message})}
     try{$actionPreview.Dispose();$actionRecord.controllerDisposed=$true}catch{$actionRecord.controllerDisposed=$false;$cleanupFailures.Add(@{stage='dispose';type=$_.Exception.GetBaseException().GetType().FullName;message=$_.Exception.GetBaseException().Message})}
     try{$actionRecord.profileRemoved=($null -eq $actionDir -or -not (Test-Path -LiteralPath $actionDir));$actionRecord.jobMembersAfter=@(Members $actionPreview).Count;$actionRecord.cleanupDiagnostic=Field $actionPreview 'CleanupDiagnostic';$actionRecord.memberCleanupObservations=@([CodexNative.PreviewFixtures]::ObserveMemberCleanup([CodexNative.PreviewProcessIdentity[]]$actionMemberIdentities))}catch{$cleanupFailures.Add(@{stage='identity-observation';type=$_.Exception.GetBaseException().GetType().FullName;message=$_.Exception.GetBaseException().Message})}
     try{Assert ($actionRecord.cleanup -eq 'cleaned' -and $actionRecord.profileRemoved -and $actionRecord.jobMembersAfter -eq 0) ('security click cleanup failed: '+$action);foreach($observation in $actionRecord.memberCleanupObservations){Assert ($observation.Status -notin @('owned_alive','unverified')) ('security click Job identity survived or unverified: '+$action+' / '+$observation.Pid+' / '+$observation.Status)}}catch{$cleanupFailures.Add(@{stage='cleanup-assertion';type=$_.Exception.GetBaseException().GetType().FullName;message=$_.Exception.GetBaseException().Message})}
     $actionRecord.cleanupFailures=$cleanupFailures.ToArray()
     $securityProof.Add($actionRecord);Write-Output ('SECURITY_INPUT_STATE='+(ConvertTo-Json -Compress -Depth 12 $actionRecord));if($securityPath){[IO.File]::WriteAllText($securityPath,(ConvertTo-Json -Depth 12 -InputObject $securityProof.ToArray()));Write-Output ('SECURITY_INPUT_EVIDENCE='+$securityPath)}
    }
    if($actionFailure){throw $actionFailure};Assert ($cleanupFailures.Count -eq 0) ('security click cleanup verification failed: '+$action)
   }
   Assert ($canary.Count -eq 0) 'late canary connection escaped browser cleanup'
  } finally {$canary.Dispose()}
  Assert ([CodexNative.PreviewFixtures]::Gate()) 'production test changed enabled gate'
 }
 # Pause actual old Command and CaptureAsync catches, replace their Job, then release.
 foreach($latePath in @('command','capture','input')) {
 $late=[CodexNative.PreviewFixtures]::Create((New-Object CodexNative.PreviewFixtureHandler),$exe,$args);$controllers.Add($late)
 $null=Await ($late.SetTargetAsync((Target),[CodexNative.PreviewOpenReason]::ExplicitOpen));$oldDir=Field $late 'directory';$oldMembers=@(Members $late);$oldIdentities=@(MemberIdentities $oldMembers)
 $catchBarrier=New-Object CodexNative.PreviewGuardCatchBarrier $late,($latePath -eq 'capture'),($latePath -eq 'input')
 try {
  Assert ($catchBarrier.CommandEntered.Wait(10000)) 'old command did not enter cancellation wait'
  $catchBarrier.Cancel();Assert ($catchBarrier.Entered.Wait(10000)) 'old command catch did not pause'
  $r=Await ($late.SetTargetAsync((Target '33333333-3333-4333-8333-333333333333'),[CodexNative.PreviewOpenReason]::ExplicitOpen))
  Assert ($r.State -eq 'open' -and $r.OperationGeneration -eq 2) 'replacement preview did not open'
  $newMembers=@(Members $late);$newIdentities=@(MemberIdentities $newMembers);Assert ($newMembers.Count -gt 0) 'replacement Job empty'
  Assert (-not (Test-Path -LiteralPath $oldDir)) 'old guard profile retained'
  AssertMemberIdentities $oldIdentities 'old Job survived replacement' $late $oldDir
  $catchBarrier.Release.Set();Assert ($catchBarrier.Command.Wait(10000)) 'old command did not finish'
  Assert (-not $catchBarrier.Failed) 'disposed old guard executed Fail'
  Assert ($late.Snapshot.State -eq 'open' -and $late.Snapshot.OperationGeneration -eq 2 -and $null -eq $late.Snapshot.ErrorCode) 'old catch corrupted new preview state'
  AssertMemberIdentities $newIdentities 'old catch killed new Job' $late $null -Alive
  Assert (@(Members $late).Count -eq $newMembers.Count) 'new Job changed after old catch'
 } finally {$catchBarrier.Dispose();$null=Await ($late.StopAsync('late-catch-finally'));$late.Dispose()}
 }
 # Insert accepted Stop/new target at exact launch checkpoints, with no timing sleeps.
 foreach($checkpoint in @('before_create','before_resume')){foreach($operation in @('stop','target')){
  $race=[CodexNative.PreviewFixtures]::Create((New-Object CodexNative.PreviewFixtureHandler),$exe,$args);$controllers.Add($race)
  $barrier=New-Object CodexNative.PreviewLaunchBarrier $race,$checkpoint
  try{
   $stale=$race.SetTargetAsync((Target),[CodexNative.PreviewOpenReason]::ExplicitOpen)
   Assert ($barrier.Entered.Wait(10000)) ('launch checkpoint not reached: '+$checkpoint)
   $staleDir=Field $race 'directory'
   Assert (Test-Path -LiteralPath $staleDir) 'race fixture lacks owned directory'
   Assert (($checkpoint -eq 'before_create' -and $barrier.StalePid -eq 0) -or ($checkpoint -eq 'before_resume' -and $barrier.StalePid -gt 0)) 'unexpected process creation stage';$staleIdentities=if($barrier.StalePid -gt 0){@(MemberIdentities @($barrier.StalePid))}else{@()}
   # Schedule must return while the worker holds nativeGate at before_resume.
   $timer=[Diagnostics.Stopwatch]::StartNew()
   if($operation -eq 'stop'){$latest=$race.StopAsync('launch-race')}else{$latest=$race.SetTargetAsync((Target '33333333-3333-4333-8333-333333333333'),[CodexNative.PreviewOpenReason]::ExplicitOpen)}
   Assert ($timer.ElapsedMilliseconds -lt 2000) 'Schedule blocked behind nativeGate'
   $barrier.Release.Set();$null=Await $stale;$result=Await $latest
   Assert ($barrier.StaleResumes -eq 0) ('stale generation resumed: '+$checkpoint+' / '+$operation)
   Assert (-not (Test-Path -LiteralPath $staleDir)) 'stale owned directory retained'
   if($barrier.StalePid -gt 0){AssertMemberIdentities $staleIdentities 'stale suspended process survived' $race $staleDir}
   Assert ($result.OperationGeneration -eq 2) 'latest generation not completed'
   if($operation -eq 'stop'){Assert ($result.State -eq 'closed' -and $result.CleanupState -eq 'cleaned' -and (Field $race 'job') -eq [IntPtr]::Zero) 'inserted Stop did not clean up'}else{Assert ($result.State -eq 'open' -and $result.Target.RunId -eq '33333333-3333-4333-8333-333333333333') 'inserted target did not open';Assert (@(Members $race).Count -gt 0) 'latest target missing Job member'}
  }finally{$barrier.Dispose();$null=Await ($race.StopAsync('race-finally'));$race.Dispose()}
 }}
 foreach($scenario in @('capability','instance','launch')){
  $h=New-Object CodexNative.PreviewFixtureHandler
  if($scenario -eq 'capability'){$h.Supported=$false}
  if($scenario -eq 'instance'){$h.Instance='33333333-3333-4333-8333-333333333333'}
  $program=if($scenario -eq 'launch'){Join-Path $fixtureRoot 'missing.exe'}else{$exe}
  $c=[CodexNative.PreviewFixtures]::Create($h,$program,$args);$controllers.Add($c)
  $r=Await ($c.SetTargetAsync((Target),[CodexNative.PreviewOpenReason]::ExplicitOpen))
  $expected=@{capability='capability_missing';instance='instance_mismatch';launch='launch_failed'}[$scenario]
  Assert ($r.State -eq 'error' -and $r.ErrorCode -eq $expected) ('wrong failure: '+$scenario)
  Assert ((Field $c 'job') -eq [IntPtr]::Zero) 'failure retained job handle'
  $null=Await ($c.StopAsync('fixture'));$c.Dispose()
 }
 $h=New-Object CodexNative.PreviewFixtureHandler;$c=[CodexNative.PreviewFixtures]::Create($h,$exe,$args);$controllers.Add($c)
 $r=Await ($c.SetTargetAsync($t,[CodexNative.PreviewOpenReason]::ExplicitOpen))
 Assert ($r.State -eq 'open') ('job fixture failed: '+$r.ErrorCode+' / '+$r.CleanupState)
 $members=@(Members $c);$memberIdentities=@(MemberIdentities $members);Assert ($members.Count -gt 0) 'job has no members'
 $dir=Field $c 'directory';Assert (Test-Path -LiteralPath (Join-Path $dir 'ownership.txt')) 'ownership marker absent'
 $t.RunId='44444444-4444-4444-8444-444444444444'
 Assert ($c.Snapshot.Target.RunId -eq '22222222-2222-4222-8222-222222222222') 'target not copied'
 $snap=$c.Snapshot;$snap.Target.RunId='55555555-5555-4555-8555-555555555555'
 Assert ($c.Snapshot.Target.RunId -eq '22222222-2222-4222-8222-222222222222') 'snapshot not copied'
 $r=Await ($c.SetTargetAsync((Target),[CodexNative.PreviewOpenReason]::FollowSelection))
 Assert ((Field $c 'directory') -eq $dir) 'same target restarted'
 $digestTarget=Target;[CodexNative.PreviewFixtures]::Presentation($digestTarget,'Detached',$false,'digest-one');$r=Await ($c.SetTargetAsync($digestTarget,[CodexNative.PreviewOpenReason]::FollowSelection));Assert ($r.State -eq 'open' -and -not (Test-Path -LiteralPath $dir)) 'digest change did not retire old Job';$dir=Field $c 'directory';$digestJob=Field $c 'job'
 $digestTarget.SelectionGeneration++;$digestTarget.WindowGeneration++;$r=Await ($c.SetTargetAsync($digestTarget,[CodexNative.PreviewOpenReason]::FollowSelection));Assert ((Field $c 'directory') -eq $dir -and (Field $c 'job') -eq $digestJob -and $r.Target.SelectionGeneration -eq $digestTarget.SelectionGeneration -and $r.Target.WindowGeneration -eq $digestTarget.WindowGeneration) 'identity delivery update recreated Job'
 [CodexNative.PreviewFixtures]::Presentation($digestTarget,'Detached',$false,'digest-two');$r=Await ($c.SetTargetAsync($digestTarget,[CodexNative.PreviewOpenReason]::FollowSelection));Assert ($r.State -eq 'open' -and -not (Test-Path -LiteralPath $dir)) 'new digest reused old Job';$dir=Field $c 'directory'
 $r=Await ($c.SetTargetAsync((Target '33333333-3333-4333-8333-333333333333'),[CodexNative.PreviewOpenReason]::FollowSelection))
 Assert ($r.State -eq 'open' -and -not (Test-Path -LiteralPath $dir)) ('switch failed: '+$r.State+' / '+$r.ErrorCode+' / '+$r.CleanupState+' / diagnostic='+(Field $c 'CleanupDiagnostic')+' / old='+$dir+' / new='+(Field $c 'directory'))
 AssertMemberIdentities $memberIdentities 'old job member survived switch' $c $null
 $dir=Field $c 'directory';$r=Await ($c.StopAsync('fixture'))
 Assert ($r.State -eq 'closed' -and $r.CleanupState -eq 'cleaned' -and -not (Test-Path -LiteralPath $dir)) 'stop cleanup failed'
 $r=Await ($c.SetTargetAsync((Target),[CodexNative.PreviewOpenReason]::FollowSelection));Assert ($r.State -eq 'closed') 'follow reopened without intent'
 $r=Await ($c.SetTargetAsync((Target),[CodexNative.PreviewOpenReason]::ExplicitRun));Assert ($r.State -eq 'open') 'explicit run did not reopen'
 $dir=Field $c 'directory';$markerPath=Join-Path $dir 'ownership.txt';$original=[IO.File]::ReadAllText($markerPath);[IO.File]::WriteAllText($markerPath,'forged')
 $r=Await ($c.StopAsync('fixture'));Assert ($r.CleanupState -eq 'retained_path_unsafe' -and (Test-Path -LiteralPath $dir)) 'forged marker deleted'
 [IO.File]::WriteAllText($markerPath,$original);$r=Await ($c.StopAsync('fixture'));Assert ($r.CleanupState -eq 'cleaned') 'owned directory recovery failed'
 # Locked owned file must retain the exact directory and recover after release.
 $r=Await ($c.SetTargetAsync((Target),[CodexNative.PreviewOpenReason]::ExplicitOpen))
 $dir=Field $c 'directory';$locked=Join-Path $dir 'profile/locked.txt';[IO.File]::WriteAllText($locked,'fixture')
 $lock=[IO.File]::Open($locked,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::None)
 try{$r=Await ($c.StopAsync('fixture'));Assert ($r.CleanupState -eq 'retained_delete_failed' -and (Test-Path -LiteralPath $dir)) 'locked file cleanup misreported'}finally{$lock.Dispose()}
 $r=Await ($c.StopAsync('fixture'));Assert ($r.CleanupState -eq 'cleaned') 'locked directory recovery failed'
 # Reparse points are retained without traversing the target.
 $null=Await ($c.SetTargetAsync((Target),[CodexNative.PreviewOpenReason]::ExplicitOpen));$dir=Field $c 'directory'
 $junction=Join-Path $dir 'profile/redirect';New-Item -ItemType Junction -Path $junction -Target $fixtureRoot|Out-Null
 $r=Await ($c.StopAsync('fixture'));Assert ($r.CleanupState -eq 'retained_path_unsafe' -and (Test-Path -LiteralPath $helperPath)) 'reparse point traversed'
 [IO.Directory]::Delete($junction);$r=Await ($c.StopAsync('fixture'));Assert ($r.CleanupState -eq 'cleaned') 'reparse directory recovery failed'
 # A descendant is also a Job member and must exit when the Job is stopped.
 $childCommand="Start-Process -FilePath '$exe' -WindowStyle Hidden -ArgumentList '-NoProfile -NonInteractive -WindowStyle Hidden -Command Start-Sleep -Seconds 60'; Start-Sleep -Seconds 60"
 $encoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($childCommand))
 $childArgs='-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand '+$encoded
 $tree=[CodexNative.PreviewFixtures]::Create((New-Object CodexNative.PreviewFixtureHandler),$exe,$childArgs);$controllers.Add($tree)
 $r=Await ($tree.SetTargetAsync((Target),[CodexNative.PreviewOpenReason]::ExplicitOpen))
 $watch=[Diagnostics.Stopwatch]::StartNew();do{$treeMembers=@(Members $tree);$treeIdentities=@(MemberIdentities $treeMembers);if($treeMembers.Count -ge 2){break};Start-Sleep -Milliseconds 50}while($watch.ElapsedMilliseconds -lt 5000)
 Assert ($treeMembers.Count -ge 2) 'descendant did not join job'
 Assert ([CodexNative.PreviewFixtures]::ForeignCleanupMember($tree)) 'cleanup accepted foreign process handle from reused PID'
 $r=Await ($tree.StopAsync('fixture'));Assert ($r.CleanupState -eq 'cleaned') 'descendant job cleanup failed'
 AssertMemberIdentities $treeIdentities 'descendant survived job stop' $tree $null
 # A Job member may exit between the membership snapshot and OpenProcess.
 $cleanupRaceExecutable=Join-Path $fixtureRoot 'cleanup-member-worker.exe'
 Add-Type -TypeDefinition 'using System.Diagnostics;using System.Reflection;using System.Threading;public static class PreviewCleanupWorker{public static void Main(string[] args){if(args.Length==0)Process.Start(new ProcessStartInfo{FileName=Assembly.GetExecutingAssembly().Location,Arguments="child",UseShellExecute=false,CreateNoWindow=true});Thread.Sleep(60000);}}' -OutputAssembly $cleanupRaceExecutable -OutputType ConsoleApplication
 $cleanupRace=[CodexNative.PreviewFixtures]::Create((New-Object CodexNative.PreviewFixtureHandler),$cleanupRaceExecutable,'');$controllers.Add($cleanupRace)
 $null=Await ($cleanupRace.SetTargetAsync((Target),[CodexNative.PreviewOpenReason]::ExplicitOpen));$cleanupRaceDirectory=Field $cleanupRace 'directory'
 $watch.Restart();do{$cleanupRaceMembers=@(Members $cleanupRace);if($cleanupRaceMembers.Count -ge 2){break};Start-Sleep -Milliseconds 25}while($watch.ElapsedMilliseconds -lt 10000)
 Assert ($cleanupRaceMembers.Count -ge 2) 'cleanup race descendant readiness timeout'
 $cleanupExitFixture=New-Object CodexNative.PreviewCleanupExitFixture $cleanupRace
 try{$r=Await ($cleanupRace.StopAsync('cleanup-member-exit-race'));Assert ($cleanupExitFixture.CheckpointReached -and $cleanupExitFixture.OwnedJobEmpty -and $cleanupExitFixture.RootHandlesSignaled) 'cleanup race did not prove exact owned exit';Assert ($r.State -eq 'closed' -and $r.CleanupState -eq 'cleaned' -and -not (Test-Path -LiteralPath $cleanupRaceDirectory) -and -not (Field $cleanupRace 'exitUnconfirmed')) 'exited Job member permanently suppressed cleanup'}finally{$cleanupExitFixture.Dispose()}
 $r=Await ($cleanupRace.SetTargetAsync((Target),[CodexNative.PreviewOpenReason]::ExplicitOpen));Assert ($r.State -eq 'open') 'confirmed member exit blocked same-instance explicit reopen'
 $watch.Restart();do{$cleanupReopenMembers=@(Members $cleanupRace);if($cleanupReopenMembers.Count -ge 2){break};Start-Sleep -Milliseconds 25}while($watch.ElapsedMilliseconds -lt 10000)
 Assert ($cleanupReopenMembers.Count -ge 2) 'cleanup reopen descendant readiness timeout'
 $r=Await ($cleanupRace.StopAsync('cleanup-member-reopen-finally'));Assert ($r.CleanupState -eq 'cleaned') 'ready reopened Job failed cleanup'
 # Natural exit suppresses follow; a new explicit operation may reopen.
 $short=[CodexNative.PreviewFixtures]::Create((New-Object CodexNative.PreviewFixtureHandler),$exe,'-NoProfile -NonInteractive -WindowStyle Hidden -Command "Start-Sleep -Milliseconds 300"');$controllers.Add($short)
 $null=Await ($short.SetTargetAsync((Target),[CodexNative.PreviewOpenReason]::ExplicitOpen))
 $watch.Restart();while($short.Snapshot.State -ne 'closed' -and $watch.ElapsedMilliseconds -lt 5000){Start-Sleep -Milliseconds 50}
 Assert ($short.Snapshot.State -eq 'closed' -and $short.Snapshot.ErrorCode -eq 'process_exited') 'natural exit not observed'
 $r=Await ($short.SetTargetAsync((Target),[CodexNative.PreviewOpenReason]::FollowSelection));Assert ($r.State -eq 'closed') 'natural close reopened by polling'
 $short.Dispose()
 # Disposal synchronously waits for its owned worker to stop and clean up.
 $dispose=[CodexNative.PreviewFixtures]::Create((New-Object CodexNative.PreviewFixtureHandler),$exe,$args);$controllers.Add($dispose)
 $null=Await ($dispose.SetTargetAsync((Target),[CodexNative.PreviewOpenReason]::ExplicitOpen));$disposeDir=Field $dispose 'directory';$dispose.Dispose()
 Assert (-not (Test-Path -LiteralPath $disposeDir)) 'dispose left owned profile'
 $tree.Dispose()
 $c.Dispose()
} finally {
 foreach($c in $controllers){try{$null=Await ($c.StopAsync('fixture-finally'))}finally{$c.Dispose()}}
 if($cleanupRaceExecutable){Remove-Item -LiteralPath $cleanupRaceExecutable -ErrorAction Stop}
 foreach($generated in @($captureGeometryPath,$captureMeasurePath)){if($generated -and (Test-Path -LiteralPath $generated)){Remove-Item -LiteralPath $generated -ErrorAction Stop}}
 Remove-Item -LiteralPath $helperPath -ErrorAction SilentlyContinue
 [IO.Directory]::Delete($fixtureRoot)
}
Write-Output ('native-preview selftest passed: '+$script:checks+' checks; productionEdge='+$ProductionEdge+'; realModelCalls=0')
