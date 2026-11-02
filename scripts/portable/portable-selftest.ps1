[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$ReportPath)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$ReportPath = [IO.Path]::GetFullPath($ReportPath)
$fixture = Join-Path ([IO.Path]::GetDirectoryName($ReportPath)) ('fixture-' + [Guid]::NewGuid().ToString('N'))
$env:CODEX_HOME = Join-Path $fixture 'codex-home'
$env:LOCALAPPDATA = Join-Path $fixture 'local-app-data'
$null = [IO.Directory]::CreateDirectory($env:CODEX_HOME)
$null = [IO.Directory]::CreateDirectory($env:LOCALAPPDATA)
. (Join-Path $root 'scripts/start-floating-widget.ps1')
$script:LauncherMutexName = 'CodexCompanionPortableSelfTest-' + [Guid]::NewGuid().ToString('N')
function Write-LauncherLog([string]$Stage, [string]$Message) {
    [IO.File]::AppendAllText(($ReportPath + '.launcher.log'), ($Stage + ': ' + $Message + "`r`n"))
}
function Show-LauncherDiagnostic([string]$Message) { throw $Message }
$script:uiOpened = $false
$script:uiError = $null
$script:serverPid = 0
try {
    if (@(Get-LauncherListeners).Count -ne 0) { throw 'Self-test needs port 4173 to be free; no existing service was changed.' }
    $node = Get-LauncherNodePath
    if ($node -cne (Join-Path $root 'runtime/node.exe')) { throw 'Self-test did not select the bundled runtime.' }
    $nodeVersion = & $node --version
    if ($LASTEXITCODE -ne 0) { throw 'Bundled Node could not execute.' }
    Start-NativeLauncher -OpenNativeWindow {
        $listeners = @(Get-LauncherListeners)
        if ($listeners.Count -ne 1) { throw 'Expected exactly one owned server listener.' }
        $script:serverPid = [int]$listeners[0].OwningProcess
        $server = Get-Process -Id $script:serverPid -ErrorAction Stop
        try { if ($server.Path -cne $node) { throw 'Server is not running from the bundled Node executable.' } } finally { $server.Dispose() }
        foreach ($path in @('/', '/app.js', '/tokens.css')) {
            $request = [Net.HttpWebRequest]::Create('http://127.0.0.1:4173' + $path)
            $request.Proxy = $null; $request.AllowAutoRedirect = $false; $request.Timeout = 5000
            $response = $request.GetResponse()
            try { if ([int]$response.StatusCode -ne 200 -or $response.ContentLength -eq 0) { throw ('Missing packaged web asset: ' + $path) } } finally { $response.Dispose(); $request.Abort() }
        }
        & (Join-Path $root 'scripts/native-widget.ps1') -LoadOnly
        $script:portableWindow = New-Object CodexNative.WidgetWindow $true
        $script:portableTimer = New-Object Windows.Threading.DispatcherTimer
        $script:portableTimer.Interval = [TimeSpan]::FromMilliseconds(700)
        $script:portableTimer.Add_Tick({
            $script:portableTimer.Stop()
            try {
                $script:uiOpened = $script:portableWindow.IsVisible
                $script:portableWindow.Capture($ReportPath + '.png')
            } catch { $script:uiError = $_.Exception.Message } finally { $script:portableWindow.Close() }
        })
        $script:portableTimer.Start()
        try { $null = $script:portableWindow.ShowDialog() } finally { $script:portableTimer.Stop(); $script:portableWindow.Close() }
    }
    if ($script:uiError) { throw $script:uiError }
    if (-not $script:uiOpened -or -not (Test-Path -LiteralPath ($ReportPath + '.png'))) { throw 'Packaged WPF fixture window was not shown/captured.' }
    if (@(Get-LauncherListeners).Count -ne 0) { throw 'Owned server listener survived window close.' }
    $result = [ordered]@{Status='PASS'; CacheRoot=$root; NodePath=$node; NodeVersion=$nodeVersion;
        UiOpened=$script:uiOpened; ServerPid=$script:serverPid; ServerStopped=$true; RealModelCalls=0; Screenshot=($ReportPath + '.png')}
    [IO.File]::WriteAllText($ReportPath, ($result | ConvertTo-Json -Depth 4), (New-Object Text.UTF8Encoding $false))
} catch {
    $result = @{Status='FAIL'; Error=$_.Exception.Message; Stack=$_.ScriptStackTrace; CacheRoot=$root}
    [IO.File]::WriteAllText($ReportPath, ($result | ConvertTo-Json -Depth 4), (New-Object Text.UTF8Encoding $false))
    exit 1
}
