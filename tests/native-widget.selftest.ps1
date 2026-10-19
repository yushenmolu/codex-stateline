[CmdletBinding()]
param([string]$ScreenshotPath,[string]$ResultScreenshotPath)
$ErrorActionPreference='Stop'
& (Join-Path $PSScriptRoot '../scripts/native-widget.ps1') -LoadOnly
$script:checks=0
$clients=New-Object 'Collections.Generic.List[System.IDisposable]'
$fixtureWindows=New-Object 'Collections.Generic.List[System.Windows.Window]'
$window=$null
try {
# Project test conventions discovered: PowerShell Assert helpers, serialized in-memory fixtures,
# dispatcher PumpUntil for async controls, and try/finally ownership (widget/preview/svg selftests).
function Assert($condition,$message) { if (-not $condition) { throw $message }; $script:checks++ }
$htmlCaps=[CodexNative.WidgetClient]::Json('{"capabilities":["pelican-html-animated-v1","isolated-html-preview-v1"]}')
Assert ([CodexNative.WidgetClient]::SupportsHtml($htmlCaps)) 'paired HTML capabilities not recognized'
Assert (-not [CodexNative.WidgetClient]::SupportsHtml([CodexNative.WidgetClient]::Json('{"capabilities":["pelican-html-animated-v1"]}'))) 'single HTML capability accepted'
Assert (-not [CodexNative.WidgetClient]::SupportsHtml([CodexNative.WidgetClient]::Json('{"capabilities":["configured-defaults","pelican-svg-v2","versioned-scoring"]}'))) 'old service HTML enabled'
Assert ([CodexNative.WidgetClient]::SupportsLive([CodexNative.WidgetClient]::Json('{"capabilities":["live-telemetry-v1"]}'))) 'live capability not recognized'
foreach($cap in @('Live-telemetry-v1','live-telemetry-v1-suffix','configured-defaults')){
 Assert (-not [CodexNative.WidgetClient]::SupportsLive([CodexNative.WidgetClient]::Json(([CodexNative.WidgetClient]::Serialize(@{capabilities=@($cap)}))))) 'live capability was matched by case or substring'
}

foreach($capabilities in @(@(),@('pelican-cockpit-v1'),@('cockpit-preview-source-v1'),@('pelican-cockpit-v1','cockpit-preview-source-v1'))){
 $d=[CodexNative.WidgetClient]::Json((ConvertTo-Json -Compress @{capabilities=$capabilities}))
 Assert ([CodexNative.WidgetClient]::SupportsCockpit($d) -eq ($capabilities.Count -eq 2)) 'Cockpit capability pairing mismatch'
}
$validCaps=[CodexNative.WidgetClient]::Json('{"product":"codex-companion","protocolVersion":1,"instanceId":"11111111-1111-4111-8111-111111111111","capabilities":["configured-defaults","pelican-svg-v2","versioned-scoring","pelican-cockpit-v1","cockpit-preview-source-v1"]}')
Assert ([CodexNative.WidgetClient]::ValidateCapabilities($validCaps) -eq '11111111-1111-4111-8111-111111111111' -and [CodexNative.WidgetClient]::SupportsCockpit($validCaps)) 'valid Cockpit capabilities incompatible'
$svg='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M0 0 h100 v100 h-100 z M25 25 v50 h50 v-50 z"/></svg>'
$r=[CodexNative.SafeSvg]::Parse($svg)
Assert ($null -ne $r.Image) ($r.Error)
$drawing=$r.Image.Drawing.Children[1].Children[0].Children[0].Children[0]
Assert ($drawing.Brush.Color -eq [Windows.Media.Colors]::Black) 'default black fill failed'
Assert ($null -eq $drawing.Pen) 'default no stroke failed'
Assert (-not $drawing.Geometry.FillContains((New-Object Windows.Point 50,50))) 'nonzero winding hole failed'
$p=[CodexNative.SafeSvg]::Transform('translate(10 20) scale(2)').Transform((New-Object Windows.Point 3,4))
Assert ($p.X -eq 16 -and $p.Y -eq 28) 'transform order wrong'
$r=[CodexNative.SafeSvg]::Parse('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 100 100"><g fill="red"><rect width="100" height="100"/></g></svg>')
Assert ($r.Image.Drawing.Children[1].Transform.Matrix.OffsetX -eq 50) 'viewBox centering failed'
Assert ($r.Image.Drawing.Children[1].Children[0].Children[0].Children[0].Children[0].Brush.Color -eq [Windows.Media.Colors]::Red) 'inheritance failed'
foreach($bad in @('<!DOCTYPE svg [<!ENTITY a SYSTEM "file:///C:/Windows/win.ini">]><svg xmlns="http://www.w3.org/2000/svg">&a;</svg>','<?evil test?><svg xmlns="http://www.w3.org/2000/svg"/>','<svg xmlns="http://www.w3.org/2000/svg"><image href="https://invalid/"/></svg>','<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1" style="fill:red"/></svg>','<svg xmlns="http://www.w3.org/2000/svg"><path d="M NaN 0"/></svg>','<svg xmlns="http://www.w3.org/2000/svg"><g transform="scale(1000000)"><g transform="scale(1000000)"><rect width="2" height="2"/></g></g></svg>',('<svg xmlns="http://www.w3.org/2000/svg">'+('<g>'*33)+('</g>'*33)+'</svg>'),('<svg xmlns="http://www.w3.org/2000/svg">'+('<rect width="1" height="1"/>'*4097)+'</svg>'),('<svg xmlns="http://www.w3.org/2000/svg"><path d="'+('M0 0 '*7000)+'"/></svg>'))) { Assert ($null -eq [CodexNative.SafeSvg]::Parse($bad).Image) 'unsafe SVG accepted' }
Add-Type -ReferencedAssemblies @('System.dll','System.Core.dll','System.Net.Http.dll') -TypeDefinition @'
using System;using System.IO;using System.Net;using System.Net.Http;using System.Threading;using System.Threading.Tasks;
public class NativeFixtureHandler:HttpMessageHandler {public volatile bool Waiting;public TaskCompletionSource<bool> Release=new TaskCompletionSource<bool>();public string InstanceId="12345678-1234-1234-1234-123456789abc";public string Payload;public string ErrorCode;public int Status=400;public int Mode,Posts,NonceCalls,Requests;public bool DisposedStream,Origin;public string Route,RouteCode;public int RouteStatus;public volatile bool RouteWaiting;public volatile int RouteHits;public TaskCompletionSource<bool> RouteRelease=new TaskCompletionSource<bool>();public volatile bool UsageWaiting;public int UsageHits;public string UsagePayload,UsageStalePayload;public TaskCompletionSource<bool> UsageHeldRelease=new TaskCompletionSource<bool>();public TaskCompletionSource<bool> UsageFinalRelease=new TaskCompletionSource<bool>();
  public bool Live,HoldLive,FailLive;public string LastLiveQuery,LivePayload;public int LiveHits;public TaskCompletionSource<bool> LiveRelease=new TaskCompletionSource<bool>();
  protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage req,CancellationToken token){Interlocked.Increment(ref Requests);Origin=req.Headers.Contains("Origin");string path=req.RequestUri.AbsolutePath;if(req.Method==HttpMethod.Post)Posts++;if(Mode==1)await Task.Delay(500,token);if(path=="/api/capabilities")return Response((@"{'product':'codex-companion','protocolVersion':1,'capabilities':['configured-defaults','pelican-svg-v2','versioned-scoring'"+(Live?",'live-telemetry-v1'":"")+@"],'instanceId':'12345678-1234-1234-1234-123456789abc'}").Replace((char)39,(char)34).Replace("12345678-1234-1234-1234-123456789abc",InstanceId));if(path=="/api/nonce"){NonceCalls++;var r=Response("{}");r.Headers.Add("X-Codex-Companion-Nonce","fixture");return r;}if(Mode==4&&req.Method==HttpMethod.Post&&Posts==1){var r=Response(@"{'error':{'code':'nonce_invalid'}}".Replace((char)39,(char)34));r.StatusCode=HttpStatusCode.Forbidden;return r;}if((Mode==7||Mode==8)&&path=="/api/benchmark"){Waiting=true;await Release.Task;if(Mode==8)throw new HttpRequestException("private-secret");return Response("{}");}if(Mode==6){var error=Response("{"+(char)34+"error"+(char)34+": {"+(char)34+"code"+(char)34+":"+(char)34+ErrorCode+(char)34+","+(char)34+"message"+(char)34+":"+(char)34+"private-secret diagnostics"+(char)34+"}}");error.StatusCode=(HttpStatusCode)Status;return error;}if(Mode==2||Mode==3){var r=new HttpResponseMessage(HttpStatusCode.OK);r.Content=new StreamContent(new Slow(this,Mode==3));return r;}if(Mode==5){var r=Response("{}");r.Content.Headers.ContentLength=16777217;return r;}if(Route=="hold"&&path=="/api/telemetry"){RouteHits++;RouteWaiting=true;if(!RouteRelease.Task.Wait(8000))throw new TimeoutException("held telemetry was never released");return Response("{}");}if(Route=="status"){var scripted=Response("{"+(char)34+"error"+(char)34+":{"+(char)34+"code"+(char)34+":"+(char)34+RouteCode+(char)34+"}}");scripted.StatusCode=(HttpStatusCode)RouteStatus;return scripted;}if(path=="/api/live"){Interlocked.Increment(ref LiveHits);LastLiveQuery=req.RequestUri.Query;if(HoldLive)await LiveRelease.Task;if(FailLive)throw new HttpRequestException("fixture live disconnected");return Response(LivePayload??Payload??"{}");}if(path=="/api/usage"){int hit=Interlocked.Increment(ref UsageHits);UsageWaiting=true;if(hit==1)return UsageResponse(UsagePayload??Payload??"{}");if(hit==2){var held=new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);UsageHeldRelease=held;return UsageResponse(UsageStalePayload??UsagePayload??"{}",held.Task);}if(hit==3){var final=new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);UsageFinalRelease=final;return UsageResponse(UsagePayload??Payload??"{}",final.Task);}return UsageResponse(UsagePayload??Payload??"{}");}return Response(Payload??"{}");}
  static HttpResponseMessage UsageResponse(string text,Task gate=null){if(gate==null)return Response(text);return new HttpResponseMessage(HttpStatusCode.OK){Content=new StreamContent(new GatedStream(gate,text))};}

  public sealed class GatedStream:Stream {readonly Task gate;readonly byte[] bytes;int offset;public GatedStream(Task g,string text){gate=g;bytes=System.Text.Encoding.UTF8.GetBytes(text);}public override async Task<int> ReadAsync(byte[] buffer,int offset,int count,CancellationToken token){await gate.ConfigureAwait(false);return Read(buffer,offset,count);}public override int Read(byte[] buffer,int offset,int count){int n=Math.Min(count,bytes.Length-this.offset);if(n<=0)return 0;Array.Copy(bytes,this.offset,buffer,offset,n);this.offset+=n;return n;}public override bool CanRead{get{return true;}}public override bool CanSeek{get{return false;}}public override bool CanWrite{get{return false;}}public override long Length{get{return bytes.Length;}}public override long Position{get{return offset;}set{throw new NotSupportedException();}}public override void Flush(){}public override long Seek(long o,SeekOrigin s){throw new NotSupportedException();}public override void SetLength(long v){throw new NotSupportedException();}public override void Write(byte[] b,int o,int c){throw new NotSupportedException();}}
 static HttpResponseMessage Response(string s){return new HttpResponseMessage(HttpStatusCode.OK){Content=new StringContent(s)};}
 class Slow:Stream {NativeFixtureHandler h;bool trickle;public Slow(NativeFixtureHandler owner,bool t){h=owner;trickle=t;}public override async Task<int> ReadAsync(byte[] b,int o,int c,CancellationToken token){await Task.Delay(trickle?25:500,token);b[o]=32;return 1;}protected override void Dispose(bool d){h.DisposedStream=true;base.Dispose(d);}public override bool CanRead{get{return true;}}public override bool CanSeek{get{return false;}}public override bool CanWrite{get{return false;}}public override long Length{get{throw new NotSupportedException();}}public override long Position{get{throw new NotSupportedException();}set{throw new NotSupportedException();}}public override int Read(byte[] b,int o,int c){throw new NotSupportedException();}public override void Flush(){}public override long Seek(long o,SeekOrigin s){throw new NotSupportedException();}public override void SetLength(long v){throw new NotSupportedException();}public override void Write(byte[] b,int o,int c){throw new NotSupportedException();}}
}
'@
function PumpUntil($predicate,[int]$ms=2500) {
    $watch=[Diagnostics.Stopwatch]::StartNew()
    while (-not (& $predicate)) {
        if($watch.ElapsedMilliseconds -gt $ms){throw 'fixture deadline exceeded'}
        $frame=New-Object Windows.Threading.DispatcherFrame
        $null=[Windows.Threading.Dispatcher]::CurrentDispatcher.BeginInvoke([Windows.Threading.DispatcherPriority]::Background,[Action]{ $frame.Continue=$false })
        [Windows.Threading.Dispatcher]::PushFrame($frame)
    }
}
function PumpUntilLabeled([string]$label,[scriptblock]$predicate,[int]$ms=8000) {
    try { PumpUntil $predicate $ms }
    catch { throw ($label+': '+$_.Exception.Message) }
}
function ClientInFlight($client,[string]$kind) {
    # Direct PowerShell calls coerce a null string path to ""; reflection preserves CLR null.
    return $client.GetType().GetMethod('IsInFlight').Invoke($client,[object[]]@($kind,$null))
}
foreach($mode in 1,2,3) {
    $handler=New-Object NativeFixtureHandler; $handler.Mode=$mode
    $client=New-Object CodexNative.WidgetClient $false,$handler; $clients.Add($client)
    $task=$client.RequestAsync('/api/telemetry',$null,262144,100)
    PumpUntil { $task.IsCompleted }
    Assert ($task.IsCanceled -or $task.IsFaulted) 'send/body/trickle deadline failed'
    if($mode -gt 1){Assert $handler.DisposedStream 'timeout stream not disposed'}
    Assert $handler.Origin 'Origin missing'
    $client.Dispose()
}
$handler=New-Object NativeFixtureHandler;$handler.Mode=4
$client=New-Object CodexNative.WidgetClient $false,$handler; $clients.Add($client)
Assert ($client.Start('mutation','/api/benchmark/run',@{requestId='fixture-id';model='configured';reasoningEffort='configured'})) 'first submit rejected'
Assert (-not $client.Start('mutation','/api/benchmark/run',@{})) 'duplicate submit accepted'
$script:event=$null
PumpUntil { $e=$null;if($client.Dequeue([ref]$e)){$script:event=$e;$true}else{$false} }
Assert ($null -eq $script:event.Error -and $handler.Posts -eq 2 -and $handler.NonceCalls -eq 2) 'nonce retry-once failed'
$client.Dispose()
$handler=New-Object NativeFixtureHandler;$handler.Mode=5
$client=New-Object CodexNative.WidgetClient $false,$handler; $clients.Add($client)
$task=$client.RequestAsync('/api/benchmark',$null,[CodexNative.WidgetClient]::HistoryCap,1000)
PumpUntil { $task.IsCompleted }
Assert ($task.IsFaulted -and $task.Exception.InnerException.Code -eq 'history_too_large') 'history cap not distinguished'
$handler.Mode=0;$task=$client.RequestAsync('/api/telemetry',$null,262144,1000);PumpUntil {$task.IsCompleted}
Assert (-not $task.IsFaulted) 'history error affected telemetry'
$client.Dispose()
$handler=New-Object NativeFixtureHandler;$client=New-Object CodexNative.WidgetClient $true,$handler; $clients.Add($client)
$task=$client.RequestAsync('/api/benchmark/run','{}',100,100);PumpUntil {$task.IsCompleted}
Assert ($task.IsFaulted -and $handler.Posts -eq 0) 'fixture allowed live POST'
$client.Dispose()
$handler=New-Object NativeFixtureHandler
$client=New-Object CodexNative.WidgetClient $false,$handler; $clients.Add($client)
# Actual escaped UTF-8 history at the supported cap, then one byte over.
foreach($version in 'pelican-v1','pelican-svg-v2') {
    $seed=[CodexNative.WidgetClient]::Serialize(@{runs=@(@{rubricVersion=$version;caseResults=@(@{answer=('中"'+[char]92)*1000})})})
    $size=[Text.Encoding]::UTF8.GetByteCount($seed)
    $handler.Payload=$seed+(' '*([CodexNative.WidgetClient]::HistoryCap-$size))
    $task=$client.RequestAsync('/api/benchmark',$null,[CodexNative.WidgetClient]::HistoryCap,5000)
    PumpUntil {$task.IsCompleted} 7000
    Assert (-not $task.IsFaulted) 'serialized history at cap rejected'
    $handler.Payload+=' '
    $task=$client.RequestAsync('/api/benchmark',$null,[CodexNative.WidgetClient]::HistoryCap,5000)
    PumpUntil {$task.IsCompleted} 7000
    Assert ($task.IsFaulted -and $task.Exception.InnerException.Code -eq 'history_too_large') 'serialized history above cap accepted'
}
$client.Dispose()
$handler=New-Object NativeFixtureHandler;$handler.Mode=2
$client=New-Object CodexNative.WidgetClient $false,$handler; $clients.Add($client)
$task=$client.RequestAsync('/api/telemetry',$null,262144,5000)
$client.Dispose()
PumpUntil {$task.IsCompleted}
Assert ($task.IsCanceled -or $task.IsFaulted) 'close did not cancel request'
$fence=([char]96).ToString()*3
Assert ($null -ne [CodexNative.SafeSvg]::Parse($fence+'svg'+[char]10+$svg+[char]10+$fence).Image) 'fenced SVG rejected'
$r=[CodexNative.SafeSvg]::Parse($svg.Replace('<path','<path fill-rule="evenodd"'))
Assert ($null -ne $r.Image -and -not $r.Image.Drawing.Children[1].Children[0].Children[0].Children[0].Geometry.FillContains((New-Object Windows.Point 50,50))) 'evenodd hole failed'
# Exact HTTP whitelist: status/message/substring must never smuggle diagnostics.
$handler=New-Object NativeFixtureHandler;$handler.Mode=6
$client=New-Object CodexNative.WidgetClient $false,$handler; $clients.Add($client)
foreach($code in 'authentication_failed','rate_limited','model_unavailable','process_failed','timed_out','score_invalid','service_unavailable','benchmark_unavailable','run_active','nonce_invalid','request_id_conflict') {
    $handler.ErrorCode=$code
    $task=$client.RequestAsync('/api/telemetry',$null,262144,1000);PumpUntil {$task.IsCompleted}
    Assert ($task.IsFaulted -and $task.Exception.InnerException.Code -ceq $code) "HTTP whitelist failed: $code"
    Assert ([CodexNative.WidgetClient]::ErrorDescription($code) -match '[一-龥]' -and [CodexNative.WidgetClient]::ErrorDescription($code) -notmatch 'private-secret') 'description not localized'
}
foreach($code in 'private-secret','authentication_failed private-secret','AUTHENTICATION_FAILED','rate_limited_suffix','') {
    $handler.ErrorCode=$code
    $task=$client.RequestAsync('/api/telemetry',$null,262144,1000);PumpUntil {$task.IsCompleted}
    Assert ($task.IsFaulted -and $task.Exception.InnerException.Code -eq 'request_failed') 'HTTP exact whitelist bypassed'
}
$client.Dispose()
# Stale queued successes AND failures are discarded on a new service generation.
$handler=New-Object NativeFixtureHandler;$client=New-Object CodexNative.WidgetClient $false,$handler; $clients.Add($client)
$flags=[Reflection.BindingFlags]'Instance,NonPublic'
$queue=$client.GetType().GetField('queue',$flags).GetValue($client)
foreach($staleError in @($null,'disconnected')) {
    $old=New-Object CodexNative.ClientEvent;$old.Kind='history';$old.Error=$staleError;$old.Generation=0;$queue.Enqueue($old)
}
$client.GetType().GetField('generation',$flags).SetValue($client,1)
$event=$null
Assert (-not $client.Dequeue([ref]$event)) 'stale queued result/error delivered'
$client.Dispose()
# A real in-flight old history response/error must disappear after serialized re-handshake.
foreach($mode in 7,8) {
    $handler=New-Object NativeFixtureHandler;$handler.Mode=$mode
    $client=New-Object CodexNative.WidgetClient $false,$handler; $clients.Add($client)
    Assert ($client.Start('history','/api/benchmark',$null)) 'history start rejected'
    PumpUntil {$handler.Waiting}
    $handler.InstanceId='aaaaaaaa-1234-1234-1234-123456789abc'
    Assert ($client.Start('telemetry','/api/telemetry',$null)) 'replacement handshake start rejected'
    $script:newEvent=$null
    PumpUntil {$e=$null;if($client.Dequeue([ref]$e)){$script:newEvent=$e;$true}else{$false}}
    Assert ($script:newEvent.Kind -eq 'telemetry' -and $null -eq $script:newEvent.Error) 'replacement handshake failed'
    $handler.Release.SetResult($true)
    PumpUntil {$client.GetType().GetField('inflight',$flags).GetValue($client).Count -eq 0}
    $e=$null
    Assert (-not $client.Dequeue([ref]$e)) 'in-flight old success/error leaked after generation change'
    $client.Dispose()
}
function Visuals($root) {
    $root
    for($i=0;$i -lt [Windows.Media.VisualTreeHelper]::GetChildrenCount($root);$i++){ Visuals ([Windows.Media.VisualTreeHelper]::GetChild($root,$i)) }
}
function Click($button){$button.RaiseEvent((New-Object Windows.RoutedEventArgs ([Windows.Controls.Primitives.ButtonBase]::ClickEvent)))}
function UiText($root){((Visuals $root | Where-Object {$_ -is [Windows.Controls.TextBlock]} | ForEach-Object {$_.Text}) -join ' ')}
function VisibleUiText($root){((Visuals $root | Where-Object {$_ -is [Windows.Controls.TextBlock] -and $_.IsVisible}) | ForEach-Object {$_.Text}) -join ' '}
function ResetTelemetryFixture($target,[string]$taskId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') {
    # A real selection boundary clears the constructor's valid telemetry without touching cache fields.
    $other='99999999-9999-4999-8999-999999999999'
    $target.FixtureTasks(([CodexNative.WidgetClient]::Serialize(@{tasks=@(@{id=$other;title='Reset fixture'},@{id=$taskId;title='Telemetry fixture'});sampledAt='2026-10-16T09:00:05.000Z';stale=$false;truncated=$false})))
    $target.TaskControl.SelectedValue=$other
    $target.TaskControl.SelectedValue=$taskId
    Assert ($target.SelectedTask -ceq $taskId -and $target.MetricControls[0].Text -ceq '—' -and $target.MetricControls[3].Text -ceq '—') 'fresh telemetry fixture did not cross a real task boundary'
}
# Mode selection belongs to the main window, independent of Results/history.
$window=New-Object CodexNative.WidgetWindow $true;$fixtureWindows.Add($window)
$c=$window.GetType().GetField('client',$flags).GetValue($window);$c.GetType().GetField('cockpitSupported',$flags).SetValue($c,$true)
$window.FixtureAcceptRun=$true;$window.FixtureRun()
$submitted=[CodexNative.WidgetClient]::Json([CodexNative.WidgetClient]::Serialize($window.SubmittedRequest))
Assert ($submitted.mode -ceq 'cockpit') 'main Run before Results must default to Cockpit'
$window.FixtureEvent('run','run_active',$null)
$window.Show();$window.OpenResults()
$runButton=$window.GetType().GetField('run',$flags).GetValue($window)
Assert ($window.ModeControl.SelectedValue -ceq 'cockpit' -and @($window.ModeControl.ItemsSource).Count -eq 1 -and @($window.ModeControl.ItemsSource)[0].Value -ceq 'cockpit' -and $runButton.Content -match 'Cockpit') 'initial selector or Run button did not expose only Cockpit'
$staticHistory=@{runId="mode-static-history";mode="static";status="completed";caseSetVersion="pelican-svg-v2";rubricVersion="pelican-svg-v2";caseResults=@()}
$window.FixtureEvent("history",$null,([CodexNative.WidgetClient]::Serialize(@{latestRun=$staticHistory;runs=@($staticHistory)})))
Assert ($window.SelectedRunId -eq "mode-static-history" -and $null -eq $window.HistoryControl -and $window.ModeControl.SelectedValue -eq "cockpit") 'static history changed the next-run Cockpit mode'
$staticHistory.Remove("mode")
$window.FixtureEvent("history",$null,([CodexNative.WidgetClient]::Serialize(@{latestRun=$staticHistory;runs=@($staticHistory)})))
Assert ($window.SelectedRunId -eq "mode-static-history" -and $null -eq $window.HistoryControl -and $window.ModeControl.SelectedValue -eq "cockpit") 'legacy history without a mode changed the next-run Cockpit mode'
$modeClient=$window.GetType().GetField('client',$flags).GetValue($window)
$cockpitCapability=$modeClient.GetType().GetField('cockpitSupported',$flags)
$window.ResultsWindow.Close();$window.OpenResults()
Assert ($window.ModeControl.SelectedValue -ceq 'cockpit' -and @($window.ModeControl.ItemsSource).Count -eq 1 -and $runButton.Content.ToString().Contains('Cockpit')) 'close/reopen changed the only supported next-run mode'
$window.FixtureRun()
$submitted=[CodexNative.WidgetClient]::Json([CodexNative.WidgetClient]::Serialize($window.SubmittedRequest))
Assert ($submitted.mode -ceq 'cockpit' -and $window.IsBusy) 'Run did not snapshot Cockpit mode'
$window.FixtureEvent('run','run_active',$null)
$cockpitCapability.SetValue($modeClient,$false)
$window.ResultsWindow.Close();$window.OpenResults()
$prior=$window.SubmittedRequest;$window.FixtureRun()
Assert (-not $window.IsBusy -and [object]::ReferenceEquals($prior,$window.SubmittedRequest) -and $window.BenchState -eq '当前服务不支持 Cockpit 源码预览') 'reopened Cockpit mode bypassed capability gate'
$cockpitChoice=@($window.ModeControl.ItemsSource)[0]
Assert ($cockpitChoice.Value -ceq 'cockpit' -and -not $cockpitChoice.Enabled) 'unsupported Cockpit choice enabled'
$window.Close()
$window=New-Object CodexNative.WidgetWindow $true;$fixtureWindows.Add($window)
$c=$window.GetType().GetField('client',$flags).GetValue($window)
foreach($state in 'empty','ambiguous','unavailable') {
    $freshWindow=New-Object CodexNative.WidgetWindow $true;$fixtureWindows.Add($freshWindow)
    try {
        ResetTelemetryFixture $freshWindow
        $freshWindow.FixtureState(('{"state":"'+$state+'"}'))
        Assert (-not $freshWindow.MetricsVisible -and -not $freshWindow.ContextVisible -and -not $freshWindow.CurrentTurnVisible -and -not $freshWindow.AgentsVisible -and -not $freshWindow.TaskTitleVisible -and -not $freshWindow.TaskFlagsVisible -and -not $freshWindow.EffortVisible) 'fresh no-data telemetry displayed placeholder chrome'
    } finally {$freshWindow.Close()}
    $window.FixtureState(('{"state":"'+$state+'"}'))
    Assert ($window.DisplayState -ne '● 活动中') 'fixture state did not change'
    Assert ($window.MetricsVisible -and $window.ContextVisible -and $window.EffortVisible -and $window.MetricControls[2].Text -ceq '15,740' -and $window.SelectedUsageStateControl.Text -match '上次有效数据') 'seeded no-data telemetry erased valid same-conversation data or historical provenance'
    Assert (-not $window.CurrentTurnVisible -and -not $window.AgentsVisible -and -not $window.TaskTitleVisible -and -not $window.TaskFlagsVisible) 'seeded no-data telemetry restored dense placeholder chrome'
}
$window.SetFixture()
# First open and same selection reopen must populate fresh controls.
$window.Show();$window.OpenResults();$window.ResultsWindow.UpdateLayout()
$firstResults=$window.ResultsWindow
$firstCases=$window.GetType().GetField('cases',$flags).GetValue($window)
Assert ($firstResults.IsVisible -and $null -ne $firstResults.Content -and $firstCases.Children.Count -gt 0) 'first Results open has no visible content'
$firstId=$window.SelectedRunId
$window.ResultsWindow.Close();$window.OpenResults();$window.ResultsWindow.UpdateLayout()
$reopenedCases=$window.GetType().GetField('cases',$flags).GetValue($window)
Assert ($window.ResultsWindow.IsVisible -and $window.SelectedRunId -ceq $firstId -and -not [object]::ReferenceEquals($firstResults,$window.ResultsWindow) -and -not [object]::ReferenceEquals($firstCases,$reopenedCases) -and $reopenedCases.Children.Count -eq $firstCases.Children.Count) 'same selected result reopen left a blank control tree'
# Inject a pre-Show RenderKey exception without changing production hooks.
$window.ResultsWindow.Close()
$snapshotField=$window.GetType().GetField('snapshot',$flags)
$goodSnapshot=$snapshotField.GetValue($window)
$badScores=New-Object 'Collections.Generic.Dictionary[string,object]'
$badScores.Add('cycle',$badScores)
$badRun=[CodexNative.WidgetClient]::Json([CodexNative.WidgetClient]::Serialize(@{runId='construction-failure';status='completed';caseResults=@(@{caseId='pelican-svg';status='completed';answer='fixture'})}))
$badRun['caseResults'][0]['scores']=$badScores
$badSnapshot=New-Object 'Collections.Generic.Dictionary[string,object]'
$badSnapshot.Add('latestRun',$badRun);$badSnapshot.Add('runs',[object[]]@($badRun))
$snapshotField.SetValue($window,$badSnapshot)
$openFailure=$null
try {$window.OpenResults()} catch {$openFailure=$_.Exception;while($null -ne $openFailure.InnerException){$openFailure=$openFailure.InnerException}}
Assert ($null -ne $openFailure -and $openFailure -is [InvalidOperationException]) 'construction exception was swallowed or changed'
Assert ($null -eq $window.ResultsWindow) 'failed pre-Show construction retained an unusable Results window'
$snapshotField.SetValue($window,$goodSnapshot)
$window.OpenResults();$window.ResultsWindow.UpdateLayout()
Assert ($window.ResultsWindow.IsVisible -and $window.GetType().GetField('cases',$flags).GetValue($window).Children.Count -gt 0) 'Results could not recover after construction failure'
PumpUntil { $window.Heartbeats -ge 12 }
$expectedHeight=[Math]::Min(320,[Math]::Max(1,[Windows.SystemParameters]::WorkArea.Height))
$expectedWidth=[Math]::Min(380,[Math]::Max(1,[Windows.SystemParameters]::WorkArea.Width))
Assert ($window.ActualWidth -eq $expectedWidth -and $window.ActualHeight -eq $expectedHeight) 'compact widget dimensions failed'
# Shared controls retain keyboard focus and keep the arrow outside the selected label.
$mainButtons=@(Visuals $window | Where-Object {$_ -is [Windows.Controls.Button] -and $_.IsVisible} | Where-Object {[Windows.Automation.AutomationProperties]::GetAutomationId($_) -in @('Close','Pin','Settings','Results','Usage')})
Assert ($mainButtons.Count -eq 5 -and @($mainButtons | Where-Object {-not $_.Focusable -or -not $_.IsTabStop}).Count -eq 0 -and @($mainButtons | ForEach-Object {[Windows.Automation.AutomationProperties]::GetAutomationId($_)} | Sort-Object -Unique).Count -eq 5) 'main actions are missing, have duplicate AutomationIds or cannot receive keyboard focus'
foreach($button in $mainButtons){Assert ($null -ne $button.Template.FindName('FocusRing',$button) -and $null -ne $button.Template.FindName('Interaction',$button)) 'button focus or interaction feedback missing'}
$usageEntry=@($mainButtons | Where-Object {[Windows.Automation.AutomationProperties]::GetAutomationId($_) -ceq 'Usage'})[0]
$usageEntryStack=$usageEntry.Parent
Assert ($usageEntry.Content.ToString() -ceq '用量统计 ↗' -and $usageEntryStack -is [Windows.Controls.StackPanel] -and [object]::ReferenceEquals($usageEntryStack.Children[$usageEntryStack.Children.Count-1],$usageEntry)) 'usage entry is missing from the bottom of the main body'
Assert ($null -eq $window.UsageWindow -and @(Visuals $window | Where-Object {[Windows.Automation.AutomationProperties]::GetAutomationId($_) -like 'Local*' -or [Windows.Automation.AutomationProperties]::GetAutomationId($_) -in @('UsageBarChart','UsageRangeSlider') -or $_ -is [Windows.Controls.Slider]}).Count -eq 0) 'main window contains the local usage surface or opened its window eagerly'
$taskSelector=$window.TaskControl
$selectedLabel=$taskSelector.Template.FindName('ContentSite',$taskSelector)
$selectorArrow=$taskSelector.Template.FindName('Arrow',$taskSelector)
Assert ($null -ne $selectedLabel -and $selectedLabel.TextTrimming -eq [Windows.TextTrimming]::CharacterEllipsis -and $taskSelector.Focusable -and $taskSelector.IsTabStop) 'task selector does not trim long labels or retain keyboard access'
$labelRight=$selectedLabel.TransformToAncestor($taskSelector).Transform((New-Object Windows.Point $selectedLabel.ActualWidth,0)).X
$arrowLeft=$selectorArrow.TransformToAncestor($taskSelector).Transform((New-Object Windows.Point 0,0)).X
Assert ($selectedLabel.ActualWidth -gt 0 -and $labelRight+2 -le $arrowLeft) 'task selector label overlaps its dropdown arrow'
$null=$window.Activate();$null=[Windows.Input.Keyboard]::Focus($taskSelector);$window.UpdateLayout()
Assert ($taskSelector.IsKeyboardFocusWithin -and $taskSelector.Template.FindName('FocusRing',$taskSelector).Opacity -gt 0) 'task selector keyboard focus is invisible'
$taskPinButton=$window.GetType().GetField('taskPin',$flags).GetValue($window)
$null=[Windows.Input.Keyboard]::Focus($taskPinButton);$window.UpdateLayout()
Assert ($taskPinButton.IsKeyboardFocused -and $taskPinButton.Template.FindName('FocusRing',$taskPinButton).Opacity -gt 0) 'button keyboard focus is invisible'
# Real WPF controls on the STA dispatcher, fixture never performs HTTP POST.
Assert ($window.ModelControl.SelectedValue -ceq 'configured') 'configured payload value changed'
Assert ($window.ModelControl.SelectedItem.Label -eq '当前配置') 'configured label not localized'
$window.ResultsWindow.UpdateLayout()
$text=UiText $window.ResultsWindow
Assert ($text -match "下次运行配置" -and $text -match "运行控制" -and $text -match "作品结果" -and $text -notmatch "评分|基线|源码") "three areas incorrect"
$nextSettings=$window.GetType().GetField('nextSettings',$flags).GetValue($window)
$settingsViewport=$window.GetType().GetField('settingsViewport',$flags).GetValue($window)
Assert ($null -ne $nextSettings -and -not $nextSettings.IsExpanded -and [Windows.Automation.AutomationProperties]::GetName($nextSettings) -ceq '下次运行配置' -and -not $window.ModelControl.IsVisible) 'next-run settings are not initially collapsed or clearly labelled'
$nextSettings.IsExpanded=$true;$window.ResultsWindow.UpdateLayout()
Assert ($window.ModelControl.IsVisible -and $window.ModeControl.IsVisible -and $settingsViewport.ActualHeight -le $settingsViewport.MaxHeight+1 -and $settingsViewport.VerticalScrollBarVisibility -eq [Windows.Controls.ScrollBarVisibility]::Auto) 'expanded model/mode settings are hidden or unbounded'
$nextSettings.IsExpanded=$false;$window.ResultsWindow.UpdateLayout()
# Next-run summary must reflect the committed selection, never the previous ComboBox value.
# ComboBox.SelectedValue still holds the OLD value inside SelectionChanged, so a stale read here
# is exactly the one-step lag this regression and its switch-back step pin down.
$nextRunModels=$window.ModelControl
$nextRunEfforts=$window.GetType().GetField('efforts',$flags).GetValue($window)
$nextRunModes=$window.ModeControl
$nextRunSummaryControl=$window.GetType().GetField('nextRunSummary',$flags).GetValue($window)
$nextRunArtwork=$window.GetType().GetField('currentWork',$flags).GetValue($window)
$nextRunArtworkBefore=$nextRunArtwork.Text
$nextRunModels.SelectedValue='example-provider/deepseek-v4.1-flash'
Assert ($nextRunSummaryControl.Text -match 'example-provider/deepseek-v4\.1-flash' -and $nextRunSummaryControl.Text -match '当前配置' -and $nextRunSummaryControl.Text -match 'Cockpit') 'summary lagged behind the model switch'
Assert ([string]$nextRunModels.ToolTip -ceq 'example-provider/deepseek-v4.1-flash' -and [Windows.Automation.AutomationProperties]::GetHelpText($nextRunModels) -ceq '模型 example-provider/deepseek-v4.1-flash') 'model tooltip or accessible value lagged behind the switch'
$nextRunEfforts.SelectedValue='high'
Assert ($nextRunSummaryControl.Text -match '高' -and $nextRunSummaryControl.Text -match 'example' -and $nextRunSummaryControl.Text -match 'Cockpit') 'summary lagged behind the effort switch'
Assert ([string]$nextRunEfforts.ToolTip -ceq 'high' -and [Windows.Automation.AutomationProperties]::GetHelpText($nextRunEfforts) -ceq '推理强度 high') 'effort tooltip or accessible value lagged behind the switch'
Assert (@($nextRunModes.ItemsSource).Count -eq 1 -and $nextRunModes.SelectedValue -ceq 'cockpit' -and $nextRunSummaryControl.Text -match 'Cockpit' -and $nextRunSummaryControl.Text -match '高' -and $nextRunSummaryControl.Text -match 'example') 'next-run controls exposed a removed mode or lost the Cockpit summary'
Assert ([string]$nextRunModes.ToolTip -ceq 'cockpit' -and [Windows.Automation.AutomationProperties]::GetHelpText($nextRunModes) -ceq '作品形式 Cockpit 网页动画') 'Cockpit tooltip or accessible mode is incorrect'
# Switching a value back must land on the final value too, not the previous one.
$nextRunModels.SelectedValue='configured'
Assert ($nextRunSummaryControl.Text -match '当前配置' -and $nextRunSummaryControl.Text -notmatch 'example') 'summary kept the previous model after switching back'
Assert ([string]$nextRunModels.ToolTip -ceq 'configured' -and [Windows.Automation.AutomationProperties]::GetHelpText($nextRunModels) -ceq '模型 configured') 'model tooltip kept the previous value after switching back'
$nextRunEfforts.SelectedValue='configured'
Assert ($nextRunSummaryControl.Text -match '当前配置' -and $nextRunSummaryControl.Text -match 'Cockpit' -and $nextRunSummaryControl.Text -notmatch '高|SVG') 'summary did not return to the defaults after switching back'
Assert ($nextRunArtwork.Text -ceq $nextRunArtworkBefore) 'next-run switches relabelled the historical current artwork'
# Settings window: one draggable header, a single close action, a vertical equal-width field stack and keyboard focus.
$window.OpenSettings();$settingsWindow=$window.SettingsWindow
Assert ($null -ne $settingsWindow -and $settingsWindow.IsVisible) 'settings window did not open'
$settingsWindow.UpdateLayout()
$settingsModels=$window.SettingsModelControl;$settingsEfforts=$window.SettingsEffortControl;$settingsModes=$window.SettingsModeControl
$settingsSummary=$window.SettingsSummaryControl
Assert ($settingsWindow.Title -ceq '设置' -and [Windows.Automation.AutomationProperties]::GetAutomationId($settingsWindow) -ceq 'SettingsWindow') 'settings window title or AutomationId mismatch'
Assert ($settingsWindow.WindowStyle -eq [Windows.WindowStyle]::None -and $settingsWindow.ResizeMode -eq [Windows.ResizeMode]::NoResize -and $settingsWindow.AllowsTransparency -and $settingsWindow.Background -eq [Windows.Media.Brushes]::Transparent) 'settings window is not a fixed transparent frame'
$settingsButtons=@(Visuals $settingsWindow | Where-Object {$_ -is [Windows.Controls.Button] -and $_.IsVisible})
$settingsClose=@($settingsButtons | Where-Object {[Windows.Automation.AutomationProperties]::GetAutomationId($_) -ceq 'CloseSettings'})
Assert ($settingsButtons.Count -eq 1 -and $settingsClose.Count -eq 1 -and $settingsClose[0].Content.ToString() -ceq '×' -and $settingsClose[0].Focusable -and $settingsClose[0].IsTabStop) 'settings window has duplicate or inaccessible close actions'
$dragHandles=@(Visuals $settingsWindow | Where-Object {[string]$_.Tag -ceq 'SettingsDragHandle'})
Assert ($dragHandles.Count -eq 1 -and $dragHandles[0].IsVisible -and $dragHandles[0].IsHitTestVisible) 'settings drag handle is missing, hidden or not hit-testable'
$settingsFieldsPanel=@(Visuals $settingsWindow | Where-Object {[string]$_.Tag -ceq 'SettingsFields'})[0]
Assert ($settingsFieldsPanel -is [Windows.Controls.StackPanel] -and $settingsFieldsPanel.Children.Count -eq 3) 'settings fields are not a three-row vertical stack'
$fieldBoxes=@($settingsModels,$settingsEfforts,$settingsModes)
$fieldWidths=@($fieldBoxes | ForEach-Object {$_.ActualWidth})
$fieldPositions=@($fieldBoxes | ForEach-Object {$_.TransformToAncestor($settingsWindow).Transform((New-Object Windows.Point 0,0))})
$expectedCaptions=@('模型','推理强度','作品形式')
for($i=0;$i -lt 3;$i++) {
    $child=$settingsFieldsPanel.Children[$i]
    $label=@($child.Children | Where-Object {$_ -is [Windows.Controls.TextBlock]})[0]
    $box=@($child.Children | Where-Object {$_ -is [Windows.Controls.ComboBox]})[0]
    $labelTop=$label.TransformToAncestor($child).Transform((New-Object Windows.Point 0,0)).Y
    Assert ($child -is [Windows.Controls.StackPanel] -and $child.HorizontalAlignment -eq [Windows.HorizontalAlignment]::Stretch -and $label.Text -ceq $expectedCaptions[$i] -and $label.IsVisible -and [Math]::Abs($labelTop) -le 0.5 -and [object]::ReferenceEquals($box,$fieldBoxes[$i]) -and $box.IsVisible -and $box.Focusable -and $box.IsTabStop -and $box.HorizontalAlignment -eq [Windows.HorizontalAlignment]::Stretch) 'settings field is not in the expected order, aligned, visible or keyboard-reachable'
}
Assert ([Math]::Abs($fieldPositions[0].X-$fieldPositions[1].X) -le 1 -and [Math]::Abs($fieldPositions[1].X-$fieldPositions[2].X) -le 1) 'settings fields are not vertically aligned at the same X'
Assert ([Math]::Abs($fieldWidths[0]-$fieldWidths[1]) -le 1 -and [Math]::Abs($fieldWidths[1]-$fieldWidths[2]) -le 1 -and $fieldWidths[0] -gt 0) 'settings fields do not have a consistent width'
Assert ($fieldPositions[0].Y -lt $fieldPositions[1].Y -and $fieldPositions[1].Y -lt $fieldPositions[2].Y) 'settings field order is not model, effort, mode'
$settingsHelp=@(Visuals $settingsWindow | Where-Object {[Windows.Automation.AutomationProperties]::GetAutomationId($_) -ceq 'SettingsHelp'})[0]
$settingsHelpText='更改会立即保存为草稿，不会提交运行。Esc 关闭，Tab 切换字段。加载中或提交结果未知时字段禁用，草稿保留。'
$settingsBody=$settingsFieldsPanel.Parent
Assert ($null -ne $settingsHelp -and $settingsHelp.IsVisible -and $settingsHelp.Text -ceq '自动保存草稿，不会自动运行。' -and $settingsBody -is [Windows.Controls.StackPanel] -and [object]::ReferenceEquals($settingsBody.Children[0],$settingsFieldsPanel) -and [object]::ReferenceEquals($settingsBody.Children[1],$settingsSummary) -and [object]::ReferenceEquals($settingsBody.Children[2],$settingsHelp) -and [string]$settingsHelp.ToolTip -ceq $settingsHelpText -and [Windows.Automation.AutomationProperties]::GetHelpText($settingsHelp) -ceq $settingsHelpText) 'settings help is missing, misplaced, incomplete or inaccessible'
$workArea=[Windows.SystemParameters]::WorkArea
Assert ($settingsWindow.MinHeight -le $settingsWindow.Height -and $settingsWindow.Height -le $settingsWindow.MaxHeight -and $settingsWindow.Height -le $workArea.Height -and $settingsWindow.Height -ge 360 -and $settingsWindow.Width -le $workArea.Width) 'settings window height is outside its declared bounds or the work area'
Assert ($settingsModels.IsKeyboardFocused -and $settingsModels.SelectedValue -ceq $window.ModelControl.SelectedValue -and $settingsEfforts.SelectedValue -ceq $nextRunEfforts.SelectedValue -and $settingsModes.SelectedValue -ceq $window.ModeControl.SelectedValue) 'settings did not open on the shared draft or focus the first field'
$settingsModeChoices=@($settingsModes.ItemsSource)
Assert ($settingsModeChoices.Count -eq 1 -and $settingsModeChoices[0].Value -ceq 'cockpit' -and $settingsModeChoices[0].Enabled -and $settingsModes.SelectedValue -ceq 'cockpit') 'settings did not expose only the available Cockpit mode'
$settingsModels.SelectedValue='example-provider/deepseek-v4.1-flash';$settingsEfforts.SelectedValue='high'
Assert ($window.ModelControl.SelectedValue -ceq 'example-provider/deepseek-v4.1-flash' -and $nextRunEfforts.SelectedValue -ceq 'high' -and $window.ModeControl.SelectedValue -ceq 'cockpit' -and $nextRunSummaryControl.Text -match 'example' -and $nextRunSummaryControl.Text -match '高' -and $nextRunSummaryControl.Text -match 'Cockpit' -and $settingsSummary.Text -ceq $nextRunSummaryControl.Text) 'settings draft did not synchronize to the main controls or summaries'
$nextRunModels.SelectedValue='configured';$nextRunEfforts.SelectedValue='medium';$nextRunModes.SelectedValue='cockpit'
Assert ($settingsModels.SelectedValue -ceq 'configured' -and $settingsEfforts.SelectedValue -ceq 'medium' -and $settingsModes.SelectedValue -ceq 'cockpit' -and $settingsSummary.Text -match '当前配置' -and $settingsSummary.Text -match '中' -and $settingsSummary.Text -match 'Cockpit') 'main draft changes did not synchronize back to settings'
$nextRunEfforts.SelectedValue='configured'
$settingsHeaderButton=$window.GetType().GetField('settingsHeaderButton',$flags).GetValue($window)
Click $settingsClose[0]
Assert ($null -eq $window.SettingsWindow -and $null -eq $window.SettingsModelControl -and -not $settingsWindow.IsVisible) 'settings close did not release the window or field references'
PumpUntil {$settingsHeaderButton.IsKeyboardFocused}
Assert ($settingsHeaderButton.IsKeyboardFocused) 'settings close did not restore focus to the Settings button'
$window.OpenSettings();$settingsWindow=$window.SettingsWindow
Assert ($null -ne $settingsWindow -and $settingsWindow.IsVisible -and $window.SettingsModelControl.IsKeyboardFocused) 'settings reopen failed or did not focus the first field'
$escapeKey=[Windows.Input.KeyEventArgs]::new([Windows.Input.Keyboard]::PrimaryDevice,[Windows.PresentationSource]::FromVisual($settingsWindow),0,[Windows.Input.Key]::Escape)
$escapeKey.RoutedEvent=[Windows.UIElement]::PreviewKeyDownEvent
$settingsWindow.RaiseEvent($escapeKey)
Assert ($escapeKey.Handled -and $null -eq $window.SettingsWindow -and -not $settingsWindow.IsVisible) 'Escape did not close the settings window'
PumpUntil {$settingsHeaderButton.IsKeyboardFocused}
Assert ($settingsHeaderButton.IsKeyboardFocused) 'Escape close did not restore focus to the Settings button'
$window.FixtureEvent('history',$null,'{"activeRun":{"runId":"busy","status":"running","requestId":"busy-request"},"runs":[]}')
foreach($kind in 'history','telemetry') {$window.FixtureEvent($kind,'timeout',$null);Assert $window.IsBusy 'poll error cleared known busy state'}
$window.FixtureUnknown('unknown-request')
foreach($kind in 'history','telemetry','baseline','cancel','score') {
    $window.FixtureEvent($kind,'disconnected',$null)
    Assert ($window.IsBusy -and $window.SubmissionUnknown) 'unrelated error cleared unknown-submit busy'
}
$window.FixtureEvent('history',$null,'{"status":"idle","activeRun":null,"latestRun":null,"runs":[],"available":true}')
Assert ($window.IsBusy -and $window.SubmissionUnknown -and $window.BenchState -match '未知') 'empty poll cleared unknown-submit busy'
$window.FixtureEvent('history',$null,'{"status":"idle","runs":[{"runId":"resolved","requestId":"unknown-request","status":"failed"}],"latestRun":null,"activeRun":null}')
Assert (-not $window.IsBusy -and -not $window.SubmissionUnknown) 'historical matching request did not resolve unknown submission'
$window.FixtureEvent('history',$null,'{"status":"idle","activeRun":null,"latestRun":null,"runs":[],"available":true}')
Assert ($window.BenchState -match '尚未运行' -and $null -eq $window.SelectedRunId) 'idle history dishonest'
$window.FixtureEvent('history',$null,$null)
Assert ($window.BenchState -eq '历史不可用') 'null history dishonest'
foreach($code in 'authentication_failed','rate_limited','model_unavailable','process_failed','timed_out','spawn_failed','malformed_output','private-secret diagnostics') {
    $record=@{runId='failed-fixture';status='failed';model='configured';caseResults=@(@{caseId='pelican-svg';status='failed';errorCode=$code;diagnostics='private-secret'})}
    $window.FixtureEvent('history',$null,([CodexNative.WidgetClient]::Serialize(@{latestRun=$record;activeRun=$null;runs=@($record)})))
    $window.ResultsWindow.UpdateLayout()
    $text=UiText $window.ResultsWindow
    Assert ($text.Contains([CodexNative.WidgetClient]::ErrorDescription($code)) -and $text -notmatch 'private-secret|authentication_failed|process_failed|timed_out') 'failed case diagnostic not visible/localized/sanitized'
    Assert ($window.BenchState -match '失败') 'failed history reported success'
}
$window.FixtureEvent('history',$null,'{"latestRun":null,"activeRun":null,"runs":[{"runId":"old-1","status":"completed","model":"configured"},{"runId":"old-2","status":"failed","model":"gpt-6-astra"}]}')
Assert ($window.SelectedRunId -eq "old-1" -and $null -eq $window.HistoryControl) 'runs historical records omitted'
$usageSession=@{id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';updatedAt='2026-10-11T14:37:35.621Z'}
foreach($case in @(@{value=-1;invalid=$true},@{value=1000000000;invalid=$false},@{value=[double]::MaxValue;invalid=$true})) {
    # metrics[0..2] read the top-level cumulative usage; metrics[3] reads turnAverageSpeed.
    # Cumulative counts must be safe non-negative integers; speed keeps its own bounded formatting.
    ResetTelemetryFixture $window
    $value=$case.value
    $total=if($case.invalid){$value}else{$value*2}
    $turn=@{state='available';source='turn_token_usage';reason='none';startedAt='2026-10-11T14:12:15.062Z';completedAt='2026-10-11T14:37:35.621Z';elapsedSeconds=1520.559;inputTokens=$value;outputTokens=$value;totalTokens=$total}
    $speed=@{state='available';source='completed_turn';reason='none';outputTokensPerSecond=($value/1520.559);completedAt='2026-10-11T14:37:35.621Z';includesToolsAndWait=$true}
    $usage=@{inputTokens=$value;outputTokens=$value;totalTokens=$total}
    $window.FixtureState(([CodexNative.WidgetClient]::Serialize(@{state='ok';session=$usageSession;sampledAt=$usageSession.updatedAt;usage=$usage;lastCompletedTurn=$turn;turnAverageSpeed=$speed})))
    $window.UpdateLayout()
    Assert ($window.MetricsVisible) 'cumulative grid hidden for a resolved session'
    foreach($index in 0..2) {
        if($case.invalid){$expected='—'}elseif($index -eq 2){$expected='2G'}else{$expected='1G'}
        Assert ($window.MetricControls[$index].Text -eq $expected) ('cumulative count '+$index+' misformatted: '+$window.MetricControls[$index].Text)
        Assert ($window.MetricControls[$index].Text.Length -le 8) 'cumulative count not bounded'
    }
    if($case.invalid){Assert ($window.MetricControls[3].Text -eq '—') 'invalid speed displayed'}
    else {Assert ($window.MetricControls[3].Text -ceq '657.7k' -and $window.MetricControls[3].Text.Length -le 8) 'consistent large speed not bounded or misformatted'}
    $metric=$window.MetricControls[0]
    $formatted=New-Object Windows.Media.FormattedText $metric.Text,([Globalization.CultureInfo]::CurrentCulture),([Windows.FlowDirection]::LeftToRight),(New-Object Windows.Media.Typeface $metric.FontFamily,$metric.FontStyle,$metric.FontWeight,$metric.FontStretch),$metric.FontSize,$metric.Foreground
    Assert ($formatted.Width -le $metric.ActualWidth) 'cumulative count text exceeds actual control width'
}
# Invalid/partial fields cannot replace a previously complete triple or splice fragments into it.
$seedUsage=@{inputTokens=1000000000;outputTokens=1000000000;totalTokens=2000000000}
$window.FixtureState(([CodexNative.WidgetClient]::Serialize(@{state='ok';session=$usageSession;sampledAt=$usageSession.updatedAt;usage=$seedUsage})))
foreach($invalidUsage in @(@{inputTokens=-1;outputTokens=0;totalTokens=$null},@{inputTokens=[double]::MaxValue;outputTokens=0;totalTokens=$null},@{inputTokens=5;outputTokens=$null;totalTokens='many'},@{inputTokens=1;outputTokens=1;totalTokens=3})) {
    $window.FixtureState(([CodexNative.WidgetClient]::Serialize(@{state='ok';session=$usageSession;sampledAt=$usageSession.updatedAt;usage=$invalidUsage})))
    Assert ($window.MetricControls[0].Text -ceq '1G' -and $window.MetricControls[1].Text -ceq '1G' -and $window.MetricControls[2].Text -ceq '2G' -and $window.SelectedUsageStateControl.Text -match '上次有效数据') 'invalid/partial legacy usage replaced a complete same-task triple'
    Assert ([string]$window.MetricControls[2].ToolTip -ceq '合计 · 2000000000 tokens' -and [Windows.Automation.AutomationProperties]::GetHelpText($window.MetricControls[2]) -match '2000000000') 'retained legacy triple lost exact tooltip or accessibility'
}
# A fresh legacy response may expose individually valid fields, without creating a complete triple.
ResetTelemetryFixture $window
$partialUsage=@{inputTokens=5;outputTokens=$null;totalTokens='many'}
$window.FixtureState(([CodexNative.WidgetClient]::Serialize(@{state='ok';session=$usageSession;sampledAt=$usageSession.updatedAt;usage=$partialUsage})))
$window.UpdateLayout()
Assert ($window.MetricsVisible -and $window.MetricControls[0].Text -eq (5).ToString('N0') -and $window.MetricControls[1].Text -eq '—' -and $window.MetricControls[2].Text -eq '—') 'partial cumulative usage not validated per field'
# Fresh null usage dashes the counts while a validated speed stays visible.
ResetTelemetryFixture $window
$window.FixtureState(([CodexNative.WidgetClient]::Serialize(@{state='ok';session=$usageSession;sampledAt=$usageSession.updatedAt;usage=$null;lastCompletedTurn=@{state='available';source='turn_token_usage';reason='none';startedAt='2026-10-11T14:35:55.621Z';completedAt='2026-10-11T14:37:35.621Z';elapsedSeconds=100;inputTokens=2;outputTokens=1190;totalTokens=1192};turnAverageSpeed=@{state='available';source='completed_turn';reason='none';outputTokensPerSecond=11.9;completedAt='2026-10-11T14:37:35.621Z';includesToolsAndWait=$true}})))
$window.UpdateLayout()
Assert ($window.MetricsVisible -and $window.MetricControls[0].Text -eq '—' -and $window.MetricControls[2].Text -eq '—' -and $window.MetricControls[3].Text -ceq (11.9).ToString('N1')) 'null cumulative usage hid the grid or dropped valid speed'
# A session id that is not a valid task id must not display cumulative usage.
ResetTelemetryFixture $window
$window.FixtureState(([CodexNative.WidgetClient]::Serialize(@{state='ok';session=@{id='not-a-task-id'};sampledAt=$usageSession.updatedAt;usage=@{inputTokens=7;outputTokens=8;totalTokens=15}})))
$window.UpdateLayout()
Assert (-not $window.MetricsVisible -and $window.MetricControls[0].Text -eq '—' -and $window.MetricControls[2].Text -eq '—') 'invalid cumulative session displayed usage'
# Real zero metrics stay visible through a data-less same-task refresh.
ResetTelemetryFixture $window
$zeroTurn=@{state='available';source='turn_token_usage';reason='none';startedAt='2026-10-15T07:32:08.226Z';completedAt='2026-10-15T07:32:13.226Z';elapsedSeconds=5;inputTokens=0;outputTokens=0;totalTokens=0}
$zeroSpeed=@{state='available';source='completed_turn';reason='none';outputTokensPerSecond=0;completedAt=$zeroTurn.completedAt;includesToolsAndWait=$true}
$window.FixtureState(([CodexNative.WidgetClient]::Serialize(@{state='ok';session=$usageSession;sampledAt=$zeroTurn.completedAt;usage=@{inputTokens=0;outputTokens=0;totalTokens=0};lastCompletedTurn=$zeroTurn;turnAverageSpeed=$zeroSpeed})))
$window.UpdateLayout()
$zeroText='0'
Assert ($window.MetricsVisible -and @($window.MetricControls | Where-Object {$_.Text -ne $zeroText}).Count -eq 0) 'real zero metrics were hidden or reformatted'
$window.FixtureState('{"state":"ok"}')
Assert ($window.MetricsVisible -and @($window.MetricControls | Where-Object {$_.Text -ne $zeroText}).Count -eq 0 -and $window.SelectedUsageStateControl.Text -match '上次有效数据') 'data-less telemetry erased valid zero metrics or their historical provenance'
# Large but valid counts keep bounded formatting while remaining visible.
$bigTurn=@{state='available';source='turn_token_usage';reason='none';startedAt='2026-10-15T07:32:15.226Z';completedAt='2026-10-15T07:33:55.226Z';elapsedSeconds=100;inputTokens=500000000;outputTokens=500000000;totalTokens=1000000000}
$bigSpeed=@{state='available';source='completed_turn';reason='none';outputTokensPerSecond=5000000;completedAt=$bigTurn.completedAt;includesToolsAndWait=$true}
$window.FixtureState(([CodexNative.WidgetClient]::Serialize(@{state='ok';session=$usageSession;sampledAt=$bigTurn.completedAt;usage=@{inputTokens=500000000;outputTokens=500000000;totalTokens=1000000000};lastCompletedTurn=$bigTurn;turnAverageSpeed=$bigSpeed})))
$window.UpdateLayout()
Assert ($window.MetricsVisible -and $window.MetricControls[2].Text -eq '1G' -and $window.MetricControls[3].Text -eq '5M') 'valid large metrics hidden or misformatted'
# Rejected run exercises the real Run path without HTTP or model calls.
$requestField=$window.GetType().GetField('requestId',$flags)
$requestField.SetValue($window,'prior-cancellable-request')
$window.FixtureAcceptRun=$false;$window.FixtureRun()
Assert ($requestField.GetValue($window) -ceq 'prior-cancellable-request' -and -not $window.IsBusy) 'rejected run replaced cancellation identity or marked busy'
Assert ($window.BenchState -match '正在提交') 'rejected run missing safe message'
$window.FixtureAcceptRun=$true;$window.FixtureRun()
Assert ($requestField.GetValue($window) -ne 'prior-cancellable-request' -and $window.IsBusy) 'accepted run did not register identity/state'
$window.FixtureEvent('run','run_active',$null)
Assert ([CodexNative.WidgetClient]::ErrorDescription('authentication_failed') -match '中转配置凭据') 'auth message omitted relay credentials'
# Inspect real comparison TextBlock content, including configured baseline with explicit selection.
ResetTelemetryFixture $window
$window.SetFixture();$window.FixtureEvent('history',$null,([CodexNative.WidgetClient]::Serialize($window.GetType().GetField('snapshot',$flags).GetValue($window))))

$previewStart=$window.Heartbeats;PumpUntil { $window.Heartbeats -ge ($previewStart+4) }
$window.ResultsWindow.UpdateLayout()
$images=@(Visuals $window.ResultsWindow | Where-Object {$_ -is [Windows.Controls.Image] -and $null -ne $_.Source})
Assert ($images.Count -gt 0) 'fixture SVG never rendered in real control'
Assert ($window.BenchState -eq '最近运行 · 已完成' -and $window.ResultsWindow.Title -match '示例数据') 'fixture screenshot labels missing'
if($ScreenshotPath){$window.Capture($ScreenshotPath)}
if($ResultScreenshotPath){$window.CaptureResults($ResultScreenshotPath)}
$gradientAnswer=([char]96).ToString()*3+'svg'+[char]10+'<svg xmlns="http://www.w3.org/2000/svg" width="900" height="700" role="img" aria-labelledby="title desc"><title id="title">Pelican</title><desc id="desc">Preview</desc><defs><linearGradient id="sky" x2="0" y2="1"><stop stop-color="#fce8b4"/><stop offset="1" stop-color="#83c9e5"/></linearGradient><linearGradient id="pouch" x2="0" y2="1"><stop stop-color="#ffc060"/><stop offset="1" stop-color="#d06030"/></linearGradient></defs><rect width="900" height="700" fill="url(#sky)"/><ellipse cx="450" cy="400" rx="120" ry="80" fill="url(#pouch)"/></svg>'+[char]10+([char]96).ToString()*3
foreach($previewCase in @(@{id='gradient-preview';answer=$gradientAnswer;valid=$true},@{id='unsafe-preview';answer=$gradientAnswer.Replace('url(#sky)','url(https://invalid/sky)');valid=$false})){
    $record=@{runId=$previewCase.id;status='completed';caseResults=@(@{caseId='pelican-svg';status='completed';answer=$previewCase.answer})}
    $window.FixtureEvent('history',$null,([CodexNative.WidgetClient]::Serialize(@{latestRun=$record;runs=@($record)})))
    
    $targetKey=$previewCase.id+':pelican-svg'
    $previews=$window.GetType().GetField('previews',$flags).GetValue($window)
    $messages=$window.GetType().GetField('previewMessages',$flags).GetValue($window)
    Assert ($previews.ContainsKey($targetKey)) 'specific preview control missing'
    Assert ($messages[$targetKey].Text -eq '正在生成原生预览…') 'preview loading state missing'
    PumpUntil { $messages[$targetKey].Text -ne '正在生成原生预览…' } 7000
    if($previewCase.valid){Assert ($null -ne $previews[$targetKey].Source -and $previews[$targetKey].Source.IsFrozen -and $messages[$targetKey].Text -eq '原生 SVG 预览') 'gradient target preview failed'}
    else {Assert ($null -eq $previews[$targetKey].Source -and $messages[$targetKey].Text -match '未支持或不安全') 'unsafe target preview lacks error'}
    $casePanel=$window.GetType().GetField('cases',$flags).GetValue($window)
    $sourceBoxes=@($casePanel.Children | Where-Object {$_ -is [Windows.Controls.Expander]} | ForEach-Object {$_.Content} | Where-Object {$_ -is [Windows.Controls.TextBox] -and $_.IsReadOnly})
Assert ($sourceBoxes.Count -eq 0 -and $window.GetType().GetField("selected",$flags).GetValue($window)["caseResults"][0]["answer"] -ceq $previewCase.answer) "source hidden or internal answer changed"
}
# Frozen W4 contract regressions: defaults are independent from logged context.
Assert ($window.ModeControl.SelectedValue -ceq 'cockpit') 'history or telemetry changed the default Cockpit mode'
$context=@{state='available';source='turn_context';reason='none';model='gpt-6.1-sol';reasoningEffort='max';observedAt='2026-10-11T14:37:35.621Z'}
$turn=@{state='available';source='turn_token_usage';reason='none';startedAt='2026-10-11T14:12:15.062Z';completedAt='2026-10-11T14:37:35.621Z';elapsedSeconds=1520.559;inputTokens=2;outputTokens=9310;totalTokens=9312}
$speed=@{state='available';source='completed_turn';reason='none';outputTokensPerSecond=(9310/1520.559);completedAt=$turn.completedAt;includesToolsAndWait=$true}
function ContextFixture { $window.FixtureState(([CodexNative.WidgetClient]::Serialize(@{state='ok';session=$usageSession;sampledAt=$usageSession.updatedAt;conversationContext=$context;lastCompletedTurn=$turn;turnAverageSpeed=$speed;speed=@{state='available';outputTokensPerSecond=999}}))) }
ResetTelemetryFixture $window
ContextFixture
Assert ($window.ContextVisible -and $window.ContextText -match 'gpt-6.1-sol' -and $window.MetricControls[3].Text -eq (9310/1520.559).ToString('N1')) 'frozen telemetry context/turn average not displayed'
# Fresh invalid model/effort stay unknown independently; seeded fields retain their last valid value.
ResetTelemetryFixture $window
$context.reasoningEffort='not-a-level'
ContextFixture
Assert ($window.ContextVisible -and $window.ContextText -match 'gpt-6.1-sol' -and $window.EffortVisible -and $window.EffortText -match '未知') ('unknown effort hid a known model: visible='+$window.ContextVisible+' text='+$window.ContextText+' effortVisible='+$window.EffortVisible+' effort='+$window.EffortText)
$context.reasoningEffort='max';ContextFixture
$context.reasoningEffort='not-a-level';ContextFixture
Assert ($window.ContextText -match 'gpt-6.1-sol' -and $window.EffortText -match 'max' -and $window.SelectedUsageStateControl.Text -match '上次有效数据') 'invalid effort erased a seeded valid effort or historical provenance'
ResetTelemetryFixture $window
$context.model='not a model';$context.reasoningEffort='max'
ContextFixture
Assert ($window.ContextVisible -and $window.ContextText -match '未知' -and $window.EffortVisible -and $window.EffortText -match 'max') ('unknown model hid a known effort: contextVisible='+$window.ContextVisible+' context='+$window.ContextText+' effortVisible='+$window.EffortVisible+' effort='+$window.EffortText)
$context.model='gpt-6.1-sol';ContextFixture
$context.model='not a model';ContextFixture
Assert ($window.ContextText -match 'gpt-6.1-sol' -and $window.EffortText -match 'max' -and $window.SelectedUsageStateControl.Text -match '上次有效数据') 'invalid model erased a seeded valid model or historical provenance'
$context.model='gpt-6.1-sol';$context.reasoningEffort='max'
foreach($state in 'unavailable','stale','unexpected'){
    ResetTelemetryFixture $window
    $context.state=$state;$speed.state=$state
    ContextFixture
    Assert (-not $window.ContextVisible -and $window.ContextText -match '未知' -and -not $window.EffortVisible -and $window.EffortText -match '未知' -and $window.MetricControls[3].Text -eq '—') ('fresh invalid state displayed actual telemetry: '+$state)
    $context.state='available';$speed.state='available';ContextFixture
    $context.state=$state;$speed.state=$state;ContextFixture
    Assert ($window.ContextVisible -and $window.ContextText -match 'gpt-6.1-sol' -and $window.EffortVisible -and $window.EffortText -match 'max' -and $window.MetricControls[3].Text -ceq (9310/1520.559).ToString('N1') -and $window.SelectedUsageStateControl.Text -match '上次有效数据') ('invalid state erased seeded context/effort/speed: '+$state)
}
ResetTelemetryFixture $window
$window.FixtureState('{"state":"ok","speed":{"state":"available","outputTokensPerSecond":999}}')
Assert ($window.MetricControls[3].Text -eq '—') 'legacy speed fallback must not be displayed'
# Native speed visibility: rejection is tested fresh; continuity is tested after a valid same-task seed.
# The renderer only accepts a rate matching outputTokens/elapsedSeconds, so keep this fixture consistent.
$turn.outputTokens=1190;$turn.totalTokens=1192;$turn.elapsedSeconds=100;$turn.startedAt='2026-10-11T14:35:55.621Z'
$speed.state='available';$speed.reason='none';$speed.outputTokensPerSecond=11.9
function SpeedFixture([string]$state='ok',[object]$session=$usageSession) { $window.FixtureState(([CodexNative.WidgetClient]::Serialize(@{state=$state;session=$session;sampledAt=$usageSession.updatedAt;lastCompletedTurn=$turn;turnAverageSpeed=$speed;speed=@{state='available';outputTokensPerSecond=999}})));$window.UpdateLayout() }
ResetTelemetryFixture $window
SpeedFixture
Assert ($window.MetricControls[3].Text -ceq (11.9).ToString('N1')) 'valid 11.9 changed formatting'
Assert ((UiText $window) -match '上轮均速 token/s') 'speed header missing visible unit'
function RetainedSpeed([string]$label,[string]$tip,[string]$help) {
    Assert ($window.MetricControls[3].Text -ceq (11.9).ToString('N1') -and $window.SelectedUsageStateControl.Text -match '上次有效数据') ('transient/invalid sample erased validated same-task speed: '+$label)
    Assert ([string]$window.MetricControls[3].ToolTip -ceq $tip -and [Windows.Automation.AutomationProperties]::GetHelpText($window.MetricControls[3]) -ceq $help) ('retained speed lost its original tooltip/accessibility: '+$label)
}
$reasonLabels=@{turn_incomplete='—';turn_start_missing='—';read_gap='—';turn_ambiguous='—';unknown='—';read_gap_suffix='—';none='—'}
foreach($reason in $reasonLabels.Keys){
    ResetTelemetryFixture $window
    $speed.state='unavailable';$speed.reason=$reason;$speed.outputTokensPerSecond=$null;SpeedFixture
    Assert ($window.MetricControls[3].Text -ceq $reasonLabels[$reason]) ('null speed exact reason mismatch: '+$reason)
    Assert ($window.MetricControls[3].ToolTip -match '含工具及等待' -and $window.MetricControls[3].ToolTip -notmatch '999|11.9') 'unavailable tooltip stale or missing tools/wait'
    if($reason -eq 'read_gap'){Assert ($window.MetricControls[3].ToolTip -match '日志读取存在缺口') 'read gap detail missing';if($ScreenshotPath){$window.Capture($ScreenshotPath+'.read-gap.png')}}
    if($reason -eq 'turn_incomplete'){Assert ($window.MetricControls[3].ToolTip -match '尚未完成') 'incomplete detail missing';if($ScreenshotPath){$window.Capture($ScreenshotPath+'.pending.png')}}
    if($reason -eq 'turn_ambiguous'){Assert ($window.MetricControls[3].ToolTip -match '无法唯一确认') 'ambiguous detail missing';if($ScreenshotPath){$window.Capture($ScreenshotPath+'.ambiguous.png')}}
    $metric=$window.MetricControls[3]
    $formatted=New-Object Windows.Media.FormattedText $metric.Text,([Globalization.CultureInfo]::CurrentCulture),([Windows.FlowDirection]::LeftToRight),(New-Object Windows.Media.Typeface $metric.FontFamily,$metric.FontStyle,$metric.FontWeight,$metric.FontStretch),$metric.FontSize,$metric.Foreground
    Assert ($formatted.Width -le $metric.ActualWidth) 'speed reason overflows metric width'
    $speed.state='available';$speed.reason='none';$speed.outputTokensPerSecond=11.9;SpeedFixture
    $retainedTip=[string]$window.MetricControls[3].ToolTip;$retainedHelp=[Windows.Automation.AutomationProperties]::GetHelpText($window.MetricControls[3])
    $speed.state='unavailable';$speed.reason=$reason;$speed.outputTokensPerSecond=$null;SpeedFixture
    RetainedSpeed $reason $retainedTip $retainedHelp
}
$validTurn=$turn.Clone();$validSpeed=$speed.Clone();$validSpeed.state='available';$validSpeed.reason='none';$validSpeed.outputTokensPerSecond=11.9
$speedRejections=@(
    @{target='speed';key='reason';value='READ_GAP'},@{target='speed';key='reason';value='read_gap'},
    @{target='speed';key='state';value='AVAILABLE'},@{target='speed';key='source';value='COMPLETED_TURN'},
    @{target='speed';key='completedAt';value='2026-10-11T14:37:36.621Z'},
    @{target='speed';key='completedAt';value='2026-10-11T14:37:35.621'},
    @{target='speed';key='includesToolsAndWait';value=$false},@{target='speed';key='includesToolsAndWait';value='true'},
    @{target='speed';key='outputTokensPerSecond';value=$null},@{target='speed';key='outputTokensPerSecond';value=-1},
    @{target='speed';key='outputTokensPerSecond';value='11.9'},@{target='speed';key='outputTokensPerSecond';value=@{value=11.9}},
    @{target='speed';key='outputTokensPerSecond';value=12},
    @{target='turn';key='state';value='AVAILABLE'},@{target='turn';key='source';value='other_source'},@{target='turn';key='reason';value='read_gap'},
    @{target='turn';key='elapsedSeconds';value=0},@{target='turn';key='elapsedSeconds';value=-1},@{target='turn';key='elapsedSeconds';value='100'},
    @{target='turn';key='elapsedSeconds';value=101},@{target='turn';key='startedAt';value='2026-10-11T14:36:00.621Z'},
    @{target='turn';key='startedAt';value='2026-10-11T14:35:55.621+08:00'},@{target='turn';key='completedAt';value='not-a-timestamp'},
    @{target='turn';key='inputTokens';value=-1},@{target='turn';key='outputTokens';value='1190'},@{target='turn';key='totalTokens';value=1193}
)
foreach($rejection in $speedRejections){
    ResetTelemetryFixture $window
    $turn=$validTurn.Clone();$speed=$validSpeed.Clone()
    if($rejection.target -ceq 'turn'){$turn[$rejection.key]=$rejection.value}else{$speed[$rejection.key]=$rejection.value}
    SpeedFixture
    Assert ($window.MetricControls[3].Text -ceq '—') ('fresh invalid speed/turn accepted: '+$rejection.target+'.'+$rejection.key)
    $turn=$validTurn.Clone();$speed=$validSpeed.Clone();SpeedFixture
    $retainedTip=[string]$window.MetricControls[3].ToolTip;$retainedHelp=[Windows.Automation.AutomationProperties]::GetHelpText($window.MetricControls[3])
    if($rejection.target -ceq 'turn'){$turn[$rejection.key]=$rejection.value}else{$speed[$rejection.key]=$rejection.value}
    SpeedFixture
    RetainedSpeed ($rejection.target+'.'+$rejection.key) $retainedTip $retainedHelp
}
$turn=$validTurn.Clone();$speed=$validSpeed.Clone()
foreach($badEnvelope in @(@{state='ok';session=$null},@{state='ok';session=@{id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'}},@{state='ok';session=@{id='invalid'}},@{state='loading';session=$usageSession},@{state='unavailable';session=$usageSession})){
    ResetTelemetryFixture $window
    SpeedFixture $badEnvelope.state $badEnvelope.session
    Assert ($window.MetricControls[3].Text -ceq '—') 'fresh nonmatching/unavailable telemetry borrowed a validated-looking speed'
    SpeedFixture
    $retainedTip=[string]$window.MetricControls[3].ToolTip;$retainedHelp=[Windows.Automation.AutomationProperties]::GetHelpText($window.MetricControls[3])
    SpeedFixture $badEnvelope.state $badEnvelope.session
    RetainedSpeed 'envelope identity/state' $retainedTip $retainedHelp
}
SpeedFixture
$retainedTip=[string]$window.MetricControls[3].ToolTip;$retainedHelp=[Windows.Automation.AutomationProperties]::GetHelpText($window.MetricControls[3])
$window.FixtureEvent('telemetry','disconnected',$null)
RetainedSpeed 'disconnected' $retainedTip $retainedHelp
Assert ($window.DisplayState -match '本地服务断连' -and -not $window.TaskFlagsVisible) 'telemetry error duplicated outside the single main status'
Assert ($window.Height -eq $expectedHeight) 'speed UI changed fixed window height'
$window.UpdateLayout()
$speedControl=$window.MetricControls[3]
$speedBottom=$speedControl.TransformToAncestor($window).Transform((New-Object Windows.Point 0,$speedControl.ActualHeight)).Y
Assert ($speedBottom -le $window.ActualHeight) 'speed UI overflows fixed window'
ResetTelemetryFixture $window
$turn.outputTokens=9310;$turn.totalTokens=9312;$turn.elapsedSeconds=1520.559;$turn.startedAt='2026-10-11T14:12:15.062Z'
$speed.state='available';$speed.reason='none';$speed.outputTokensPerSecond=(9310/1520.559)
$defaults=@{model=@{state='available';source='config_top_level';reason='none';value='gpt-6-astra'};reasoningEffort=@{state='unavailable';source='none';reason='key_missing';value=$null}}
$window.FixtureEvent('history',$null,([CodexNative.WidgetClient]::Serialize(@{status='unavailable';available=$false;unavailableReason='benchmark_unavailable';defaults=$defaults;runs=@()})))
Assert (-not $window.ContextVisible -and $window.DefaultsText -match 'gpt-6-astra' -and $window.DefaultsText -match '推理强度 未知' -and $window.ContextText -match '未知') 'independent defaults missing or substituted as actual context'
# A failed history refresh invalidates defaults, including after closing/reopening.
$defaultsSnapshot=[CodexNative.WidgetClient]::Serialize(@{defaults=$defaults;runs=@()})
$window.FixtureEvent('history','disconnected',$null)
Assert ($window.DefaultsText -notmatch 'gpt-6-astra' -and $window.DefaultsText -match '未知') 'history disconnect retained available defaults'
$window.FixtureEvent('history','disconnected',$null)
Assert ($window.DefaultsText -notmatch 'gpt-6-astra') 'persistent disconnect restored cached defaults'
$window.ResultsWindow.Close();$window.OpenResults()
Assert ($window.DefaultsText -notmatch 'gpt-6-astra' -and $window.DefaultsText -match '未知') 'reopen restored disconnected defaults'
$window.FixtureEvent('history',$null,$defaultsSnapshot)
Assert ($window.DefaultsText -match 'gpt-6-astra') 'successful refresh failed to recover defaults'
function HistoryFixture($active,$latest,$records){$window.FixtureEvent('history',$null,([CodexNative.WidgetClient]::Serialize(@{activeRun=$active;latestRun=$latest;runs=$records})))}
$a=@{runId='auto-a';status='completed';caseResults=@()};$b=@{runId='auto-b';status='failed';caseResults=@()}
$window.RestoreAutoFollow();HistoryFixture $null $a @($a)
Assert ($window.AutoFollow -and $window.SelectedRunId -eq 'auto-a') 'programmatic update disabled auto follow'
HistoryFixture $b $a @($a,$b)
Assert ($window.AutoFollow -and $window.SelectedRunId -eq 'auto-b') 'active failure did not supersede old success'
Assert ($null -eq $window.HistoryControl) "history visible"
$window.RestoreAutoFollow()
Assert ($window.AutoFollow -and $window.SelectedRunId -eq 'auto-b') 'restore auto did not immediately apply latest'
# Static images use their actual source viewport, including transparent space, and fit both axes.
$ratioRun=@{runId='ratio-source';mode='static';status='completed';caseSetVersion='pelican-svg-v2';rubricVersion='pelican-svg-v2';caseResults=@(@{caseId='pelican-svg';status='completed';answer='<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800" viewBox="0 0 1200 800"><rect x="500" y="300" width="10" height="10"/></svg>';diagnostics=@{terminationReason='completed';cleanupStatus='confirmed'}})}
HistoryFixture $null $ratioRun @($ratioRun)
$staticPreviews=$window.GetType().GetField('previews',$flags).GetValue($window)
PumpUntil {$null -ne $staticPreviews['ratio-source:pelican-svg'].Source} 7000
$ratioImage=$staticPreviews['ratio-source:pelican-svg'];$window.ResultsWindow.UpdateLayout()
PumpUntil {$ratioImage.ActualHeight -gt 160}
$ratioViewport=$window.GetType().GetField('caseViewport',$flags).GetValue($window)
Assert ([Math]::Abs($ratioImage.Source.Width/$ratioImage.Source.Height-1.5) -lt 0.001 -and [Math]::Abs($ratioImage.ActualWidth/$ratioImage.ActualHeight-1.5) -lt 0.001 -and $ratioImage.ActualWidth -le $ratioViewport.ViewportWidth+1 -and $ratioImage.ActualHeight -le $ratioViewport.ViewportHeight+1) 'static source ratio, 160px cap removal or contain constraints failed'
Assert ($ratioImage.IsVisible -and $ratioImage.ToolTip -match '运行诊断' -and $ratioImage.ToolTip -match '结束原因 正常完成') 'normal static artwork lost accessible diagnostics'
$staticBounds=@($window.ResultsWindow.Width,$window.ResultsWindow.Height)
$window.ResultsWindow.Width=610;$window.ResultsWindow.Height=420;$window.ResultsWindow.UpdateLayout()
PumpUntil {$ratioImage.ActualHeight -ge 150 -and $ratioImage.ActualWidth -le $ratioViewport.ViewportWidth+1 -and $ratioImage.ActualHeight -le $ratioViewport.ViewportHeight+1}
Assert ($ratioImage.ActualHeight -ge 150 -and [Math]::Abs($ratioImage.ActualWidth/$ratioImage.ActualHeight-1.5) -lt 0.001 -and $ratioViewport.ScrollableHeight -le 1) 'compact static artwork is too small, distorted or scroll-clipped'
Assert ($ratioImage.IsVisible -and $ratioImage.ToolTip -match '运行诊断' -and $ratioImage.ToolTip -match '清理已确认') 'compact static diagnostics remained on a collapsed case heading'
$window.ResultsWindow.Width=$staticBounds[0];$window.ResultsWindow.Height=$staticBounds[1];$window.ResultsWindow.UpdateLayout()
$ratioRun.caseResults=@($ratioRun.caseResults[0],@{caseId='pelican-svg-animated';status='completed';answer=$ratioRun.caseResults[0].answer})
HistoryFixture $null $ratioRun @($ratioRun)
PumpUntil {$null -ne $staticPreviews['ratio-source:pelican-svg-animated'].Source} 7000
$window.ResultsWindow.UpdateLayout();$ratioViewport.ScrollToEnd();$window.ResultsWindow.UpdateLayout()
Assert ($ratioViewport.ScrollableHeight -gt 0 -and $ratioViewport.VerticalOffset -gt 0 -and $staticPreviews['ratio-source:pelican-svg-animated'].ActualHeight -le $ratioViewport.ViewportHeight+1) 'multiple artwork cases are not bounded and scrollable'
$ratioViewport.ScrollToTop()
$animated='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><g><rect x="30" y="30" width="10" height="10"/><animateTransform attributeName="transform" type="translate" values="0 0;10 0;0 0" dur="1s" repeatCount="indefinite"/></g></svg>'
$animationRun=@{runId='animation-w4';status='completed';caseSetVersion='pelican-svg-animated-v1';rubricVersion='pelican-svg-animated-v1';caseResults=@(@{caseId='pelican-svg-animated';status='completed';answer=$animated;scores=@{correctness=4;consistency=4;constraint_adherence=4}})}
HistoryFixture $null $animationRun @($animationRun)
PumpUntil {$window.PlaybackCount -eq 1} 7000
$playbackField=$window.GetType().GetField('playbacks',$flags);$playback=$playbackField.GetValue($window)['animation-w4:pelican-svg-animated']
$targets=$playback.GetType().GetField('targets',$flags).GetValue($playback)
$initialOffset=$targets[0].Matrix.OffsetX
PumpUntil {[Math]::Abs($targets[0].Matrix.OffsetX-$initialOffset) -gt 0.5} 3000
Assert ($window.PlaybackCount -eq 1) 'single UI clock did not visibly sample animation'
$animationOffsetObserved=$targets[0].Matrix.OffsetX;$animationInitialOffset=$initialOffset
HistoryFixture $null $animationRun @($animationRun)
Assert ([object]::ReferenceEquals($playback,$playbackField.GetValue($window)['animation-w4:pelican-svg-animated'])) 'same content poll rebuilt playback'
$animationRun.caseResults[0].scores.correctness=5
HistoryFixture $null $animationRun @($animationRun)
Assert ([object]::ReferenceEquals($playback,$playbackField.GetValue($window)['animation-w4:pelican-svg-animated'])) 'score change restarted animation'
Assert ((UiText $window.ResultsWindow) -notmatch "评分|基线|版本") "animated metadata visible"
$window.ResultsWindow.Hide()
Assert ($window.PlaybackCount -eq 0) 'hide retained animation playback'
$window.ResultsWindow.Show();PumpUntil {$window.PlaybackCount -eq 1} 7000
Assert (-not [object]::ReferenceEquals($playback,$playbackField.GetValue($window)['animation-w4:pelican-svg-animated'])) 'reopen did not rebuild from zero'
# Deliver a synthetic old completion after close/reopen; no old task may alter new controls.
$wg=$window.GetType().GetField('windowGeneration',$flags).GetValue($window);$sg=$window.GetType().GetField('selectionGeneration',$flags).GetValue($window)
$old=New-Object CodexNative.ClientEvent;$old.Kind='svg';$old.Instance='fixture';$old.WindowGeneration=$wg;$old.SelectionGeneration=$sg;$old.Key='animation-w4:pelican-svg-animated';$old.ContentKey='obsolete';$old.Svg=[CodexNative.SafeSvg]::Parse($svg)
$window.ResultsWindow.Close();Assert ($window.PlaybackCount -eq 0) 'close retained animation'
$window.OpenResults();PumpUntil {$window.PlaybackCount -eq 1} 7000
$before=$playbackField.GetValue($window)['animation-w4:pelican-svg-animated'];$null=$window.GetType().GetMethod('Apply',$flags).Invoke($window,[object[]]@($old.psobject.BaseObject))
Assert ([object]::ReferenceEquals($before,$playbackField.GetValue($window)['animation-w4:pelican-svg-animated'])) 'old window result altered new preview'
$nextRunEfforts=$window.GetType().GetField('efforts',$flags).GetValue($window)
$window.FixtureAcceptRun=$true;$window.FixtureRun()
$captured=[CodexNative.WidgetClient]::Json([CodexNative.WidgetClient]::Serialize($window.SubmittedRequest));$window.ModelControl.SelectedValue='example-provider/gpt-6-astra';$nextRunEfforts.SelectedValue='high'
$capturedAfter=[CodexNative.WidgetClient]::Json([CodexNative.WidgetClient]::Serialize($window.SubmittedRequest))
Assert ($captured.mode -ceq 'cockpit' -and $capturedAfter.mode -ceq 'cockpit' -and $capturedAfter.model -ceq $captured.model -and $capturedAfter.reasoningEffort -ceq $captured.reasoningEffort -and $window.ModelControl.SelectedValue -ceq 'example-provider/gpt-6-astra' -and $nextRunEfforts.SelectedValue -ceq 'high') 'submitted Cockpit configuration changed with the next-run draft'
$window.FixtureEvent('run','run_active',$null)
$previewClient=New-Object CodexNative.WidgetClient $true;$clients.Add($previewClient)
for($i=0;$i -lt 200;$i++){$previewClient.Preview($animated,'bounded',1,$i,'key'+$i);Assert ($previewClient.PreviewQueueDepth -le 2) 'preview queue exceeded active plus one pending'}
$previewClient.ClearPreview();$previewClient.Dispose()
# HTML stays as plain source in WPF; no browser is created in fixture mode.
$window.FixtureEvent('run','','{}')
$htmlRun=@{runId='html-fixture';status='completed';model='configured';reasoningEffort='configured';caseSetVersion='pelican-html-animated-v1';rubricVersion='pelican-html-animated-v1';caseResults=@(@{caseId='pelican-html-animated';status='completed';answer='<html>fixture source</html>';scores=@{correctness=4;consistency=4;constraint_adherence=5}})}
$window.RestoreAutoFollow()
$window.FixtureEvent('history','',($(@{latestRun=$htmlRun;runs=@($htmlRun)})|ConvertTo-Json -Depth 8 -Compress))
Assert ($window.PlaybackCount -eq 0) 'HTML entered native SVG playback'
$casePanel=$window.GetType().GetField('cases',$flags).GetValue($window)
$htmlOpen=@($casePanel.Children|Where-Object {$_ -is [Windows.Controls.Button] -and [Windows.Automation.AutomationProperties]::GetAutomationId($_) -eq 'OpenHtmlPreview'})
Assert ($htmlOpen.Count -eq 1 -and -not $htmlOpen[0].IsEnabled) 'fixture/unsupported HTML open enabled'
Assert (@($casePanel.Children|Where-Object {$_ -is [Windows.Controls.Button] -and [Windows.Automation.AutomationProperties]::GetAutomationId($_) -eq 'SaveScore'}).Count -eq 0) 'HTML scoring visible'
$savedHtmlSupported=$c.HtmlSupported
try {
    $c.GetType().GetField('htmlSupported',$flags).SetValue($c,$true)
    $htmlRecord=$window.GetType().GetField('selected',$flags).GetValue($window)
    $window.GetType().GetField('htmlIntent',$flags).SetValue($window,$true)
    $null=$window.GetType().GetMethod('OpenHtml',$flags).Invoke($window,[object[]]@($htmlRecord,[CodexNative.PreviewOpenReason]::ExplicitOpen))
    $htmlClosed=$window.GetType().GetField('fixturePreviewSnapshot',$flags).GetValue($window);$htmlClosed.State='closed'
    $null=$window.GetType().GetMethod('ApplyPreviewUpdate',$flags).Invoke($window,[object[]]@($htmlClosed.psobject.BaseObject))
    $htmlStatus=$window.GetType().GetField('htmlStatus',$flags).GetValue($window)
    Assert ($htmlStatus.Text -ceq '动画预览已关闭，请点击“打开动画”重新打开。' -and [string]$htmlOpen[0].Content -ceq '打开动画') 'legacy HTML closed message named a missing Reload action'
} finally {$c.GetType().GetField('htmlSupported',$flags).SetValue($c,$savedHtmlSupported)}
$c.GetType().GetField('cockpitSupported',$flags).SetValue($c,$false);$previous=$window.SubmittedRequest;$window.FixtureRun()
Assert ($window.BenchState -eq '当前服务不支持 Cockpit 源码预览' -and [object]::ReferenceEquals($previous,$window.SubmittedRequest) -and $window.ModeControl.SelectedValue -ceq 'cockpit') 'unsupported service submitted Cockpit'
$c.GetType().GetField('cockpitSupported',$flags).SetValue($c,$true)

$window.RestoreAutoFollow()
$cockpitRun=@{runId='cockpit-fixture';status='completed';model='configured';reasoningEffort='configured';caseSetVersion='pelican-cockpit-v1';rubricVersion='pelican-cockpit-v1';caseResults=@(@{caseId='pelican-cockpit';status='completed';answer='<html>cockpit source</html>';scores=@{correctness=4;consistency=4;constraint_adherence=5};diagnostics=@{terminationReason='completed';cleanupStatus='confirmed'}})}
$autoHistorySchedules=[long]$window.GetType().GetField('fixturePreviewScheduleCount',$flags).GetValue($window)
$previewRequestBefore=$window.SubmittedRequest;$previewRequestJsonBefore=[CodexNative.WidgetClient]::Serialize($previewRequestBefore)
$previewDraftModel=$window.ModelControl.SelectedValue;$previewDraftEffort=$nextRunEfforts.SelectedValue
$window.FixtureEvent('history','',(@{latestRun=$cockpitRun;runs=@($cockpitRun)}|ConvertTo-Json -Depth 8 -Compress))
$casePanel=$window.GetType().GetField('cases',$flags).GetValue($window)
$texts=@($casePanel.Children|Where-Object {$_ -is [Windows.Controls.TextBlock]}|ForEach-Object {$_.Text})
Assert ((UiText $window.ResultsWindow) -notmatch "创建一个 HTML|原始来源|题集|评分|版本|cockpit source") "Cockpit metadata visible"
Assert ((UiText $window.ResultsWindow) -notmatch "创建一个 HTML|原始来源|题集|评分|版本|cockpit source") "Cockpit metadata visible"
Assert ((UiText $window.ResultsWindow) -notmatch "创建一个 HTML|原始来源|题集|评分|版本|cockpit source") "Cockpit metadata visible"
Assert ((UiText $window.ResultsWindow) -notmatch '安全环境未核验时预览禁用|环境安全门槛未核验时禁用') 'obsolete disabled gate explanation retained'
Assert ((UiText $window.ResultsWindow) -notmatch "创建一个 HTML|原始来源|题集|评分|版本|cockpit source") "Cockpit metadata visible"
# Cockpit fixture uses copied in-memory frames and the production UI pipeline, without a browser or POST.
$allFields=[Reflection.BindingFlags]'Instance,Public,NonPublic'
function WindowField([string]$name){$window.GetType().GetField($name,$allFields).GetValue($window)}
function InvokeWindow([string]$name,[object[]]$arguments=@()){
    $window.GetType().GetMethod($name,$allFields).Invoke($window,$arguments)
}
function CopyPreviewTarget($target){
    $copy=New-Object CodexNative.PreviewTarget
    foreach($field in $target.GetType().GetFields($allFields)){$field.SetValue($copy,$field.GetValue($target))}
    return $copy
}
function PreviewField($target,[string]$name){$target.GetType().GetField($name,$allFields).GetValue($target)}
function SetPreviewField($target,[string]$name,$value){$target.GetType().GetField($name,$allFields).SetValue($target,$value)}
function FrameBytes([byte]$red,[byte]$blue,[int]$width=2,[int]$height=2){
    $pixels=New-Object byte[] ($width*$height*4)
    for($i=0;$i -lt $pixels.Length;$i+=4){$pixels[$i]=$blue;$pixels[$i+2]=$red;$pixels[$i+3]=255}
    $bitmap=[Windows.Media.Imaging.BitmapSource]::Create($width,$height,96,96,[Windows.Media.PixelFormats]::Bgra32,$null,$pixels,($width*4))
    $encoder=New-Object Windows.Media.Imaging.PngBitmapEncoder
    $encoder.Frames.Add([Windows.Media.Imaging.BitmapFrame]::Create($bitmap))
    $memory=New-Object IO.MemoryStream
    try {$encoder.Save($memory);return ,$memory.ToArray()} finally {$memory.Dispose()}
}
$frameType=$window.GetType().Assembly.GetType('CodexNative.PreviewFrame')
$frameConstructor=@($frameType.GetConstructors($allFields))[0]
function FixtureFrame($target,[long]$operation,[long]$sequence,[byte[]]$bytes){
    $arguments=New-Object object[] 4
    $arguments[0]=$operation;$arguments[1]=$target.psobject.BaseObject;$arguments[2]=$sequence;$arguments[3]=$bytes
    return $frameConstructor.Invoke($arguments)
}
function QueueFrame($frame){$arguments=New-Object object[] 1;$arguments[0]=$frame.psobject.BaseObject;$null=InvokeWindow 'PreviewFrameReady' $arguments}
function ApplyFrame($frame){QueueFrame $frame;$null=InvokeWindow 'DrainCockpitFrame'}
function PixelBytes($image){$pixels=New-Object byte[] ($image.Source.PixelWidth*$image.Source.PixelHeight*4);$image.Source.CopyPixels($pixels,($image.Source.PixelWidth*4),0);return ,$pixels}
function MapCockpitPoint([double]$width,[double]$height,[double]$sourceWidth,[double]$sourceHeight,[double]$x,[double]$y){
    $arguments=New-Object object[] 7
    $arguments[0]=$width;$arguments[1]=$height;$arguments[2]=$sourceWidth;$arguments[3]=$sourceHeight;$arguments[4]=$x;$arguments[5]=$y;$arguments[6]=(New-Object Windows.Point).psobject.BaseObject
    $accepted=$window.GetType().GetMethod('TryCockpitPoint',[Reflection.BindingFlags]'Static,NonPublic').Invoke($null,$arguments)
    [pscustomobject]@{accepted=$accepted;point=$arguments[6]}
}
function BeginCockpitClick([double]$x,[double]$y,[int]$clicks=1){InvokeWindow 'BeginCockpitPress' ([object[]]@($x,$y,$clicks))}
function EndCockpitClick([double]$x,[double]$y,[int]$clicks=1){InvokeWindow 'EndCockpitPressAsync' ([object[]]@($x,$y,$clicks))}
function MouseHandlerCount($image,$routedEvent){
    $store=[Windows.UIElement].GetProperty('EventHandlersStore',[Reflection.BindingFlags]'Instance,NonPublic').GetValue($image,$null)
    $arguments=New-Object object[] 1;$arguments[0]=$routedEvent
    @($store.GetType().GetMethod('GetRoutedEventHandlers',[Reflection.BindingFlags]'Instance,Public,NonPublic').Invoke($store,$arguments)).Count
}
$pointCases=@(
    @(960,600,960,600,0,0,0,0),@(960,600,960,600,959.9,599.9,959.9,599.9),
    @(480,300,960,600,240,150,480,300),@(1920,1200,960,600,960,600,480,300),
    @(1000,600,960,600,20,0,0,0),@(1000,600,960,600,979.9,599.9,959.9,599.9),
    @(960,800,960,600,0,100,0,0),@(960,800,960,600,959.9,699.9,959.9,599.9),
    @(480,300,480,300,240,150,480,300),@(960,600,480,600,240,0,0,0)
)
foreach($case in $pointCases){
    $point=MapCockpitPoint $case[0] $case[1] $case[2] $case[3] $case[4] $case[5]
    Assert ($point.accepted -and [Math]::Abs($point.point.X-$case[6]) -lt 0.001 -and [Math]::Abs($point.point.Y-$case[7]) -lt 0.001) ('Uniform/DIP mapping failed: '+($case -join ','))
}
$rejectedPoints=@(
    @(960,600,960,600,-1,0),@(960,600,960,600,0,-1),@(960,600,960,600,960,0),@(960,600,960,600,0,600),
    @(1000,600,960,600,19.9,0),@(1000,600,960,600,980,0),@(960,800,960,600,0,99.9),@(960,800,960,600,0,700),
    @(0,600,960,600,0,0),@(960,0,960,600,0,0),@(960,600,0,600,0,0),@(960,600,960,0,0,0)
)
foreach($case in $rejectedPoints){Assert (-not (MapCockpitPoint $case[0] $case[1] $case[2] $case[3] $case[4] $case[5]).accepted) ('letterbox/bounds mapping accepted: '+($case -join ','))}
foreach($bad in @([double]::NaN,[double]::PositiveInfinity,[double]::NegativeInfinity)){
    for($index=0;$index -lt 6;$index++){$case=[double[]]@(960,600,960,600,480,300);$case[$index]=$bad;Assert (-not (MapCockpitPoint $case[0] $case[1] $case[2] $case[3] $case[4] $case[5]).accepted) 'non-finite mapping accepted'}
}
$cockpitPointChecks=$pointCases.Count+$rejectedPoints.Count+18

$cockpitImage=WindowField 'cockpitImage'
$window.ResultsWindow.UpdateLayout()
PumpUntil {$cockpitImage.Width -gt 1 -and [Math]::Abs($cockpitImage.Height-$cockpitImage.Width*600/960) -lt 1}
Assert ($null -ne $cockpitImage -and $cockpitImage.Width -gt 0 -and [Math]::Abs($cockpitImage.Height-$cockpitImage.Width*600/960) -lt 1 -and $cockpitImage.Width -le $casePanel.ActualWidth+1 -and $cockpitImage.Stretch -eq [Windows.Media.Stretch]::Uniform -and [Windows.Automation.AutomationProperties]::GetAutomationId($cockpitImage) -ceq 'CockpitPreviewImage') 'Cockpit Image did not contain within the available width or lost identity'
Assert ((UiText $window.ResultsWindow) -match '点击画面中的播放/暂停按钮操作作品') 'inline artwork interaction explanation missing'
Assert ((UiText $window.ResultsWindow) -match '系统减少动态效果可能使作品默认暂停' -and (UiText $window.ResultsWindow) -match '最多每秒 5 帧') 'inline sampling/reduced-motion explanation missing'
$workArea=[Windows.SystemParameters]::WorkArea;$resultsBounds=$window.ResultsWindow
Assert ($resultsBounds.Width -le $workArea.Width -and $resultsBounds.Height -le $workArea.Height -and $resultsBounds.MinWidth -le $workArea.Width -and $resultsBounds.MinHeight -le $workArea.Height -and $resultsBounds.Left -ge $workArea.Left -and $resultsBounds.Top -ge $workArea.Top -and $resultsBounds.Left+$resultsBounds.Width -le $workArea.Right -and $resultsBounds.Top+$resultsBounds.Height -le $workArea.Bottom) 'default Results bounds exceed WorkArea'
$caseScroll=@(Visuals $window.ResultsWindow|Where-Object {$_ -is [Windows.Controls.ScrollViewer] -and [object]::ReferenceEquals($_.Content,$casePanel)})[0]
Assert ($caseScroll.HorizontalScrollBarVisibility -eq [Windows.Controls.ScrollBarVisibility]::Disabled -and $caseScroll.VerticalScrollBarVisibility -eq [Windows.Controls.ScrollBarVisibility]::Auto) 'result viewport allowed horizontal infinite layout'
Assert ($cockpitImage.Height -le $caseScroll.ViewportHeight+1 -and $casePanel.ActualHeight -le $caseScroll.ViewportHeight+1) 'primary artwork and its actions extend past the bounded viewport'
$currentWork=WindowField 'currentWork';$beforeNextDraft=$currentWork.Text;$window.ModelControl.SelectedValue='configured';$nextRunEfforts.SelectedValue='medium'
Assert ($currentWork.Text -ceq $beforeNextDraft -and $currentWork.Text -match 'Cockpit' -and $window.ModeControl.SelectedValue -ceq 'cockpit') 'next-run model or effort relabelled the current artwork'
$window.ModelControl.SelectedValue=$previewDraftModel;$nextRunEfforts.SelectedValue=$previewDraftEffort
if($workArea.Width -ge 960 -and $workArea.Height -ge 900){Assert ($cockpitImage.Width -gt 700 -and $cockpitImage.Height -gt 400) ('large WorkArea retained old 384x240 preview; target='+$cockpitImage.Width+'x'+$cockpitImage.Height+'; cases='+$casePanel.ActualWidth+'; viewport='+$caseScroll.ViewportWidth+'; results='+$resultsBounds.ActualWidth+'x'+$resultsBounds.ActualHeight)}
Assert ($null -eq $cockpitImage.Source -and (WindowField 'htmlIntent') -and [long](WindowField 'fixturePreviewScheduleCount') -eq $autoHistorySchedules+1) 'first ready history did not automatically schedule inline preview in the visible Results window'
Assert ([object]::ReferenceEquals($previewRequestBefore,$window.SubmittedRequest) -and [CodexNative.WidgetClient]::Serialize($window.SubmittedRequest) -ceq $previewRequestJsonBefore -and $window.ModelControl.SelectedValue -ceq $previewDraftModel -and $nextRunEfforts.SelectedValue -ceq $previewDraftEffort -and $window.ModeControl.SelectedValue -ceq 'cockpit') 'automatic history preview submitted a generation or changed the next-run draft'
$target=WindowField 'cockpitTarget';$live=WindowField 'fixturePreviewSnapshot';$operation=[long]$live.OperationGeneration
Assert ((WindowField 'htmlIntent') -and (PreviewField $target 'Presentation').ToString() -ceq 'Inline' -and (PreviewField $target 'CaptureFrames') -and (PreviewField $target 'ContentDigest') -match '^[a-f0-9]{64}$') 'ready history did not authorize inline capture without a second Results click'
Assert ((WindowField 'cockpitMessage').Text -ceq '正在加载动画预览…' -and $null -eq $cockpitImage.Source) 'Cockpit loading state missing'
Assert (-not (BeginCockpitClick 0 0) -and $null -eq (WindowField 'cockpitShownTarget')) 'loading accepted artwork input'
$redBytes=FrameBytes 255 0;$blueBytes=FrameBytes 0 255
$redFrame=FixtureFrame $target $operation 1 $redBytes
ApplyFrame $redFrame
Assert ($null -ne $cockpitImage.Source -and $cockpitImage.Source.IsFrozen -and (WindowField 'cockpitMessage').Text -ceq '动画预览已加载 · 最多每秒 5 帧') 'first in-memory frame did not render'
$firstBitmap=$cockpitImage.Source;$firstPixels=PixelBytes $cockpitImage;$heartbeatsBefore=$window.Heartbeats;$frameWidth=$cockpitImage.Width;$frameHeight=$cockpitImage.Height
QueueFrame (FixtureFrame $target $operation 2 $blueBytes)
PumpUntil {(WindowField 'cockpitAppliedFrames') -ge 2}
Assert (-not [object]::ReferenceEquals($firstBitmap,$cockpitImage.Source) -and [Convert]::ToBase64String($firstPixels) -ne [Convert]::ToBase64String((PixelBytes $cockpitImage)) -and $window.Heartbeats -gt $heartbeatsBefore) 'two frames or UI heartbeat did not advance'
Assert ($cockpitImage.Width -eq $frameWidth -and $cockpitImage.Height -eq $frameHeight) 'subsequent frames changed explicit 960:600 layout dimensions'
# UI input is bound to the shown 960x600 frame, and simulated only in this browser-free fixture.
$inputChecksBefore=$script:checks
Assert (-not (BeginCockpitClick 1 1)) 'small image fixture authorized real viewport input'
$fullRedBytes=FrameBytes 255 0 960 600;$fullBlueBytes=FrameBytes 0 255 960 600
$live.State='open';ApplyFrame (FixtureFrame $target $operation 3 $fullRedBytes);$window.ResultsWindow.UpdateLayout()
$inputX=$cockpitImage.ActualWidth/2;$inputY=$cockpitImage.ActualHeight/2
Assert ($cockpitImage.ActualWidth -gt 0 -and [Math]::Abs($cockpitImage.ActualHeight-$cockpitImage.ActualWidth*600/960) -lt 1) 'shown viewport frame did not keep 8:5 aspect ratio'
if($workArea.Width -ge 960 -and $workArea.Height -ge 900){Assert ($cockpitImage.ActualWidth -gt 700 -and $cockpitImage.ActualHeight -gt 400) 'shown viewport retained small artwork'}
$shownViewportWidth=$cockpitImage.ActualWidth;$shownViewportHeight=$cockpitImage.ActualHeight
Assert ((InvokeWindow 'CurrentCockpitImage') -and [object]::ReferenceEquals((WindowField 'cockpitShownBitmap'),$cockpitImage.Source) -and -not [object]::ReferenceEquals((WindowField 'cockpitShownTarget'),$target)) 'shown frame credentials missing or mutable target reused'
$previousSyncContext=[Threading.SynchronizationContext]::Current
[Threading.SynchronizationContext]::SetSynchronizationContext((New-Object Windows.Threading.DispatcherSynchronizationContext ([Windows.Threading.Dispatcher]::CurrentDispatcher)))
$script:cockpitClickSources=New-Object 'Collections.Generic.List[object]'
$script:cockpitInputRequests=New-Object 'Collections.Generic.List[object]'
function NewClickResult([bool]$completed=$true,[bool]$accepted=$true){
    $completion=New-Object 'Threading.Tasks.TaskCompletionSource[bool]';$script:cockpitClickSources.Add($completion)
    if($completed){$completion.SetResult($accepted)}
    $script:cockpitClickResult=$completion
    return $completion
}
$fixtureClick=[Func[CodexNative.PreviewTarget,long,double,double,Threading.Tasks.Task[bool]]]{
    param($inputTarget,[long]$inputOperation,[double]$viewportX,[double]$viewportY)
    $script:cockpitInputRequests.Add([pscustomobject]@{target=$inputTarget;operation=$inputOperation;x=$viewportX;y=$viewportY})
    return $script:cockpitClickResult.Task
}
$window.GetType().GetField('FixtureCockpitClick',$allFields).SetValue($window,$fixtureClick)
try {
    foreach($state in 'starting','closing','closed','error'){$live.State=$state;Assert (-not (BeginCockpitClick $inputX $inputY)) ('non-open input accepted: '+$state)}
    $live.State='open'
    $shownTarget=WindowField 'cockpitShownTarget'
    $inputChanges=@{InstanceId='old-instance';RunId='old-run';Mode='html-animated';Version='old-version';ServiceGeneration=($target.ServiceGeneration-1);WindowGeneration=($target.WindowGeneration-1);SelectionGeneration=($target.SelectionGeneration-1);ContentDigest=('0'*64);CaptureFrames=$false}
    foreach($name in $inputChanges.Keys){
        $staleShown=CopyPreviewTarget $shownTarget;SetPreviewField $staleShown $name $inputChanges[$name];$window.GetType().GetField('cockpitShownTarget',$allFields).SetValue($window,$staleShown)
        Assert (-not (BeginCockpitClick $inputX $inputY)) ('stale shown '+$name+' accepted input')
    }
    $staleShown=CopyPreviewTarget $shownTarget;$presentationField=$shownTarget.GetType().GetField('Presentation',$allFields);SetPreviewField $staleShown 'Presentation' ([Enum]::ToObject($presentationField.FieldType,0))
    $window.GetType().GetField('cockpitShownTarget',$allFields).SetValue($window,$staleShown)
    Assert (-not (BeginCockpitClick $inputX $inputY)) 'Detached shown frame accepted input'
    $window.GetType().GetField('cockpitShownTarget',$allFields).SetValue($window,$shownTarget)
    $savedSource=$cockpitImage.Source;$cockpitImage.Source=$null
    Assert (-not (BeginCockpitClick $inputX $inputY)) 'missing displayed bitmap accepted input'
    $cockpitImage.Source=$savedSource
    $generationBefore=$c.ServiceGeneration;$c.GetType().GetField('generation',$flags).SetValue($c,($generationBefore+1))
    Assert (-not (BeginCockpitClick $inputX $inputY)) 'service generation switch accepted input'
    $c.GetType().GetField('generation',$flags).SetValue($c,$generationBefore)
    Assert (-not (BeginCockpitClick $inputX $inputY 2) -and -not (BeginCockpitClick -1 $inputY) -and -not (BeginCockpitClick $cockpitImage.ActualWidth $inputY)) 'double click or image boundary press accepted'
    Assert ((BeginCockpitClick $inputX $inputY)) 'valid press refused'
    $dragged=EndCockpitClick ($inputX+[Windows.SystemParameters]::MinimumHorizontalDragDistance) $inputY
    Assert ($dragged.IsCompleted -and -not $dragged.Result -and $script:cockpitInputRequests.Count -eq 0) 'drag dispatched a click'
    Assert ((BeginCockpitClick $inputX $inputY)) 'valid release-boundary press refused'
    $outside=EndCockpitClick -1 $inputY
    Assert ($outside.IsCompleted -and -not $outside.Result -and $script:cockpitInputRequests.Count -eq 0) 'outside release dispatched a click'
    Assert ((BeginCockpitClick $inputX $inputY)) 'leave-boundary press refused'
    $leave=New-Object Windows.Input.MouseEventArgs ([Windows.Input.Mouse]::PrimaryDevice),0;$leave.RoutedEvent=[Windows.UIElement]::MouseLeaveEvent;$cockpitImage.RaiseEvent($leave)
    $leftImage=EndCockpitClick $inputX $inputY
    Assert ($leftImage.IsCompleted -and -not $leftImage.Result -and $script:cockpitInputRequests.Count -eq 0) 'leave then unrelated release reused a stale press'
    $null=NewClickResult
    Assert ((BeginCockpitClick $inputX $inputY)) 'stable-frame press refused'
    $sourceBeforeRefresh=$cockpitImage.Source;ApplyFrame (FixtureFrame $target $operation 4 $fullBlueBytes)
    $click=EndCockpitClick $inputX $inputY;PumpUntil {$click.IsCompleted}
    $request=$script:cockpitInputRequests[0]
    Assert ($click.Result -and $script:cockpitInputRequests.Count -eq 1 -and -not [object]::ReferenceEquals($sourceBeforeRefresh,$cockpitImage.Source) -and $request.operation -eq $operation -and [Math]::Abs($request.x-480) -lt 0.001 -and [Math]::Abs($request.y-300) -lt 0.001) 'normal screenshot refresh interrupted click or mapped coordinates incorrectly'
    Assert (-not [object]::ReferenceEquals($request.target,(WindowField 'cockpitShownTarget'))) 'click callback received mutable displayed target'
    $request.target.RunId='callback-mutated-run'
    Assert ((WindowField 'cockpitShownTarget').RunId -eq $target.RunId -and (WindowField 'cockpitMessage').Text -notmatch '正在播放|已暂停') 'click result changed identity or invented artwork playback state'
    # Same target but a new live operation must wait for its own successfully displayed frame.
    Assert ((BeginCockpitClick $inputX $inputY)) 'operation-switch press refused'
    $live.OperationGeneration=$operation+1
    $switched=EndCockpitClick $inputX $inputY
    Assert ($switched.IsCompleted -and -not $switched.Result -and -not (BeginCockpitClick $inputX $inputY)) 'old displayed frame accepted new operation'
    ApplyFrame (FixtureFrame $target ($operation+1) 1 $fullRedBytes)
    Assert ((BeginCockpitClick $inputX $inputY)) 'new operation displayed frame did not restore input'
    $null=InvokeWindow 'ResetCockpitPress';$live.OperationGeneration=$operation;ApplyFrame (FixtureFrame $target $operation 5 $fullBlueBytes)
    # One UI request is pending; frame consumption continues and a second request is rejected.
    $pendingResult=NewClickResult $false;$countBefore=$script:cockpitInputRequests.Count;$schedulesBeforeInput=[long](WindowField 'fixturePreviewScheduleCount')
    Assert ((BeginCockpitClick $inputX $inputY)) 'pending-click press refused'
    $pendingClick=EndCockpitClick $inputX $inputY
    Assert (-not $pendingClick.IsCompleted -and (WindowField 'cockpitInputPending') -and -not (BeginCockpitClick $inputX $inputY)) 'UI input was not single-flight'
    $duplicate=EndCockpitClick $inputX $inputY;$framesBeforeInput=[long](WindowField 'cockpitAppliedFrames');$heartbeatBeforeInput=$window.Heartbeats
    ApplyFrame (FixtureFrame $target $operation 6 $fullRedBytes);PumpUntil {$window.Heartbeats -gt $heartbeatBeforeInput}
    Assert ($duplicate.IsCompleted -and -not $duplicate.Result -and $script:cockpitInputRequests.Count -eq $countBefore+1 -and [long](WindowField 'cockpitAppliedFrames') -eq $framesBeforeInput+1 -and [long](WindowField 'fixturePreviewScheduleCount') -eq $schedulesBeforeInput -and $live.OperationGeneration -eq $operation) 'pending click queued duplicates, froze frames or restarted preview'
    $pendingResult.SetResult($true);PumpUntil {$pendingClick.IsCompleted}
    Assert ($pendingClick.Result -and -not (WindowField 'cockpitInputPending')) 'completed UI request retained pending flag'
    $null=NewClickResult $true $false;Assert ((BeginCockpitClick $inputX $inputY)) 'rejected callback press refused'
    $rejectedClick=EndCockpitClick $inputX $inputY;PumpUntil {$rejectedClick.IsCompleted}
    Assert (-not $rejectedClick.Result -and (WindowField 'htmlIntent') -and $null -ne $cockpitImage.Source -and -not (WindowField 'cockpitInputPending')) 'benign click rejection stopped capture'
    # Repeated renders keep exactly one subscription; resizing changes image scale without reopening.
    $sameInputImage=$cockpitImage;$inputSchedules=[long](WindowField 'fixturePreviewScheduleCount')
    for($repeat=0;$repeat -lt 4;$repeat++){$cockpitRun.caseResults[0].scores.correctness=2+$repeat;HistoryFixture $null $cockpitRun @($cockpitRun)}
    $window.ResultsWindow.UpdateLayout()
    Assert ([object]::ReferenceEquals($sameInputImage,(WindowField 'cockpitImage')) -and (MouseHandlerCount $cockpitImage ([Windows.UIElement]::MouseLeftButtonDownEvent)) -eq 1 -and (MouseHandlerCount $cockpitImage ([Windows.UIElement]::MouseLeftButtonUpEvent)) -eq 1 -and (MouseHandlerCount $cockpitImage ([Windows.UIElement]::MouseLeaveEvent)) -eq 1) 'RenderSelected resubscribed or replaced input Image'
    $savedWidth=$window.ResultsWindow.Width;$imageWidthBefore=$cockpitImage.ActualWidth
    $window.ResultsWindow.Width=[Math]::Max($window.ResultsWindow.MinWidth,$savedWidth-160);$window.ResultsWindow.UpdateLayout()
    PumpUntil {$cockpitImage.ActualWidth -lt $imageWidthBefore -and [Math]::Abs($cockpitImage.ActualHeight-$cockpitImage.ActualWidth*600/960) -lt 1}
    Assert ($cockpitImage.ActualWidth -lt $imageWidthBefore -and [long](WindowField 'fixturePreviewScheduleCount') -eq $inputSchedules -and (WindowField 'cockpitShownOperation') -eq $operation) 'resize failed to scale or restarted capture'
    $window.ResultsWindow.Width=$savedWidth;$window.ResultsWindow.UpdateLayout();PumpUntil {[Math]::Abs($cockpitImage.ActualHeight-$cockpitImage.ActualWidth*600/960) -lt 1}
    $savedHeight=$window.ResultsWindow.Height;$nextSettings=WindowField 'nextSettings';$caseScroll=WindowField 'caseViewport'
    foreach($bounds in @(@(610,420),@(1250,600),@(960,900))){
        $window.ResultsWindow.Width=$bounds[0];$window.ResultsWindow.Height=$bounds[1];$window.ResultsWindow.UpdateLayout()
        PumpUntil {$cockpitImage.ActualWidth -le $caseScroll.ViewportWidth+1 -and $casePanel.ActualHeight -le $caseScroll.ViewportHeight+1 -and [Math]::Abs($cockpitImage.ActualHeight-$cockpitImage.ActualWidth*600/960) -lt 1}
        Assert ($cockpitImage.ActualWidth -gt 0 -and $cockpitImage.ActualHeight -gt 0 -and $casePanel.ActualHeight -le $caseScroll.ViewportHeight+1) ('small/wide viewport clipped the complete artwork or actions: '+($bounds -join 'x'))
        $openControl=@($casePanel.Children|Where-Object {$_ -is [Windows.Controls.Button] -and [Windows.Automation.AutomationProperties]::GetAutomationId($_) -eq 'OpenHtmlPreview'})[0]
        if($bounds[1] -eq 420){
            Assert ((WindowField 'cockpitMessage').IsVisible -and (WindowField 'cockpitMessage').Text -match '作品操作未发送') 'compact density hid the preceding rejected artwork operation'
            $null=InvokeWindow 'SetCockpitMessage' @('动画预览已加载 · 最多每秒 5 帧')
            PumpUntil {$cockpitImage.ActualHeight -ge 150 -and -not (WindowField 'cockpitMessage').IsVisible -and -not (WindowField 'resultHeading').IsVisible}
            $imagePoint=$cockpitImage.TranslatePoint((New-Object Windows.Point 0,0),$caseScroll);$actionPoint=$openControl.TranslatePoint((New-Object Windows.Point 0,0),$caseScroll)
            Assert ($cockpitImage.ActualHeight -ge 150 -and $imagePoint.X -ge -1 -and $imagePoint.Y -ge -1 -and $imagePoint.X+$cockpitImage.ActualWidth -le $caseScroll.ViewportWidth+1 -and $imagePoint.Y+$cockpitImage.ActualHeight -le $caseScroll.ViewportHeight+1 -and $caseScroll.ScrollableHeight -le 1) ('compact artwork is too small or incomplete: '+$cockpitImage.ActualWidth+'x'+$cockpitImage.ActualHeight)
            Assert ($openControl.IsVisible -and $openControl.IsEnabled -and $actionPoint.Y -ge -1 -and $actionPoint.Y+$openControl.ActualHeight -le $caseScroll.ViewportHeight+1) 'compact artwork action is not reachable without scrolling'
            Assert ($openControl.ToolTip -match '运行诊断' -and $openControl.ToolTip -match '清理已确认') 'compact Cockpit diagnostics remained on a collapsed case heading'
            Assert ((WindowField 'cockpitExplanation').IsVisible -and (WindowField 'cockpitExplanation').Text -ceq '点击画面中的播放/暂停按钮操作作品。' -and (WindowField 'cockpitExplanation').ToolTip -match '最多每秒 5 帧' -and (WindowField 'cockpitExplanation').ToolTip -match '系统减少动态效果可能使作品默认暂停' -and $openControl.ToolTip -match '弹窗内预览 · 支持作品交互') 'compact operation guidance or detailed tooltip missing'
            $null=InvokeWindow 'SetCockpitMessage' @('作品操作未发送，请稍后重试。');$window.ResultsWindow.UpdateLayout()
            Assert ((WindowField 'cockpitMessage').IsVisible -and (WindowField 'cockpitMessage').Text -match '作品操作未发送') 'compact density hid an artwork input error'
            $benchControl=WindowField 'bench';$savedBench=$benchControl.Text;$benchControl.Text=[CodexNative.WidgetClient]::ErrorDescription('disconnected');$null=InvokeWindow 'UpdateControls'
            PumpUntil {(WindowField 'processStatus').IsVisible}
            Assert ((WindowField 'processStatus').IsVisible -and (WindowField 'processStatus').Text -ceq $benchControl.Text) 'compact density hid a service/process error'
            $benchControl.Text=$savedBench;$null=InvokeWindow 'UpdateControls';$null=InvokeWindow 'SetCockpitMessage' @('动画预览已加载 · 最多每秒 5 帧')
        }else{
            PumpUntil {(WindowField 'resultHeading').IsVisible -and (WindowField 'cockpitMessage').IsVisible -and (WindowField 'cockpitExplanation').Text -match '最多每秒 5 帧'}
            Assert ((WindowField 'resultTitle').FontSize -eq 22 -and (WindowField 'resultHeading').IsVisible -and (WindowField 'cockpitMessage').IsVisible) 'compact density leaked into the default/wide layout'
            Assert ($openControl.IsVisible -and $openControl.ToolTip -match '运行诊断' -and $openControl.ToolTip -match '结束原因 正常完成') 'normal Cockpit artwork lost accessible diagnostics'
        }
        $nextSettings.IsExpanded=$true;$window.ResultsWindow.UpdateLayout();PumpUntil {$window.ModelControl.IsVisible -and (WindowField 'settingsViewport').ActualHeight -le (WindowField 'settingsViewport').MaxHeight+1}
        $caseScroll.ScrollToEnd();$window.ResultsWindow.UpdateLayout()
        $openControl=@($casePanel.Children|Where-Object {$_ -is [Windows.Controls.Button] -and [Windows.Automation.AutomationProperties]::GetAutomationId($_) -eq 'OpenHtmlPreview'})[0]
        $actionPoint=$openControl.TranslatePoint((New-Object Windows.Point 0,0),$caseScroll)
        Assert ($window.ModelControl.IsVisible -and $actionPoint.Y -ge -1 -and $actionPoint.Y+$openControl.ActualHeight -le $caseScroll.ActualHeight+1) 'expanded settings made artwork actions unreachable'
        $nextSettings.IsExpanded=$false;$caseScroll.ScrollToTop();$window.ResultsWindow.UpdateLayout()
    }
    $window.ResultsWindow.Width=$savedWidth;$window.ResultsWindow.Height=$savedHeight;$window.ResultsWindow.UpdateLayout()
    PumpUntil {$casePanel.ActualHeight -le $caseScroll.ViewportHeight+1 -and [Math]::Abs($cockpitImage.ActualHeight-$cockpitImage.ActualWidth*600/960) -lt 1}
    Assert ([long](WindowField 'fixturePreviewScheduleCount') -eq $inputSchedules -and (WindowField 'cockpitShownOperation') -eq $operation) 'settings or height resize restarted capture'
    $inputX=$cockpitImage.ActualWidth/2;$inputY=$cockpitImage.ActualHeight/2
    # A late failing reply from a cleared operation cannot clear a newer pending request.
    $oldResult=NewClickResult $false;Assert ((BeginCockpitClick $inputX $inputY)) 'old-token press refused'
    $oldClick=EndCockpitClick $inputX $inputY;$oldToken=[long](WindowField 'cockpitInputToken');$null=InvokeWindow 'RevokeCockpitInput'
    Assert (-not (WindowField 'cockpitInputPending') -and $null -eq (WindowField 'cockpitShownTarget') -and -not (BeginCockpitClick $inputX $inputY)) 'new request retained shown credentials'
    $live.OperationGeneration=$operation+1;ApplyFrame (FixtureFrame $target ($operation+1) 1 $fullBlueBytes)
    $newResult=NewClickResult $false;Assert ((BeginCockpitClick $inputX $inputY)) 'new-token press refused'
    $newClick=EndCockpitClick $inputX $inputY;$newToken=[long](WindowField 'cockpitInputToken');$newSource=$cockpitImage.Source
    $oldResult.SetException((New-Object IO.IOException 'fixture old input failed'));PumpUntil {$oldClick.IsCompleted}
    Assert (-not $oldClick.Result -and -not $newClick.IsCompleted -and (WindowField 'cockpitInputPending') -and [long](WindowField 'cockpitInputToken') -eq $newToken -and $newToken -gt $oldToken -and [object]::ReferenceEquals($newSource,$cockpitImage.Source) -and (WindowField 'htmlIntent')) 'late exception/finally cleared new click, frame or intent'
    $newResult.SetResult($true);PumpUntil {$newClick.IsCompleted}
    Assert ($newClick.Result -and -not (WindowField 'cockpitInputPending')) 'new click failed after late old exception'
    $live.OperationGeneration=$operation;ApplyFrame (FixtureFrame $target $operation 7 $fullRedBytes)
    # A source change between press/release revokes the old gesture even after its new frame is visible.
    Assert ((BeginCockpitClick $inputX $inputY)) 'content-switch press refused'
    $requestsBeforeSwitch=$script:cockpitInputRequests.Count;$oldInputOperation=$operation
    $cockpitRun.caseResults[0].answer='<html>fixture changed between mouse press and release</html>';HistoryFixture $null $cockpitRun @($cockpitRun)
    Assert ($null -eq (WindowField 'cockpitShownTarget') -and $null -eq (WindowField 'cockpitPressTarget') -and $null -eq $cockpitImage.Source) 'content switch retained shown or press credentials'
    $target=WindowField 'cockpitTarget';$live=WindowField 'fixturePreviewSnapshot';$operation=[long]$live.OperationGeneration;$live.State='open';ApplyFrame (FixtureFrame $target $operation 1 $fullRedBytes)
    $contentSwitched=EndCockpitClick $inputX $inputY
    Assert ($contentSwitched.IsCompleted -and -not $contentSwitched.Result -and $operation -ne $oldInputOperation -and $script:cockpitInputRequests.Count -eq $requestsBeforeSwitch -and (InvokeWindow 'CurrentCockpitImage')) 'new source frame accepted a press belonging to the old source'
    # A current exception is localized and revokes credentials; polling cannot reopen the failed preview.
    $fault=NewClickResult $false;$fault.SetException((New-Object IO.IOException 'fixture current input failed'));Assert ((BeginCockpitClick $inputX $inputY)) 'current-failure press refused'
    $failedClick=EndCockpitClick $inputX $inputY;PumpUntil {$failedClick.IsCompleted}
    Assert (-not $failedClick.Result -and -not (WindowField 'htmlIntent') -and $null -eq $cockpitImage.Source -and $null -eq (WindowField 'cockpitShownTarget') -and -not (WindowField 'cockpitInputPending') -and (WindowField 'cockpitMessage').Text -match '作品操作失败') 'current input failure was not localized, stopped or cleared'
    $failedSchedules=[long](WindowField 'fixturePreviewScheduleCount');HistoryFixture $null $cockpitRun @($cockpitRun)
    Assert ([long](WindowField 'fixturePreviewScheduleCount') -eq $failedSchedules -and -not (WindowField 'htmlIntent')) 'poll reauthorized failed input'
    $reload=@($casePanel.Children|Where-Object {$_ -is [Windows.Controls.Button] -and [Windows.Automation.AutomationProperties]::GetAutomationId($_) -eq 'OpenHtmlPreview'})[0];Click $reload
    $target=WindowField 'cockpitTarget';$live=WindowField 'fixturePreviewSnapshot';$operation=[long]$live.OperationGeneration
    Assert ((WindowField 'htmlIntent') -and [long](WindowField 'fixturePreviewScheduleCount') -eq $failedSchedules+1 -and (PreviewField $target 'Presentation').ToString() -ceq 'Inline' -and (PreviewField $target 'CaptureFrames')) 'Reload did not retry the failed inline input preview'
    ApplyFrame (FixtureFrame $target $operation 1 $blueBytes)
} finally {
    $window.GetType().GetField('FixtureCockpitClick',$allFields).SetValue($window,$null)
    foreach($completion in $script:cockpitClickSources){if(-not $completion.Task.IsCompleted){$completion.TrySetResult($false)|Out-Null}}
    [Threading.SynchronizationContext]::SetSynchronizationContext($previousSyncContext)
}
$cockpitInputFixtureChecks=$script:checks-$inputChecksBefore
$scheduleBefore=[long](WindowField 'fixturePreviewScheduleCount');$sameImage=WindowField 'cockpitImage';$sameBitmap=$sameImage.Source
for($i=0;$i -lt 3;$i++){HistoryFixture $null $cockpitRun @($cockpitRun)}
$cockpitRun.caseResults[0].scores.correctness=5;HistoryFixture $null $cockpitRun @($cockpitRun)
Assert ([long](WindowField 'fixturePreviewScheduleCount') -eq $scheduleBefore -and [object]::ReferenceEquals($sameImage,(WindowField 'cockpitImage')) -and [object]::ReferenceEquals($sameBitmap,(WindowField 'cockpitImage').Source)) 'same content poll/score rescheduled or rebuilt Cockpit image'
$consumerTimer=WindowField 'timer';$consumerWasEnabled=$consumerTimer.IsEnabled;$consumerTimer.Stop()
try {
    $appliedBefore=[long](WindowField 'cockpitAppliedFrames')
    for($i=3;$i -le 202;$i++){
        QueueFrame (FixtureFrame $target $operation $i $blueBytes)
        $pendingFrame=WindowField 'pendingCockpitFrame';$burstLive=WindowField 'fixturePreviewSnapshot';$burstTarget=WindowField 'cockpitTarget'
        $reflectedSequence=if($null -eq $pendingFrame){$null}else{$pendingFrame.GetType().GetProperty('Sequence',$allFields).GetValue($pendingFrame,$null)}
        $burstDiagnostic=[ordered]@{i=$i;pendingNull=($null -eq $pendingFrame);adapterSequence=$pendingFrame.Sequence;reflectionSequence=$reflectedSequence;appliedBefore=$appliedBefore;appliedAfter=[long](WindowField 'cockpitAppliedFrames');timerEnabled=$consumerTimer.IsEnabled;htmlIntent=(WindowField 'htmlIntent');acceptFrames=(WindowField 'acceptCockpitFrames');windowGeneration=(WindowField 'windowGeneration');selectionGeneration=(WindowField 'selectionGeneration');targetWindow=$burstTarget.WindowGeneration;targetSelection=$burstTarget.SelectionGeneration;liveOperation=$burstLive.OperationGeneration}|ConvertTo-Json -Compress
        Assert ($null -ne $pendingFrame -and $reflectedSequence -eq $i -and [long](WindowField 'cockpitAppliedFrames') -eq $appliedBefore) ('frame event grew a queue or decoded before timer;fixtureDiagnostic='+$burstDiagnostic)
    }
    $null=InvokeWindow 'DrainCockpitFrame'
    Assert ($null -eq (WindowField 'pendingCockpitFrame') -and [long](WindowField 'cockpitAppliedFrames') -eq $appliedBefore+1 -and [long](WindowField 'cockpitFrameSequence') -eq 202) 'single pending slot did not consume latest frame'
} finally {if($consumerWasEnabled){$consumerTimer.Start()}}
$heartbeatAfterBurst=$window.Heartbeats;PumpUntil {$window.Heartbeats -gt $heartbeatAfterBurst}
Assert ($consumerTimer.IsEnabled -and $window.Heartbeats -gt $heartbeatAfterBurst) 'frame burst did not restore live UI consumer'
Assert (@($window.GetType().GetFields($allFields)|Where-Object {$_.FieldType.FullName -match 'Queue.*PreviewFrame'}).Count -eq 0) 'Cockpit has an unbounded frame queue'
$accepted=[long](WindowField 'cockpitAppliedFrames');$acceptedBitmap=(WindowField 'cockpitImage').Source
$changes=@{InstanceId='old-instance';RunId='old-run';Mode='html-animated';Version='old-version';ServiceGeneration=($target.ServiceGeneration-1);WindowGeneration=($target.WindowGeneration-1);SelectionGeneration=($target.SelectionGeneration-1);ContentDigest=('0'*64);CaptureFrames=$false}
foreach($name in $changes.Keys){
    $staleTarget=CopyPreviewTarget $target;SetPreviewField $staleTarget $name $changes[$name]
    ApplyFrame (FixtureFrame $staleTarget $operation 203 $redBytes)
    Assert ([long](WindowField 'cockpitAppliedFrames') -eq $accepted -and [object]::ReferenceEquals($acceptedBitmap,(WindowField 'cockpitImage').Source)) ('late '+$name+' frame accepted')
}
$staleTarget=CopyPreviewTarget $target;$presentationField=$target.GetType().GetField('Presentation',$allFields);SetPreviewField $staleTarget 'Presentation' ([Enum]::ToObject($presentationField.FieldType,0))
ApplyFrame (FixtureFrame $staleTarget $operation 203 $redBytes)
Assert ([long](WindowField 'cockpitAppliedFrames') -eq $accepted) 'late presentation frame accepted'
ApplyFrame (FixtureFrame $target ($operation-1) 203 $redBytes);ApplyFrame (FixtureFrame $target $operation 202 $redBytes)
Assert ([long](WindowField 'cockpitAppliedFrames') -eq $accepted) 'late operation or repeated sequence frame accepted'
$serviceGeneration=$c.ServiceGeneration;$c.GetType().GetField('generation',$flags).SetValue($c,($serviceGeneration+1));ApplyFrame (FixtureFrame $target $operation 204 $redBytes)
$serviceDiagnostic=[ordered]@{clientMatchesWindow=[object]::ReferenceEquals($c,(WindowField 'client'));modifiedClientGeneration=$c.ServiceGeneration;windowClientGeneration=(WindowField 'client').ServiceGeneration;frameTargetGeneration=$target.ServiceGeneration;appliedBefore=$accepted;appliedAfter=[long](WindowField 'cockpitAppliedFrames');timerEnabled=(WindowField 'timer').IsEnabled;htmlIntent=(WindowField 'htmlIntent');frameOperation=$operation;liveOperation=(WindowField 'fixturePreviewSnapshot').OperationGeneration;targetWindow=$target.WindowGeneration;currentWindow=(WindowField 'windowGeneration');targetSelection=$target.SelectionGeneration;currentSelection=(WindowField 'selectionGeneration')}|ConvertTo-Json -Compress
Assert ([long](WindowField 'cockpitAppliedFrames') -eq $accepted) ('changed client service generation accepted old frame;fixtureDiagnostic='+$serviceDiagnostic)
$c.GetType().GetField('generation',$flags).SetValue($c,$serviceGeneration)
$cockpitRun.caseResults[0].answer='<html>changed cockpit source</html>';HistoryFixture $null $cockpitRun @($cockpitRun)
Assert ($null -eq (WindowField 'cockpitImage').Source -and [long](WindowField 'fixturePreviewScheduleCount') -eq $scheduleBefore+1) 'changed content retained pixels or omitted new request'
ApplyFrame (FixtureFrame $target $operation 205 $redBytes)
Assert ($null -eq (WindowField 'cockpitImage').Source) 'old digest frame restored changed content'
$target=WindowField 'cockpitTarget';$operation=[long](WindowField 'fixturePreviewSnapshot').OperationGeneration
Assert ((WindowField 'htmlIntent') -and (PreviewField $target 'Presentation').ToString() -ceq 'Inline' -and (PreviewField $target 'CaptureFrames')) 'changed ready content required a second Results click'
ApplyFrame (FixtureFrame $target $operation 1 $redBytes)
$openControls=@($casePanel.Children|Where-Object {$_ -is [Windows.Controls.Button] -and [Windows.Automation.AutomationProperties]::GetAutomationId($_) -eq 'OpenHtmlPreview'})
$open=$openControls[0]
Assert ($openControls.Count -eq 1 -and $open.Content.ToString() -ceq '重新加载动画' -and $open.IsEnabled -and $open.ToolTip -match '^弹窗内预览 · 支持作品交互' -and $open.ToolTip -match '运行诊断') 'Cockpit reload action is duplicated, disabled or describes a detached window'
$inlineSchedules=[long](WindowField 'fixturePreviewScheduleCount');$inlineBitmap=(WindowField 'cockpitImage').Source;$inlineShown=WindowField 'cockpitShownTarget'
$inlineRequest=$window.SubmittedRequest;$inlineRequestJson=[CodexNative.WidgetClient]::Serialize($inlineRequest)
for($repeat=0;$repeat -lt 3;$repeat++){Click $open}
HistoryFixture $null $cockpitRun @($cockpitRun)
Assert ([long](WindowField 'fixturePreviewScheduleCount') -eq $inlineSchedules -and [long](WindowField 'fixturePreviewSnapshot').OperationGeneration -eq $operation -and (PreviewField (WindowField 'cockpitTarget') 'Presentation').ToString() -ceq 'Inline' -and (PreviewField (WindowField 'cockpitTarget') 'CaptureFrames') -and [object]::ReferenceEquals($inlineBitmap,(WindowField 'cockpitImage').Source) -and [object]::ReferenceEquals($inlineShown,(WindowField 'cockpitShownTarget')) -and [long](WindowField 'cockpitShownOperation') -eq $operation) 'repeated live Reload clicks or polling restarted capture, cleared the displayed bitmap or changed presentation'
Assert ([object]::ReferenceEquals($inlineRequest,$window.SubmittedRequest) -and [CodexNative.WidgetClient]::Serialize($window.SubmittedRequest) -ceq $inlineRequestJson -and $window.ModeControl.SelectedValue -ceq 'cockpit' -and $window.ModelControl.SelectedValue -ceq $previewDraftModel -and $nextRunEfforts.SelectedValue -ceq $previewDraftEffort) 'Reload submitted generation work or changed the next-run configuration'
$inlineTarget=CopyPreviewTarget $target;$inlineOperation=$operation
$stopBefore=[long](WindowField 'fixturePreviewStopCount');$window.ResultsWindow.Hide()
Assert ($null -eq (WindowField 'cockpitShownTarget') -and $null -eq (WindowField 'cockpitShownBitmap') -and -not (WindowField 'cockpitInputPending') -and -not (WindowField 'htmlIntent') -and $null -eq (WindowField 'cockpitImage').Source -and $null -eq (WindowField 'pendingCockpitFrame') -and [long](WindowField 'fixturePreviewStopCount') -gt $stopBefore) 'hide retained frame, intent or worker'
QueueFrame (FixtureFrame $inlineTarget $inlineOperation 2 $redBytes)
Assert ($null -eq (WindowField 'pendingCockpitFrame')) 'hidden late event retained bytes'
$window.ResultsWindow.Show()
Assert ((WindowField 'htmlIntent') -and [long](WindowField 'fixturePreviewScheduleCount') -eq $inlineSchedules+1 -and (PreviewField (WindowField 'cockpitTarget') 'Presentation').ToString() -ceq 'Inline' -and (PreviewField (WindowField 'cockpitTarget') 'CaptureFrames') -and $null -eq (WindowField 'cockpitImage').Source) 'Show did not automatically resume a fresh inline capture'
$target=WindowField 'cockpitTarget';$operation=[long](WindowField 'fixturePreviewSnapshot').OperationGeneration
Assert ($operation -ne $inlineOperation -and $target.WindowGeneration -ne $inlineTarget.WindowGeneration) 'Show reused the hidden capture operation or window generation'
ApplyFrame (FixtureFrame $inlineTarget $inlineOperation 3 $blueBytes)
Assert ($null -eq (WindowField 'cockpitImage').Source) 'hidden-generation frame restored pixels after Show'
ApplyFrame (FixtureFrame $target $operation 1 $redBytes)
Assert ($null -ne (WindowField 'cockpitImage').Source -and [long](WindowField 'cockpitShownOperation') -eq $operation) 'Show resumed capture but did not display its new frame'
$oversized=FrameBytes 255 0 961 1;ApplyFrame (FixtureFrame $target $operation 2 $oversized)
Assert ($null -eq (WindowField 'cockpitImage').Source -and -not (WindowField 'htmlIntent') -and (WindowField 'cockpitMessage').Text -match '画面读取失败') 'oversized decode did not clear and stop'
$failedSchedules=[long](WindowField 'fixturePreviewScheduleCount')
for($repeat=0;$repeat -lt 3;$repeat++){$cockpitRun.caseResults[0].scores.correctness=2+$repeat;HistoryFixture $null $cockpitRun @($cockpitRun)}
Assert (-not (WindowField 'htmlIntent') -and [long](WindowField 'fixturePreviewScheduleCount') -eq $failedSchedules -and $null -eq (WindowField 'cockpitShownTarget') -and $null -eq (WindowField 'cockpitImage').Source) 'oversized-frame failure was retried by ordinary history or score polling'
$open=@($casePanel.Children|Where-Object {$_ -is [Windows.Controls.Button] -and [Windows.Automation.AutomationProperties]::GetAutomationId($_) -eq 'OpenHtmlPreview'})[0];Click $open
$target=WindowField 'cockpitTarget';$operation=[long](WindowField 'fixturePreviewSnapshot').OperationGeneration
Assert ((WindowField 'htmlIntent') -and [long](WindowField 'fixturePreviewScheduleCount') -eq $failedSchedules+1 -and (PreviewField $target 'Presentation').ToString() -ceq 'Inline' -and (PreviewField $target 'CaptureFrames')) 'Reload did not explicitly retry an oversized-frame failure'
ApplyFrame (FixtureFrame $target $operation 1 $blueBytes);ApplyFrame (FixtureFrame $target $operation 2 ([byte[]]@(1,2,3,4)))
Assert ($null -eq (WindowField 'cockpitImage').Source -and -not (WindowField 'htmlIntent') -and $null -eq (WindowField 'pendingCockpitFrame')) 'invalid encoded frame retained stale pixels'
$failedSchedules=[long](WindowField 'fixturePreviewScheduleCount')
for($repeat=0;$repeat -lt 3;$repeat++){$cockpitRun.caseResults[0].scores.correctness=2+$repeat;HistoryFixture $null $cockpitRun @($cockpitRun)}
Assert (-not (WindowField 'htmlIntent') -and [long](WindowField 'fixturePreviewScheduleCount') -eq $failedSchedules -and $null -eq (WindowField 'cockpitShownTarget')) 'invalid encoded frame was retried by ordinary polling'
foreach($errorCode in 'source_unavailable','source_identity_mismatch','source_digest_mismatch','source_html_ambiguous','guard_environment_unavailable','preview_capture_failed','preview_input_failed','capability_missing','edge_not_found','cleanup_failed','unknown-private-secret'){
    $schedulesBeforeReload=[long](WindowField 'fixturePreviewScheduleCount');$open=@($casePanel.Children|Where-Object {$_ -is [Windows.Controls.Button] -and [Windows.Automation.AutomationProperties]::GetAutomationId($_) -eq 'OpenHtmlPreview'})[0];Click $open
    $target=WindowField 'cockpitTarget';$operation=[long](WindowField 'fixturePreviewSnapshot').OperationGeneration
    Assert ((WindowField 'htmlIntent') -and [long](WindowField 'fixturePreviewScheduleCount') -eq $schedulesBeforeReload+1 -and (PreviewField $target 'Presentation').ToString() -ceq 'Inline' -and (PreviewField $target 'CaptureFrames')) ('Reload did not recover a failed inline preview: '+$errorCode)
    ApplyFrame (FixtureFrame $target $operation 1 $redBytes)
    $errorUpdate=New-Object CodexNative.PreviewSnapshot;$errorUpdate.Target=CopyPreviewTarget $target;$errorUpdate.OperationGeneration=$operation;$errorUpdate.State='error';$errorUpdate.ErrorCode=$errorCode;$errorUpdate.CleanupState='cleaned'
    $window.GetType().GetField('fixturePreviewSnapshot',$allFields).SetValue($window,$errorUpdate)
    $previewUpdateArguments=New-Object object[] 1;$previewUpdateArguments[0]=$errorUpdate.psobject.BaseObject;$null=InvokeWindow 'ApplyPreviewUpdate' $previewUpdateArguments
    Assert ($null -eq (WindowField 'cockpitShownTarget') -and $null -eq (WindowField 'cockpitShownBitmap') -and -not (WindowField 'cockpitInputPending') -and -not (WindowField 'htmlIntent') -and $null -eq (WindowField 'cockpitImage').Source -and (WindowField 'cockpitMessage').Text -match '[一-龥]' -and (WindowField 'cockpitMessage').Text -notmatch 'private-secret|source_|guard_') ('error not localized or stopped: '+$errorCode)
    $schedules=[long](WindowField 'fixturePreviewScheduleCount')
    for($repeat=0;$repeat -lt 3;$repeat++){$cockpitRun.caseResults[0].scores.correctness=2+$repeat;HistoryFixture $null $cockpitRun @($cockpitRun)}
    Assert ([long](WindowField 'fixturePreviewScheduleCount') -eq $schedules -and -not (WindowField 'htmlIntent') -and $null -eq (WindowField 'cockpitImage').Source) ('error history or score poll restored capture: '+$errorCode)
}
$explicitRetrySchedules=[long](WindowField 'fixturePreviewScheduleCount');$window.OpenResults()
$target=WindowField 'cockpitTarget';$operation=[long](WindowField 'fixturePreviewSnapshot').OperationGeneration
Assert ((WindowField 'htmlIntent') -and [long](WindowField 'fixturePreviewScheduleCount') -eq $explicitRetrySchedules+1 -and (PreviewField $target 'Presentation').ToString() -ceq 'Inline' -and (PreviewField $target 'CaptureFrames')) 'explicit Results open did not retry the failed content'
ApplyFrame (FixtureFrame $target $operation 1 $redBytes)
$cockpitRun.caseResults[0].answer='';HistoryFixture $null $cockpitRun @($cockpitRun)
Assert ((WindowField 'cockpitMessage').Text -match '暂无动画作品' -and $null -eq (WindowField 'cockpitImage').Source -and -not @($casePanel.Children|Where-Object {$_ -is [Windows.Controls.Button] -and [Windows.Automation.AutomationProperties]::GetAutomationId($_) -eq 'OpenHtmlPreview'})[0].IsEnabled) 'empty Cockpit state missing'
$cockpitRun.status='running';$cockpitRun.caseResults[0].status='running';HistoryFixture $cockpitRun $null @($cockpitRun)
Assert ((WindowField 'cockpitMessage').Text -match '等待动画作品') 'pending Cockpit state missing'
$completionSchedules=[long](WindowField 'fixturePreviewScheduleCount');$completionRequest=$window.SubmittedRequest
$cockpitRun.status='completed';$cockpitRun.caseResults[0].status='completed';$cockpitRun.caseResults[0].answer='<html>fixture restored</html>';HistoryFixture $null $cockpitRun @($cockpitRun)
$target=WindowField 'cockpitTarget';$operation=[long](WindowField 'fixturePreviewSnapshot').OperationGeneration
Assert ((WindowField 'htmlIntent') -and [long](WindowField 'fixturePreviewScheduleCount') -eq $completionSchedules+1 -and (PreviewField $target 'Presentation').ToString() -ceq 'Inline' -and (PreviewField $target 'CaptureFrames') -and $null -eq (WindowField 'cockpitImage').Source -and [object]::ReferenceEquals($completionRequest,$window.SubmittedRequest)) 'running-to-completed history did not automatically start inline capture without generation work'
ApplyFrame (FixtureFrame $target $operation 1 $blueBytes)
Assert ($null -ne (WindowField 'cockpitImage').Source -and [long](WindowField 'cockpitShownOperation') -eq $operation) 'completed history did not display its automatic inline frame'
$c.GetType().GetField('cockpitSupported',$flags).SetValue($c,$false);$cockpitRun.caseResults[0].scores.correctness=3;HistoryFixture $null $cockpitRun @($cockpitRun)
$null=InvokeWindow 'StopHtml';$window.OpenResults()
Assert (-not (WindowField 'htmlIntent') -and (WindowField 'cockpitMessage').Text -match '不支持') 'unsupported Cockpit enabled capture'
$c.GetType().GetField('cockpitSupported',$flags).SetValue($c,$true);HistoryFixture $null $cockpitRun @($cockpitRun);$window.OpenResults()
$target=WindowField 'cockpitTarget';$operation=[long](WindowField 'fixturePreviewSnapshot').OperationGeneration;ApplyFrame (FixtureFrame $target $operation 1 $redBytes)
$window.FixtureEvent('telemetry','disconnected',$null)
Assert (-not (WindowField 'htmlIntent') -and $null -eq (WindowField 'cockpitImage').Source -and $null -eq (WindowField 'pendingCockpitFrame')) 'telemetry disconnect retained Cockpit capture'
HistoryFixture $null $cockpitRun @($cockpitRun);$window.OpenResults()
$target=WindowField 'cockpitTarget';$operation=[long](WindowField 'fixturePreviewSnapshot').OperationGeneration;ApplyFrame (FixtureFrame $target $operation 1 $blueBytes)
$window.FixtureEvent('history','disconnected',$null)
Assert (-not (WindowField 'htmlIntent') -and $null -eq (WindowField 'cockpitImage').Source -and $null -eq (WindowField 'pendingCockpitFrame')) 'history disconnect retained Cockpit capture'
HistoryFixture $null $cockpitRun @($cockpitRun);$window.OpenResults()
$target=WindowField 'cockpitTarget';$operation=[long](WindowField 'fixturePreviewSnapshot').OperationGeneration;ApplyFrame (FixtureFrame $target $operation 1 $redBytes)
$closedImage=WindowField 'cockpitImage';$closedTarget=CopyPreviewTarget $target;$closedOperation=$operation;$beforeClose=[long](WindowField 'fixturePreviewStopCount');$closedSchedules=[long](WindowField 'fixturePreviewScheduleCount');$window.ResultsWindow.Close()
QueueFrame (FixtureFrame $target $operation 2 $blueBytes)
Assert ($null -eq (WindowField 'cockpitShownTarget') -and $null -eq (WindowField 'cockpitShownBitmap') -and $null -eq (WindowField 'cockpitPressTarget') -and -not (WindowField 'cockpitInputPending') -and $null -eq $closedImage.Source -and $null -eq (WindowField 'pendingCockpitFrame') -and -not (WindowField 'htmlIntent') -and [long](WindowField 'fixturePreviewStopCount') -gt $beforeClose) 'close retained capture or late event'
$window.OpenResults()
$target=WindowField 'cockpitTarget';$operation=[long](WindowField 'fixturePreviewSnapshot').OperationGeneration
Assert ((WindowField 'htmlIntent') -and [long](WindowField 'fixturePreviewScheduleCount') -eq $closedSchedules+1 -and $operation -ne $closedOperation -and $target.WindowGeneration -ne $closedTarget.WindowGeneration -and (PreviewField $target 'Presentation').ToString() -ceq 'Inline' -and (PreviewField $target 'CaptureFrames') -and $null -eq (WindowField 'cockpitImage').Source) 'first Results open after Close did not start fresh inline capture'
ApplyFrame (FixtureFrame $closedTarget $closedOperation 3 $blueBytes)
Assert ($null -eq (WindowField 'cockpitImage').Source) 'closed-generation frame restored pixels in the new Results window'
ApplyFrame (FixtureFrame $target $operation 1 $redBytes)
Assert ($null -ne (WindowField 'cockpitImage').Source -and [long](WindowField 'cockpitShownOperation') -eq $operation) 'first Results reopen did not display its new frame'
Assert ($null -eq (WindowField 'browser')) 'fixture created a browser'
# An empty visible Results window waits for a ready result, including after Hide/Show.
$null=InvokeWindow 'StopHtml'
foreach($name in 'snapshot','selected','selectedId'){$window.GetType().GetField($name,$allFields).SetValue($window,$null)}
$null=InvokeWindow 'UpdateHistory';$earlySchedules=[long](WindowField 'fixturePreviewScheduleCount')
$window.OpenResults()
Assert (-not (WindowField 'htmlIntent') -and $null -eq (WindowField 'cockpitTarget') -and [long](WindowField 'fixturePreviewScheduleCount') -eq $earlySchedules) 'empty Results started capture before any history arrived'
HistoryFixture $null $null @()
Assert (-not (WindowField 'htmlIntent') -and [long](WindowField 'fixturePreviewScheduleCount') -eq $earlySchedules) 'empty early history scheduled a preview'
HistoryFixture $null $cockpitRun @($cockpitRun)
Assert ((WindowField 'htmlIntent') -and [long](WindowField 'fixturePreviewScheduleCount') -eq $earlySchedules+1 -and (PreviewField (WindowField 'cockpitTarget') 'Presentation').ToString() -ceq 'Inline' -and (PreviewField (WindowField 'cockpitTarget') 'CaptureFrames')) 'first ready history did not automatically load in the waiting Results window'
$null=InvokeWindow 'StopHtml'
foreach($name in 'snapshot','selected','selectedId'){$window.GetType().GetField($name,$allFields).SetValue($window,$null)}
$null=InvokeWindow 'UpdateHistory';$window.OpenResults();$earlySchedules=[long](WindowField 'fixturePreviewScheduleCount')
$window.ResultsWindow.Hide();$window.ResultsWindow.Show()
Assert (-not (WindowField 'htmlIntent') -and [long](WindowField 'fixturePreviewScheduleCount') -eq $earlySchedules) 'Show started capture before the waiting history was ready'
HistoryFixture $null $cockpitRun @($cockpitRun)
Assert ((WindowField 'htmlIntent') -and [long](WindowField 'fixturePreviewScheduleCount') -eq $earlySchedules+1 -and (PreviewField (WindowField 'cockpitTarget') 'Presentation').ToString() -ceq 'Inline' -and (PreviewField (WindowField 'cockpitTarget') 'CaptureFrames')) 'ready history after Hide/Show did not automatically load inline'
$cockpitChecks=[long](WindowField 'cockpitAppliedFrames');$null=InvokeWindow 'StopHtml'
$c.GetType().GetField('cockpitSupported',$flags).SetValue($c,$true);$window.GetType().GetMethod('UpdateDefaults',$flags).Invoke($window,@())|Out-Null
Assert ($window.ModeControl.SelectedValue -ceq 'cockpit' -and @($window.ModeControl.ItemsSource).Count -eq 1 -and ($window.GetType().GetField('run',$flags).GetValue($window)).Content -match 'Cockpit') ('history preview changed the only next-run mode: '+$window.ModeControl.SelectedValue+' / '+($window.GetType().GetField('run',$flags).GetValue($window)).Content)
# Hidden scoring retains its internal acknowledgement and version identity semantics.
$draftMap=$window.GetType().GetField('drafts',$flags).GetValue($window)
$draftKey=[CodexNative.WidgetClient]::Serialize(@('internal-score','pelican-svg-animated','pelican-svg-animated-v1'))
$draftMap[$draftKey]=[int[]]@(2,3,4)
$startScore=$window.GetType().GetMethod('StartScore',$flags)
$window.FixtureAcceptScore=$false
Assert (-not $startScore.Invoke($window,@(@{rubricVersion='pelican-svg-animated-v1'},$draftKey)) -and $null -eq $window.PendingDraft) 'rejected internal score became pending'
$window.FixtureAcceptScore=$true
Assert ($startScore.Invoke($window,@(@{rubricVersion='pelican-svg-animated-v1'},$draftKey)) -and $window.PendingDraft -eq $draftKey) 'internal score identity lost'
foreach($kind in 'run','cancel','baseline'){$window.FixtureEvent($kind,$null,'{}');Assert ($draftMap.ContainsKey($draftKey) -and $window.PendingDraft -eq $draftKey) 'unrelated ack cleared score'}
$window.FixtureEvent('score','score_invalid',$null)
Assert ($draftMap.ContainsKey($draftKey) -and $null -eq $window.PendingDraft) 'failed score lost draft'
$null=$startScore.Invoke($window,@(@{rubricVersion='pelican-svg-animated-v1'},$draftKey));$window.FixtureEvent('score',$null,'{}')
Assert (-not $draftMap.ContainsKey($draftKey) -and $null -eq $window.PendingDraft) 'own score ack not cleared'
# Actual result buttons: fixture has no HTTP or browser.
$window.ModeControl.SelectedValue='cockpit';$window.FixtureAcceptRun=$true;$window.FixtureAcceptCancel=$true
$window.FixtureEvent('history',$null,(@{available=$true;runs=@()}|ConvertTo-Json -Compress))
$start=$window.GetType().GetField('startRun',$flags).GetValue($window)
$cancel=$window.GetType().GetField('cancelRun',$flags).GetValue($window)
$retry=$window.GetType().GetField('retryRun',$flags).GetValue($window)
Assert ($start.IsEnabled -and -not $cancel.IsEnabled -and -not $retry.IsEnabled) ('idle buttons start='+$start.IsEnabled+' cancel='+$cancel.IsEnabled+' retry='+$retry.IsEnabled+' busy='+$window.IsBusy+' unknown='+$window.SubmissionUnknown)
Click $start
$id=$window.GetType().GetField('requestId',$flags).GetValue($window)
Assert ($window.IsBusy -and -not $start.IsEnabled -and $cancel.IsEnabled -and -not $window.ModelControl.IsEnabled) 'submitting buttons'
Click $start;Assert ($window.GetType().GetField('requestId',$flags).GetValue($window) -eq $id) 'double start changed identity'
$pending=$window.GetType().GetField('awaitingHtmlRun',$flags)
$runPreviewSchedules=[long](WindowField 'fixturePreviewScheduleCount')
$fixtureRun=@{runId='11111111-1111-4111-8111-111111111111';requestId=$id;status='queued';caseSetVersion='pelican-cockpit-v1';rubricVersion='pelican-cockpit-v1';caseResults=@(@{caseId='pelican-cockpit';status='queued';answer=''})}
foreach($state in 'queued','running'){
$fixtureRun.status=$state;$fixtureRun.caseResults[0].status=$state;HistoryFixture $fixtureRun $null @($fixtureRun)
Assert ($pending.GetValue($window) -and $window.SelectedRunId -eq $fixtureRun.runId -and -not $start.IsEnabled -and [long](WindowField 'fixturePreviewScheduleCount') -eq $runPreviewSchedules -and $null -eq (WindowField 'cockpitImage').Source) 'unfinished run consumed intent or started inline capture'
}
$fixtureRun.status='completed';HistoryFixture $null $fixtureRun @($fixtureRun)
Assert ($pending.GetValue($window) -and [long](WindowField 'fixturePreviewScheduleCount') -eq $runPreviewSchedules) 'completed run with an unfinished case consumed intent or started capture'
$fixtureRun.caseResults[0].status='completed';HistoryFixture $null $fixtureRun @($fixtureRun)
Assert ($pending.GetValue($window) -and [long](WindowField 'fixturePreviewScheduleCount') -eq $runPreviewSchedules) 'completed case without an answer consumed intent or started capture'
$fixtureRun.caseResults[0].answer='<html>synthetic</html>';HistoryFixture $null $fixtureRun @($fixtureRun)
Assert (-not $pending.GetValue($window) -and $start.IsEnabled -and -not $cancel.IsEnabled -and (WindowField 'htmlIntent') -and [long](WindowField 'fixturePreviewScheduleCount') -eq $runPreviewSchedules+1 -and (PreviewField (WindowField 'cockpitTarget') 'Presentation').ToString() -ceq 'Inline' -and (PreviewField (WindowField 'cockpitTarget') 'CaptureFrames')) 'new generation completion did not enable the controls and automatically load inline'
$target=WindowField 'cockpitTarget';$operation=[long](WindowField 'fixturePreviewSnapshot').OperationGeneration;ApplyFrame (FixtureFrame $target $operation 1 $redBytes)
$completedRunBitmap=(WindowField 'cockpitImage').Source;HistoryFixture $null $fixtureRun @($fixtureRun)
Assert ($null -ne $completedRunBitmap -and [object]::ReferenceEquals($completedRunBitmap,(WindowField 'cockpitImage').Source) -and [long](WindowField 'fixturePreviewScheduleCount') -eq $runPreviewSchedules+1 -and [long](WindowField 'cockpitShownOperation') -eq $operation) 'completed generation did not display inline or polling restarted it'
Click $start;Click $cancel
Assert ($window.IsBusy -and -not $cancel.IsEnabled -and -not $pending.GetValue($window)) 'cancel became terminal early'
$fixtureRun.status='cancelled';$fixtureRun.requestId=$window.GetType().GetField('requestId',$flags).GetValue($window);HistoryFixture $null $fixtureRun @($fixtureRun)
Assert ($retry.IsEnabled -and $start.IsEnabled -and -not $cancel.IsEnabled) 'cancelled retry state'
$beforeRetry=$fixtureRun.requestId;Click $retry
Assert ($window.IsBusy -and $window.GetType().GetField('requestId',$flags).GetValue($window) -ne $beforeRetry) 'retry reused identity'
$window.FixtureUnknown('uncertain');Assert (-not $start.IsEnabled -and -not $retry.IsEnabled) 'unknown permits generation'
$fixtureRun.status='failed';$fixtureRun.requestId='uncertain';HistoryFixture $null $fixtureRun @($fixtureRun)
Assert ($retry.IsEnabled -and -not $window.SubmissionUnknown) 'matched identity not resolved'
$window.FixtureEvent('history','disconnected',$null)
Assert (-not $start.IsEnabled -and -not $retry.IsEnabled) 'disconnect permits generation'
$window.ResultsWindow.Close();$window.OpenResults()
Assert (-not $window.GetType().GetField('htmlIntent',$flags).GetValue($window)) 'reopen restored intent'
$window.Close()
Assert ($window.PlaybackCount -eq 0) 'owner close retained animation'
QueueFrame (FixtureFrame $target $operation 999 $blueBytes)
Assert ($null -eq (WindowField 'pendingCockpitFrame') -and (WindowField 'widgetClosed') -and -not (WindowField 'previewEventsAttached')) 'owner close accepted late Cockpit event'
# Task list and task-scoped telemetry: allowlist, picker, pin/follow, stale/truncated, null usage,
# stale-generation dropping, pinned-404 retention and diagnostics rendering.
$window=New-Object CodexNative.WidgetWindow $true;$fixtureWindows.Add($window)
$window.Show();$window.UpdateLayout()
$taskClient=$window.GetType().GetField('client',$flags).GetValue($window)
$allowed=$taskClient.GetType().GetMethod('Allowed',[Reflection.BindingFlags]'NonPublic,Static')
Assert ($allowed.Invoke($null,@('/api/tasks',$false)) -eq $true) 'GET /api/tasks not allowed'
Assert ($allowed.Invoke($null,@('/api/telemetry?taskId=11111111-1111-4111-8111-111111111111',$false)) -eq $true) 'single legal taskId query rejected'
foreach($rejected in @('/api/tasks?taskId=11111111-1111-4111-8111-111111111111','/api/telemetry?taskId=not-a-uuid','/api/telemetry?taskId=11111111-1111-4111-8111-111111111111&x=1','/api/benchmark?taskId=11111111-1111-4111-8111-111111111111','/api/evidence')){
    Assert ($allowed.Invoke($null,@($rejected,$false)) -eq $false) ('unsafe GET path allowed: '+$rejected)
}
$taskAlpha='11111111-1111-4111-8111-111111111111'
$taskBeta='22222222-2222-4222-8222-222222222222'
$taskSampled='2026-10-15T07:32:15.226Z'
$taskUpdated='2026-10-15T07:32:13.226Z'
$taskAgents=@(
    @{id='33333333-3333-4333-8333-000000000001';parentId=$taskAlpha;role='coordinator';model='example-provider/gpt-6.1-sol';effort='ultra';rootTurnId='fixture-turn-0';association='current_turn';state='in_progress';updatedAt=$taskUpdated;usage=@{inputTokens=1234;cachedInputTokens=1000;outputTokens=56;reasoningOutputTokens=12;totalTokens=1290};usageUpdatedAt=$taskUpdated},
    @{id='33333333-3333-4333-8333-000000000002';parentId=$taskAlpha;role='agency-backend';model='example-provider/deepseek-v4.1-flash';effort='max';rootTurnId='fixture-turn-0';association='current_turn';state='in_progress';updatedAt=$taskUpdated;usage=@{inputTokens=1234;cachedInputTokens=1000;outputTokens=56;reasoningOutputTokens=12;totalTokens=1290};usageUpdatedAt=$taskUpdated},
    @{id='33333333-3333-4333-8333-000000000003';parentId=$taskAlpha;role='reviewer';model='example-provider/gpt-6-astra';effort='high';rootTurnId='fixture-turn-0';association='other_turn';state='completed';updatedAt=$taskUpdated;usage=$null;usageUpdatedAt=$null}
)
$taskList=@{tasks=@(@{id=$taskAlpha;title='Fixture Alpha';updatedAt=$taskUpdated},@{id=$taskBeta;title='Fixture Beta';updatedAt=$taskUpdated});sampledAt=$taskSampled;stale=$false;truncated=$false}
$taskCurrent=@{id='fixture-turn-0';usage=@{inputTokens=1234;cachedInputTokens=1000;outputTokens=56;reasoningOutputTokens=12;totalTokens=1290};usageUpdatedAt=$taskUpdated}
$taskCompleted=@{state='available';source='turn_token_usage';reason='none';inputTokens=100;outputTokens=20;totalTokens=120;elapsedSeconds=5;startedAt='2026-10-15T07:32:08.226Z';completedAt=$taskUpdated}
$taskSpeed=@{state='available';source='completed_turn';reason='none';outputTokensPerSecond=4;completedAt=$taskUpdated;includesToolsAndWait=$true}
$taskContext=@{state='available';source='turn_context';reason='none';model='example-provider/gpt-6.1-sol';reasoningEffort='ultra';observedAt=$taskUpdated}
function TaskFixture([bool]$stale,[bool]$truncated,[object]$current){
    @{state='ok';session=@{id=$taskAlpha;updatedAt=$taskUpdated};usage=@{inputTokens=1000;outputTokens=200;totalTokens=1200};speed=$null;sampledAt=$taskSampled;conversationContext=$taskContext;lastCompletedTurn=$taskCompleted;turnAverageSpeed=$taskSpeed;task=@{id=$taskAlpha;title='Fixture Alpha';selection='pinned';rootTurnId='fixture-turn-0';updatedAt=$taskUpdated;stale=$stale;truncated=$truncated};currentTurn=$current;agents=$taskAgents}
}
$tasksJson=[CodexNative.WidgetClient]::Serialize($taskList)
$normalJson=[CodexNative.WidgetClient]::Serialize((TaskFixture $false $false $taskCurrent))
$staleJson=[CodexNative.WidgetClient]::Serialize((TaskFixture $true $true $taskCurrent))
$missingJson=[CodexNative.WidgetClient]::Serialize((TaskFixture $false $false @{id='fixture-turn-0';usage=$null;usageUpdatedAt=$null}))
$nullUsageTask=TaskFixture $false $false $taskCurrent;$nullUsageTask.usage=$null
$nullUsageJson=[CodexNative.WidgetClient]::Serialize($nullUsageTask)
$betaJson=$normalJson.Replace($taskAlpha,$taskBeta).Replace('Fixture Alpha','Fixture Beta')
$emptyJson=[CodexNative.WidgetClient]::Serialize(@{state='empty';session=$null;usage=$null;speed=$null;task=$null;currentTurn=$null;agents=@();sampledAt=$taskSampled})
$window.FixtureTasks($tasksJson)
Assert ($window.TasksSupported -and $window.TaskControl.Items.Count -eq 2) 'task list did not populate the selector'
Assert ($window.SelectedTask -eq '11111111-1111-4111-8111-111111111111' -and -not $window.PinnedTask) 'follow mode did not select the first task'
Assert ($window.TaskControl.SelectedValue -eq '11111111-1111-4111-8111-111111111111') 'selector out of sync with follow selection'
$generation=$window.TaskGeneration
# Root fallback has its own view: it must not seed the normal legacy fixture's retention history.
$rootCoverage=@{discoveredFiles=1;completeFiles=1;pendingFiles=0;excludedFiles=0;failedFiles=0;responsesCounted=1;conversationsCounted=1;subagentThreadsCounted=0;legacyOnlyConversations=0;duplicateResponses=0;conflictingResponses=0;invalidResponses=0;complete=$true}
$rootAgent=@{id=$taskAlpha;parentId=$null;role='root';model='example-provider/gpt-6.1-sol';effort='ultra';rootTurnId='fixture-turn-0';association='current_turn';state='completed';updatedAt=$taskUpdated;usage=@{inputTokens=10;cachedInputTokens=0;outputTokens=5;reasoningOutputTokens=0;totalTokens=15};usageUpdatedAt=$taskUpdated}
$rootFallback=TaskFixture $false $false $null
$rootFallback.state='unavailable';$rootFallback.reason='pinned_task'
$rootFallback.usage=$null
$rootFallback.conversationContext=$null
$rootFallback.lastCompletedTurn=$null
$rootFallback.turnAverageSpeed=$null
$rootFallback.agents=@($taskAgents[0],$rootAgent)
$rootWindow=New-Object CodexNative.WidgetWindow $true;$fixtureWindows.Add($rootWindow)
try {
    # An explicit null timestamp is invalid; only an absent key permits its documented fallback.
    foreach($timeSource in 'root','legacy'){
        ResetTelemetryFixture $rootWindow $taskAlpha
        $timePayload=@{state='ok';session=@{id=$taskAlpha;updatedAt=$taskUpdated};task=@{id=$taskAlpha};usage=$null;agents=@()}
        if($timeSource -ceq 'root'){
            $timeOwner=@{id=$taskAlpha;parentId=$null;role='root';updatedAt=$taskUpdated;usage=@{inputTokens=10;outputTokens=5;totalTokens=15};usageUpdatedAt=$null}
            $timePayload.agents=@($timeOwner);$timeKey='usageUpdatedAt'
        }else{
            $timePayload.usage=@{inputTokens=10;outputTokens=5;totalTokens=15};$timePayload.sampledAt=$null
            $timeOwner=$timePayload;$timeKey='sampledAt'
        }
        $rootWindow.FixtureTaskTelemetry($rootWindow.TaskGeneration,$null,([CodexNative.WidgetClient]::Serialize($timePayload)))
        Assert ($rootWindow.MetricControls[0].Text -ceq '—' -and $rootWindow.MetricControls[1].Text -ceq '—' -and $rootWindow.MetricControls[2].Text -ceq '—') ('explicit null '+$timeSource+' timestamp borrowed its fallback time')
        foreach($metric in $rootWindow.MetricControls[0..2]){
            Assert ($null -eq $metric.ToolTip -and [string]::IsNullOrEmpty([Windows.Automation.AutomationProperties]::GetHelpText($metric))) ('explicit null '+$timeSource+' timestamp retained an exact token value')
        }
        $timeOwner.Remove($timeKey)
        $rootWindow.FixtureTaskTelemetry($rootWindow.TaskGeneration,$null,([CodexNative.WidgetClient]::Serialize($timePayload)))
        Assert ($rootWindow.MetricsVisible -and $rootWindow.MetricControls[0].Text -ceq '10' -and $rootWindow.MetricControls[1].Text -ceq '5' -and $rootWindow.MetricControls[2].Text -ceq '15') ('missing '+$timeSource+' timestamp did not use its documented fallback')
    }
    foreach($fallbackSession in @($null,@{id=$taskBeta;updatedAt=$taskUpdated})){
        ResetTelemetryFixture $rootWindow $taskAlpha
        $rootFallback.session=$fallbackSession
        $rootWindow.FixtureTaskTelemetry($rootWindow.TaskGeneration,$null,([CodexNative.WidgetClient]::Serialize($rootFallback)))
        Assert ($rootWindow.MetricsVisible -and $rootWindow.MetricControls[0].Text -ceq '10' -and $rootWindow.MetricControls[1].Text -ceq '5' -and $rootWindow.MetricControls[2].Text -ceq '15') 'unavailable pinned root fallback did not render the exact validated triple with missing/wrong top session'
        Assert ($rootWindow.SelectedUsageCaptionControl.Text -match '最近回合记录' -and $rootWindow.ContextText -match 'gpt-6.1-sol' -and $rootWindow.EffortText -match 'ultra') 'pinned root-agent fallback lost its source label, model or effort'
        Assert ($rootWindow.DisplayState -match '已停止 · 本轮已完成' -and $rootWindow.MetricControls[3].Text -ceq '—') 'pinned completed root did not show stopped/completed without inventing speed'
    }
    $rootAgent.state='aborted'
    $rootWindow.FixtureTaskTelemetry($rootWindow.TaskGeneration,$null,([CodexNative.WidgetClient]::Serialize($rootFallback)))
    Assert ($rootWindow.DisplayState -match '已停止 · 本轮已中止' -and $rootWindow.MetricControls[2].Text -ceq '15' -and $rootWindow.MetricControls[3].Text -ceq '—') 'aborted root lost stopped wording or invented a speed'
    $rootAgent.state='completed'
    $rootSelected=@{state='available';reason=$null;scope='selected_task';taskId=$taskAlpha;usage=@{inputTokens=30;outputTokens=6;totalTokens=36};coverage=$rootCoverage;updatedAt=$taskUpdated}
    $rootOverall=@{state='partial';reason='scan_in_progress';scope='local_all';usage=@{inputTokens=100;outputTokens=200;totalTokens=300};coverage=$rootCoverage;updatedAt=$taskUpdated}
    $rootWindow.FixtureUsage($rootWindow.UsageGeneration,$null,([CodexNative.WidgetClient]::Serialize(@{sampledAt=$taskUpdated;overall=$rootOverall;selected=$rootSelected})))
    Assert ($rootWindow.MetricControls[0].Text -ceq '30' -and $rootWindow.MetricControls[2].Text -ceq '36' -and $rootWindow.SelectedUsageStateControl.Text -match '已核实') 'valid selected usage did not take priority over root fallback'
    $rootWindow.FixtureTaskTelemetry($rootWindow.TaskGeneration,$null,([CodexNative.WidgetClient]::Serialize($rootFallback)))
    Assert ($rootWindow.MetricControls[2].Text -ceq '36') 'equal-time root fallback displaced a valid selected aggregate'
    $newerRoot=$rootAgent.Clone();$newerRoot.updatedAt='2026-10-15T07:32:16.226Z';$newerRoot.usageUpdatedAt=$newerRoot.updatedAt
    $newerRoot.usage=@{inputTokens=90;outputTokens=9;totalTokens=99}
    $newerRootPayload=$rootFallback.Clone();$newerRootPayload.sampledAt=$newerRoot.updatedAt;$newerRootPayload.agents=@($taskAgents[0],$newerRoot)
    $rootWindow.FixtureTaskTelemetry($rootWindow.TaskGeneration,$null,([CodexNative.WidgetClient]::Serialize($newerRootPayload)))
    Assert ($rootWindow.MetricControls[0].Text -ceq '30' -and $rootWindow.MetricControls[1].Text -ceq '6' -and $rootWindow.MetricControls[2].Text -ceq '36') 'newer root displaced a still-valid selected aggregate'
    # Envelope freshness must not let an older selected block retire the current candidate.
    $oldSelected=$rootSelected.Clone();$oldSelected.state='partial';$oldSelected.reason='scan_in_progress';$oldSelected.usage=$null;$oldSelected.updatedAt='2026-10-15T07:32:12.226Z'
    $rootWindow.FixtureUsage($rootWindow.UsageGeneration,$null,([CodexNative.WidgetClient]::Serialize(@{sampledAt=$newerRoot.updatedAt;overall=$rootOverall;selected=$oldSelected})))
    $newerRoot.usage=@{inputTokens=91;outputTokens=9;totalTokens=100}
    $rootWindow.FixtureTaskTelemetry($rootWindow.TaskGeneration,$null,([CodexNative.WidgetClient]::Serialize($newerRootPayload)))
    Assert ($rootWindow.MetricControls[0].Text -ceq '30' -and $rootWindow.MetricControls[1].Text -ceq '6' -and $rootWindow.MetricControls[2].Text -ceq '36') 'old selected block with a new envelope retired the active candidate'
    $loadingSelected=@{state='loading';reason='scan_in_progress';scope='selected_task';taskId=$taskAlpha;usage=$null;coverage=$rootCoverage;updatedAt=$taskUpdated}
    $rootWindow.FixtureUsage($rootWindow.UsageGeneration,$null,([CodexNative.WidgetClient]::Serialize(@{sampledAt=$taskUpdated;overall=$rootOverall;selected=$loadingSelected})))
    Assert ($rootWindow.MetricControls[0].Text -ceq '30' -and $rootWindow.MetricControls[1].Text -ceq '6' -and $rootWindow.MetricControls[2].Text -ceq '36' -and $rootWindow.MetricControls[3].Text -ceq '—') 'loading selected usage erased the last valid same-task counts'
    Assert ($rootWindow.SelectedUsageStateControl.Text -match '上次有效数据' -and $rootWindow.SelectedUsageStateControl.Text -match '正在统计') 'loading selected usage lost its historical provenance or health state'

    # Actual client error codes must stay visible independently of retained task lifecycle.
    $healthStatus=$rootWindow.GetType().GetField('status',$flags).GetValue($rootWindow)
    $healthRoot=$rootAgent.Clone();$healthRoot.state='in_progress'
    $healthPayload=TaskFixture $false $false $taskCurrent;$healthPayload.agents=@($healthRoot,$taskAgents[0])
    $healthJson=[CodexNative.WidgetClient]::Serialize($healthPayload)
    foreach($healthCode in 'telemetry_unavailable','invalid_json','incompatible_service','fixture_unknown_telemetry_error'){
        $healthDescription=[CodexNative.WidgetClient]::ErrorDescription($healthCode)
        ResetTelemetryFixture $rootWindow $taskAlpha
        $rootWindow.FixtureTaskTelemetry($rootWindow.TaskGeneration,$healthCode,$null)
        Assert ($healthStatus.Visibility -eq [Windows.Visibility]::Visible -and $rootWindow.DisplayState.Contains($healthDescription)) ('fresh telemetry error hid its mapped main status: '+$healthCode)
        Assert ($rootWindow.MetricControls[0].Text -ceq '—' -and $rootWindow.MetricControls[1].Text -ceq '—' -and $rootWindow.MetricControls[2].Text -ceq '—' -and $rootWindow.MetricControls[3].Text -ceq '—') ('fresh telemetry error invented retained metrics: '+$healthCode)

        ResetTelemetryFixture $rootWindow $taskAlpha
        $rootWindow.FixtureTaskTelemetry($rootWindow.TaskGeneration,$null,$healthJson)
        Assert ($rootWindow.DisplayState -match '运行中' -and $rootWindow.MetricControls[0].Text -ceq '10' -and $rootWindow.MetricControls[1].Text -ceq '5' -and $rootWindow.MetricControls[2].Text -ceq '15' -and $rootWindow.MetricControls[3].Text -ceq '4.0') ('running telemetry seed did not establish its full validated metrics: '+$healthCode)
        $rootWindow.FixtureTaskTelemetry($rootWindow.TaskGeneration,$healthCode,$null)
        Assert ($healthStatus.Visibility -eq [Windows.Visibility]::Visible -and $rootWindow.DisplayState.Contains($healthDescription) -and $rootWindow.DisplayState -match '运行中') ('seeded telemetry error hid health behind the cached running lifecycle: '+$healthCode)
        Assert ($rootWindow.MetricsVisible -and $rootWindow.MetricControls[0].Text -ceq '10' -and $rootWindow.MetricControls[1].Text -ceq '5' -and $rootWindow.MetricControls[2].Text -ceq '15' -and $rootWindow.MetricControls[3].Text -ceq '4.0' -and $rootWindow.SelectedUsageStateControl.Text -match '上次有效数据') ('seeded telemetry error erased validated metrics or historical provenance: '+$healthCode)
    }
} finally {$rootWindow.Close()}
$window.FixtureTaskTelemetry($generation,$null,$normalJson)
Assert ($window.TaskControl.SelectedItem.Label -match 'Fixture Alpha' -and $window.TaskControl.SelectedItem.Label -match '11111111' -and -not $window.TaskTitleVisible) 'task identity must appear once in the picker'
Assert ($window.TaskControl.ToolTip -match 'Fixture Alpha' -and $window.TaskControl.ToolTip -match '11111111-1111-4111-8111-111111111111') 'picker tooltip lost the full title/id'
Assert (-not $window.TaskFlagsVisible -and [string]::IsNullOrEmpty($window.TaskFlagsText)) 'normal task sample displayed log freshness chrome'
$mainText=VisibleUiText $window

Assert (-not $window.CurrentTurnVisible -and -not $window.AgentsVisible -and $window.AgentsPanelControl.Children.Count -eq 0) 'dense current-turn/agent rows returned to the main window'
Assert ($mainText -notmatch '1234|1290|代理[ ]*·|当前回合|基准|鹈鹕(?!测试)|刷新|可信时间|日志滞后|日志可能') 'rich payload leaked dense log/current-turn/agent/benchmark chrome into the main window'
Assert ($window.ContextVisible -and $window.ContextText -match 'gpt-6.1-sol' -and $window.EffortVisible -and $window.EffortText -match 'ultra') 'valid conversation model/effort missing'
$window.UpdateLayout()
$taskPinButton=$window.GetType().GetField('taskPin',$flags).GetValue($window)
$mainContext=$window.GetType().GetField('contextLabel',$flags).GetValue($window)
$mainEffort=$window.GetType().GetField('effortLabel',$flags).GetValue($window)
$mainSpeed=$window.MetricControls[3]
$contextBottom=$mainContext.TransformToAncestor($window).Transform((New-Object Windows.Point 0,$mainContext.ActualHeight)).Y
$effortTop=$mainEffort.TransformToAncestor($window).Transform((New-Object Windows.Point 0,0)).Y
Assert ($contextBottom -le $effortTop -and $mainContext.ActualWidth -gt 300) 'full-width model overlaps secondary metadata'
Assert ($mainEffort.IsVisible -and $mainSpeed.ActualWidth -gt 0 -and $mainSpeed.IsVisible) 'secondary effort or speed value is not rendered'
foreach($control in @($window.TaskControl,$taskPinButton,$mainContext,$mainEffort)+$window.MetricControls){
    $origin=$control.TransformToAncestor($window).Transform((New-Object Windows.Point 0,0))
    Assert ($control.IsVisible -and $origin.X -ge 0 -and $origin.Y -ge 0 -and $origin.X+$control.ActualWidth -le $window.ActualWidth+1 -and $origin.Y+$control.ActualHeight -le $window.ActualHeight+1) 'main data or action extends beyond the fixed window'
}
$totalMetric=$window.MetricControls[2]
Assert ($totalMetric.FontSize -eq 28 -and $window.MetricControls[0].FontSize -eq 17 -and $totalMetric.FontSize -gt $window.MetricControls[0].FontSize -and $totalMetric.FontWeight -eq [Windows.FontWeights]::SemiBold -and $window.MetricControls[0].FontWeight -eq [Windows.FontWeights]::Medium) 'total usage lost its 28px semibold emphasis over 17px input/output'
$totalCell=[Windows.Media.VisualTreeHelper]::GetParent($totalMetric)
$selectedBody=[Windows.Media.VisualTreeHelper]::GetParent($totalCell)
$selectedCard=[Windows.Media.VisualTreeHelper]::GetParent($selectedBody)
$selectedSurface=[Windows.Media.VisualTreeHelper]::GetParent($selectedCard)
$selectedHost=[Windows.Media.VisualTreeHelper]::GetParent($selectedSurface)
Assert ($totalCell -is [Windows.Controls.StackPanel] -and $selectedCard -is [Windows.Controls.Grid] -and $selectedSurface -is [Windows.Controls.Border] -and [object]::ReferenceEquals($selectedHost,$window.GetType().GetField('metricsGrid',$flags).GetValue($window))) 'selected usage card left its own metrics surface'
$window.OpenUsage();$window.UsageWindow.UpdateLayout()
$overallMetric=$window.OverallMetricControls[2]
$overallCell=[Windows.Media.VisualTreeHelper]::GetParent($overallMetric)
$overallBody=[Windows.Media.VisualTreeHelper]::GetParent($overallCell)
$overallCard=[Windows.Media.VisualTreeHelper]::GetParent($overallBody)
$overallChartPanel=[Windows.Media.VisualTreeHelper]::GetParent($overallCard)
$overallSurface=[Windows.Media.VisualTreeHelper]::GetParent($overallChartPanel)
Assert ($overallCell -is [Windows.Controls.StackPanel] -and $overallCard -is [Windows.Controls.Grid] -and $overallChartPanel -is [Windows.Controls.StackPanel] -and $overallSurface -is [Windows.Controls.Border] -and -not [object]::ReferenceEquals($overallSurface,$selectedSurface) -and [object]::ReferenceEquals([Windows.Window]::GetWindow($overallMetric),$window.UsageWindow)) 'local total usage did not render in its independent window card'
$selectedHostControl=$window.GetType().GetField('metricsGrid',$flags).GetValue($window)
Assert ($selectedHostControl.MinHeight -ge 84 -and [Math]::Abs($selectedHostControl.ActualHeight-$selectedHostControl.MinHeight) -le 60) 'selected usage card height is outside its layout budget'
# A telemetry disconnect preserves validated information but exposes source health separately.
$window.FixtureTaskTelemetry($generation,'disconnected',$null)
Assert ($window.DisplayState -match '本地服务断连') 'task telemetry disconnect lost the single main status'
Assert (-not $window.TaskFlagsVisible -and [string]::IsNullOrEmpty($window.TaskFlagsText)) 'task telemetry disconnect retained stale success flags'
Assert ($window.MetricsVisible -and $window.ContextVisible -and $window.EffortVisible -and -not $window.CurrentTurnVisible -and -not $window.AgentsVisible -and $window.AgentsPanelControl.Children.Count -eq 0) 'task telemetry disconnect hid validated context or restored dense current/agent rows'
Assert ($window.MetricControls[0].Text -ceq '1,000' -and $window.MetricControls[2].Text -ceq '1,200' -and $window.MetricControls[3].Text -ceq '4.0' -and $window.SelectedUsageStateControl.Text -match '上次有效数据') 'task telemetry disconnect erased last valid same-task metrics or provenance'
$window.FixtureTaskTelemetry($generation,$null,$normalJson)
Assert (-not $window.TaskFlagsVisible -and $window.MetricsVisible -and -not (WindowField 'telemetryHistorical') -and $window.MetricControls[3].Text -ceq '4.0') ('recovered task telemetry did not restore status and speed: metrics='+$window.MetricControls[2].Text+' speed='+$window.MetricControls[3].Text+' speedReason='+(WindowField 'selectedSnapshot').SpeedReason+' historical='+(WindowField 'telemetryHistorical'))
Assert (-not $window.CurrentTurnVisible -and -not $window.AgentsVisible) 'recovered task telemetry restored dense rows'
# A successful request with no envelope is transient absence, not a task boundary.
$window.FixtureTaskTelemetry($generation,$null,$null)
Assert ($window.MetricControls[0].Text -ceq '1,000' -and $window.MetricControls[1].Text -ceq '200' -and $window.MetricControls[2].Text -ceq '1,200' -and $window.MetricControls[3].Text -ceq '4.0' -and $window.ContextText -match 'gpt-6.1-sol' -and $window.EffortText -match 'ultra' -and $window.SelectedUsageStateControl.Text -match '上次有效数据') 'null telemetry envelope erased validated same-task counts, context, effort, speed or historical provenance'
Assert (-not $window.CurrentTurnVisible -and -not $window.AgentsVisible -and $window.AgentsPanelControl.Children.Count -eq 0) 'null telemetry envelope restored dense current-turn or agent rows'
$window.FixtureTaskTelemetry($generation,$null,$normalJson)
# Apply must recheck a telemetry error's service generation after Dequeue has released it.
$lateTelemetryError=New-Object CodexNative.ClientEvent
$lateTelemetryError.Kind='telemetry';$lateTelemetryError.Error='task_not_found'
$lateTelemetryError.Generation=$taskClient.ServiceGeneration-1;$lateTelemetryError.SelectionGeneration=$generation
$null=$window.GetType().GetMethod('Apply',$flags).Invoke($window,[object[]]@($lateTelemetryError.psobject.BaseObject))
Assert ($window.SelectedTask -ceq $taskAlpha -and $window.MetricControls[0].Text -ceq '1,000' -and $window.MetricControls[1].Text -ceq '200' -and $window.MetricControls[2].Text -ceq '1,200' -and $window.MetricControls[3].Text -ceq '4.0') 'post-dequeue stale-service telemetry error cleared valid current-task metrics'
# A late error and a late success from an older selection must not overwrite the newer task.
$window.FixtureTaskTelemetry($generation-1,'task_not_found',$null)
Assert ($window.TaskHeaderText -match 'Fixture Alpha' -and $window.SelectedTask -eq '11111111-1111-4111-8111-111111111111' -and $window.MetricControls[0].Text -ceq '1,000' -and $window.MetricControls[1].Text -ceq '200' -and $window.MetricControls[2].Text -ceq '1,200' -and $window.MetricControls[3].Text -ceq '4.0') 'stale-selection error overwrote the current task or cleared its metrics'
$window.FixtureTaskTelemetry($generation-1,$null,$staleJson)
Assert ($window.TaskHeaderText -match 'Fixture Alpha' -and $window.TaskFlagsText -notmatch '陈旧') 'stale-generation success overwrote the current task'
$window.FixtureTaskTelemetry($generation,$null,$staleJson)

Assert ($window.TaskFlagsText -match '陈旧' -and $window.TaskFlagsText -match '已截断') 'stale / truncated flags missing'
Assert ($window.TaskFlagsTip -match '可信时间' -and $window.TaskFlagsTip -match '日志滞后' -and $window.TaskFlagsTip -match '日志已截断') 'compact stale/truncated hint lost its tooltip detail'
$window.FixtureTaskTelemetry($generation,$null,$missingJson)
Assert (-not $window.CurrentTurnVisible -and -not $window.AgentsVisible -and $window.MetricsVisible -and $window.MetricControls[2].Text -ceq '1,200') 'null current-turn usage disturbed the legacy session triple or dense rows'
# Null top-level usage retains the complete triple and the validated last-turn speed.
$window.FixtureTaskTelemetry($generation,$null,$nullUsageJson)
Assert ($window.MetricsVisible -and $window.MetricControls[0].Text -ceq '1,000' -and $window.MetricControls[2].Text -ceq '1,200' -and $window.MetricControls[3].Text -ceq '4.0' -and $window.SelectedUsageStateControl.Text -match '上次有效数据') 'null cumulative usage erased the complete legacy triple, speed or historical label'
$window.FixtureTaskTelemetry($generation,$null,$emptyJson)
Assert (-not $window.CurrentTurnVisible -and $window.CurrentTurnControl.Text -match '未观测' -and $window.AgentsPanelControl.Children.Count -eq 0 -and -not $window.AgentsVisible -and $window.MetricsVisible -and $window.ContextVisible -and $window.EffortVisible -and $window.MetricControls[2].Text -ceq '1,200' -and $window.MetricControls[3].Text -ceq '4.0' -and $window.SelectedUsageStateControl.Text -match '上次有效数据') 'empty task payload erased valid same-task information or restored dense rows'
$longTitle='Long fixture task title '+('X'*60)
$window.FixtureTasks(([CodexNative.WidgetClient]::Serialize(@{tasks=@(@{id=$taskAlpha;title=$longTitle;updatedAt=$taskUpdated},@{id=$taskBeta;title='Fixture Beta';updatedAt=$taskUpdated});sampledAt=$taskSampled;stale=$false;truncated=$false})))
$longLabel=$window.TaskControl.SelectedItem.Label
Assert ($longLabel -match '…' -and $longLabel -notmatch ('X'*50) -and $longLabel -match '11111111' -and -not $window.TaskTitleVisible) 'long task title not bounded in the picker'
Assert ($window.TaskControl.ToolTip -match ('X'*50) -and $window.TaskControl.ToolTip -match $taskAlpha) 'long task title tooltip lost the full title'
$window.FixtureTasks($tasksJson)
# Information-slice regressions: unified caption, exact token values, independent list/log warnings,
# visibly explained speed, real zero, exact-value continuity and collapsed-title binding.
$window.Close()
$window=New-Object CodexNative.WidgetWindow $true;$fixtureWindows.Add($window)
$window.Show()
$window.FixtureTasks($tasksJson)
$window.UpdateLayout()
$infoTitle='Synthetic information transitions'
$infoObserved='2026-10-16T09:00:05.000Z'
$infoTask=$taskAlpha
$infoList=@{tasks=@(@{id=$infoTask;title=$infoTitle;updatedAt=$infoObserved});stale=$false;truncated=$false;sampledAt=$infoObserved}
$infoSample=@{state='ok';session=@{id=$infoTask};usage=@{inputTokens=1234567;outputTokens=0;totalTokens=1234567};
    task=@{id=$infoTask;title=$infoTitle;updatedAt=$infoObserved;stale=$false;truncated=$false};
    conversationContext=$null;lastCompletedTurn=$null;turnAverageSpeed=@{state='unavailable';source='none';reason='turn_incomplete'};sampledAt=$infoObserved}
function InfoListUpdate { $window.FixtureTasks(([CodexNative.WidgetClient]::Serialize($infoList)));$window.UpdateLayout() }
function InfoSampleApply { $window.FixtureTaskTelemetry($window.TaskGeneration,$null,([CodexNative.WidgetClient]::Serialize($infoSample)));$window.UpdateLayout() }
function InfoExactCleared {
    foreach($metric in $window.MetricControls[0..2]) {
        Assert ($null -eq $metric.ToolTip) 'previous exact token tooltip was retained'
        Assert ([string]::IsNullOrEmpty([Windows.Automation.AutomationProperties]::GetHelpText($metric))) 'previous exact accessible token value was retained'
    }
}
InfoListUpdate
InfoSampleApply
$infoGeneration=$window.TaskGeneration
Assert (-not $window.TaskFlagsVisible) 'fresh list and fresh task displayed warnings'
Assert (([regex]::Matches((VisibleUiText $window),'当前对话 · 会话累计（日志）')).Count -eq 1 -and (VisibleUiText $window) -notmatch '会话消耗 · tokens') 'legacy conversation caption missing, duplicated or mislabeled as a selected aggregate'
Assert (([string]$window.MetricControls[0].ToolTip -ceq '输入 · 1234567 tokens') -and ([string]$window.MetricControls[2].ToolTip -ceq '合计 · 1234567 tokens')) 'exact invariant token tooltip missing on input/total'
Assert ([Windows.Automation.AutomationProperties]::GetHelpText($window.MetricControls[2]) -match '1234567') 'accessible help lost the exact total count'
Assert ($window.MetricControls[1].Text -ceq '0') 'real zero count was hidden or reformatted'
Assert ($window.ContextVisible -and $window.ContextText -match '未知' -and $window.EffortVisible -and $window.EffortText -match '未知') 'resolved session did not explicitly show unknown context and effort'
$infoSelected=$window.TaskControl.Template.FindName('ContentSite',$window.TaskControl)
Assert ($null -ne $infoSelected -and $infoSelected.Text -ceq $infoTitle -and $infoSelected.Text -notmatch '…') 'collapsed task selector did not prioritize the full title'
Assert ($window.TaskControl.SelectedItem.Label -match '11111111' -and $window.TaskControl.SelectedItem.Label -match $infoTitle) 'dropdown identity lost the bounded title or short id'
Assert ([Windows.Automation.AutomationProperties]::GetHelpText($window.TaskControl) -match $infoTask -and $window.TaskControl.ToolTip -match $infoTask) 'accessible task identity lost the full task id'
$infoSample.usage=@{inputTokens=9007199254740991;outputTokens=0;totalTokens=9007199254740991}
InfoSampleApply
Assert ([string]$window.MetricControls[0].ToolTip -ceq '输入 · 9007199254740991 tokens' -and [string]$window.MetricControls[2].ToolTip -ceq '合计 · 9007199254740991 tokens') 'maximum safe integer was rounded or reformatted in its exact tooltip'
foreach($metric in @($window.MetricControls[0],$window.MetricControls[2])) { Assert ([Windows.Automation.AutomationProperties]::GetHelpText($metric) -match '9007199254740991' -and [Windows.Automation.AutomationProperties]::GetHelpText($metric) -match 'tokens') 'maximum safe integer was rounded in accessible help' }
$infoSample.usage=@{inputTokens=1234567;outputTokens=0;totalTokens=1234567}
InfoSampleApply
$infoList.stale=$true;$infoList.truncated=$true
InfoListUpdate
Assert ($window.TaskGeneration -eq $infoGeneration -and $window.TaskFlagsVisible) 'unchanged task list update failed to expose list warnings'
Assert ($window.TaskFlagsText -match '列表' -and $window.TaskFlagsText -match '陈旧' -and $window.TaskFlagsText -match '已截断') 'list stale/truncated flags missing'
Assert ($window.TaskFlagsTip -match '任务列表 · 采样' -and $window.TaskFlagsTip -match '列表已截断') 'list warning tooltip lost its sampling or truncation detail'
InfoSampleApply
Assert ($window.TaskFlagsVisible -and $window.TaskFlagsText -match '列表' -and $window.TaskFlagsText -notmatch '日志') 'fresh selected-log detail overwrote the list warnings'
$infoSample.task.stale=$true;$infoSample.task.truncated=$true
InfoSampleApply
Assert ($window.TaskFlagsText -match '列表' -and $window.TaskFlagsText -match '日志') 'list and selected-log scopes were not distinguishable'
Assert ($window.TaskFlagsTip -match '选中日志 · 可信时间' -and $window.TaskFlagsTip -match '日志滞后' -and $window.TaskFlagsTip -match '日志已截断') 'selected-log warning detail lost its trusted time, lag or truncation note'
$infoList.stale=$false;$infoList.truncated=$false
InfoListUpdate
Assert ($window.TaskGeneration -eq $infoGeneration -and $window.TaskFlagsVisible -and $window.TaskFlagsText -notmatch '列表' -and $window.TaskFlagsText -match '日志') 'list refresh cleared the selected log warnings'
$infoSample.task.stale=$false;$infoSample.task.truncated=$false
InfoSampleApply
Assert (-not $window.TaskFlagsVisible -and [string]::IsNullOrEmpty($window.TaskFlagsText)) 'cleared list and log warnings remained visible'
$infoSample.usage=@{inputTokens=-1;outputTokens='unknown';totalTokens=$null}
InfoSampleApply
Assert ($window.MetricsVisible -and $window.MetricControls[0].Text -ceq '1.2M' -and $window.MetricControls[1].Text -ceq '0' -and $window.MetricControls[2].Text -ceq '1.2M' -and $window.SelectedUsageStateControl.Text -match '上次有效数据') 'invalid counts erased the last complete legacy triple'
Assert ([string]$window.MetricControls[0].ToolTip -ceq '输入 · 1234567 tokens' -and [string]$window.MetricControls[2].ToolTip -ceq '合计 · 1234567 tokens' -and [Windows.Automation.AutomationProperties]::GetHelpText($window.MetricControls[2]) -match '1234567') 'invalid refresh erased exact retained tooltip or accessibility'
$infoSample.usage=@{inputTokens=10;outputTokens=0;totalTokens=10}
InfoSampleApply
Assert ([string]$window.MetricControls[0].ToolTip -ceq '输入 · 10 tokens') 'valid count lost its exact tooltip after an invalid refresh'
$window.FixtureTaskTelemetry($window.TaskGeneration,'disconnected',$null)
$window.UpdateLayout()
Assert ($window.MetricsVisible -and $window.ContextVisible -and $window.EffortVisible -and $window.MetricControls[2].Text -ceq '10' -and $window.SelectedUsageStateControl.Text -match '上次有效数据' -and $window.DisplayState -match '本地服务断连') 'telemetry disconnect erased validated data or hid historical/source-health labels'
Assert ([string]$window.MetricControls[0].ToolTip -ceq '输入 · 10 tokens' -and [Windows.Automation.AutomationProperties]::GetHelpText($window.MetricControls[2]) -match '10 tokens') 'disconnect erased the retained exact tooltip/accessibility'
InfoSampleApply
Assert ($window.MetricsVisible -and $window.MetricControls[0].Text -ne '—' -and -not $window.TaskFlagsVisible) 'recovered sample did not restore the metrics surface'
Assert ((VisibleUiText $window) -match '上轮均速 · 回合未完成' -and $window.MetricControls[3].Text -ceq '—') 'unavailable speed lacks a visible short reason'
Assert ([string]$window.MetricControls[3].ToolTip -match '尚未完成') 'unavailable speed tooltip lost the full explanation'
$infoSample.lastCompletedTurn=@{state='available';source='turn_token_usage';reason='none';inputTokens=100;outputTokens=20;totalTokens=120;elapsedSeconds=5;startedAt='2026-10-16T09:00:00.000Z';completedAt=$infoObserved}
$infoSample.turnAverageSpeed=@{state='available';source='completed_turn';reason='none';outputTokensPerSecond=4;completedAt=$infoObserved;includesToolsAndWait=$true}
InfoSampleApply
Assert ((VisibleUiText $window) -match '上轮均速 token/s' -and (VisibleUiText $window) -notmatch '上轮均速 · ' -and $window.MetricControls[3].Text -ceq '4.0') 'valid speed caption or value missing'
$infoSample.state='empty';$infoSample.session=$null;$infoSample.usage=$null;$infoSample.task=$null
$infoSample.conversationContext=$null;$infoSample.lastCompletedTurn=$null;$infoSample.turnAverageSpeed=$null
InfoSampleApply
Assert ($window.MetricsVisible -and $window.ContextVisible -and $window.EffortVisible -and -not $window.CurrentTurnVisible -and $window.MetricControls[2].Text -ceq '10' -and $window.MetricControls[3].Text -ceq '4.0' -and $window.SelectedUsageStateControl.Text -match '上次有效数据') 'empty telemetry erased last validated counts/context/speed'
Assert ([string]$window.MetricControls[0].ToolTip -ceq '输入 · 10 tokens' -and [Windows.Automation.AutomationProperties]::GetHelpText($window.MetricControls[2]) -match '10 tokens') 'empty telemetry cleared retained exact values'
$infoList.tasks=@(@{id=$taskBeta;title='New synthetic task';updatedAt=$infoObserved})
InfoListUpdate
InfoExactCleared
Assert ($window.SelectedTask -eq $taskBeta -and -not $window.MetricsVisible -and -not $window.ContextVisible -and $window.MetricControls[0].Text -ceq '—' -and $window.MetricControls[3].Text -ceq '—') 'task switch retained the previous task metrics, context or exact values'
$infoSample.state='ok';$infoSample.session=@{id=$taskAlpha};$infoSample.usage=@{inputTokens=1234567;outputTokens=0;totalTokens=1234567}
$infoSample.task=@{id=$taskAlpha;title=$infoTitle;updatedAt=$infoObserved;stale=$false;truncated=$false}
$window.FixtureTasks($tasksJson)
InfoSampleApply
Assert ($window.SelectedTask -eq $taskAlpha -and -not $window.PinnedTask -and $window.MetricsVisible -and -not $window.TaskFlagsVisible -and $window.MetricControls[2].Text -ne '—') 'information regressions did not restore the followed fixture task'

# Real control events: explicit selection pins the task; the pin button resumes follow mode.
$window.TaskControl.SelectedValue='22222222-2222-4222-8222-222222222222'
Assert ($window.PinnedTask -and $window.SelectedTask -eq '22222222-2222-4222-8222-222222222222') 'explicit selection did not pin the task'
Assert ($window.TaskControl.SelectedItem.Label -match 'Fixture Beta') 'explicit selection did not surface the picked task'
$pinnedGeneration=$window.TaskGeneration
Click $window.TaskPinControl
Assert (-not $window.PinnedTask -and $window.TaskGeneration -gt $pinnedGeneration -and $window.SelectedTask -eq '11111111-1111-4111-8111-111111111111') 'pin button did not resume follow mode'
Assert ($window.TaskControl.SelectedValue -eq $taskAlpha -and $window.TaskControl.SelectedItem.Label -match 'Fixture Alpha') 'pin-button resume left the picker on the previously pinned task'
Assert ($window.TaskControl.ToolTip -match 'Fixture Alpha' -and $window.TaskControl.ToolTip -match $taskAlpha -and $window.TaskControl.ToolTip -notmatch '22222222') 'pin-button resume left the picker tooltip on the previously pinned task'
$window.FixtureTasks($tasksJson.Replace('11111111-1111-4111-8111-111111111111','33333333-3333-4333-8333-333333333333'))
Assert ($window.TaskControl.Items.Count -eq 2 -and $window.SelectedTask -eq '33333333-3333-4333-8333-333333333333') 'follow mode did not track the refreshed first task'
# A pinned task missing from the refreshed list keeps both the selection and a placeholder row.
$window.TaskControl.SelectedValue='22222222-2222-4222-8222-222222222222'
$window.FixtureTasks($tasksJson)
Assert ($window.PinnedTask -and $window.SelectedTask -eq '22222222-2222-4222-8222-222222222222') 'list refresh dropped the pinned selection'
# Cumulative usage follows the session of the selected task, not a stale followed session.
$window.FixtureTaskTelemetry($window.TaskGeneration,$null,$normalJson)
Assert (-not $window.MetricsVisible -and $window.MetricControls[0].Text -ceq '—' -and $window.MetricControls[3].Text -ceq '—' -and -not $window.ContextVisible -and -not $window.EffortVisible) 'followed-session counts/context/speed borrowed into a differently pinned task'
$window.FixtureTaskTelemetry($window.TaskGeneration,'task_not_found',$null)
Assert ($window.PinnedTask -and $window.SelectedTask -eq '22222222-2222-4222-8222-222222222222' -and $window.TaskFlagsText -match '保留固定选择') 'pinned 404 did not retain the selection'
Assert (-not $window.MetricsVisible -and $window.MetricControls[3].Text -ceq '—') 'pinned 404 retained stale completion metrics'
# A current-generation task_not_found must state the task-unavailable main status without stale data,
# keep the fixed selection, and a following normal sample must restore status and data.
$window.FixtureTaskTelemetry($window.TaskGeneration,$null,$normalJson)
$window.FixtureTaskTelemetry($window.TaskGeneration,$null,$betaJson)
Assert ([string]::IsNullOrEmpty($window.DisplayState) -and $window.MetricsVisible -and $window.MetricControls[2].Text -eq '1,200' -and $window.MetricControls[3].Text -ceq '4.0') 'normal sample before task_not_found did not show main data without a success status'
$window.FixtureTaskTelemetry($window.TaskGeneration,'task_not_found',$null)
$statusControl=$window.GetType().GetField('status',$allFields).GetValue($window)
Assert ($window.DisplayState -match '固定任务日志不可用' -and $statusControl.Visibility -eq [Windows.Visibility]::Visible) 'current-generation task_not_found status missing or hidden'
Assert (-not $window.MetricsVisible -and -not $window.ContextVisible -and -not $window.EffortVisible -and -not $window.CurrentTurnVisible -and -not $window.AgentsVisible -and $window.MetricControls[0].Text -ceq '—' -and $window.MetricControls[3].Text -ceq '—') 'current-generation task_not_found retained stale task data'
Assert ($window.PinnedTask -and $window.SelectedTask -eq '22222222-2222-4222-8222-222222222222' -and $window.TaskFlagsText -match '保留固定选择') 'current-generation task_not_found lost the fixed selection or pinned warning'
$window.FixtureTaskTelemetry($window.TaskGeneration,$null,$betaJson)
Assert ([string]::IsNullOrEmpty($window.DisplayState) -and $window.MetricsVisible -and $window.MetricControls[2].Text -eq '1,200' -and $window.MetricControls[3].Text -ceq '4.0') 'task_not_found recovery did not restore the main data'
Assert ($window.PinnedTask -and $window.SelectedTask -eq '22222222-2222-4222-8222-222222222222') 'task_not_found recovery lost the fixed selection'
$window.FixtureTasks($tasksJson.Replace('22222222-2222-4222-8222-222222222222','44444444-4444-4444-8444-444444444444'))
Assert ($window.PinnedTask -and $window.SelectedTask -eq '22222222-2222-4222-8222-222222222222' -and $window.TaskControl.SelectedItem.Label -match '未在当前列表' -and $window.TaskControl.ToolTip -match '22222222-2222-4222-8222-222222222222') 'pinned placeholder lost selection or full-id tooltip'
# Transient task-list failures keep polling; only the definitive missing route disables the list.
$window.FixtureTasks($tasksJson)
Click $window.TaskPinControl
Assert (-not $window.PinnedTask -and $window.SelectedTask -eq $taskAlpha) 'fixture setup did not resume follow mode'
$window.FixtureError('tasks','telemetry_unavailable',$window.TaskGeneration)
Assert ($window.TasksSupported -and $window.SelectedTask -eq $taskAlpha) 'transient task-list failure disabled task polling'
$window.FixtureError('tasks','not_found',$window.TaskGeneration)
Assert (-not $window.TasksSupported) 'definitive missing /api/tasks route did not disable the list'
$window.FixtureTasks($tasksJson)
# A valid pinned task with a legacy unavailable follow snapshot keeps detail and clears borrowed metrics.
$unavailableTask=TaskFixture $false $false $taskCurrent
$unavailableTask.state='unavailable';$unavailableTask.session=$null;$unavailableTask.usage=$null;$unavailableTask.speed=$null
$window.FixtureTaskTelemetry($window.TaskGeneration,$null,([CodexNative.WidgetClient]::Serialize($unavailableTask)))
Assert ($window.TaskControl.SelectedItem.Label -match 'Fixture Alpha' -and -not $window.CurrentTurnVisible -and -not $window.AgentsVisible -and $window.AgentsPanelControl.Children.Count -eq 0 -and -not $window.TaskFlagsVisible) 'valid pinned task hidden by legacy unavailable follow state'
Assert (-not $window.MetricsVisible -and $window.MetricControls[0].Text -eq '—' -and $window.MetricControls[3].Text -eq '—') 'pinned-task unavailable follow state retained follow-session metrics'
# Results-window benchmark/history errors must not alter the visible main metrics.
$window.FixtureTaskTelemetry($window.TaskGeneration,$null,$normalJson)
$window.FixtureEvent('history','disconnected',$null)
$window.FixtureEvent('benchmark','benchmark_unavailable',$null)
Assert ($window.MetricsVisible -and $window.MetricControls[2].Text -eq '1,200' -and $window.MetricControls[3].Text -ceq '4.0' -and [string]::IsNullOrEmpty($window.DisplayState) -and (UiText $window) -notmatch '断连|基准|不可用') 'benchmark/history error polluted the main window'
# Diagnostics: legacy records without a diagnostics object stay unchanged, whitelisted fields render.
# Diagnostics: legacy records without a diagnostics object stay unchanged, whitelisted fields render.
$window.OpenResults();$window.ResultsWindow.UpdateLayout()
$history=@{latestRun=@{runId='55555555-5555-4555-8555-555555555555';status='timed_out';caseSetVersion='pelican-svg-v2';rubricVersion='pelican-svg-v2';caseResults=@(@{caseId='pelican-svg';status='timed_out';errorCode='timed_out'})};runs=@()}
$window.FixtureEvent('history',$null,([CodexNative.WidgetClient]::Serialize($history)))
$casesPanel=$window.GetType().GetField('cases',$flags).GetValue($window)
Assert ((UiText $casesPanel) -notmatch '运行诊断') 'legacy run without diagnostics rendered a diagnostics line'
$history.latestRun.caseResults[0]['diagnostics']=@{startedAt='2026-10-15T05:00:00.000Z';finishedAt='2026-10-15T05:15:00.000Z';lastPhase='stopping';terminationReason='budget_exhausted';timeoutMs=900000;elapsedMs=900000;firstEventElapsedMs=1100;lastEventElapsedMs=888000;cleanupStatus='unconfirmed';configWarning='timeout_config_invalid';secret='do-not-render'}
$window.FixtureEvent('history',$null,([CodexNative.WidgetClient]::Serialize($history)))
$casesPanel=$window.GetType().GetField('cases',$flags).GetValue($window);$diagnosticsText=UiText $casesPanel;$diagnosticsTip=(@($casesPanel.Children|Where-Object {$null -ne $_.ToolTip}|ForEach-Object {[string]$_.ToolTip}) -join ' ')
Assert ($diagnosticsText -notmatch '运行诊断' -and $diagnosticsTip -match '运行诊断' -and $diagnosticsTip -match '结束原因 预算耗尽' -and $diagnosticsText -match '清理未确认，临时文件可能保留' -and $diagnosticsText -match '超时配置无效，已使用默认时长') 'routine diagnostics tooltip or visible critical warnings incomplete'
Assert (($diagnosticsText+' '+$diagnosticsTip) -notmatch 'do-not-render') 'unlisted diagnostics field leaked into the UI'
$window.ResultsWindow.Width=610;$window.ResultsWindow.Height=420;$window.ResultsWindow.UpdateLayout()
PumpUntil {-not (WindowField 'resultHeading').IsVisible}
$warningControls=@($casesPanel.Children|Where-Object {$_ -is [Windows.Controls.TextBlock] -and $_.Text -match '清理未确认，临时文件可能保留|超时配置无效，已使用默认时长'})
Assert ($warningControls.Count -eq 2 -and @($warningControls|Where-Object {-not $_.IsVisible}).Count -eq 0 -and @($casesPanel.Children|Where-Object {$_ -is [Windows.Controls.TextBlock] -and $_.Text -ceq [CodexNative.WidgetClient]::ErrorDescription('timed_out') -and $_.IsVisible}).Count -gt 0) 'compact density hid run errors or critical cleanup/configuration warnings'
$window.Close()

# Independent usage summaries: selected task and local-all blocks render, validate,
# invalidate and coalesce independently, and older responses cannot overwrite them.
$window=New-Object CodexNative.WidgetWindow $true;$fixtureWindows.Add($window)
$window.Show()
$window.FixtureTasks($tasksJson)
$taskAlpha='11111111-1111-4111-8111-111111111111'
$taskBeta='22222222-2222-4222-8222-222222222222'
$usageStamped='2026-10-16T09:00:05.000Z'
$coverage=@{
    discoveredFiles=3;completeFiles=3;pendingFiles=0;
    excludedFiles=0;failedFiles=0;responsesCounted=2;
    conversationsCounted=1;subagentThreadsCounted=1;
    legacyOnlyConversations=0;duplicateResponses=0;
    conflictingResponses=0;invalidResponses=0;complete=$true
}
function UsageBlock([string]$scope,[string]$state,[object]$reason,[object]$usage,[string]$taskId) {
    $blockCoverage=@{}
    foreach($key in $coverage.Keys){$blockCoverage[$key]=$coverage[$key]}
    $block=@{state=$state;reason=$reason;scope=$scope;usage=$usage;coverage=$blockCoverage;updatedAt=$usageStamped}
    if($taskId){$block.taskId=$taskId}
    return $block
}
function UsageFixture([string]$generation,[object]$overall,[object]$selected,[string]$sampledAt=$usageStamped) {
    $window.FixtureUsage([int]$generation,$null,([CodexNative.WidgetClient]::Serialize(@{sampledAt=$sampledAt;overall=$overall;selected=$selected})))
    $window.UpdateLayout()
    if($null -ne $window.UsageWindow){$window.UsageWindow.UpdateLayout()}
}
$usageGeneration=$window.UsageGeneration
$selectedUsage=UsageBlock 'selected_task' 'available' $null @{inputTokens=10;outputTokens=5;totalTokens=15} $taskAlpha
$overallUsage=UsageBlock 'local_all' 'partial' 'scan_in_progress' @{inputTokens=100;outputTokens=200;totalTokens=300} $null
UsageFixture $usageGeneration $overallUsage $selectedUsage
Assert ($null -eq $window.UsageWindow -and $window.OverallMetricControls[2].Text -ceq '300') 'background usage update opened a window or did not update detached controls'
$usageEntry=@(Visuals $window | Where-Object {$_ -is [Windows.Controls.Button] -and [Windows.Automation.AutomationProperties]::GetAutomationId($_) -ceq 'Usage'})[0]
Click $usageEntry
$usagePopup=$window.UsageWindow;$usagePopup.UpdateLayout()
$usageView=$window.GetType().GetField('usageView',$flags).GetValue($window)
$chartViewport=$window.GetType().GetField('usageWindowViewport',$flags).GetValue($window)
$expectedUsageWidth=[Math]::Min(420,[Math]::Max(1,[Windows.SystemParameters]::WorkArea.Width-24))
$expectedUsageHeight=[Math]::Min(400,[Math]::Max(1,[Windows.SystemParameters]::WorkArea.Height-24))
Assert ($usagePopup.IsVisible -and $usagePopup.Title -ceq 'Codex 总用量' -and [Windows.Automation.AutomationProperties]::GetAutomationId($usagePopup) -ceq 'UsageWindow' -and [object]::ReferenceEquals($usagePopup.Owner,$window) -and $window.IsEnabled) 'usage entry did not open an owned nonmodal usage window'
Assert ($usagePopup.ActualWidth -eq $expectedUsageWidth -and $usagePopup.ActualHeight -eq $expectedUsageHeight -and $usagePopup.MinHeight -le $usagePopup.Height -and $usagePopup.Height -le $usagePopup.MaxHeight -and $usagePopup.Width -le [Windows.SystemParameters]::WorkArea.Width -and $usagePopup.Height -le [Windows.SystemParameters]::WorkArea.Height) 'usage window dimensions exceed the work area or its height bounds'
Assert ($chartViewport -is [Windows.Controls.ScrollViewer] -and [object]::ReferenceEquals($chartViewport.Content,$usageView) -and $chartViewport.VerticalScrollBarVisibility -eq [Windows.Controls.ScrollBarVisibility]::Auto -and $chartViewport.HorizontalScrollBarVisibility -eq [Windows.Controls.ScrollBarVisibility]::Disabled) 'usage surface is not mounted in its own vertical viewport'
$usageClose=@(Visuals $usagePopup | Where-Object {$_ -is [Windows.Controls.Button] -and [Windows.Automation.AutomationProperties]::GetAutomationId($_) -ceq 'CloseUsage'})
Assert ($usageClose.Count -eq 1 -and $usageClose[0].IsVisible -and $usageClose[0].Focusable -and $usageClose[0].IsTabStop) 'usage close action is missing, duplicated or inaccessible'
Assert (@(Visuals $window | Where-Object {[Windows.Automation.AutomationProperties]::GetAutomationId($_) -like 'Local*' -or [Windows.Automation.AutomationProperties]::GetAutomationId($_) -in @('UsageBarChart','UsageRangeSlider') -or $_ -is [Windows.Controls.Slider]}).Count -eq 0) 'opening usage put its controls back in the main visual tree'
Assert ($window.MetricControls[0].Text -ceq '10' -and $window.MetricControls[1].Text -ceq '5' -and $window.MetricControls[2].Text -ceq '15' -and $window.MetricControls[3].Text -ceq '—') 'selected usage did not replace the session triple or preserve the speed cell'
Assert ($window.OverallMetricControls[0].Text -ceq '100' -and $window.OverallMetricControls[1].Text -ceq '200' -and $window.OverallMetricControls[2].Text -ceq '300') 'overall usage did not render its independent triple'
Assert ($window.SelectedUsageCaptionControl.Text -ceq '当前对话 · 含已核实代理 · 历史日志 · 非实时' -and (VisibleUiText $usagePopup) -match 'Codex 总用量' -and (VisibleUiText $window) -notmatch 'Codex 总用量') 'usage captions are missing or local totals remain in the main window'
$selectedUsageText=(VisibleUiText $window)+' '+(VisibleUiText $usagePopup)
Assert ($selectedUsageText -match '输入' -and $selectedUsageText -match '输出' -and $selectedUsageText -match '合计') 'usage cards lost their visible input/output/total hierarchy'
Assert ($window.OverallStateControl.Text -match '已统计部分' -and $window.OverallStateControl.Text -match '正在扫描' -and $window.OverallStateControl.IsVisible) 'partial overall state lacks reason or its explicit subset label'
Assert ($window.SelectedUsageStateControl.Text -ceq '已核实' -and $window.SelectedUsageStateControl.IsVisible) 'available selected usage is not visibly labelled'
Assert ($window.MetricControls[0].ToolTip -ceq '输入 · 10 tokens' -and $window.OverallMetricControls[2].ToolTip -ceq '合计 · 300 tokens') 'usage exact tooltips missing'

# The chart changes only its date range, never the lifetime or selected totals.
function ChartOverall([bool]$complete=$false,[bool]$legacy=$false) {
    $chart=UsageBlock 'local_all' 'partial' 'scan_in_progress' @{inputTokens=100;outputTokens=20;totalTokens=120} $null
    $chart.coverage.responsesCounted=4
    $chart.coverage.complete=$complete
    if($complete){$chart.state='available';$chart.reason=$null}
    $to=[DateTimeOffset]::Parse('2026-10-17T00:00:00.000Z')
    $records=@(
        @{at=[DateTimeOffset]::Parse('2026-10-16T12:00:00.000Z');input=10;output=2},
        @{at=[DateTimeOffset]::Parse('2026-10-10T12:00:00.000Z');input=20;output=4},
        @{at=[DateTimeOffset]::Parse('2026-09-20T12:00:00.000Z');input=30;output=6},
        @{at=[DateTimeOffset]::Parse('2026-06-01T12:00:00.000Z');input=40;output=8}
    )
    $ranges=@()
    $definitions=@(@{id='7d';days=7;step=24},@{id='30d';days=30;step=72},@{id='90d';days=90;step=168},@{id='all';days=138;step=240});if(-not $legacy){$definitions=@(@{id='today';days=1;step=2})+$definitions};foreach($definition in $definitions) {
        $from=$to.AddDays(-$definition.days);$cursor=$from;$buckets=@();$inputSum=0;$outputSum=0;$count=0
        while($cursor -lt $to) {
            $end=$cursor.AddHours($definition.step);if($end -gt $to){$end=$to}
            $matches=@($records | Where-Object {$_.at -ge $cursor -and $_.at -lt $end})
            $input=0;$output=0;foreach($record in $matches){$input+=$record.input;$output+=$record.output}
            $triple=$null;if($matches.Count -gt 0 -or $complete){$triple=@{inputTokens=$input;outputTokens=$output;totalTokens=$input+$output}}
            $buckets+=@{from=$cursor.UtcDateTime.ToString('yyyy-MM-ddTHH:mm:ss.fffZ');to=$end.UtcDateTime.ToString('yyyy-MM-ddTHH:mm:ss.fffZ');usage=$triple;responsesCounted=$matches.Count}
            $inputSum+=$input;$outputSum+=$output;$count+=$matches.Count;$cursor=$end
        }
        $ranges+=@{id=$definition.id;from=$from.UtcDateTime.ToString('yyyy-MM-ddTHH:mm:ss.fffZ');to=$to.UtcDateTime.ToString('yyyy-MM-ddTHH:mm:ss.fffZ');usage=@{inputTokens=$inputSum;outputTokens=$outputSum;totalTokens=$inputSum+$outputSum};responsesCounted=$count;buckets=$buckets}
    }
    $chart.timeline=@{timeZone='UTC';ranges=$ranges}
    return $chart
}
function NativeChartOverall([bool]$complete=$false) {
    $chart=ChartOverall $complete
    $chart.coverage.nativeIncrementsCounted=$chart.coverage.responsesCounted
    $chart.coverage.responsesCounted=0
    foreach($range in $chart.timeline.ranges){
        $range.nativeIncrementsCounted=$range.responsesCounted;$range.responsesCounted=0
        foreach($bucket in $range.buckets){$bucket.nativeIncrementsCounted=$bucket.responsesCounted;$bucket.responsesCounted=0}
    }
    return $chart
}
$chartOverall=ChartOverall
UsageFixture $usageGeneration $chartOverall $selectedUsage
$chartRange=$window.GetType().GetField('usageRange',$flags).GetValue($window)
$chartTotal=$window.GetType().GetField('usageRangeTotal',$flags).GetValue($window)
$chartNote=$window.GetType().GetField('usageChartNote',$flags).GetValue($window)
$chartBars=$window.GetType().GetField('usageBarControls',$flags).GetValue($window)
$chartProgress=$window.GetType().GetField('usageProgress',$flags).GetValue($window)
$chartScale=$window.GetType().GetField('usageScale',$flags).GetValue($window)
$chartViewport=$window.GetType().GetField('usageWindowViewport',$flags).GetValue($window)
Assert ($chartRange -is [Windows.Controls.Slider] -and $chartRange.Minimum -eq 0 -and $chartRange.Maximum -eq 4 -and $chartRange.Value -eq 0 -and $chartRange.IsSnapToTickEnabled -and $chartRange.IsTabStop) 'usage range slider is missing or cannot be used by keyboard'
Assert ($chartTotal.Text -ceq '12' -and $chartBars.Count -eq 12 -and $window.OverallMetricControls[2].Text -ceq '120') 'default today chart does not show only today usage'
Assert ($usagePopup.Title -ceq 'Codex 总用量' -and $chartBars[6].ToolTip -match '12:00 \+00:00 至 2026-10-16 14:00 \+00:00' -and $chartBars[6].ToolTip -match '不含结束时间' -and $chartBars[6].ToolTip -match '合计 12 tokens') 'today chart lost its exact hourly boundaries or usage-window title'
Assert ($chartRange.ToolTip -match '按记录确认时间' -and [Windows.Automation.AutomationProperties]::GetHelpText($window.GetType().GetField('usageBars',$flags).GetValue($window)) -match '按记录确认时间') 'usage timeline omitted its source-record confirmation-time basis'
$legacyChart=ChartOverall $false $true
UsageFixture $usageGeneration $legacyChart $selectedUsage
Assert ($chartBars.Count -eq 0 -and $chartTotal.Text -ceq '—' -and $chartNote.Text -match '旧版服务不提供当天数据' -and $window.OverallMetricControls[2].Text -ceq '120') 'legacy UTC chart fabricated today data or erased lifetime total'
$chartRange.Value=1
UsageFixture $usageGeneration $legacyChart $selectedUsage
Assert ($chartTotal.Text -ceq '36' -and $chartBars.Count -eq 7) 'legacy UTC 7-day range stopped working'
$chartRange.Value=4
Assert ($chartTotal.Text -ceq '120' -and $chartBars.Count -eq 14) 'legacy UTC all range stopped matching lifetime usage'
$reorderedChart=ChartOverall
$reorderedChart.timeline.ranges=@($reorderedChart.timeline.ranges[4],$reorderedChart.timeline.ranges[2],$reorderedChart.timeline.ranges[0],$reorderedChart.timeline.ranges[3],$reorderedChart.timeline.ranges[1])
UsageFixture $usageGeneration $reorderedChart $selectedUsage
$chartRange.Value=0
Assert ($chartTotal.Text -ceq '12' -and $chartBars.Count -eq 12) 'five-range timeline was indexed by position instead of id'
$localChart=ChartOverall;$localChart.timeline.timeZone='Asia/Shanghai'
UsageFixture $usageGeneration $localChart $selectedUsage
$localHour=[DateTimeOffset]::Parse('2026-10-16T12:00:00.000Z').ToLocalTime().ToString('yyyy-MM-dd HH:mm zzz')
Assert ($chartBars.Count -eq 12 -and $chartBars[6].ToolTip.Contains($localHour) -and $chartBars[6].ToolTip -match 'Asia/Shanghai' -and $chartTotal.Text -ceq '12') 'IANA local timeline did not display system-local hourly boundaries'
foreach($dayHours in 23,25){
    $dstChart=ChartOverall;$dstToday=$dstChart.timeline.ranges[0]
    $dstFrom=[DateTimeOffset]::Parse($dstToday.from);$dstTo=$dstFrom.AddHours($dayHours);$dstToday.to=$dstTo.UtcDateTime.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    $dstBuckets=@();$cursor=$dstFrom
    while($cursor -lt $dstTo){$end=$cursor.AddHours(2);if($end -gt $dstTo){$end=$dstTo};$observed=($cursor -eq $dstFrom.AddHours(12));$dstBuckets+=@{from=$cursor.UtcDateTime.ToString('yyyy-MM-ddTHH:mm:ss.fffZ');to=$end.UtcDateTime.ToString('yyyy-MM-ddTHH:mm:ss.fffZ');usage=$(if($observed){@{inputTokens=10;outputTokens=2;totalTokens=12}}else{$null});responsesCounted=$(if($observed){1}else{0})};$cursor=$end}
    $dstToday.buckets=$dstBuckets
    UsageFixture $usageGeneration $dstChart $selectedUsage
    Assert ($chartBars.Count -eq [Math]::Ceiling($dayHours/2.0) -and $chartTotal.Text -ceq '12' -and $chartBars[$chartBars.Count-1].ToolTip -match '不含结束时间') ('DST-length today was rejected or lost its final shorter bucket: '+$dayHours)
}
UsageFixture $usageGeneration $chartOverall $selectedUsage
$chartRange.Value=4;$usagePopup.UpdateLayout()
Assert ($chartTotal.Text -ceq '120' -and $chartBars.Count -eq 14 -and $window.OverallMetricControls[2].Text -ceq '120') 'all-time chart does not match deduplicated lifetime total'
$chartRange.Value=1;$usagePopup.UpdateLayout()
Assert ($chartTotal.Text -ceq '36' -and $chartBars.Count -eq 7 -and $window.OverallMetricControls[2].Text -ceq '120' -and $window.MetricControls[2].Text -ceq '15') '7-day range changed lifetime/selected totals or used the wrong interval'
Assert (@($chartBars | Where-Object {$_.ToolTip -match '用量未知'}).Count -eq 5 -and @($chartBars | Where-Object {$_.ToolTip -match '合计 0 tokens'}).Count -eq 0) 'partial empty buckets were fabricated as zeros'
Assert ($chartBars[0].ToolTip -match '2026-10-10' -and $chartBars[0].ToolTip -match '输入 20 · 输出 4 · 合计 24 tokens' -and [Windows.Automation.AutomationProperties]::GetHelpText($chartBars[0]) -match '24 tokens' -and $chartBars[0].Focusable) 'chart bars lost precise date/token details or keyboard accessibility'
Assert ($chartProgress.Text -match '文件 3/3' -and $chartProgress.Text -match '已计 4 个响应' -and $chartProgress.Text -match '覆盖未完成') 'chart scan progress is hidden or presents partial coverage as complete'
$null=$usagePopup.Activate();$null=[Windows.Input.Keyboard]::Focus($chartRange);$usagePopup.UpdateLayout()
Assert ($chartRange.IsKeyboardFocusWithin -and $chartRange.Template.FindName('Focus',$chartRange).Opacity -gt 0) 'range slider keyboard focus is invisible'
$focusedBucket=$chartBars[0]
$null=[Windows.Input.Keyboard]::Focus($focusedBucket)
Assert ($focusedBucket.IsKeyboardFocused) 'chart bar cannot receive keyboard focus'
UsageFixture $usageGeneration $chartOverall $selectedUsage
Assert ($chartBars[0].IsKeyboardFocused -and $chartBars[0].Tag -ceq $focusedBucket.Tag -and -not [object]::ReferenceEquals($chartBars[0],$focusedBucket)) 'usage polling lost keyboard focus on the same date bucket'
$null=[Windows.Input.Keyboard]::Focus($chartRange)
[Windows.Controls.Slider]::IncreaseSmall.Execute($null,$chartRange);$usagePopup.UpdateLayout()
Assert ($chartRange.Value -eq 2 -and $chartTotal.Text -ceq '72' -and $chartBars.Count -eq 10) 'range slider keyboard command did not update the 30-day chart'
$chartRange.Value=3;$usagePopup.UpdateLayout()
Assert ($chartTotal.Text -ceq '72' -and $chartBars.Count -eq 13) '90-day chart range did not update'
UsageFixture $usageGeneration (ChartOverall $true) $selectedUsage
$chartRange.Value=1;$usagePopup.UpdateLayout()
Assert (@($chartBars | Where-Object {$_.ToolTip -match '合计 0 tokens'}).Count -eq 5 -and @($chartBars | Where-Object {$_.ToolTip -match '用量未知'}).Count -eq 0 -and $chartProgress.Text -match '扫描完整') 'complete empty buckets are not distinguished from unknown partial buckets'
$emptyRange=ChartOverall
$emptyRange.timeline.ranges[1].usage=$null
$emptyRange.timeline.ranges[1].responsesCounted=0
foreach($bucket in $emptyRange.timeline.ranges[1].buckets){$bucket.usage=$null;$bucket.responsesCounted=0}
UsageFixture $usageGeneration $emptyRange $selectedUsage
Assert ($chartTotal.Text -ceq '—' -and $chartScale.Text -ceq '峰值 —' -and $chartNote.Text -match '尚无已核实记录' -and $window.OverallMetricControls[2].Text -ceq '120') 'unknown range fabricated a zero peak or changed lifetime usage'
foreach($chartFault in 'timezone','duplicate-range','oversized','bad-sum','gap','today-oversized','today-step','all-mismatch') {
    $badChart=ChartOverall
    switch($chartFault){
        'timezone' {$badChart.timeline.timeZone='local'}
        'duplicate-range' {$badChart.timeline.ranges[2].id='7d'}
        'oversized' {$badChart.timeline.ranges[4].buckets+=@{from='2026-10-17T00:00:00.000Z';to='2026-10-18T00:00:00.000Z';usage=$null;responsesCounted=0}}
        'bad-sum' {$badChart.timeline.ranges[1].usage.totalTokens=999}
        'gap' {$badChart.timeline.ranges[1].buckets[0].to='2026-10-10T23:00:00.000Z'}
        'today-oversized' {$badChart.timeline.ranges[0].buckets+=@($badChart.timeline.ranges[0].buckets[0],$badChart.timeline.ranges[0].buckets[0])}
        'today-step' {$badChart.timeline.ranges[0].buckets[0].to='2026-10-16T03:00:00.000Z';$badChart.timeline.ranges[0].buckets[1].from='2026-10-16T03:00:00.000Z'}
        'all-mismatch' {$badChart.timeline.ranges[4].usage=@{inputTokens=99;outputTokens=20;totalTokens=119}}
    }
    UsageFixture $usageGeneration $badChart $selectedUsage
    Assert ($chartBars.Count -eq 0 -and $chartTotal.Text -ceq '—' -and $chartNote.Text -match '图表数据不可用' -and $window.OverallMetricControls[2].Text -ceq '120' -and $window.MetricControls[2].Text -ceq '15') ('invalid '+$chartFault+' timeline was accepted or erased independent valid counters')
}
# Native token_count intervals remain increments, never fabricated response counts.
$chartRange.Value=1
$nativeOverall=NativeChartOverall
UsageFixture $usageGeneration $nativeOverall $selectedUsage
Assert ($chartTotal.Text -ceq '36' -and $chartBars.Count -eq 7 -and $window.OverallMetricControls[2].Text -ceq '120' -and $window.MetricControls[2].Text -ceq '15') 'native-only partial usage was rejected or replaced selected usage'
Assert ($chartProgress.Text -match '已计 0 个响应' -and $chartProgress.Text -match '旧版增量 4 段' -and $chartProgress.Text -notmatch '已计 4 个响应' -and $window.OverallStateControl.ToolTip -match '已计响应 0' -and $window.OverallStateControl.ToolTip -match '旧版增量 4 段') 'native increments were mislabeled as modern responses'
Assert ($chartProgress.TextWrapping -eq [Windows.TextWrapping]::Wrap -and $chartProgress.TextTrimming -eq [Windows.TextTrimming]::None -and [double]::IsPositiveInfinity($chartProgress.MaxHeight)) 'extended native scan progress is truncated or cannot wrap'
Assert ($chartTotal.ToolTip -match '旧版增量 2 段' -and $chartBars[0].ToolTip -match '旧版增量 1 段' -and $chartBars[0].ToolTip -match '已计 0 个响应' -and [Windows.Automation.AutomationProperties]::GetHelpText($chartBars[0]) -match '旧版增量 1 段') 'native range/bucket counts or accessible increment details are missing'
$nativeOverall=NativeChartOverall $true
UsageFixture $usageGeneration $nativeOverall $selectedUsage
Assert ($window.OverallMetricControls[2].Text -ceq '120' -and $window.OverallStateControl.Text -ceq '已核实' -and $chartProgress.Text -match '扫描完整' -and $chartBars.Count -eq 7) 'available native-only usage was rejected solely because modern responses are zero'
$mixedOverall=NativeChartOverall $true
$mixedOverall.coverage.responsesCounted=1;$mixedOverall.coverage.nativeIncrementsCounted=3
$recordAt=[DateTimeOffset]::Parse('2026-10-16T12:00:00.000Z')
foreach($range in $mixedOverall.timeline.ranges){
    $range.responsesCounted=1;$range.nativeIncrementsCounted--
    $bucket=@($range.buckets | Where-Object {[DateTimeOffset]::Parse($_.from) -le $recordAt -and [DateTimeOffset]::Parse($_.to) -gt $recordAt})[0]
    $bucket.responsesCounted=1;$bucket.nativeIncrementsCounted--
}
UsageFixture $usageGeneration $mixedOverall $selectedUsage
Assert ($chartTotal.Text -ceq '36' -and $chartProgress.Text -match '已计 1 个响应' -and $chartProgress.Text -match '旧版增量 3 段' -and $chartTotal.ToolTip -match '已计 1 个响应' -and $chartTotal.ToolTip -match '旧版增量 1 段') 'mixed modern/native usage merged distinct record counts or lost usage'
foreach($completeNative in $false,$true){
    $nativeZero=NativeChartOverall $completeNative
    $nativeZero.usage=@{inputTokens=0;outputTokens=0;totalTokens=0}
    foreach($range in $nativeZero.timeline.ranges){
        $range.usage=@{inputTokens=0;outputTokens=0;totalTokens=0}
        foreach($bucket in $range.buckets){if($null -ne $bucket.usage){$bucket.usage=@{inputTokens=0;outputTokens=0;totalTokens=0}}}
    }
    UsageFixture $usageGeneration $nativeZero $selectedUsage
    $expectedKnown=$(if($completeNative){7}else{2});$expectedUnknown=7-$expectedKnown
    Assert ($chartTotal.Text -ceq '0' -and $chartScale.Text -ceq '峰值 0' -and $chartNote.Text -match '已记录用量为 0' -and $window.OverallMetricControls[2].Text -ceq '0' -and @($chartBars | Where-Object {$_.ToolTip -match '合计 0 tokens'}).Count -eq $expectedKnown -and @($chartBars | Where-Object {$_.ToolTip -match '用量未知'}).Count -eq $expectedUnknown) ('native known-zero usage was hidden, fabricated or rejected; complete='+$completeNative)
}
$nativeNoRecords=NativeChartOverall
$nativeNoRecords.coverage.nativeIncrementsCounted=0
$nativeNoRecords.usage=$null
foreach($range in $nativeNoRecords.timeline.ranges){$range.nativeIncrementsCounted=0;$range.usage=$null;foreach($bucket in $range.buckets){$bucket.nativeIncrementsCounted=0;$bucket.usage=$null}}
UsageFixture $usageGeneration $nativeNoRecords $selectedUsage
Assert ($window.OverallMetricControls[2].Text -ceq '—' -and $chartTotal.Text -ceq '—' -and $chartBars.Count -eq 0 -and $chartProgress.Text -match '已计 0 个响应' -and $chartProgress.Text -notmatch '旧版增量 [1-9]' -and $window.MetricControls[2].Text -ceq '15') 'native no-record usage was fabricated as a known zero or erased selected usage'
$nativeEmptyRange=NativeChartOverall
$nativeEmptyRange.timeline.ranges[1].usage=$null;$nativeEmptyRange.timeline.ranges[1].nativeIncrementsCounted=0
foreach($bucket in $nativeEmptyRange.timeline.ranges[1].buckets){$bucket.usage=$null;$bucket.nativeIncrementsCounted=0}
UsageFixture $usageGeneration $nativeEmptyRange $selectedUsage
Assert ($chartTotal.Text -ceq '—' -and $chartScale.Text -ceq '峰值 —' -and $chartBars.Count -eq 7 -and $chartNote.Text -match '尚无已核实记录' -and @($chartBars | Where-Object {$_.ToolTip -match '用量未知'}).Count -eq 7 -and $window.OverallMetricControls[2].Text -ceq '120') 'native empty range was fabricated as zero or erased lifetime usage'
foreach($nativeFault in 'negative','fraction','large-fraction','string','null','unsafe','sum-unsafe','range-mismatch','all-count-mismatch','null-record-usage','missing-range-count','missing-bucket-count','kind-swap'){
    $badNative=NativeChartOverall
    $nativeRange=$badNative.timeline.ranges[1];$nativeBucket=$nativeRange.buckets[0]
    switch($nativeFault){
        'negative' {$nativeBucket.nativeIncrementsCounted=-1}
        'fraction' {$nativeBucket.nativeIncrementsCounted=0.5}
        'large-fraction' {$nativeBucket.nativeIncrementsCounted=[decimal]'9007199254740990.5'}
        'string' {$nativeBucket.nativeIncrementsCounted='1'}
        'null' {$nativeBucket.nativeIncrementsCounted=$null}
        'unsafe' {$nativeBucket.nativeIncrementsCounted=[long]9007199254740992}
        'sum-unsafe' {$nativeBucket.responsesCounted=[long]9007199254740991;$nativeBucket.nativeIncrementsCounted=1}
        'range-mismatch' {$nativeRange.nativeIncrementsCounted=1}
        'all-count-mismatch' {$badNative.coverage.nativeIncrementsCounted=5}
        'null-record-usage' {$nativeBucket.usage=$null}
        'missing-range-count' {$null=$nativeRange.Remove('nativeIncrementsCounted')}
        'missing-bucket-count' {$null=$nativeBucket.Remove('nativeIncrementsCounted')}
        'kind-swap' {
            $badNative.coverage.responsesCounted=1;$badNative.coverage.nativeIncrementsCounted=3
            $nativeBucket.responsesCounted=1;$nativeBucket.nativeIncrementsCounted=0
        }
    }
    UsageFixture $usageGeneration $badNative $selectedUsage
    Assert ($chartBars.Count -eq 0 -and $chartTotal.Text -ceq '—' -and $chartNote.Text -match '图表数据不可用' -and $window.OverallMetricControls[2].Text -ceq '120' -and $window.MetricControls[2].Text -ceq '15') ('invalid native '+$nativeFault+' timeline was accepted or erased independent totals')
}
foreach($nativeCoverageFault in 'negative','fraction','large-fraction','string','null','unsafe','sum-unsafe'){
    $badNative=NativeChartOverall $true
    switch($nativeCoverageFault){
        'negative' {$badNative.coverage.nativeIncrementsCounted=-1}
        'fraction' {$badNative.coverage.nativeIncrementsCounted=0.5}
        'large-fraction' {$badNative.coverage.nativeIncrementsCounted=[decimal]'9007199254740990.5'}
        'string' {$badNative.coverage.nativeIncrementsCounted='4'}
        'null' {$badNative.coverage.nativeIncrementsCounted=$null}
        'unsafe' {$badNative.coverage.nativeIncrementsCounted=[long]9007199254740992}
        'sum-unsafe' {$badNative.coverage.responsesCounted=[long]9007199254740991;$badNative.coverage.nativeIncrementsCounted=1}
    }
    UsageFixture $usageGeneration $badNative $selectedUsage
    Assert ($window.OverallMetricControls[2].Text -ceq '—' -and $chartBars.Count -eq 0 -and $window.MetricControls[2].Text -ceq '15') ('invalid native '+$nativeCoverageFault+' coverage was accepted or erased selected usage')
}
foreach($safeResponses in [long]0,[long]9007199254740990){
    $safeRecordCount=UsageBlock 'local_all' 'available' $null @{inputTokens=1;outputTokens=1;totalTokens=2} $null
    $safeRecordCount.coverage.responsesCounted=$safeResponses;$safeRecordCount.coverage.nativeIncrementsCounted=[long]9007199254740991-$safeResponses
    UsageFixture $usageGeneration $safeRecordCount $selectedUsage
    Assert ($window.OverallMetricControls[2].Text -ceq '2' -and $window.MetricControls[2].Text -ceq '15') 'safe-integer native/modern record count boundary was rejected'
}
$nativeSelected=UsageBlock 'selected_task' 'available' $null @{inputTokens=10;outputTokens=5;totalTokens=15} $taskAlpha
$nativeSelected.coverage.responsesCounted=0;$nativeSelected.coverage.nativeIncrementsCounted=2
UsageFixture $usageGeneration (NativeChartOverall $true) $nativeSelected
Assert ($window.MetricControls[2].Text -ceq '15' -and $window.SelectedUsageStateControl.Text -ceq '已核实' -and $window.SelectedUsageCaptionControl.ToolTip -notmatch '的响应用量') 'native-only selected usage was rejected or described entirely as response usage'
$chartRange.Value=1
UsageFixture $usageGeneration $chartOverall $selectedUsage
$chartBounds=$window.GetType().GetField('usageBars',$flags).GetValue($window)
$chartBounds.BringIntoView();$usagePopup.UpdateLayout()
$plotOrigin=$chartBounds.TransformToAncestor($usagePopup).Transform((New-Object Windows.Point 0,0))
Assert ($plotOrigin.X -ge 0 -and $plotOrigin.X+$chartBounds.ActualWidth -le $usagePopup.ActualWidth -and $plotOrigin.Y -ge 0 -and $plotOrigin.Y+$chartBounds.ActualHeight -le $usagePopup.ActualHeight) 'chart is clipped in the normal usage window'
$usagePopup.Height=[Math]::Min(300,$expectedUsageHeight);$usagePopup.UpdateLayout();$chartBounds.BringIntoView();$usagePopup.UpdateLayout()
Assert ($chartViewport.ScrollableHeight -gt 0 -and $chartViewport.HorizontalScrollBarVisibility -eq [Windows.Controls.ScrollBarVisibility]::Disabled -and $chartRange.ActualWidth -gt 0) 'short work-area chart has no scroll access or causes horizontal overflow'
$usagePopup.Height=$expectedUsageHeight;$chartViewport.ScrollToTop();$usagePopup.UpdateLayout()

# Window lifetime must not own the sampled data, controls, range selection or other tools.
$usageLifecycleGeneration=$window.UsageGeneration;$usageLifecycleSubmission=$window.SubmittedRequest
$window.OpenUsage();Click $usageEntry
Assert ([object]::ReferenceEquals($window.UsageWindow,$usagePopup) -and @($window.OwnedWindows | Where-Object {[Windows.Automation.AutomationProperties]::GetAutomationId($_) -ceq 'UsageWindow'}).Count -eq 1) 'repeated usage entry created another window'
$usagePopup.Hide()
Assert (-not $usagePopup.IsVisible -and [object]::ReferenceEquals($window.UsageWindow,$usagePopup)) 'hidden usage window lost its reusable instance'
$window.OpenUsage();$usagePopup.UpdateLayout()
Assert ($usagePopup.IsVisible -and [object]::ReferenceEquals($window.UsageWindow,$usagePopup) -and $chartRange.Value -eq 1 -and [object]::ReferenceEquals($chartViewport.Content,$usageView)) 'opening hidden usage replaced the window, controls or selected range'
$window.OpenSettings();$independentSettings=$window.SettingsWindow
$window.SettingsEffortControl.SelectedValue='high'
$window.OpenResults();$independentResults=$window.ResultsWindow;$independentRun=$window.SelectedRunId
Assert ($usagePopup.IsVisible -and $independentSettings.IsVisible -and $independentResults.IsVisible -and $window.IsEnabled -and -not $window.IsBusy) 'usage window blocked the main window or another nonmodal tool'
$null=$usagePopup.Activate();Click $usageClose[0]
Assert ($null -eq $window.UsageWindow -and -not $usagePopup.IsVisible -and $null -eq $chartViewport.Content -and $window.IsVisible -and $independentSettings.IsVisible -and $independentResults.IsVisible) 'CloseUsage did not detach only its own surface'
PumpUntil {$usageEntry.IsKeyboardFocused}
Assert ($usageEntry.IsKeyboardFocused) 'usage close did not return focus to the main usage entry'
$closedChart=ChartOverall
$closedChart.usage.inputTokens+=10;$closedChart.usage.outputTokens+=2;$closedChart.usage.totalTokens+=12
$latestRecord=[DateTimeOffset]::Parse('2026-10-16T12:00:00.000Z')
foreach($range in $closedChart.timeline.ranges){
    $range.usage.inputTokens+=10;$range.usage.outputTokens+=2;$range.usage.totalTokens+=12
    $bucket=@($range.buckets | Where-Object {[DateTimeOffset]::Parse($_.from) -le $latestRecord -and [DateTimeOffset]::Parse($_.to) -gt $latestRecord})[0]
    $bucket.usage.inputTokens+=10;$bucket.usage.outputTokens+=2;$bucket.usage.totalTokens+=12
}
UsageFixture $usageGeneration $closedChart $selectedUsage
Assert ($null -eq $window.UsageWindow -and -not $chartTotal.IsVisible -and $chartTotal.Text -ceq '48' -and $window.OverallMetricControls[2].Text -ceq '132' -and $window.MetricControls[2].Text -ceq '15' -and $chartRange.Value -eq 1) 'closed usage stopped accepting snapshots, reopened itself or lost the selected range'
$window.OpenUsage();$usagePopup=$window.UsageWindow;$usagePopup.UpdateLayout()
$reopenedViewport=$window.GetType().GetField('usageWindowViewport',$flags).GetValue($window)
Assert ($usagePopup.IsVisible -and [object]::ReferenceEquals($reopenedViewport.Content,$usageView) -and [object]::ReferenceEquals($chartRange,$window.GetType().GetField('usageRange',$flags).GetValue($window)) -and [object]::ReferenceEquals($chartTotal,$window.GetType().GetField('usageRangeTotal',$flags).GetValue($window)) -and [object]::ReferenceEquals($chartBars,$window.GetType().GetField('usageBarControls',$flags).GetValue($window)) -and $chartRange.Value -eq 1 -and $chartTotal.Text -ceq '48' -and $chartBars.Count -eq 7 -and $window.OverallMetricControls[2].Text -ceq '132') 'usage reopen rebuilt persistent controls or displayed an older snapshot or range'
Assert ([object]::ReferenceEquals($window.SettingsWindow,$independentSettings) -and [object]::ReferenceEquals($window.ResultsWindow,$independentResults) -and $window.SettingsEffortControl.SelectedValue -ceq 'high' -and $window.SelectedRunId -ceq $independentRun) 'usage close/reopen disturbed settings draft or result selection'
$usageEscape=[Windows.Input.KeyEventArgs]::new([Windows.Input.Keyboard]::PrimaryDevice,[Windows.PresentationSource]::FromVisual($usagePopup),0,[Windows.Input.Key]::Escape)
$usageEscape.RoutedEvent=[Windows.UIElement]::PreviewKeyDownEvent;$usagePopup.RaiseEvent($usageEscape)
Assert ($usageEscape.Handled -and $null -eq $window.UsageWindow -and -not $usagePopup.IsVisible -and $null -eq $reopenedViewport.Content -and $window.IsVisible -and $independentSettings.IsVisible -and $independentResults.IsVisible) 'Escape did not close and detach only the usage window'
PumpUntil {$usageEntry.IsKeyboardFocused}
Assert ($usageEntry.IsKeyboardFocused -and $chartRange.Value -eq 1 -and $chartTotal.Text -ceq '48') 'Escape close lost the saved chart or main-entry focus'
Click $usageEntry;$usagePopup=$window.UsageWindow;$usagePopup.UpdateLayout()
$chartViewport=$window.GetType().GetField('usageWindowViewport',$flags).GetValue($window)
Assert ($usagePopup.IsVisible -and $chartTotal.Text -ceq '48' -and $chartRange.Value -eq 1 -and $window.UsageGeneration -eq $usageLifecycleGeneration -and [object]::ReferenceEquals($window.SubmittedRequest,$usageLifecycleSubmission) -and -not $window.IsBusy) 'usage lifetime changed task generation, submitted a benchmark or reset the chart'
$independentSettings.Close()
Assert ($usagePopup.IsVisible -and [object]::ReferenceEquals($window.ResultsWindow,$independentResults)) 'closing settings affected usage or results'
$independentResults.Close()
Assert ($usagePopup.IsVisible -and $null -eq $window.SettingsWindow -and $null -eq $window.ResultsWindow -and $chartRange.Value -eq 1 -and $chartTotal.Text -ceq '48') 'closing results affected usage or its selected range'
UsageFixture $usageGeneration $chartOverall $selectedUsage

$chartUnavailable=ChartOverall;$chartUnavailable.state='unavailable';$chartUnavailable.reason='snapshot_stale';$chartUnavailable.usage=$null
UsageFixture $usageGeneration $chartUnavailable $selectedUsage
Assert ($chartBars.Count -eq 0 -and $chartTotal.Text -ceq '—' -and $chartNote.Text -match '快照可能陈旧') 'stale overall block retained its old chart'
$chartUnknown=UsageBlock 'local_all' 'partial' 'budget_exceeded' $null $null
$chartUnknown.coverage.complete=$false
UsageFixture $usageGeneration $chartUnknown $selectedUsage
Assert ($chartTotal.Text -ceq '—' -and $chartBars.Count -eq 0 -and $window.OverallMetricControls[2].Text -ceq '—' -and $chartProgress.Text -match '覆盖未完成') 'partial-null overall chart fabricated a total'
UsageFixture $usageGeneration $chartOverall $selectedUsage
$window.FixtureEvent('usage','disconnected',$null)
Assert ($chartBars.Count -eq 0 -and $chartTotal.Text -ceq '—' -and $window.OverallMetricControls[2].Text -ceq '—') 'usage disconnect retained the old chart'
$chartRange.Value=4
UsageFixture $usageGeneration $overallUsage $selectedUsage
Assert ($chartBars.Count -eq 0 -and $chartTotal.Text -ceq '—' -and $window.OverallMetricControls[2].Text -ceq '300') 'legacy no-timeline response was not kept compatible with total counters'

$selectedUsage.usage=@{inputTokens=0;outputTokens=0;totalTokens=0}
UsageFixture $usageGeneration $overallUsage $selectedUsage
Assert ($window.MetricControls[0].Text -ceq '0' -and $window.MetricControls[2].Text -ceq '0') 'valid zero selected usage was hidden or dashed'
$selectedUsage.usage=@{inputTokens=9007199254740991;outputTokens=0;totalTokens=9007199254740991}
UsageFixture $usageGeneration $overallUsage $selectedUsage
Assert ([string]$window.MetricControls[0].ToolTip -ceq '输入 · 9007199254740991 tokens' -and [string]$window.MetricControls[2].ToolTip -ceq '合计 · 9007199254740991 tokens') 'maximum safe usage integer was rounded in exact tooltips'
$selectedUsage.usage=@{inputTokens=10;outputTokens=5;totalTokens=15}
UsageFixture $usageGeneration $overallUsage $selectedUsage

$legacy=@{state='ok';session=@{id=$taskAlpha;updatedAt=$usageStamped};sampledAt=$usageStamped;usage=@{inputTokens=7;outputTokens=8;totalTokens=15};lastCompletedTurn=@{state='available';source='turn_token_usage';reason='none';inputTokens=100;outputTokens=20;totalTokens=120;elapsedSeconds=5;startedAt='2026-10-16T09:00:00.000Z';completedAt=$usageStamped};turnAverageSpeed=@{state='available';source='completed_turn';reason='none';outputTokensPerSecond=4;completedAt=$usageStamped;includesToolsAndWait=$true}}
$window.FixtureTaskTelemetry($window.TaskGeneration,$null,([CodexNative.WidgetClient]::Serialize($legacy)))
Assert ($window.MetricControls[0].Text -ceq '10' -and $window.MetricControls[2].Text -ceq '15' -and $window.MetricControls[3].Text -ceq '4.0') 'legacy telemetry overwrote responded usage counts or failed to refresh speed'

$selectedUsage.state='loading';$selectedUsage.reason='scan_in_progress';$selectedUsage.usage=$null
$loadingOverall=UsageBlock 'local_all' 'loading' 'scan_in_progress' $null $null
UsageFixture $usageGeneration $loadingOverall $selectedUsage
Assert ($window.MetricsVisible -and $window.MetricControls[0].Text -ceq '10' -and $window.MetricControls[1].Text -ceq '5' -and $window.MetricControls[2].Text -ceq '15' -and $window.MetricControls[3].Text -ceq '4.0') 'loading selected usage discarded the last valid counts or speed'
Assert ($window.OverallMetricControls[0].Text -ceq '—' -and $window.OverallMetricControls[2].Text -ceq '—') 'loading overall usage retained a previously valid total'
Assert ($window.SelectedUsageStateControl.Text -match '正在统计对话' -and $window.SelectedUsageStateControl.Text -match '上次有效数据' -and $window.OverallStateControl.Text -ceq '正在统计' -and $window.SelectedUsageStateControl.IsVisible -and $window.OverallStateControl.IsVisible -and $window.SelectedUsageStateControl.Text -cne $window.OverallStateControl.Text) 'loading usage states are missing, hidden or indistinguishable'
$usageBounds=@()
foreach($usageState in @($window.SelectedUsageStateControl,$window.OverallStateControl)) {
    $usageHost=[Windows.Window]::GetWindow($usageState)
    $origin=$usageState.TransformToAncestor($usageHost).Transform((New-Object Windows.Point 0,0))
    $usageBounds+=@([pscustomobject]@{Left=$origin.X;Right=$origin.X+$usageState.ActualWidth;Width=$usageState.ActualWidth;HostWidth=$usageHost.ActualWidth})
}
Assert (@($usageBounds | Where-Object {$_.Width -le 0 -or $_.Left -lt -1 -or $_.Right -gt $_.HostWidth+1}).Count -eq 0) 'loading usage states are unmeasured or clipped by their own window'
$selectedUsage.state='partial';$selectedUsage.reason='budget_exceeded';$selectedUsage.usage=@{inputTokens=20;outputTokens=6;totalTokens=26}
UsageFixture $usageGeneration $overallUsage $selectedUsage
Assert ($window.MetricControls[2].Text -ceq '26' -and $window.SelectedUsageStateControl.Text -match '已统计部分') 'partial selected usage with valid counts was not labelled'
$selectedUsage.usage=$null
UsageFixture $usageGeneration $overallUsage $selectedUsage
Assert ($window.MetricControls[0].Text -ceq '20' -and $window.MetricControls[1].Text -ceq '6' -and $window.MetricControls[2].Text -ceq '26' -and $window.SelectedUsageStateControl.Text -match '已统计部分' -and $window.SelectedUsageStateControl.Text -match '上次有效数据') 'partial-null selected usage erased a complete validated triple or historical state'
$selectedUsage.state='unavailable';$selectedUsage.reason='snapshot_stale';$selectedUsage.usage=$null
UsageFixture $usageGeneration $overallUsage $selectedUsage
Assert ($window.MetricControls[0].Text -ceq '20' -and $window.MetricControls[2].Text -ceq '26' -and $window.SelectedUsageStateControl.Text -match '快照可能陈旧' -and $window.SelectedUsageStateControl.Text -match '上次有效数据') 'stale selected usage erased validated data or mislabeled its history'
$selectedUsage.state='unavailable';$selectedUsage.reason='task_not_found'
UsageFixture $usageGeneration $overallUsage $selectedUsage
Assert ($window.MetricControls[0].Text -ceq '—' -and $window.SelectedUsageStateControl.Text -match '任务不存在' -and $window.OverallMetricControls[2].Text -ceq '300') 'task-not-found selected block cleared overall usage or lacked its reason'

$badSelected=UsageBlock 'selected_task' 'available' $null @{inputTokens=999;outputTokens=1;totalTokens=1000} $taskBeta
UsageFixture $usageGeneration $overallUsage $badSelected
Assert ($window.MetricControls[0].Text -ceq '—' -and $window.SelectedUsageStateControl.Text -match '当前任务用量不可用' -and $window.OverallMetricControls[2].Text -ceq '300') 'invalid selected task identity did not invalidate selected only'
$validOverall=UsageBlock 'local_all' 'available' $null @{inputTokens=40;outputTokens=2;totalTokens=42} $null
UsageFixture $usageGeneration $validOverall $selectedUsage
$badSelected.taskId=$taskAlpha;$badSelected.usage=@{inputTokens=1;outputTokens=1;totalTokens=3}
UsageFixture $usageGeneration $validOverall $badSelected
Assert ($window.MetricControls[0].Text -ceq '—' -and $window.OverallMetricControls[2].Text -ceq '42') 'selected usage with inconsistent sum was accepted or cleared overall'
$badSelected.usage=@{inputTokens=2;outputTokens=3;totalTokens=5};$badSelected.coverage.pendingFiles=1;$badSelected.coverage.completeFiles=2
UsageFixture $usageGeneration $validOverall $badSelected
Assert ($window.MetricControls[0].Text -ceq '—' -and $window.OverallMetricControls[2].Text -ceq '42') 'selected usage with inconsistent coverage was accepted or cleared overall'
$badSelected.coverage=$coverage
UsageFixture $usageGeneration $validOverall $badSelected 'not-a-timestamp'
Assert ($window.MetricControls[0].Text -ceq '—' -and $window.OverallMetricControls[2].Text -ceq '—') 'invalid usage envelope timestamp was accepted'
UsageFixture $usageGeneration $validOverall $null
Assert ($window.MetricControls[0].Text -ceq '—' -and $window.OverallMetricControls[2].Text -ceq '42' -and $window.SelectedUsageStateControl.Text -match '当前任务用量不可用') 'null selected block cleared overall or kept stale selected values'

# Repeat rejection with a real seed: invalid updates cannot overwrite valid selected data.
$selectedUsage=UsageBlock 'selected_task' 'available' $null @{inputTokens=10;outputTokens=5;totalTokens=15} $taskAlpha
UsageFixture $usageGeneration $validOverall $selectedUsage
foreach($invalidSelected in @(
    (UsageBlock 'selected_task' 'available' $null @{inputTokens=999;outputTokens=1;totalTokens=1000} $taskBeta),
    (UsageBlock 'selected_task' 'available' $null @{inputTokens=1;outputTokens=1;totalTokens=3} $taskAlpha),
    (UsageBlock 'selected_task' 'available' $null @{inputTokens=2;outputTokens=3;totalTokens=5} $taskAlpha)
)) {
    if($invalidSelected.usage.totalTokens -eq 5){$invalidSelected.coverage.pendingFiles=1;$invalidSelected.coverage.completeFiles=2}
    UsageFixture $usageGeneration $validOverall $invalidSelected
    Assert ($window.MetricControls[0].Text -ceq '10' -and $window.MetricControls[1].Text -ceq '5' -and $window.MetricControls[2].Text -ceq '15' -and $window.SelectedUsageStateControl.Text -match '上次有效数据' -and $window.OverallMetricControls[2].Text -ceq '42') 'invalid selected identity/sum/coverage erased seeded data or independent overall'
    Assert ([string]$window.MetricControls[2].ToolTip -ceq '合计 · 15 tokens' -and [Windows.Automation.AutomationProperties]::GetHelpText($window.MetricControls[2]) -match '15 tokens') 'rejected selected update erased exact retained tooltip/accessibility'
}
UsageFixture $usageGeneration $validOverall $selectedUsage 'not-a-timestamp'
Assert ($window.MetricControls[2].Text -ceq '15' -and $window.SelectedUsageStateControl.Text -match '上次有效数据' -and $window.OverallMetricControls[2].Text -ceq '—') 'invalid envelope did not retain selected independently while invalidating overall'
UsageFixture $usageGeneration $validOverall $null
Assert ($window.MetricControls[2].Text -ceq '15' -and $window.SelectedUsageStateControl.Text -match '上次有效数据' -and $window.OverallMetricControls[2].Text -ceq '42') 'null selected block erased validated selected history or independent overall'

$selectedUsage=UsageBlock 'selected_task' 'available' $null @{inputTokens=10;outputTokens=5;totalTokens=15} $taskAlpha
$badOverall=UsageBlock 'local_all' 'available' $null @{inputTokens=1;outputTokens=1;totalTokens=2} $null
UsageFixture $usageGeneration $badOverall $selectedUsage
Assert ($window.OverallMetricControls[2].Text -ceq '2' -and $window.MetricControls[2].Text -ceq '15') 'valid null-reason available blocks were not accepted'
$badOverall.reason=[string]::Empty
$badOverall.usage=@{inputTokens=40;outputTokens=2;totalTokens=42}
UsageFixture $usageGeneration $badOverall $selectedUsage
Assert ($window.OverallMetricControls[2].Text -ceq '—' -and $window.MetricControls[2].Text -ceq '15' -and $window.OverallStateControl.Text -match '用量数据无效') 'empty available reason was accepted or invalid overall cleared selected'
$badOverall.reason='scan_in_progress'
UsageFixture $usageGeneration $badOverall $selectedUsage
Assert ($window.OverallMetricControls[2].Text -ceq '—' -and $window.MetricControls[2].Text -ceq '15') 'listed but semantically invalid available reason was accepted'
$badOverall.reason='not_a_usage_reason'
UsageFixture $usageGeneration $badOverall $selectedUsage
Assert ($window.OverallMetricControls[2].Text -ceq '—' -and $window.MetricControls[2].Text -ceq '15') 'unknown available reason was accepted'
foreach($gap in 'completeFiles','pendingFiles','excludedFiles','failedFiles','conflictingResponses','invalidResponses','legacyOnlyConversations'){$badOverall=UsageBlock 'local_all' 'available' $null @{inputTokens=40;outputTokens=2;totalTokens=42} $null;$badOverall.coverage[$gap]=1;UsageFixture $usageGeneration $badOverall $selectedUsage;Assert ($window.OverallMetricControls[2].Text -ceq '—' -and $window.MetricControls[2].Text -ceq '15') ('available overall accepted non-zero gap '+$gap)}
$badOverall=UsageBlock 'local_all' 'available' $null @{inputTokens=40;outputTokens=2;totalTokens=42} $null;$badOverall.coverage.complete=$false
UsageFixture $usageGeneration $badOverall $selectedUsage
Assert ($window.OverallMetricControls[2].Text -ceq '—' -and $window.MetricControls[2].Text -ceq '15') 'available overall accepted complete=false'
$badOverall=UsageBlock 'local_all' 'available' $null @{inputTokens=40;outputTokens=2;totalTokens=42} $null;$badOverall.coverage.responsesCounted=0
UsageFixture $usageGeneration $badOverall $selectedUsage
Assert ($window.OverallMetricControls[2].Text -ceq '—' -and $window.MetricControls[2].Text -ceq '15') 'available overall accepted zero counted responses'
$duplicateOverall=UsageBlock 'local_all' 'available' $null @{inputTokens=40;outputTokens=2;totalTokens=42} $null;$duplicateOverall.coverage.duplicateResponses=2
UsageFixture $usageGeneration $duplicateOverall $selectedUsage
Assert ($window.OverallMetricControls[2].Text -ceq '42' -and $window.OverallStateControl.ToolTip -match '重复响应 2') 'valid duplicated responses were rejected or omitted from coverage detail'
foreach($badState in 'loading','unavailable'){$badOverall=UsageBlock 'local_all' $badState 'scan_in_progress' @{inputTokens=40;outputTokens=2;totalTokens=42} $null;UsageFixture $usageGeneration $badOverall $selectedUsage;Assert ($window.OverallMetricControls[2].Text -ceq '—') ('raw usage was accepted for '+$badState)}
foreach($partialUsage in @($null,@{inputTokens=3;outputTokens=2;totalTokens=5})){$badOverall=UsageBlock 'local_all' 'partial' 'scan_in_progress' $partialUsage $null;UsageFixture $usageGeneration $badOverall $selectedUsage;if($null -eq $partialUsage){Assert ($window.OverallMetricControls[0].Text -ceq '—' -and $window.OverallMetricControls[2].Text -ceq '—') 'partial null usage was not shown as dashed'}else{Assert ($window.OverallMetricControls[0].Text -ceq '3' -and $window.OverallMetricControls[2].Text -ceq '5') 'partial triple was not shown'};Assert ($window.OverallStateControl.Text -match '已统计部分') 'partial state was hidden'}
$zeroCoverageOverall=UsageBlock 'local_all' 'partial' 'scan_in_progress' $null $null
$zeroCoverageOverall.coverage.complete=$false;$zeroCoverageOverall.coverage.completeFiles=0;$zeroCoverageOverall.coverage.pendingFiles=3
$zeroCoverageOverall.coverage.responsesCounted=0;$zeroCoverageOverall.coverage.conversationsCounted=0;$zeroCoverageOverall.coverage.subagentThreadsCounted=0
UsageFixture $usageGeneration $zeroCoverageOverall $selectedUsage
Assert ($window.OverallMetricControls[2].Text -ceq '—' -and $window.OverallStateControl.Text -match '已统计部分' -and $window.OverallStateControl.Text -match '正在扫描' -and $window.OverallStateControl.Text -match '暂无可汇总记录' -and $window.OverallStateControl.Text -notmatch '全部日志不支持|所有日志不支持|全库不支持') 'partial zero-response scan claimed complete library incompatibility or retained an overall total'
$zeroCoverageOverall.coverage.nativeIncrementsCounted=1
UsageFixture $usageGeneration $zeroCoverageOverall $selectedUsage
Assert ($window.OverallStateControl.Text -notmatch '暂无可汇总记录' -and $window.OverallStateControl.ToolTip -match '旧版增量 1 段' -and $window.OverallMetricControls[2].Text -ceq '—') 'observed native increment was treated as empty coverage or fabricated known usage'
$selectedUsage=UsageBlock 'selected_task' 'available' $null @{inputTokens=50;outputTokens=5;totalTokens=55} $taskAlpha
UsageFixture $usageGeneration $validOverall $selectedUsage
Assert ($window.OverallMetricControls[2].Text -ceq '42' -and $window.MetricControls[2].Text -ceq '55') 'valid selected usage did not survive with an independent overall block'

$staleGeneration=$usageGeneration
$window.FixtureUsage($staleGeneration-1,$null,([CodexNative.WidgetClient]::Serialize(@{sampledAt=$usageStamped;overall=$overallUsage;selected=(UsageBlock 'selected_task' 'available' $null @{inputTokens=1;outputTokens=1;totalTokens=2} $taskAlpha)})))
Assert ($window.MetricControls[2].Text -ceq '55' -and $window.OverallMetricControls[2].Text -ceq '42') 'stale RequestGeneration overwrote current usage'

$window.TaskControl.SelectedValue=$taskBeta
$newGeneration=$window.UsageGeneration
Assert ($newGeneration -gt $staleGeneration -and $window.MetricControls[0].Text -ceq '—' -and $window.OverallMetricControls[2].Text -ceq '42') 'task switch did not invalidate rotated selected usage while retaining overall'
$selectedBeta=UsageBlock 'selected_task' 'available' $null @{inputTokens=5;outputTokens=5;totalTokens=10} $taskBeta
UsageFixture $newGeneration $validOverall $selectedBeta
Assert ($window.MetricControls[2].Text -ceq '10' -and $window.OverallMetricControls[2].Text -ceq '42') 'new task usage did not replace the rotated selection'
$window.TaskControl.SelectedValue=$taskAlpha
Assert ($window.UsageGeneration -gt $newGeneration) 'returning to the first task did not start a new usage generation'

$usagePendingField=$window.GetType().GetField('usagePending',$allFields)
$usageInFlightField=$window.GetType().GetField('usageInFlight',$allFields)
$requestUsage=$window.GetType().GetMethod('RequestUsage',$allFields)
$usageInFlightField.SetValue($window,$true)
$null=$requestUsage.Invoke($window,@($false))
Assert ($window.UsagePending -and $window.UsageInFlight) 'pending request while one is in flight was not coalesced'
$usagePendingField.SetValue($window,$false)
$usageInFlightField.SetValue($window,$false)
$window.FixtureUsage($window.UsageGeneration,'task_not_found',$null)
Assert (-not $window.UsagePending -and -not $window.UsageInFlight -and $window.SelectedUsageStateControl.Text -match '任务不存在' -and $window.OverallMetricControls[2].Text -ceq '42') 'task_not_found usage error cleared overall or retained pending work'

$window.FixtureUsage($window.UsageGeneration,'not_found',$null)
Assert ($window.OverallMetricControls[0].Text -ceq '—' -and $window.MetricControls[0].Text -ceq '—' -and $window.OverallStateControl.Text -match 'Codex 总用量不可用') 'usage 404 fallback did not mark local totals unavailable'
$window.FixtureTaskTelemetry($window.TaskGeneration,$null,([CodexNative.WidgetClient]::Serialize($legacy)))
Assert ($window.MetricControls[2].Text -ceq '15' -and $window.MetricControls[0].ToolTip -ceq '输入 · 7 tokens') 'usage 404 fallback did not restore legacy session telemetry'

# Response sampling order and validated usage log time are independent clocks.
$watermarkDataAt='2026-10-16T09:00:01.000Z'
$watermarkSeedSample='2026-10-16T09:00:02.000Z'
$watermarkWaitingSample='2026-10-16T09:00:03.000Z'
$watermarkAvailableSample='2026-10-16T09:00:04.000Z'
$watermarkFuture='2026-10-16T09:10:00.000Z'
ResetTelemetryFixture $window $taskAlpha
$watermarkGeneration=$window.UsageGeneration
$initialLoading=UsageBlock 'selected_task' 'loading' 'scan_in_progress' $null $taskAlpha
$initialLoading.updatedAt=$null
foreach($key in @($initialLoading.coverage.Keys)){$initialLoading.coverage[$key]=0}
$initialLoading.coverage.complete=$false
UsageFixture $watermarkGeneration $validOverall $initialLoading $watermarkWaitingSample
Assert ($window.MetricControls[0].Text -ceq '—' -and $window.MetricControls[1].Text -ceq '—' -and $window.MetricControls[2].Text -ceq '—' -and $window.SelectedUsageStateControl.Text -match '正在统计') 'initial null-time loading response did not render its real backend state'
$watermarkAvailable=UsageBlock 'selected_task' 'available' $null @{inputTokens=21;outputTokens=3;totalTokens=24} $taskAlpha
$watermarkAvailable.updatedAt=$watermarkDataAt
UsageFixture $watermarkGeneration $validOverall $watermarkAvailable $watermarkAvailableSample
Assert ($window.MetricControls[0].Text -ceq '21' -and $window.MetricControls[1].Text -ceq '3' -and $window.MetricControls[2].Text -ceq '24' -and $window.SelectedUsageStateControl.Text -match '已核实' -and $window.SelectedUsageStateControl.Text -notmatch '上次有效数据') 'initial null-time loading sample blocked older-log available usage in a newer response'
$lateEnvelope=$watermarkAvailable.Clone();$lateEnvelope.updatedAt=$watermarkSeedSample;$lateEnvelope.usage=@{inputTokens=90;outputTokens=9;totalTokens=99}
UsageFixture $watermarkGeneration $validOverall $lateEnvelope $watermarkWaitingSample
Assert ($window.MetricControls[0].Text -ceq '21' -and $window.MetricControls[1].Text -ceq '3' -and $window.MetricControls[2].Text -ceq '24') 'older response envelope overwrote current selected data using its newer log timestamp'

ResetTelemetryFixture $window $taskAlpha
$watermarkGeneration=$window.UsageGeneration
$watermarkSeed=UsageBlock 'selected_task' 'available' $null @{inputTokens=10;outputTokens=5;totalTokens=15} $taskAlpha
$watermarkSeed.updatedAt=$watermarkDataAt
UsageFixture $watermarkGeneration $validOverall $watermarkSeed $watermarkSeedSample
Assert ($window.MetricControls[0].Text -ceq '10' -and $window.MetricControls[1].Text -ceq '5' -and $window.MetricControls[2].Text -ceq '15') 'stale-null recovery fixture did not establish its selected seed'
$nullTimeStale=UsageBlock 'selected_task' 'unavailable' 'snapshot_stale' $null $taskAlpha
$nullTimeStale.updatedAt=$null
UsageFixture $watermarkGeneration $validOverall $nullTimeStale $watermarkWaitingSample
Assert ($window.MetricControls[0].Text -ceq '10' -and $window.MetricControls[1].Text -ceq '5' -and $window.MetricControls[2].Text -ceq '15' -and $window.SelectedUsageStateControl.Text -match '快照可能陈旧' -and $window.SelectedUsageStateControl.Text -match '上次有效数据') 'null-time stale response erased validated selected history or hid its health state'
$watermarkSeed.usage=@{inputTokens=30;outputTokens=6;totalTokens=36}
UsageFixture $watermarkGeneration $validOverall $watermarkSeed $watermarkAvailableSample
Assert ($window.MetricControls[0].Text -ceq '30' -and $window.MetricControls[1].Text -ceq '6' -and $window.MetricControls[2].Text -ceq '36' -and $window.SelectedUsageStateControl.Text -match '已核实' -and $window.SelectedUsageStateControl.Text -notmatch '上次有效数据') 'newer available response could not recover from null-time stale state at the unchanged valid log time'

# Rejected future-dated payloads cannot poison admission of the next normal response.
foreach($poisonSeeded in $false,$true){
    foreach($poisonKind in 'wrong_identity','invalid_shape','invalid_counts'){
        ResetTelemetryFixture $window $taskAlpha
        $watermarkGeneration=$window.UsageGeneration
        if($poisonSeeded){
            $poisonSeed=UsageBlock 'selected_task' 'available' $null @{inputTokens=10;outputTokens=5;totalTokens=15} $taskAlpha
            $poisonSeed.updatedAt=$watermarkDataAt
            UsageFixture $watermarkGeneration $validOverall $poisonSeed $watermarkSeedSample
            Assert ($window.MetricControls[0].Text -ceq '10' -and $window.MetricControls[1].Text -ceq '5' -and $window.MetricControls[2].Text -ceq '15') ('future timestamp fixture did not establish its seed: '+$poisonKind)
        }
        $poisonBlock=UsageBlock 'selected_task' 'available' $null @{inputTokens=900;outputTokens=90;totalTokens=990} $taskAlpha
        $poisonBlock.updatedAt=$watermarkFuture
        switch($poisonKind){
            'wrong_identity' {$poisonBlock.taskId=$taskBeta}
            'invalid_shape' {$poisonBlock.coverage.completeFiles=2}
            'invalid_counts' {$poisonBlock.usage=@{inputTokens=1;outputTokens=1;totalTokens=3}}
        }
        UsageFixture $watermarkGeneration $validOverall $poisonBlock $watermarkFuture
        if($poisonSeeded){
            Assert ($window.MetricControls[0].Text -ceq '10' -and $window.MetricControls[1].Text -ceq '5' -and $window.MetricControls[2].Text -ceq '15' -and $window.SelectedUsageStateControl.Text -match '上次有效数据') ('rejected future selected payload erased its validated seed: '+$poisonKind)
        }else{
            Assert ($window.MetricControls[0].Text -ceq '—' -and $window.MetricControls[1].Text -ceq '—' -and $window.MetricControls[2].Text -ceq '—') ('fresh rejected future selected payload supplied a triple: '+$poisonKind)
        }
        $afterPoison=UsageBlock 'selected_task' 'available' $null @{inputTokens=21;outputTokens=3;totalTokens=24} $taskAlpha
        $afterPoison.updatedAt=$watermarkSeedSample
        UsageFixture $watermarkGeneration $validOverall $afterPoison $watermarkAvailableSample
        Assert ($window.MetricControls[0].Text -ceq '21' -and $window.MetricControls[1].Text -ceq '3' -and $window.MetricControls[2].Text -ceq '24' -and $window.SelectedUsageStateControl.Text -match '已核实' -and $window.SelectedUsageStateControl.Text -notmatch '上次有效数据' -and $window.OverallMetricControls[2].Text -ceq '42') ('rejected future payload poisoned valid response admission: '+$poisonKind+' seeded='+$poisonSeeded)
    }
}
$ownedUsageAtClose=$window.UsageWindow
$usageViewportAtClose=$window.GetType().GetField('usageWindowViewport',$flags).GetValue($window)
Assert ($null -ne $ownedUsageAtClose -and $ownedUsageAtClose.IsVisible) 'usage fixture did not keep its independent window open for owner-close regression'
$window.Close()
Assert ($null -eq $window.UsageWindow -and -not $ownedUsageAtClose.IsVisible -and $null -eq $usageViewportAtClose.Content) 'main window close left an owned usage window or its content mounted'
$window.OpenUsage()
Assert ($null -eq $window.UsageWindow) 'closing the main owner allowed a new usage window to open'

# Live snapshots have their own identity, source clock and selection generation. Log fixtures
# remain intentionally different so any cross-channel overwrite changes an exact assertion.
function LiveSample([string]$id=$taskBeta,[string]$scope='conversation'){
 return @{sampledAt='2026-10-18T09:00:10.000Z';state='available';source='codex_app_server';reason=$null;observedAt='2026-10-18T09:00:05.000Z';session=@{id=$id};usage=@{scope=$scope;includesSubagents=$false;inputTokens=40;outputTokens=2;totalTokens=42};model='example-provider/gpt-6.1-sol';reasoningEffort='ultra';lifecycle=@{state='running';startedAt='2026-10-18T09:00:00.000Z';completedAt=$null;elapsedSeconds=5};speed=@{source='confirmed_request';outputTokensPerSecond=2;observedAt='2026-10-18T09:00:05.000Z'}}
}
function ObservedLiveSample {
 $sample=LiveSample
 $sample.speed=@{source='observed_window';outputTokensPerSecond=1;outputTokens=2;elapsedSeconds=2;startedAt='2026-10-18T09:00:03.000Z';observedAt='2026-10-18T09:00:05.000Z';includesToolsAndWait=$true}
 return $sample
}
function ApplyLiveFixture($sample){$liveWindow.FixtureLive($true,$liveWindow.TaskGeneration,$null,([CodexNative.WidgetClient]::Serialize($sample)))}
$liveWindow=New-Object CodexNative.WidgetWindow $true;$fixtureWindows.Add($liveWindow)
$liveSpeedCaption=$liveWindow.GetType().GetField('speedCaption',$allFields).GetValue($liveWindow)
$liveWindow.FixtureLive($true,$liveWindow.TaskGeneration,'disconnected',$null)
$liveWindow.FixtureTasks($tasksJson)
$liveSample=LiveSample
ApplyLiveFixture $liveSample
Assert ($liveWindow.SelectedTask -ceq $taskAlpha -and -not $liveWindow.PinnedTask -and $liveWindow.MetricControls[2].Text -ceq '42' -and $liveWindow.SelectedUsageCaptionControl.Text -match '活动对话.*22222222.*会话累计') 'live identity borrowed the latest historical task or omitted confirmed scope'
Assert ($liveWindow.ContextText -ceq '执行模型 · example-provider/gpt-6.1-sol' -and $liveWindow.EffortText -match 'ultra' -and $liveWindow.MetricControls[3].Text -ceq '2.0' -and $liveWindow.MetricControls[3].ToolTip -match '已确认请求' -and $liveSpeedCaption.Text -ceq '请求均速 token/s') 'live execution evidence or confirmed request speed did not render'
Assert ($liveWindow.SelectedUsageCaptionControl.ToolTip -match '输入含缓存与多次请求的重复输入' -and $liveWindow.SelectedUsageCaptionControl.ToolTip -match '先前基线' -and $liveWindow.SelectedUsageCaptionControl.ToolTip -match '不等于本机扫描的已核实历史合计' -and $liveWindow.SelectedUsageCaptionControl.ToolTip -match '上下文占用或账户账单') 'live conversation cumulative tooltip omitted its accounting limits or unknown prior baseline'
$gatewayLive=LiveSample;$gatewayLive.source='magpie_gateway';$gatewayLive.usage.includesSubagents=$true;$gatewayLive.lifecycle.state='completed';$gatewayLive.lifecycle.completedAt=$gatewayLive.observedAt
ApplyLiveFixture $gatewayLive
Assert ($liveWindow.SelectedUsageStateControl.Text -match 'Magpie.*已完成' -and $liveWindow.SelectedUsageCaptionControl.ToolTip -match '包含已核实代理' -and $liveWindow.MetricControls[2].Text -ceq '42') 'confirmed gateway lifecycle or subagent scope did not render'
ApplyLiveFixture (LiveSample)
$liveOverall=UsageBlock 'local_all' 'available' $null @{inputTokens=100;outputTokens=200;totalTokens=300} $null
$liveSelected=UsageBlock 'selected_task' 'available' $null @{inputTokens=900;outputTokens=99;totalTokens=999} $taskAlpha
$liveWindow.FixtureUsage($liveWindow.UsageGeneration,$null,([CodexNative.WidgetClient]::Serialize(@{sampledAt=$usageStamped;overall=$liveOverall;selected=$liveSelected})))
Assert ($liveWindow.OverallMetricControls[2].Text -ceq '300' -and $liveWindow.MetricControls[2].Text -ceq '42') 'historical selected usage overwrote live usage or overall did not update independently'
foreach($legacyError in @($null,'task_not_found','disconnected')){
 $liveWindow.FixtureTaskTelemetry($liveWindow.TaskGeneration,$legacyError,$normalJson)
 Assert ($liveWindow.MetricControls[2].Text -ceq '42' -and $liveWindow.MetricControls[3].Text -ceq '2.0' -and $liveWindow.ContextText -ceq '执行模型 · example-provider/gpt-6.1-sol') 'historical telemetry success/error overwrote live evidence'
}
$liveWindow.FixtureError('tasks','not_found',$liveWindow.TaskGeneration)
Assert (-not $liveWindow.TasksSupported -and $liveWindow.MetricControls[2].Text -ceq '42' -and $liveWindow.TaskFlagsText -match '实时对话独立观测') 'missing historical task route erased live evidence'
$liveWindow.FixtureTasks($tasksJson)
foreach($usageError in 'not_found','disconnected','task_not_found'){
 $liveWindow.FixtureUsage($liveWindow.UsageGeneration,$usageError,$null)
 Assert ($liveWindow.MetricControls[2].Text -ceq '42' -and $liveWindow.ContextText -ceq '执行模型 · example-provider/gpt-6.1-sol' -and $liveWindow.OverallMetricControls[2].Text -ceq '—') 'usage-only failure erased or replaced live evidence'
}
foreach($scope in 'turn','request','conversation'){
 $scopeSample=LiveSample $taskBeta $scope;ApplyLiveFixture $scopeSample
 $expectedScope=@{turn='本回合（已确认）';request='本次请求（已确认）';conversation='会话累计'}[$scope]
 Assert ($liveWindow.SelectedUsageCaptionControl.Text.Contains($expectedScope) -and $liveWindow.MetricControls[2].ToolTip -ceq '合计 · 42 tokens') ('live scope mislabeled: '+$scope)
}
$unknownLive=LiveSample;$unknownLive.usage=$null;$unknownLive.model=$null;$unknownLive.reasoningEffort=$null;$unknownLive.speed=$null
ApplyLiveFixture $unknownLive
Assert ($liveWindow.MetricsVisible -and $liveWindow.MetricControls[2].Text -ceq '—' -and $null -eq $liveWindow.MetricControls[2].ToolTip -and $liveWindow.SelectedUsageStateControl.Text -match '等待已确认用量' -and $liveWindow.ContextText -ceq '执行模型 · 未确认' -and $liveWindow.EffortText -ceq '推理强度 · 未确认' -and $liveWindow.MetricControls[3].Text -ceq '—') 'unknown live values were zero-filled or borrowed configured/log values'
$zeroLive=LiveSample;$zeroLive.usage.inputTokens=0;$zeroLive.usage.outputTokens=0;$zeroLive.usage.totalTokens=0;$zeroLive.speed.outputTokensPerSecond=0
ApplyLiveFixture $zeroLive
Assert ($liveWindow.MetricControls[0].Text -ceq '0' -and $liveWindow.MetricControls[1].Text -ceq '0' -and $liveWindow.MetricControls[2].Text -ceq '0' -and $liveWindow.MetricControls[3].Text -ceq '0') 'confirmed zero was confused with unknown live usage'
$observedLive=ObservedLiveSample
ApplyLiveFixture $observedLive
Assert ($liveWindow.MetricControls[2].Text -ceq '42' -and $liveWindow.MetricControls[3].Text -ceq '1.0' -and $liveSpeedCaption.Text -ceq '观测均速 ≈ token/s') 'observed cumulative-delta speed did not render as an estimate'
$observedSpeedTip=[string]$liveWindow.MetricControls[3].ToolTip
Assert ($observedSpeedTip -match '已确认累计输出差量 / 观测时间' -and $observedSpeedTip -match '估算，包含工具、等待和用量上报延迟' -and $observedSpeedTip -match '不代表模型逐token流速' -and $observedSpeedTip -match '输出差量 2 tokens' -and $observedSpeedTip -match '观测时间 2 s' -and $observedSpeedTip -match '2026-10-18T09:00:03.000Z' -and $observedSpeedTip -match '2026-10-18T09:00:05.000Z' -and [Windows.Automation.AutomationProperties]::GetHelpText($liveWindow.MetricControls[3]) -ceq $observedSpeedTip -and [string]$liveSpeedCaption.ToolTip -ceq $observedSpeedTip) 'observed speed lost exact numerator, denominator, source clocks or accessible estimation limits'
$noSpeedLive=LiveSample;$noSpeedLive.speed=$null
ApplyLiveFixture $noSpeedLive
Assert ($liveWindow.MetricControls[2].Text -ceq '42' -and $liveWindow.MetricControls[3].Text -ceq '—' -and $liveSpeedCaption.Text -ceq '观测均速 · 待采样' -and $liveWindow.MetricControls[3].ToolTip -match '同一对话至少两次有效计数更新' -and $liveWindow.MetricControls[3].ToolTip -match '断连、无更新或计数回退会清除' -and $liveWindow.MetricControls[3].ToolTip -notmatch '输出差量 2 tokens') 'null speed retained a previous rate, denominator or misleading request caption'
$observedZero=ObservedLiveSample;$observedZero.usage.inputTokens=0;$observedZero.usage.outputTokens=0;$observedZero.usage.totalTokens=0;$observedZero.speed.outputTokens=0;$observedZero.speed.outputTokensPerSecond=0
ApplyLiveFixture $observedZero
Assert ($liveWindow.MetricControls[3].Text -ceq '0' -and $liveSpeedCaption.Text -ceq '观测均速 ≈ token/s') 'valid zero observed delta was treated as unknown'
$observedTolerance=ObservedLiveSample;$observedTolerance.speed.elapsedSeconds=2.001;$observedTolerance.speed.outputTokensPerSecond=2/2.001
ApplyLiveFixture $observedTolerance
Assert ($liveWindow.MetricControls[2].Text -ceq '42' -and $liveWindow.MetricControls[3].Text -ceq '1.0') 'observed duration rejected the allowed one-millisecond clock tolerance'
$observedTtlBoundary=ObservedLiveSample;$observedTtlBoundary.speed.startedAt='2026-10-18T08:59:08.000Z';$observedTtlBoundary.speed.observedAt='2026-10-18T08:59:10.000Z'
ApplyLiveFixture $observedTtlBoundary
Assert ($liveWindow.MetricControls[3].Text -ceq '1.0') 'observed speed expired at the inclusive sixty-second freshness boundary'
$badObservedCases=@('denominator-zero','denominator-short','denominator-long','denominator-string','duration-mismatch','rate-mismatch','negative-output','fractional-output','unsafe-output','string-output','excess-output','started-after-observation','started-invalid','non-utc-start','speed-after-source','speed-after-poll','expired','missing-usage','wrong-scope','includes-wait-false','includes-wait-string')
foreach($fault in $badObservedCases){
 $badObserved=ObservedLiveSample
 switch($fault){
  'denominator-zero' {$badObserved.speed.elapsedSeconds=0}
  'denominator-short' {$badObserved.speed.elapsedSeconds=0.5;$badObserved.speed.startedAt='2026-10-18T09:00:04.500Z';$badObserved.speed.outputTokensPerSecond=4}
  'denominator-long' {$badObserved.speed.elapsedSeconds=120.001;$badObserved.speed.startedAt='2026-10-18T08:58:04.999Z';$badObserved.speed.outputTokensPerSecond=2/120.001}
  'denominator-string' {$badObserved.speed.elapsedSeconds='2'}
  'duration-mismatch' {$badObserved.speed.elapsedSeconds=2.002;$badObserved.speed.outputTokensPerSecond=2/2.002}
  'rate-mismatch' {$badObserved.speed.outputTokensPerSecond=1.1}
  'negative-output' {$badObserved.speed.outputTokens=-1;$badObserved.speed.outputTokensPerSecond=0}
  'fractional-output' {$badObserved.speed.outputTokens=1.5;$badObserved.speed.outputTokensPerSecond=0.75}
  'unsafe-output' {$badObserved.speed.outputTokens=9007199254740992;$badObserved.speed.outputTokensPerSecond=4503599627370496}
  'string-output' {$badObserved.speed.outputTokens='2'}
  'excess-output' {$badObserved.speed.outputTokens=3;$badObserved.speed.outputTokensPerSecond=1.5}
  'started-after-observation' {$badObserved.speed.startedAt='2026-10-18T09:00:06.000Z'}
  'started-invalid' {$badObserved.speed.startedAt='invalid'}
  'non-utc-start' {$badObserved.speed.startedAt='2026-10-18T17:00:03.000+08:00'}
  'speed-after-source' {$badObserved.speed.startedAt='2026-10-18T09:00:04.000Z';$badObserved.speed.observedAt='2026-10-18T09:00:06.000Z'}
  'speed-after-poll' {$badObserved.observedAt='2026-10-18T09:00:11.000Z';$badObserved.speed.startedAt='2026-10-18T09:00:09.000Z';$badObserved.speed.observedAt=$badObserved.observedAt}
  'expired' {$badObserved.speed.startedAt='2026-10-18T08:59:07.999Z';$badObserved.speed.observedAt='2026-10-18T08:59:09.999Z'}
  'missing-usage' {$badObserved.usage=$null}
  'wrong-scope' {$badObserved.usage.scope='request'}
  'includes-wait-false' {$badObserved.speed.includesToolsAndWait=$false}
  'includes-wait-string' {$badObserved.speed.includesToolsAndWait='true'}
 }
 ApplyLiveFixture $badObserved
 Assert ($liveWindow.MetricControls[2].Text -ceq '—' -and $liveWindow.MetricControls[3].Text -ceq '—' -and $liveWindow.SelectedUsageStateControl.Text -match '实时数据无效' -and $liveSpeedCaption.Text -ceq '观测均速 · 待采样') ('invalid observed speed was displayed or retained: '+$fault)
 ApplyLiveFixture (ObservedLiveSample)
 Assert ($liveWindow.MetricControls[2].Text -ceq '42' -and $liveWindow.MetricControls[3].Text -ceq '1.0') ('valid observed speed could not recover: '+$fault)
}
ApplyLiveFixture (LiveSample)
Assert ($liveWindow.MetricControls[3].Text -ceq '2.0' -and $liveSpeedCaption.Text -ceq '请求均速 token/s' -and $liveWindow.MetricControls[3].ToolTip -match '已确认请求') 'confirmed request speed compatibility failed after observed-window samples'
$badLiveCases=@('source','source-none','scope','identity','identity-newline','sum','negative','unsafe-integer','string-count','agents','model','configured-model','effort','configured-effort','speed-source','speed-future','speed-negative','lifecycle','lifecycle-time','reason','observedAt','sampledAt')
foreach($fault in $badLiveCases){
 $badLive=LiveSample
 switch($fault){
  'source' {$badLive.source='rollout_log'}
  'source-none' {$badLive.source='none'}
  'scope' {$badLive.usage.scope='selected_task'}
  'identity' {$badLive.session=$null}
  'identity-newline' {$badLive.session.id=$taskBeta+"`n"}
  'sum' {$badLive.usage.totalTokens=43}
  'negative' {$badLive.usage.inputTokens=-1}
  'unsafe-integer' {$badLive.usage.inputTokens=9007199254740992;$badLive.usage.outputTokens=0;$badLive.usage.totalTokens=9007199254740992}
  'string-count' {$badLive.usage.totalTokens='42'}
  'agents' {$badLive.usage.includesSubagents='false'}
  'model' {$badLive.model='private model diagnostics'}
  'configured-model' {$badLive.model='configured'}
  'effort' {$badLive.reasoningEffort='highest'}
  'configured-effort' {$badLive.reasoningEffort='configured'}
  'speed-source' {$badLive.speed.source='completed_turn'}
  'speed-future' {$badLive.speed.observedAt='2026-10-18T09:00:06.000Z'}
  'speed-negative' {$badLive.speed.outputTokensPerSecond=-1}
  'lifecycle' {$badLive.lifecycle.state='in_progress'}
  'lifecycle-time' {$badLive.lifecycle.completedAt='2026-10-18T08:59:59.000Z'}
  'reason' {$badLive.reason='private diagnostic text'}
  'observedAt' {$badLive.observedAt='invalid'}
  'sampledAt' {$badLive.sampledAt='invalid'}
 }
 ApplyLiveFixture $badLive
 Assert ($liveWindow.MetricControls[2].Text -ceq '—' -and $liveWindow.MetricControls[3].Text -ceq '—' -and $liveWindow.SelectedUsageStateControl.Text -match '实时数据无效' -and $liveWindow.ContextText -ceq '执行模型 · 未确认') ('invalid live payload was displayed or retained exact values: '+$fault)
 ApplyLiveFixture (LiveSample)
 Assert ($liveWindow.MetricControls[2].Text -ceq '42') ('valid live recovery failed: '+$fault)
}
$liveSourceTip=$liveWindow.SelectedUsageCaptionControl.ToolTip
$pollOnly=LiveSample;$pollOnly.sampledAt='2026-10-18T09:00:20.000Z';ApplyLiveFixture $pollOnly
Assert ($liveWindow.SelectedUsageCaptionControl.ToolTip -ceq $liveSourceTip) 'poll sampledAt refreshed the source observedAt label'
$olderPoll=LiveSample;$olderPoll.sampledAt='2026-10-18T09:00:19.000Z';$olderPoll.usage.totalTokens=999
ApplyLiveFixture $olderPoll
Assert ($liveWindow.MetricControls[2].Text -ceq '42') 'late malformed sampled response cleared newer live evidence'
$olderSource=LiveSample;$olderSource.sampledAt='2026-10-18T09:00:21.000Z';$olderSource.observedAt='2026-10-18T09:00:04.000Z';$olderSource.speed=$null;$olderSource.usage=@{scope='conversation';includesSubagents=$false;inputTokens=1;outputTokens=1;totalTokens=2}
ApplyLiveFixture $olderSource
Assert ($liveWindow.MetricControls[2].Text -ceq '42' -and $liveWindow.SelectedUsageCaptionControl.ToolTip -ceq $liveSourceTip) 'new poll timestamp replaced newer source observations with an older source sample'
foreach($liveState in 'waiting','unavailable','disconnected','ambiguous'){
 $stateLive=LiveSample;$stateLive.sampledAt='2026-10-18T09:00:22.000Z';$stateLive.state=$liveState;$stateLive.session=$null;$stateLive.observedAt=$null;$stateLive.usage=$null;$stateLive.model=$null;$stateLive.reasoningEffort=$null;$stateLive.lifecycle=$null;$stateLive.speed=$null
 $stateLive.reason=@{waiting='identity_unverified';unavailable='source_unavailable';disconnected='source_disconnected';ambiguous='multiple_active_threads'}[$liveState]
 ApplyLiveFixture $stateLive
 Assert ($liveWindow.MetricControls[2].Text -ceq '—' -and $liveWindow.MetricControls[3].Text -ceq '—' -and $liveWindow.ContextText -ceq '执行模型 · 未确认') ('nonavailable live state retained old evidence: '+$liveState)
 if($liveState -eq 'ambiguous'){Assert ($liveWindow.SelectedUsageStateControl.Text -match '多个活动主对话') 'ambiguous source was presented as a selected active conversation'}
}
$oldAfterGap=LiveSample;$oldAfterGap.sampledAt='2026-10-18T09:00:23.000Z';$oldAfterGap.observedAt='2026-10-18T09:00:04.000Z';$oldAfterGap.speed=$null
ApplyLiveFixture $oldAfterGap
Assert ($liveWindow.MetricControls[2].Text -ceq '—') 'unavailable gap reset the source observation watermark'
$freshLive=LiveSample;$freshLive.sampledAt='2026-10-18T09:00:24.000Z';ApplyLiveFixture $freshLive
$followGeneration=$liveWindow.TaskGeneration
Click $liveWindow.TaskPinControl
Assert ($liveWindow.PinnedTask -and $liveWindow.SelectedTask -ceq $taskAlpha -and $liveWindow.TaskGeneration -gt $followGeneration -and $liveWindow.MetricControls[2].Text -ceq '—') 'follow-to-pin of the same selected id did not clear live values and advance selection generation'
$liveWindow.FixtureLive($true,$followGeneration,$null,([CodexNative.WidgetClient]::Serialize($freshLive)))
$liveWindow.FixtureLive($true,$followGeneration,'disconnected',$null)
Assert ($liveWindow.MetricControls[2].Text -ceq '—') 'old unqueried follow response/error crossed the pin boundary'
ApplyLiveFixture (LiveSample)
Assert ($liveWindow.MetricControls[2].Text -ceq '—' -and $liveWindow.SelectedUsageStateControl.Text -match '实时数据无效') 'pinned identity mismatch was accepted'
ApplyLiveFixture (LiveSample $taskAlpha)
Assert ($liveWindow.MetricControls[2].Text -ceq '42' -and $liveWindow.SelectedUsageCaptionControl.Text -match '已固定对话.*11111111') 'pin did not target the selected historical task'
$pinGeneration=$liveWindow.TaskGeneration
Click $liveWindow.TaskPinControl
Assert (-not $liveWindow.PinnedTask -and $liveWindow.SelectedTask -ceq $taskAlpha -and $liveWindow.TaskGeneration -gt $pinGeneration -and $liveWindow.MetricControls[2].Text -ceq '—') 'pin-to-follow of the same id did not clear live values and advance selection generation'
$liveWindow.FixtureLive($true,$pinGeneration,$null,([CodexNative.WidgetClient]::Serialize((LiveSample $taskAlpha))))
$liveWindow.FixtureLive($true,$pinGeneration,'disconnected',$null)
Assert ($liveWindow.MetricControls[2].Text -ceq '—') 'late pinned success/error crossed the follow boundary'
ApplyLiveFixture (LiveSample)
$liveWindow.FixtureTasks($tasksJson.Replace($taskAlpha,'33333333-3333-4333-8333-333333333333'))
Assert ($liveWindow.SelectedTask -ceq '33333333-3333-4333-8333-333333333333' -and -not $liveWindow.PinnedTask -and $liveWindow.MetricControls[2].Text -ceq '42' -and $liveWindow.SelectedUsageCaptionControl.Text -match '22222222') 'historical task refresh changed the followed live identity or erased its snapshot'
$liveWindow.TaskControl.SelectedValue=$taskBeta
Assert ($liveWindow.PinnedTask -and $liveWindow.SelectedTask -ceq $taskBeta -and $liveWindow.MetricControls[2].Text -ceq '—') 'manual dropdown selection did not pin and invalidate live snapshot'
ApplyLiveFixture (LiveSample)
$liveClient=$liveWindow.GetType().GetField('client',$allFields).GetValue($liveWindow)
$liveApply=$liveWindow.GetType().GetMethod('Apply',$allFields)
$oldLiveGeneration=$liveClient.ServiceGeneration
$staleLive=New-Object CodexNative.ClientEvent;$staleLive.Kind='live';$staleLive.Generation=$oldLiveGeneration;$staleLive.SelectionGeneration=$liveWindow.TaskGeneration;$staleLive.Data=[CodexNative.WidgetClient]::Json(([CodexNative.WidgetClient]::Serialize((LiveSample))))
$liveWindow.FixtureUsage($liveWindow.UsageGeneration,$null,([CodexNative.WidgetClient]::Serialize(@{sampledAt=$usageStamped;overall=$liveOverall;selected=$liveSelected})))
$liveClient.GetType().GetField('generation',$flags).SetValue($liveClient,$oldLiveGeneration+1)
$null=$liveWindow.GetType().GetMethod('RefreshUsageService',$flags).Invoke($liveWindow,$null)
Assert ($liveWindow.MetricControls[2].Text -ceq '—' -and $liveWindow.OverallMetricControls[2].Text -ceq '—' -and $null -eq $liveWindow.MetricControls[2].ToolTip) 'service generation change retained live or lifetime exact values'
foreach($staleLiveError in @($null,'disconnected')){
 $staleLive.Error=$staleLiveError;$null=$liveApply.Invoke($liveWindow,[object[]]@($staleLive.psobject.BaseObject))
 Assert ($liveWindow.MetricControls[2].Text -ceq '—' -and $liveWindow.OverallMetricControls[2].Text -ceq '—') 'stale live success/error was applied after a service change'
}
ApplyLiveFixture (LiveSample)
Assert ($liveWindow.MetricControls[2].Text -ceq '42') 'current service live snapshot failed to recover'
$liveWindow.Close()

# GET allowlist, response caps and cancellation retain the same contract on the live route.
$handler=New-Object NativeFixtureHandler;$client=New-Object CodexNative.WidgetClient $false,$handler;$clients.Add($client)
foreach($path in @('/api/live',('/api/live?taskId='+$taskAlpha))){
 $task=$client.RequestAsync($path,$null,262144,1000);PumpUntil {$task.IsCompleted}
 Assert (-not $task.IsFaulted -and $handler.Origin) 'allowed live GET was rejected or lost Origin'
}
foreach($path in @(('/api/live?taskId='+$taskAlpha+"`n"),('/api/live?taskId='+$taskAlpha+'&extra=1'),'/api/live?taskId=AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA','/api/live?taskId=not-a-uuid','/api/live?taskId=11111111111141118111111111111111')){
 $beforeRejected=$handler.Requests;$task=$client.RequestAsync($path,$null,262144,1000);PumpUntil {$task.IsCompleted}
 Assert ($task.IsFaulted -and $task.Exception.InnerException.Code -ceq 'path_invalid' -and $handler.Requests -eq $beforeRejected) 'noncanonical live query reached the handler'
}
$beforeRejected=$handler.Requests;$task=$client.RequestAsync('/api/live','{}',262144,1000);PumpUntil {$task.IsCompleted}
Assert ($task.IsFaulted -and $task.Exception.InnerException.Code -ceq 'path_invalid' -and $handler.Requests -eq $beforeRejected -and $handler.Posts -eq 0) 'live route allowed POST'
$handler.Mode=5;$task=$client.RequestAsync('/api/live',$null,262144,1000);PumpUntil {$task.IsCompleted}
Assert ($task.IsFaulted -and $task.Exception.InnerException.Code -ceq 'response_too_large') 'live response cap was bypassed'
$handler.Mode=0;$handler.Route='status';$handler.RouteStatus=404;$handler.RouteCode='not_found'
$task=$client.RequestAsync('/api/live',$null,262144,1000);PumpUntil {$task.IsCompleted}
Assert ($task.IsFaulted -and $task.Exception.InnerException.Code -ceq 'not_found') 'definitive live route 404 lost its compatibility error'
$client.Dispose()
foreach($mode in 1,2,3){
 $handler=New-Object NativeFixtureHandler;$handler.Mode=$mode;$client=New-Object CodexNative.WidgetClient $false,$handler;$clients.Add($client)
 $task=$client.RequestAsync('/api/live',$null,262144,100);PumpUntil {$task.IsCompleted}
 Assert ($task.IsCanceled -or $task.IsFaulted) 'live send/body/trickle deadline failed'
 if($mode -gt 1){Assert $handler.DisposedStream 'live timeout did not dispose its response stream'}
 $client.Dispose()
}
# No historical task is required to follow live. Selecting a historical task still does not
# add taskId until pin mode is explicit. The handler is in-memory; no local server is contacted.
$handler=New-Object NativeFixtureHandler;$handler.Live=$true;$handler.LivePayload=[CodexNative.WidgetClient]::Serialize((LiveSample))
$liveHttpWindow=New-Object CodexNative.WidgetWindow $false,$handler,$true;$fixtureWindows.Add($liveHttpWindow)
$liveHttpClient=$liveHttpWindow.GetType().GetField('client',$flags).GetValue($liveHttpWindow)
$requestLive=$liveHttpWindow.GetType().GetMethod('RequestTelemetry',$flags)
$httpApply=$liveHttpWindow.GetType().GetMethod('Apply',$flags)
for($liveRequest=0;$liveRequest -lt 3;$liveRequest++){
 if($liveRequest -eq 1){$liveHttpWindow.GetType().GetField('selectedTask',$flags).SetValue($liveHttpWindow,$taskAlpha)}
 if($liveRequest -eq 2){$liveHttpWindow.GetType().GetField('keepTask',$flags).SetValue($liveHttpWindow,$true);$handler.LivePayload=[CodexNative.WidgetClient]::Serialize((LiveSample $taskAlpha))}
 $null=$requestLive.Invoke($liveHttpWindow,$null)
 PumpUntilLabeled 'live HTTP selection request' {$liveHttpClient.HasQueuedEvents -and -not (ClientInFlight $liveHttpClient 'live')}
 $httpLiveEvent=$null;Assert ($liveHttpClient.Dequeue([ref]$httpLiveEvent) -and $httpLiveEvent.Kind -ceq 'live' -and $null -eq $httpLiveEvent.Error -and $liveHttpClient.LiveSupported) 'live capability handshake or queued response failed'
 $null=$httpApply.Invoke($liveHttpWindow,[object[]]@($httpLiveEvent.psobject.BaseObject))
 $expectedQuery='';if($liveRequest -eq 2){$expectedQuery='?taskId='+$taskAlpha}
 Assert ($handler.LastLiveQuery -ceq $expectedQuery -and $handler.LiveHits -eq $liveRequest+1 -and $handler.Origin -and $handler.Posts -eq 0 -and $liveHttpWindow.MetricControls[2].Text -ceq '42') 'live request query did not follow explicit pin semantics'
}
$liveHttpWindow.Close()
# One live request owns its slot. A service-generation boundary drops its success and error.
foreach($liveFails in $false,$true){
 $handler=New-Object NativeFixtureHandler;$handler.Live=$true;$handler.HoldLive=$true;$handler.FailLive=$liveFails
 $client=New-Object CodexNative.WidgetClient $false,$handler;$clients.Add($client)
 Assert ($client.Start('live','/api/live',$null,1)) 'held live request was rejected'
 PumpUntilLabeled 'held live request' {$handler.LiveHits -eq 1}
 Assert (-not $client.Start('live',('/api/live?taskId='+$taskAlpha),$null,2)) 'concurrent live selection request was accepted'
 $client.GetType().GetField('generation',$flags).SetValue($client,$client.ServiceGeneration+1)
 $null=$handler.LiveRelease.TrySetResult($true)
 PumpUntilLabeled 'stale live request settlement' {-not (ClientInFlight $client 'live')}
 $lateLive=$null;Assert (-not $client.Dequeue([ref]$lateLive)) 'stale live success/error was enqueued after service generation change'
 $client.Dispose()
}

# Real HTTP regression: the in-flight slot is per kind, so a second telemetry request is refused while
# the first one is still open, stale results of an older generation are dropped, and the slot is released.
$handler=New-Object NativeFixtureHandler;$handler.Route='hold'
$client=New-Object CodexNative.WidgetClient $false,$handler; $clients.Add($client)
Assert ($client.Start('telemetry','/api/telemetry',$null,1)) 'first telemetry submit rejected'
PumpUntil { $handler.RouteWaiting } 8000
$heldGeneration=$client.ServiceGeneration
Assert (-not $client.Start('telemetry','/api/telemetry',$null,2)) 'second telemetry selection opened a concurrent request'
Assert (-not $client.Start('telemetry','/api/telemetry',$null,3)) 'third telemetry selection opened a concurrent request'
Assert ($handler.RouteHits -eq 1) 'overlapping telemetry requests reached the handler'
$client.GetType().GetField('generation',$flags).SetValue($client,$heldGeneration+1)
$null=$handler.RouteRelease.TrySetResult($true)
PumpUntil { $client.GetType().GetField('inflight',$flags).GetValue($client).Count -eq 0 } 8000
Assert ($client.GetType().GetField('queue',$flags).GetValue($client).Count -eq 0) 'stale in-flight telemetry result was queued at all'
Assert ($client.Start('telemetry','/api/telemetry',$null,4)) 'released telemetry slot refused the next fetch'
$script:refetched=$null
PumpUntil {$e=$null;if($client.Dequeue([ref]$e)){$script:refetched=$e;$true}else{$false}} 8000
Assert ($null -eq $script:refetched.Error -and $script:refetched.Kind -eq 'telemetry' -and $script:refetched.Generation -eq ($heldGeneration+1)) 'next telemetry fetch did not deliver a current-generation result'
Assert ($handler.RouteHits -eq 2) 'next telemetry fetch never reached the service'
$client.Dispose()
# Real HTTP regression: a stale usage response dropped by a service generation change must release
# the window's own coalescing flag and retry with the current generation.
$handler=New-Object NativeFixtureHandler
$firstUsage=@{sampledAt=$usageStamped;overall=(UsageBlock 'local_all' 'available' $null @{inputTokens=40;outputTokens=2;totalTokens=42} $null);selected=(UsageBlock 'selected_task' 'available' $null @{inputTokens=10;outputTokens=5;totalTokens=15} $taskAlpha)}
$staleUsage=@{sampledAt=$usageStamped;overall=(UsageBlock 'local_all' 'available' $null @{inputTokens=900;outputTokens=99;totalTokens=999} $null);selected=(UsageBlock 'selected_task' 'available' $null @{inputTokens=10;outputTokens=5;totalTokens=15} $taskAlpha)}
$finalUsage=@{sampledAt=$usageStamped;overall=(UsageBlock 'local_all' 'available' $null @{inputTokens=70;outputTokens=7;totalTokens=77} $null);selected=(UsageBlock 'selected_task' 'available' $null @{inputTokens=10;outputTokens=5;totalTokens=15} $taskAlpha)}
$secondUsage=@{sampledAt=$usageStamped;overall=(UsageBlock 'local_all' 'available' $null @{inputTokens=50;outputTokens=5;totalTokens=55} $null);selected=(UsageBlock 'selected_task' 'available' $null @{inputTokens=10;outputTokens=5;totalTokens=15} $taskAlpha)}
$handler.UsagePayload=[CodexNative.WidgetClient]::Serialize($firstUsage)
$handler.UsageStalePayload=[CodexNative.WidgetClient]::Serialize($staleUsage)
$usageWindow=New-Object CodexNative.WidgetWindow $false,$handler,$true;$fixtureWindows.Add($usageWindow)
$usageClient=$usageWindow.GetType().GetField('client',$flags).GetValue($usageWindow)
$drainUsage=$usageWindow.GetType().GetMethod('DrainClientEvents',$allFields)
$selectedTaskField=$usageWindow.GetType().GetField('selectedTask',$allFields)
$usageTaskField=$usageWindow.GetType().GetField('usageTask',$allFields)
$usagePendingField=$usageWindow.GetType().GetField('usagePending',$allFields)
$usageInFlightField=$usageWindow.GetType().GetField('usageInFlight',$allFields)
$selectedTaskField.SetValue($usageWindow,$taskAlpha)
$usageTaskField.SetValue($usageWindow,$taskAlpha)
$usagePendingField.SetValue($usageWindow,$true)
$null=$requestUsage.Invoke($usageWindow,@($false))
 PumpUntilLabeled 'first usage response' {$usageClient.HasQueuedEvents}
$drainUsage.Invoke($usageWindow,$null)
Assert ($usageWindow.OverallMetricControls[2].Text -ceq '42') 'first usage response was not applied'
$usageUiRequests=$handler.Requests;$usageUiHits=$handler.UsageHits;$usageUiGeneration=$usageWindow.UsageGeneration
$usageUiPending=$usageWindow.UsagePending;$usageUiInFlight=$usageWindow.UsageInFlight
$usageWindow.Show();$usageWindow.OpenUsage();$usageHttpPopup=$usageWindow.UsageWindow;$usageHttpPopup.UpdateLayout()
$usageHttpClose=@(Visuals $usageHttpPopup | Where-Object {$_ -is [Windows.Controls.Button] -and [Windows.Automation.AutomationProperties]::GetAutomationId($_) -ceq 'CloseUsage'})[0]
Click $usageHttpClose;$usageWindow.OpenUsage();$usageWindow.UsageWindow.Close()
$script:usageUiTurn=$false
$null=[Windows.Threading.Dispatcher]::CurrentDispatcher.BeginInvoke([Windows.Threading.DispatcherPriority]::Background,[Action]{$script:usageUiTurn=$true})
PumpUntil {$script:usageUiTurn}
Assert ($handler.Requests -eq $usageUiRequests -and $handler.UsageHits -eq $usageUiHits -and $handler.Posts -eq 0 -and $null -eq $usageWindow.SubmittedRequest -and $usageWindow.UsageGeneration -eq $usageUiGeneration -and $usageWindow.UsagePending -eq $usageUiPending -and $usageWindow.UsageInFlight -eq $usageUiInFlight -and $usageWindow.OverallMetricControls[2].Text -ceq '42') 'usage window lifecycle requested another snapshot, benchmark or changed the polling state'
$generationBeforeRace=$usageClient.ServiceGeneration
$null=$requestUsage.Invoke($usageWindow,@($false))
 PumpUntilLabeled 'held second usage response' {$handler.UsageHits -ge 2 -and $null -ne $handler.UsageHeldRelease}
$handler.UsagePayload=[CodexNative.WidgetClient]::Serialize($finalUsage)
$handler.InstanceId='aaaaaaaa-1234-1234-1234-123456789abc'
Assert ($usageClient.Start('telemetry','/api/telemetry',$null)) 'replacement usage handshake rejected'
 PumpUntilLabeled 'replacement usage handshake' {$usageClient.ServiceGeneration -gt $generationBeforeRace -and -not (ClientInFlight $usageClient 'telemetry')}
 $drainUsage.Invoke($usageWindow,$null)
 Assert ($usageWindow.OverallMetricControls[2].Text -ceq '—' -and $usageWindow.MetricControls[2].Text -ceq '—') 'service change while usage request held retained exact counts'
 foreach($metric in @($usageWindow.MetricControls[0..2])+@($usageWindow.OverallMetricControls[0..2])) {
  Assert ($null -eq $metric.ToolTip -and [string]::IsNullOrEmpty([Windows.Automation.AutomationProperties]::GetHelpText($metric))) 'service change while usage request held retained exact tooltip or accessible help'
 }
 Assert ($handler.UsageHits -eq 2 -and $usageWindow.UsageInFlight -and -not $usageWindow.UsagePending) 'service change while usage request held opened a concurrent request or lost coalescing state'
$handler.UsageStalePayload=[CodexNative.WidgetClient]::Serialize($secondUsage)
$null=$handler.UsageHeldRelease.TrySetResult($true)
 PumpUntilLabeled 'held usage slot settlement' {-not (ClientInFlight $usageClient 'usage')}
$drainUsage.Invoke($usageWindow,$null)
$usageGenerationAfterStale=$usageWindow.UsageGeneration
Assert ($usageClient.ServiceGeneration -gt $generationBeforeRace -and $usageWindow.UsageInFlight -and -not $usageWindow.UsagePending -and $usageWindow.OverallMetricControls[2].Text -ceq '—' -and $usageWindow.MetricControls[2].Text -ceq '—') 'stale dropped usage did not clear stale counts or start a current-generation retry'
$retriedGeneration=$usageWindow.UsageGeneration
 PumpUntilLabeled 'current-generation usage retry' {$handler.UsageHits -ge 3 -and $null -ne $handler.UsageFinalRelease}
$null=$handler.UsageFinalRelease.TrySetResult($true)
 PumpUntilLabeled 'retried usage response' {$usageClient.HasQueuedEvents}
$drainUsage.Invoke($usageWindow,$null)
Assert ($retriedGeneration -eq $usageGenerationAfterStale -and $handler.UsageHits -eq 3 -and $usageWindow.OverallMetricControls[2].Text -ceq '77' -and -not $usageWindow.UsageInFlight -and -not $usageWindow.UsagePending) 'retried usage did not replace stale values and settle'
$usageWindow.Close()
 # Dequeue validates the generation, but Apply must validate it again because a handshake can
 # complete between those two calls. A stale event must not replace a current task/request.
 $handler=New-Object NativeFixtureHandler
 $handler.Payload='{}'
 $applyWindow=New-Object CodexNative.WidgetWindow $false,$handler,$true;$fixtureWindows.Add($applyWindow)
 $applyClient=$applyWindow.GetType().GetField('client',$flags).GetValue($applyWindow)
 $apply=$applyWindow.GetType().GetMethod('Apply',$allFields)
 $applyDrain=$applyWindow.GetType().GetMethod('DrainClientEvents',$allFields)
 $applySelectedTaskField=$applyWindow.GetType().GetField('selectedTask',$allFields)
 $applyUsageTaskField=$applyWindow.GetType().GetField('usageTask',$allFields)
 $applyPendingField=$applyWindow.GetType().GetField('usagePending',$allFields)
 $applyInFlightField=$applyWindow.GetType().GetField('usageInFlight',$allFields)
 $applySelectedTaskField.SetValue($applyWindow,$taskAlpha)
 $applyUsageTaskField.SetValue($applyWindow,$taskAlpha)
 $null=$requestUsage.Invoke($applyWindow,@($false))
 PumpUntilLabeled 'pre-Apply usage response' {$applyClient.HasQueuedEvents}
 $applyEvent=$null
 Assert ($applyClient.Dequeue([ref]$applyEvent) -and $applyEvent.Kind -eq 'usage') 'usage event was not dequeued for pre-Apply race'
 $null=$applyDrain.Invoke($applyWindow,$null)
 $handler.InstanceId='aaaaaaaa-1234-1234-1234-123456789abc'
 $handler.UsagePayload='{}'
 $handler.UsageStalePayload='{}'
 Assert ($applyClient.Start('telemetry','/api/telemetry',$null)) 'pre-Apply replacement handshake rejected'
 PumpUntilLabeled 'pre-Apply replacement handshake' {$applyClient.ServiceGeneration -gt $applyEvent.Generation -and -not (ClientInFlight $applyClient 'telemetry')}
 $serviceBeforeApply=$applyClient.ServiceGeneration
 $apply.Invoke($applyWindow,[object[]]@($applyEvent.psobject.BaseObject))
 Assert ($applyClient.ServiceGeneration -eq $serviceBeforeApply -and $null -eq $applyWindow.GetType().GetField('overallUsage',$allFields).GetValue($applyWindow) -and $null -eq $applyWindow.GetType().GetField('selectedUsage',$allFields).GetValue($applyWindow) -and ($applyPendingField.GetValue($applyWindow) -eq $true -or $applyInFlightField.GetValue($applyWindow) -eq $true)) ('stale usage was applied after Dequeue or replacement refresh was lost; generation='+$applyClient.ServiceGeneration+'; event='+$applyEvent.Generation+'; pending='+$applyPendingField.GetValue($applyWindow)+'; inflight='+$applyInFlightField.GetValue($applyWindow))
 $applyWindow.Close()
 # A service change between polls with no usage request in flight must also invalidate displayed data.
 $handler=New-Object NativeFixtureHandler
 $displayPayload=@{sampledAt=$usageStamped;overall=(UsageBlock 'local_all' 'available' $null @{inputTokens=40;outputTokens=2;totalTokens=42} $null);selected=(UsageBlock 'selected_task' 'available' $null @{inputTokens=10;outputTokens=5;totalTokens=15} $taskAlpha)}
 $handler.UsagePayload=[CodexNative.WidgetClient]::Serialize($displayPayload)
 $displayWindow=New-Object CodexNative.WidgetWindow $false,$handler,$true;$fixtureWindows.Add($displayWindow)
 $displayClient=$displayWindow.GetType().GetField('client',$flags).GetValue($displayWindow)
 $displayDrain=$displayWindow.GetType().GetMethod('DrainClientEvents',$allFields)
 $displaySelectedTaskField=$displayWindow.GetType().GetField('selectedTask',$allFields)
 $displayUsageTaskField=$displayWindow.GetType().GetField('usageTask',$allFields)
 $displayPendingField=$displayWindow.GetType().GetField('usagePending',$allFields)
 $displayInFlightField=$displayWindow.GetType().GetField('usageInFlight',$allFields)
 $displaySelectedTaskField.SetValue($displayWindow,$taskAlpha)
 $displayUsageTaskField.SetValue($displayWindow,$taskAlpha)
 $null=$requestUsage.Invoke($displayWindow,@($false))
 PumpUntilLabeled 'display usage baseline' {$displayClient.HasQueuedEvents}
 $displayDrain.Invoke($displayWindow,$null)
 Assert ($displayWindow.OverallMetricControls[2].Text -ceq '42' -and $displayWindow.MetricControls[2].Text -ceq '15') 'display usage baseline was not applied'
 $displayInFlightField.SetValue($displayWindow,$false)
 $displayPendingField.SetValue($displayWindow,$false)
 $handler.InstanceId='aaaaaaaa-1234-1234-1234-123456789abc'
 Assert ($displayClient.Start('telemetry','/api/telemetry',$null)) 'idle replacement handshake rejected'
 PumpUntilLabeled 'idle replacement handshake' {$displayClient.ServiceGeneration -gt ($displayWindow.GetType().GetField('usageServiceGeneration',$allFields).GetValue($displayWindow))}
 $displayDrain.Invoke($displayWindow,$null)
 Assert ($displayWindow.OverallMetricControls[2].Text -ceq '—' -and $displayWindow.MetricControls[2].Text -ceq '—') 'service change without usage in flight retained stale counts'
 $displayWindow.Close()
# Real HTTP regression: only a definitive 404 not_found on /api/tasks may disable task polling.
function RouteEvent([string]$kind,[string]$path,[int]$status,[string]$code){
    $script:routeHandler=New-Object NativeFixtureHandler
    if($status -eq 200){$script:routeHandler.Payload='{"tasks":[]}'}else{$script:routeHandler.Route='status';$script:routeHandler.RouteStatus=$status;$script:routeHandler.RouteCode=$code}
    $script:routeClient=New-Object CodexNative.WidgetClient $false,$script:routeHandler
    $clients.Add($script:routeClient)
    $null=$script:routeClient.Start($kind,$path,$null)
    PumpUntil {$e=$null;if($script:routeClient.Dequeue([ref]$e)){$script:routeEvent=$e;$true}else{$false}} 8000
    return $script:routeEvent
}
$probe=New-Object CodexNative.WidgetWindow $true;$fixtureWindows.Add($probe)
$apply=$probe.GetType().GetMethod('Apply',$flags)
$listed=RouteEvent 'tasks' '/api/tasks' 200 ''
Assert ($null -eq $listed.Error) 'real 200 /api/tasks produced an error'
$apply.Invoke($probe,[object[]]@($listed.psobject.BaseObject))
Assert ($probe.TasksSupported) 'real 200 /api/tasks did not enable the list'
$transient=RouteEvent 'tasks' '/api/tasks' 503 'tasks_unavailable'
Assert ($transient.Error -ceq 'tasks_unavailable') ('503 /api/tasks mapped to '+$transient.Error)
$apply.Invoke($probe,[object[]]@($transient.psobject.BaseObject))
Assert ($probe.TasksSupported) '503 /api/tasks disabled task polling'
    $gated=RouteEvent 'tasks' '/api/tasks' 503 'not_found'
Assert ($gated.Error -ceq 'request_failed') 'non-404 not_found code was treated as a missing route'
$apply.Invoke($probe,[object[]]@($gated.psobject.BaseObject))
Assert ($probe.TasksSupported) 'non-404 not_found code disabled task polling'
    $other=RouteEvent 'telemetry' '/api/telemetry' 404 'not_found'
Assert ($other.Error -ceq 'request_failed') 'not_found normalized outside /api/tasks'
$missing=RouteEvent 'tasks' '/api/tasks' 404 'not_found'
Assert ($missing.Error -ceq 'not_found') ('real 404 not_found /api/tasks mapped to '+$missing.Error)
$apply.Invoke($probe,[object[]]@($missing.psobject.BaseObject))
Assert (-not $probe.TasksSupported) 'real 404 not_found /api/tasks did not disable the list'
$probe.Close()
[pscustomobject]@{status='PASS';checks=$script:checks;fixtureOnly=$true;realModelCalls=0;animationTimerTransformChecks=1;animationInitialOffset=$animationInitialOffset;animationObservedOffset=$animationOffsetObserved;cockpitAppliedFrames=$cockpitChecks;cockpitSinglePendingChecks=200;cockpitViewportWidth=$shownViewportWidth;cockpitViewportHeight=$shownViewportHeight;cockpitPointChecks=$cockpitPointChecks;cockpitInputFixtureChecks=$cockpitInputFixtureChecks;heartbeats=$window.Heartbeats;screenshot=$ScreenshotPath;resultsScreenshot=$ResultScreenshotPath;cleanup='windows closed; clients disposed';routing='unverified: no final platform model metadata'}|ConvertTo-Json -Compress
} finally {
    foreach($ownedWindow in $fixtureWindows){$ownedWindow.Close()}
    foreach($ownedClient in $clients){$ownedClient.Dispose()}
}








