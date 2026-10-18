[CmdletBinding()]
param([string]$FixtureName='VALID_HTML',[string]$EvidenceDirectory)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Net.Http,System.Web.Extensions
$project=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if(-not $EvidenceDirectory){$EvidenceDirectory=Join-Path $env:TEMP ('cockpit-html-evidence-'+[Guid]::NewGuid().ToString('N'))}
$null=New-Item -ItemType Directory -Path $EvidenceDirectory -Force
$profile=Join-Path $env:TEMP ('cockpit-html-smoke-'+[Guid]::NewGuid().ToString('N'))
$profileExpected=[IO.Path]::GetFullPath($profile);$profileCreated=$false;$browserExitConfirmed=$true;$profileCleanup='not_started'
$profileMarker=[Guid]::NewGuid().ToString('N')+'|'+$PID+'|'+[Diagnostics.Process]::GetCurrentProcess().StartTime.ToUniversalTime().Ticks+'|'+$profileExpected
$fixture=$null;$browser=$null;$production=$null;$socket=$null;$script:cdpId=0;$script:events=New-Object Collections.Generic.List[object];$script:session=$null;$script:iframeSessions=@{};$script:pendingFrames=@{};$script:initializingFrames=$false;$browserExitUnknown=$false
function Await-Task($task,[int]$milliseconds=10000){if(-not $task.Wait($milliseconds)){throw 'Operation deadline exceeded.'};return $task.GetAwaiter().GetResult()}
function Fixture-Read {
    $line=Await-Task ($fixture.StandardOutput.ReadLineAsync())
    if(-not $line){throw 'Fixture process ended before acknowledgement.'}
    $value=$line|ConvertFrom-Json
    if($value.event -eq 'control_error'){throw 'Fixture command rejected; check WP2 export names.'}
    return $value
}
function Fixture-Command($command){$fixture.StandardInput.WriteLine(($command|ConvertTo-Json -Compress));$fixture.StandardInput.Flush();return Fixture-Read}
function Start-Fixture {
    $info=New-Object Diagnostics.ProcessStartInfo
    $info.FileName=(Get-Command node.exe -ErrorAction Stop).Source
    $info.Arguments='tests/helpers/html-preview-fixture-server.js --serve';$info.WorkingDirectory=$project
    $info.UseShellExecute=$false;$info.CreateNoWindow=$true
    $info.RedirectStandardInput=$true;$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
    $script:fixture=[Diagnostics.Process]::Start($info)
    return Fixture-Read
}
function Cdp([string]$method,$parameters=@{},[switch]$Browser,[string]$SessionId) {
    $script:cdpId++;$id=$script:cdpId
    $message=@{id=$id;method=$method;params=$parameters}
    if($Browser -and $SessionId){throw 'Browser and SessionId are mutually exclusive.'}
    if($SessionId){$message.sessionId=$SessionId}elseif($script:session -and -not $Browser){$message.sessionId=$script:session}
    $bytes=[Text.Encoding]::UTF8.GetBytes(($message|ConvertTo-Json -Depth 30 -Compress))
    $deadline=New-Object Threading.CancellationTokenSource 10000
    try {
        $null=Await-Task ($socket.SendAsync([ArraySegment[byte]]::new($bytes),[Net.WebSockets.WebSocketMessageType]::Text,$true,$deadline.Token))
        while($true){
            $memory=New-Object IO.MemoryStream
            try {do{$buffer=New-Object byte[] 65536;$part=Await-Task ($socket.ReceiveAsync([ArraySegment[byte]]::new($buffer),$deadline.Token));if($part.MessageType -eq 'Close'){throw 'CDP socket closed.'};$memory.Write($buffer,0,$part.Count);if($memory.Length -gt 16777216){throw 'CDP message limit exceeded.'}}while(-not $part.EndOfMessage)
                $reply=[Text.Encoding]::UTF8.GetString($memory.ToArray())|ConvertFrom-Json
            }finally{$memory.Dispose()}
            if($reply.id -eq $id){if($reply.error){throw ('CDP failed: '+$method)};$result=$reply.result;Initialize-PendingFrames;return $result}
            if($reply.method){
                $script:events.Add($reply)
                if($reply.method -eq 'Target.attachedToTarget' -and $reply.params.targetInfo.type -eq 'iframe'){
                    $script:iframeSessions[$reply.params.targetInfo.targetId]=$reply.params.sessionId
                    $script:pendingFrames[$reply.params.sessionId]=$reply.params
                }elseif($reply.method -eq 'Target.detachedFromTarget'){
                    $script:pendingFrames.Remove($reply.params.sessionId)
                    foreach($targetId in @($script:iframeSessions.Keys)){if($script:iframeSessions[$targetId] -eq $reply.params.sessionId){$script:iframeSessions.Remove($targetId)}}
                }
            }
        }
    } finally {$deadline.Dispose()}
}
function Initialize-PendingFrames {
    if($script:initializingFrames){return}
    $script:initializingFrames=$true
    try {
        while($script:pendingFrames.Count){
            $sessionId=@($script:pendingFrames.Keys)[0]
            $attached=$script:pendingFrames[$sessionId];$script:pendingFrames.Remove($sessionId)
            foreach($domain in 'Page','Network','Log','Runtime','DOM','CSS'){$null=Cdp ($domain+'.enable') @{} -SessionId $sessionId}
            $null=Cdp 'Target.setAutoAttach' @{autoAttach=$true;waitForDebuggerOnStart=$true;flatten=$true;filter=@(@{type='iframe';exclude=$false},@{exclude=$true})} -SessionId $sessionId
            if($attached.waitingForDebugger){$null=Cdp 'Runtime.runIfWaitingForDebugger' @{} -SessionId $sessionId}
        }
    } finally {$script:initializingFrames=$false}
}
function Get-PreviewFrameSession {
    $targets=Cdp 'Target.getTargets' @{} -Browser
    $frames=@($targets.targetInfos|Where-Object{$_.type -eq 'iframe' -and $_.url -eq 'http://127.0.0.1:4173/preview-frame' -and ($_.parentId -eq $page.targetId -or $_.parentFrameId -eq $page.targetId)})
    if($frames.Count -ne 1){throw 'Expected exactly one owned preview iframe target.'}
    $targetId=$frames[0].targetId
    if(-not $script:iframeSessions.ContainsKey($targetId)){
        $attached=Cdp 'Target.attachToTarget' @{targetId=$targetId;flatten=$true} -Browser
        $script:iframeSessions[$targetId]=$attached.sessionId
        $script:pendingFrames[$attached.sessionId]=@{waitingForDebugger=$false}
        Initialize-PendingFrames
    }
    return $script:iframeSessions[$targetId]
}
function Await-PreviewOpen($controller,[string]$label) {
    $limit=[Diagnostics.Stopwatch]::StartNew()
    while($true){
        $snapshot=$controller.Snapshot
        if($snapshot.ErrorCode){throw ($label+' launch failed: '+$snapshot.ErrorCode)}
        if($snapshot.State -eq 'open'){return $snapshot}
        if($snapshot.State -notin @('validating','starting')){throw ($label+' launch ended in '+$snapshot.State)}
        if($limit.ElapsedMilliseconds -ge 15000){throw ($label+' open deadline exceeded.')}
        Start-Sleep -Milliseconds 100
    }
}
function Capture([string]$name){
    $shot=Cdp 'Page.captureScreenshot' @{format='png'}
    [IO.File]::WriteAllBytes((Join-Path $EvidenceDirectory ($name+'.png')),[Convert]::FromBase64String($shot.data))
    Cdp 'Page.getLayoutMetrics' | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath (Join-Path $EvidenceDirectory ($name+'-layout.json'))
}
function Navigate([string]$url){
    $result=Cdp 'Page.navigate' @{url=$url};if($result.errorText){throw 'CDP navigation failed.'}
    # Same-URL fragment navigation retains the old fixture; require a new document.
    if(-not $result.loaderId){$null=Cdp 'Page.reload' @{ignoreCache=$true}}
    # Pump CDP while loading so paused OOPIFs resume before the handshake deadline.
    $load=[Diagnostics.Stopwatch]::StartNew()
    while($load.ElapsedMilliseconds -lt 1800){$null=Cdp 'Target.getTargets' @{} -Browser;Start-Sleep -Milliseconds 25}
}
function Find-Animated($node,[string]$className){
    for($i=0;$i -lt @($node.attributes).Count-1;$i+=2){if($node.attributes[$i] -eq 'class' -and $node.attributes[$i+1] -eq $className){return $node.nodeId}}
    foreach($child in @($node.children)+@($node.contentDocument)+@($node.shadowRoots)){if($child){$found=Find-Animated $child $className;if($found){return $found}}}
    return $null
}
function Assert-SafeProfilePath {
    if(-not [String]::Equals([IO.Path]::GetFullPath($profile),$profileExpected,[StringComparison]::Ordinal)){throw 'Profile path changed.'}
    $expectedParent=[IO.Path]::GetFullPath($env:TEMP).TrimEnd('\')
    if([IO.Path]::GetDirectoryName($profileExpected) -ne $expectedParent -or [IO.Path]::GetFileName($profileExpected) -notmatch '^cockpit-html-smoke-[0-9a-f]{32}$'){throw 'Profile path is not owned.'}
    $ancestor=$profileExpected
    while($ancestor){if(Test-Path -LiteralPath $ancestor){if(((Get-Item -LiteralPath $ancestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'Reparse ancestor.'}};$ancestor=[IO.Path]::GetDirectoryName($ancestor)}
}
function Check-ProfileTree([string]$path){
    $item=Get-Item -LiteralPath $path -Force
    if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'Reparse tree.'}
    if($item.PSIsContainer){foreach($child in Get-ChildItem -LiteralPath $path -Force){Check-ProfileTree $child.FullName}}
}
function Delete-ProfileTree([string]$path){
    Assert-SafeProfilePath
    $full=[IO.Path]::GetFullPath($path)
    if($full -ne $profileExpected -and -not $full.StartsWith($profileExpected+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Deletion escaped profile.'}
    $item=Get-Item -LiteralPath $path -Force
    if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'Reparse tree.'}
    if($item.PSIsContainer){foreach($child in Get-ChildItem -LiteralPath $path -Force){Delete-ProfileTree $child.FullName}}
    $item=Get-Item -LiteralPath $path -Force
    if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'Reparse tree changed.'}
    Remove-Item -LiteralPath $path -Force
}
function Assert-Status([string]$expected,[switch]$EmptyFrame){
    $root=(Cdp 'DOM.getDocument' @{depth=-1;pierce=$true}).root.nodeId
    $node=(Cdp 'DOM.querySelector' @{nodeId=$root;selector='#preview-status'}).nodeId
    $html=if($node){(Cdp 'DOM.getOuterHTML' @{nodeId=$node}).outerHTML}else{''}
    $actual=if($node){[Net.WebUtility]::HtmlDecode(($html -replace '<[^>]*>',''))}else{'<missing #preview-status>'}
    $failure=$null
    if($actual -notmatch [Regex]::Escape($expected)){$failure='Unexpected preview state; expected '+$expected}
    elseif($EmptyFrame -and (Cdp 'DOM.querySelector' @{nodeId=$root;selector='iframe'}).nodeId){$failure='Failed/pending preview retained a frame.'}
    if($failure){
        # Only the status node is saved; fixture source remains text, never evaluated.
        try{
            @{expected=$expected;actual=$actual;statusHtml=$html;emptyFrameRequired=[bool]$EmptyFrame;failure=$failure}|ConvertTo-Json -Depth 5|Set-Content -LiteralPath (Join-Path $EvidenceDirectory 'assert-status-failure.json') -Encoding UTF8
            [IO.File]::WriteAllText((Join-Path $EvidenceDirectory 'assert-status-failure.html'),$html,[Text.Encoding]::UTF8)
        }catch{Write-Warning 'Status failure evidence could not be saved.'}
        try{Capture 'assert-status-failure'}catch{Write-Warning 'Status failure screenshot could not be saved.'}
        throw ($failure+'; actual: '+$actual)
    }
}
try {
    $probe=New-Object Net.Sockets.TcpListener ([Net.IPAddress]::Loopback),4173
    try{$probe.Start()}finally{$probe.Stop()}
    $ready=Start-Fixture
    if($ready.event -ne 'ready'){throw 'Fixture readiness missing.'}
    $null=Fixture-Command @{command='select';fixture=$FixtureName}
    $url='http://127.0.0.1:4173/preview#v=1&instanceId='+$ready.instanceId+'&runId='+$ready.runId
    # Production launch has no debug switches. WP3 owns this source.
    Add-Type -Path (Join-Path $PSScriptRoot 'native/BrowserPreview.cs') -ReferencedAssemblies System.dll,System.Core.dll,System.Net.Http.dll,System.Web.Extensions.dll
    $target=New-Object CodexNative.PreviewTarget
    $target.InstanceId=$ready.instanceId;$target.RunId=$ready.runId;$target.ServiceGeneration=1;$target.WindowGeneration=1;$target.SelectionGeneration=1
    $before=@(Get-Process msedge -ErrorAction SilentlyContinue|ForEach-Object{@{id=$_.Id;ticks=$_.StartTime.ToUniversalTime().Ticks}})
    $production=New-Object CodexNative.BrowserPreview
    $opened=Await-Task ($production.SetTargetAsync($target,[CodexNative.PreviewOpenReason]::ExplicitOpen))
    if($opened.ErrorCode){throw ('Production launch failed: '+$opened.ErrorCode)}
    $null=Await-PreviewOpen $production 'Production'
    $closed=Await-Task ($production.StopAsync('smoke'))
    if($closed.State -ne 'closed' -or $closed.CleanupState -like 'retained*'){throw 'Production cleanup failed.'}
    $production.Dispose();$production=$null
    $edge=@([Environment]::GetFolderPath('ProgramFilesX86'),[Environment]::GetFolderPath('ProgramFiles'))|ForEach-Object{Join-Path $_ 'Microsoft/Edge/Application/msedge.exe'}|Where-Object{Test-Path -LiteralPath $_}|Select-Object -First 1
    if(-not $edge){throw 'Edge is unavailable.'}
    Assert-SafeProfilePath
    $null=New-Item -ItemType Directory -Path $profile;$profileCreated=$true
    [IO.File]::WriteAllText((Join-Path $profile 'ownership.txt'),$profileMarker)
    $edgeArguments='--user-data-dir="'+$profile+'" --remote-debugging-address=127.0.0.1 --remote-debugging-port=0 --no-first-run --no-default-browser-check --disable-background-mode --disable-extensions --app="'+$url+'"'
    $ctor=[CodexNative.BrowserPreview].GetConstructors([Reflection.BindingFlags]'Instance,NonPublic')|Select-Object -First 1
    $handler=New-Object Net.Http.HttpClientHandler;$handler.UseProxy=$false;$handler.AllowAutoRedirect=$false
    $ctorArguments=New-Object object[] 4
    $ctorArguments[0]=$handler.PSObject.BaseObject
    $ctorArguments[1]=[string]$edge;$ctorArguments[2]=[string]$edgeArguments;$ctorArguments[3]=[bool]$false
    $browser=$ctor.Invoke($ctorArguments)
    $browserExitConfirmed=$false
    $opened=Await-Task ($browser.SetTargetAsync($target,[CodexNative.PreviewOpenReason]::ExplicitOpen))
    if($opened.ErrorCode){throw ('Test launch failed: '+$opened.ErrorCode)}
    $null=Await-PreviewOpen $browser 'Test'
    $portFile=Join-Path $profile 'DevToolsActivePort';$limit=[Diagnostics.Stopwatch]::StartNew()
    while(-not (Test-Path -LiteralPath $portFile)){if($limit.ElapsedMilliseconds -gt 10000){throw 'DevToolsActivePort deadline exceeded.'};Start-Sleep -Milliseconds 100}
    $lines=Get-Content -LiteralPath $portFile
    $socket=New-Object Net.WebSockets.ClientWebSocket
    $null=Await-Task ($socket.ConnectAsync([Uri]('ws://127.0.0.1:'+$lines[0]+$lines[1]),[Threading.CancellationToken]::None))
    $targets=Cdp 'Target.getTargets' @{} -Browser
    $pages=@($targets.targetInfos|Where-Object{$_.type -eq 'page' -and $_.url -eq $url})
    if($pages.Count -ne 1){throw 'Expected exactly one owned preview page.'}
    $page=$pages[0]
    $script:session=(Cdp 'Target.attachToTarget' @{targetId=$page.targetId;flatten=$true} -Browser).sessionId
    foreach($domain in 'Page','Network','Log','DOM','CSS','Runtime'){$null=Cdp ($domain+'.enable')}
    $null=Cdp 'Target.setDiscoverTargets' @{discover=$true} -Browser
    $null=Cdp 'Target.setAutoAttach' @{autoAttach=$true;waitForDebuggerOnStart=$true;flatten=$true;filter=@(@{type='iframe';exclude=$false},@{exclude=$true})}
    $null=Cdp 'Browser.setDownloadBehavior' @{behavior='deny';eventsEnabled=$true;downloadPath=$EvidenceDirectory} -Browser
    Navigate $url;Assert-Status '动画已显示';Capture 'ready'
    $frameSession=Get-PreviewFrameSession
    $animationEvidence=New-Object Collections.Generic.List[object]
    foreach($className in 'wheel','bird'){
    $node=Find-Animated (Cdp 'DOM.getDocument' @{depth=-1;pierce=$true} -SessionId $frameSession).root $className
    if(-not $node){throw ('No animation target found: '+$className)}
    $first=(Cdp 'CSS.getComputedStyleForNode' @{nodeId=$node} -SessionId $frameSession).computedStyle|Where-Object name -eq 'transform'
    Start-Sleep -Milliseconds 375
    $second=(Cdp 'CSS.getComputedStyleForNode' @{nodeId=$node} -SessionId $frameSession).computedStyle|Where-Object name -eq 'transform'
    if(-not $first.value -or -not $second.value -or $first.value -eq $second.value){throw ('Computed animation transform did not change: '+$className)}
    $animationEvidence.Add(@{className=$className;sessionId=$frameSession;nodeId=$node;first=$first.value;second=$second.value})
    }
    $animationEvidence|ConvertTo-Json -Depth 5|Set-Content -LiteralPath (Join-Path $EvidenceDirectory 'animation-transforms.json')
    $negatives=Fixture-Command @{command='negative-list'}
    if(-not @($negatives.fixtures).Count){throw 'Negative fixture exports missing.'}
    foreach($negative in $negatives.fixtures){
        $selected=Fixture-Command @{command='negative';name=$negative.name}
        if($selected.errorCode -ne $negative.errorCode){throw 'Negative fixture acknowledgement mismatch.'}
        Navigate $url;Assert-Status $negative.errorCode -EmptyFrame;Capture ('rejected-'+$negative.name)
    }
    Navigate 'http://127.0.0.1:4173/preview-frame'
    $root=(Cdp 'DOM.getDocument' @{depth=-1;pierce=$true}).root.nodeId
    $frameRoot=(Cdp 'DOM.querySelector' @{nodeId=$root;selector='#preview-root'}).nodeId
    if(-not $frameRoot -or (Cdp 'DOM.getOuterHTML' @{nodeId=$frameRoot}).outerHTML -notmatch '^<div id="preview-root"></div>$'){throw 'Top-level frame initialized content.'}
    Capture 'top-level-frame-empty'
    $null=Fixture-Command @{command='state';status='running'};Navigate $url;Assert-Status '等待 HTML 动画结果' -EmptyFrame;Capture 'pending'
    $null=Fixture-Command @{command='empty'};Navigate $url;Assert-Status 'answer_missing' -EmptyFrame;Capture 'empty'
    $null=Fixture-Command @{command='state';status='failed'};Navigate $url;Assert-Status 'run_failed' -EmptyFrame;Capture 'failed'
    $fixture.StandardInput.WriteLine('{"command":"close"}');$fixture.StandardInput.Flush()
    if(-not $fixture.WaitForExit(10000)){throw 'Fixture shutdown failed.'};$fixture.Dispose();$fixture=$null
    $newReady=Start-Fixture
    if($newReady.instanceId -eq $ready.instanceId){throw 'Fixture instance did not change.'}
    Navigate $url;Assert-Status 'instance_mismatch' -EmptyFrame;Capture 'instance-mismatch'
    $requests=@($script:events|Where-Object method -eq 'Network.requestWillBeSent')
    $permitted='^http://127\.0\.0\.1:4173/(preview(?:#.*)?|preview-frame|preview\.(js|css)|api/capabilities|api/benchmark/preview\?runId=[0-9a-f-]+&instanceId=[0-9a-f-]+)$'
    if(@($requests|Where-Object{$_.params.request.url -notmatch $permitted}).Count){throw 'Unexpected network request; inspect events.json.'}
    $frameNavigation='^http://127\.0\.0\.1:4173/(preview(?:#v=1&instanceId=[0-9a-f-]+&runId=[0-9a-f-]+)?|preview-frame)$'
    if(@($script:events|Where-Object{$_.method -eq 'Page.frameNavigated' -and $_.params.frame.url -notmatch $frameNavigation}).Count){throw 'Unexpected frame navigation; inspect events.json.'}
    if(@($script:events|Where-Object{$_.method -eq 'Target.targetCreated' -and $_.params.targetInfo.type -eq 'page' -and $_.params.targetInfo.targetId -ne $page.targetId}).Count){throw 'Unexpected popup target.'}
    if(@($script:events|Where-Object{$_.method -in @('Runtime.exceptionThrown','Browser.downloadWillBegin')}).Count){throw 'Unexpected exception or download event; inspect events.json.'}
    if(@($script:events|Where-Object{$_.method -eq 'Log.entryAdded' -and $_.params.entry.level -eq 'error' -and $_.params.entry.source -eq 'javascript'}).Count){throw 'Unexpected JavaScript console error; inspect events.json.'}
    # Correlate by session as request IDs are not unique across CDP targets.
    # Keep raw events; only an uncorrelated browser Other cache miss is diagnostic.
    $networkFailures=New-Object Collections.Generic.List[object]
    $networkDiagnostics=New-Object Collections.Generic.List[object]
    foreach($event in @($script:events|Where-Object{$_.method -eq 'Network.loadingFailed' -and -not $_.params.canceled})){
        $mappedRequests=@($requests|Where-Object{$_.sessionId -ceq $event.sessionId -and $_.params.requestId -ceq $event.params.requestId})
        if($mappedRequests.Count -eq 0 -and $event.params.type -ceq 'Other' -and $event.params.errorText -ceq 'net::ERR_CACHE_MISS'){
            $networkDiagnostics.Add(@{classification='diagnostic';reason='Uncorrelated browser Other cache miss; no requestWillBeSent in the same session.';sessionId=$event.sessionId;requestId=$event.params.requestId;event=$event})
        }else{
            $networkFailures.Add($event)
        }
    }
    ConvertTo-Json -InputObject @($networkDiagnostics.ToArray()) -Depth 30|Set-Content -LiteralPath (Join-Path $EvidenceDirectory 'network-diagnostics.json') -Encoding UTF8
    if($networkFailures.Count){throw 'Unexpected network failure; inspect events.json and network-diagnostics.json.'}
    # Closing the owned page exercises native window/process observation without stopping the controller first.
    $closeResult=Cdp 'Target.closeTarget' @{targetId=$page.targetId} -Browser
    if(-not $closeResult.success){throw 'Owned page close failed.'}
    $closeDeadline=[Diagnostics.Stopwatch]::StartNew()
    while($browser.Snapshot.State -ne 'closed' -and $closeDeadline.ElapsedMilliseconds -lt 10000){Start-Sleep -Milliseconds 100}
    if($browser.Snapshot.State -ne 'closed'){throw 'User-close observation deadline exceeded.'}
    $followed=Await-Task ($browser.SetTargetAsync($target,[CodexNative.PreviewOpenReason]::FollowSelection))
    if($followed.State -ne 'closed'){throw 'Automatic follow reopened a user-closed preview.'}
    $followed|ConvertTo-Json -Depth 5|Set-Content -LiteralPath (Join-Path $EvidenceDirectory 'user-close-suppression.json')
    $closed=Await-Task ($browser.StopAsync('smoke'))
    $browserExitUnknown=$closed.CleanupState -eq 'retained_process_exit_unconfirmed'
    $browserExitConfirmed=-not $browserExitUnknown -and $closed.State -eq 'closed' -and $closed.CleanupState -in @('cleaned','retained_path_unsafe','retained_delete_failed')
    if($closed.State -ne 'closed' -or $closed.CleanupState -like 'retained*'){throw 'Test Job cleanup failed.'}
    foreach($old in $before){$process=Get-Process -Id $old.id -ErrorAction SilentlyContinue;if(-not $process -or $process.StartTime.ToUniversalTime().Ticks -ne $old.ticks){throw 'Pre-existing Edge process changed.'}}
    Write-Output ('Smoke checks completed; evidence: '+$EvidenceDirectory)
} finally {
    try{$script:events|ConvertTo-Json -Depth 30|Set-Content -LiteralPath (Join-Path $EvidenceDirectory 'events.json')}catch{Write-Warning 'Event evidence could not be saved.'}
    if($socket){try{$socket.Dispose()}catch{Write-Warning 'CDP socket disposal failed.'}}
    foreach($owned in @($browser,$production)){if($owned){
        try{
            $cleanup=Await-Task ($owned.StopAsync('finally'))
            if([object]::ReferenceEquals($owned,$browser)){
                if($cleanup.CleanupState -eq 'retained_process_exit_unconfirmed'){$browserExitUnknown=$true}
                $browserExitConfirmed=-not $browserExitUnknown -and $cleanup.State -eq 'closed' -and $cleanup.CleanupState -in @('cleaned','retained_path_unsafe','retained_delete_failed')
            }
        }catch{if([object]::ReferenceEquals($owned,$browser)){$browserExitConfirmed=$false;$browserExitUnknown=$true};Write-Warning 'Owned browser exit was not confirmed.'}
        finally{try{$owned.Dispose()}catch{Write-Warning 'Owned browser disposal failed.'}}
    }}
    if($fixture){try{if(-not $fixture.HasExited){$fixture.StandardInput.Close();if(-not $fixture.WaitForExit(10000)){$fixture.Kill();if(-not $fixture.WaitForExit(5000)){Write-Warning 'Fixture process exit unconfirmed.'}}}}catch{Write-Warning 'Fixture cleanup failed.'}finally{$fixture.Dispose()}}
    if($profileCreated){
        if(-not $browserExitConfirmed){$profileCleanup='retained_process_exit_unconfirmed'}
        else{
            try{Assert-SafeProfilePath;if(Test-Path -LiteralPath $profile){Check-ProfileTree $profile;if([IO.File]::ReadAllText((Join-Path $profile 'ownership.txt')) -cne $profileMarker){throw 'Profile ownership changed.'}};$profileCleanup='safe'}catch{$profileCleanup='retained_path_unsafe'}
            if($profileCleanup -eq 'safe'){try{if(Test-Path -LiteralPath $profile){Delete-ProfileTree $profile};$profileCleanup='cleaned'}catch{$profileCleanup='retained_delete_failed'}}
        }
    }
    try{@{profile=$profileExpected;profileCreated=$profileCreated;processExitConfirmed=$browserExitConfirmed;cleanupState=$profileCleanup}|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $EvidenceDirectory 'cleanup.json')}catch{Write-Warning 'Cleanup evidence could not be saved.'}
    if($profileCleanup -like 'retained*'){Write-Warning ('Test profile retained: '+$profileCleanup)}
}
