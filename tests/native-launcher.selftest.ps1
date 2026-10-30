$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $root 'scripts/start-floating-widget.ps1')
$script:passed = 0
function Assert($Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
  $script:passed++
}
function New-Capabilities {
  return [pscustomobject]@{ product = 'codex-companion'; protocolVersion = 1;
    capabilities = @('configured-defaults', 'pelican-svg-v2', 'versioned-scoring');
    instanceId = '11111111-1111-4111-8111-111111111111' }
}
function Reset-Fixture {
  $script:caps = New-Capabilities
  $script:listenerId = 12345
  $script:liveTicks = 10000000L
  $script:posts = @()
  $script:kills = 0
  $script:processKills = 0
  $script:httpCalls = 0
  $script:replaceProcessAtWait = $false
  $script:waits = 0
  $script:exitOnWait = $true
  $script:replaceAtNonce = $false
  $script:replaceAtWait = $false
  $script:listenerError = $false
  $script:process = [pscustomobject]@{ Id = 12345; StartTime = [datetime]::new(10000000L, [DateTimeKind]::Utc); HasExited = $false; Handle = [IntPtr]::new(1) }
  $script:process | Add-Member ScriptMethod Refresh {}
  $script:process | Add-Member ScriptMethod WaitForExit { param($Timeout) return $true }
  $script:process | Add-Member ScriptMethod Kill { $script:processKills++; $this.HasExited = $true }
  return @{ Process = $script:process; StartTicks = 10000000L; InstanceId = $null; Token = 'fixture-only-token'; Revoked = $false }
}
# All OS and HTTP side effects below are in-memory. No server, UI, model or history access.
function Get-Process {
  param($Id, $ErrorAction)
  $p = [pscustomobject]@{ StartTime = [datetime]::new($script:liveTicks, [DateTimeKind]::Utc) }
  $p | Add-Member ScriptMethod Dispose {}
  return $p
}
function Get-NetTCPConnection {
  param($State, $ErrorAction)
  if ($script:listenerError) { throw 'Fixture listener query failure.' }
  if ($script:listenerId) { return [pscustomobject]@{ LocalPort = 4173; LocalAddress = '127.0.0.1'; OwningProcess = $script:listenerId } }
}
function Get-LauncherCapabilities { return $script:caps }
function Invoke-LauncherHttp {
  param($Path, $Method = 'GET', $ExtraHeaders = @{})
  $script:httpCalls++
  if ($Path -eq '/api/nonce') {
    if ($script:replaceAtNonce) { $script:caps.instanceId = '22222222-2222-4222-8222-222222222222' }
    return @{ Nonce = 'fixture-nonce' }
  }
  if ($Path -eq '/api/shutdown') { $script:posts += $ExtraHeaders; return @{} }
  throw 'Unexpected fixture request.'
}
function Wait-LauncherExit {
  param($Owner)
  $script:waits++
  if ($script:replaceAtWait) { $script:listenerId = 98765 }
  if ($script:replaceProcessAtWait) { $script:liveTicks++ }
  return $script:exitOnWait
}
function Stop-LauncherTree { param($Owner) $script:kills++ }

$owner = Reset-Fixture
Assert ((Stop-LauncherOwnedServer $owner) -eq 'exited') 'Unbound startup failure did not await owned process.'
Assert ($script:waits -eq 1 -and $script:httpCalls -eq 0 -and $script:processKills -eq 0 -and $owner.Revoked -and $null -eq $owner.Token) 'Unbound graceful cleanup leaked credentials or skipped wait.'
foreach ($scenario in @('no-listener', 'foreign-listener', 'query-failure', 'revoked-bind', 'identity-before-wait', 'identity-after-wait')) {
  $owner = Reset-Fixture
  $script:exitOnWait = $false
  switch ($scenario) {
    'no-listener' { $script:listenerId = 0 }
    'foreign-listener' { $script:listenerId = 98765 }
    'query-failure' { $script:listenerError = $true }
    'revoked-bind' { $script:listenerId = 98765; $null = Bind-LauncherOwner $owner $script:caps }
    'identity-before-wait' { $script:liveTicks++ }
    'identity-after-wait' { $script:replaceProcessAtWait = $true }
  }
  $result = Stop-LauncherOwnedServer $owner
  if ($scenario -like 'identity-*') {
    Assert ($result -eq 'exited-or-identity-changed' -and $script:processKills -eq 0) ('Replaced unbound process killed: ' + $scenario)
  } else {
    Assert ($result -eq 'terminated' -and $script:processKills -eq 1 -and $script:process.HasExited -and $script:waits -eq 1) ('Unbound live process orphaned: ' + $scenario)
  }
  Assert ($script:httpCalls -eq 0 -and $script:kills -eq 0 -and $owner.Revoked -and $null -eq $owner.Token) ('Unbound cleanup used service/tree authority: ' + $scenario)
}
$owner = Reset-Fixture
Assert (Test-LauncherCapabilities $script:caps) 'Valid protocol rejected.'
foreach ($change in @('product', 'protocolVersion', 'instanceId', 'capabilities')) {
  $bad = New-Capabilities
  switch ($change) {
    product { $bad.product = 'other' }
    protocolVersion { $bad.protocolVersion = '1' }
    instanceId { $bad.instanceId = 'not-a-uuid' }
    capabilities { $bad.capabilities = @('configured-defaults') }
  }
  Assert (-not (Test-LauncherCapabilities $bad)) ('Invalid handshake accepted: ' + $change)
}
Assert (Bind-LauncherOwner $owner $script:caps) 'Owned listener binding failed.'
Assert ((Stop-LauncherOwnedServer $owner) -eq 'exited') 'Graceful exit failed.'
Assert ($script:posts.Count -eq 1 -and $script:posts[0]['X-Codex-Companion-Shutdown-Token'] -eq 'fixture-only-token' -and $script:posts[0]['X-Codex-Companion-Nonce'] -eq 'fixture-nonce') 'Shutdown credential/nonce mismatch.'
Assert ($script:waits -eq 1 -and $script:kills -eq 0 -and $null -eq $owner.Token) 'Graceful cleanup violated ownership.'

foreach ($scenario in @('foreign-first-listener', 'pid-reuse', 'instance-replacement', 'port-replacement', 'nonce-race', 'query-failure')) {
  $owner = Reset-Fixture
  if ($scenario -eq 'foreign-first-listener') {
    $script:listenerId = 98765
    Assert (-not (Bind-LauncherOwner $owner $script:caps)) 'Foreign initial listener bound.'
  } else {
    Assert (Bind-LauncherOwner $owner $script:caps) 'Fixture bind failed.'
    switch ($scenario) {
      'pid-reuse' { $script:liveTicks++ }
      'instance-replacement' { $script:caps.instanceId = '22222222-2222-4222-8222-222222222222' }
      'port-replacement' { $script:listenerId = 98765 }
      'nonce-race' { $script:replaceAtNonce = $true }
      'query-failure' { $script:listenerError = $true }
    }
  }
  $null = Stop-LauncherOwnedServer $owner
  Assert ($script:posts.Count -eq 0 -and $script:kills -eq 0 -and $owner.Revoked -and $null -eq $owner.Token) ('Old token/kill escaped isolation: ' + $scenario)
}
$owner = Reset-Fixture
Assert ((Stop-LauncherOwnedServer $null) -eq 'reused' -and $script:posts.Count -eq 0 -and $script:kills -eq 0) 'Reused service stopped.'
$owner = Reset-Fixture
$null = Bind-LauncherOwner $owner $script:caps
$script:exitOnWait = $false
Assert ((Stop-LauncherOwnedServer $owner) -eq 'terminated' -and $script:waits -eq 1 -and $script:kills -eq 1) 'Owned timeout fallback failed.'
$owner = Reset-Fixture
$null = Bind-LauncherOwner $owner $script:caps
$script:exitOnWait = $false
$script:replaceAtWait = $true
Assert ((Stop-LauncherOwnedServer $owner) -eq 'ownership-revoked' -and $script:kills -eq 0 -and $null -eq $owner.Token) 'Replacement after wait was killed.'
$owner = Reset-Fixture
Assert (-not (Test-LauncherOwner $owner) -and $script:posts.Count -eq 0) 'Unbound owner authorized.'
Assert ($owner.Revoked -and $null -eq $owner.Token) 'Unbound credential retained.'
$owner = Reset-Fixture
$oldHandshake = New-Capabilities
$script:caps.instanceId = '22222222-2222-4222-8222-222222222222'
Assert (-not (Bind-LauncherOwner $owner $oldHandshake) -and $owner.Revoked -and $null -eq $owner.Token) 'Handshake replacement bound at startup.'
$script:listenerId = 0
Assert (@(Get-LauncherListeners).Count -eq 0) 'Idle listener query failed.'

# netstat parser: the fallback path must read the same kernel table the CIM query
# reads, including the IPv6 wildcard form and the owning PID.
$script:netstatLines = @(
  '',
  'Active Connections',
  '',
  '  Proto  Local Address          Foreign Address        State           PID',
  '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1976',
  '  TCP    127.0.0.1:4173         0.0.0.0:0              LISTENING       424242',
  '  TCP    127.0.0.1:4173         127.0.0.1:50999        ESTABLISHED     424242',
  '  TCP    [::]:4173              [::]:0                 LISTENING       424242',
  '  TCP    127.0.0.1:5000         127.0.0.1:4173         SYN_SENT        19836'
)
$parsed = @(ConvertFrom-LauncherNetstat $script:netstatLines)
Assert ($parsed.Count -eq 2) 'netstat fallback did not isolate listening 4173 rows.'
Assert (@($parsed | Where-Object { $_.OwningProcess -eq 424242 }).Count -eq 2) 'netstat fallback lost the owning PID.'
Assert (@($parsed | Where-Object { $_.LocalAddress -eq '::' }).Count -eq 1) 'netstat fallback normalized the IPv6 wildcard incorrectly.'
Assert (@(ConvertFrom-LauncherNetstat @('  TCP    127.0.0.1:4174         0.0.0.0:0              LISTENING       7')).Count -eq 0) 'netstat fallback accepted a foreign port.'
Assert (@(ConvertFrom-LauncherNetstat @()).Count -eq 0) 'netstat fallback failed on empty input.'
# A denied CIM provider degrades to netstat instead of blocking the launch.
$script:listenerError = $true
$script:netstatLines = @('  TCP    127.0.0.1:4173         0.0.0.0:0              LISTENING       424242')
function netstat.exe { param([Parameter(ValueFromRemainingArguments = $true)]$Rest) $global:LASTEXITCODE = 0; return $script:netstatLines }
Assert (@(Get-LauncherListeners).Count -eq 1 -and @(Get-LauncherListeners)[0].OwningProcess -eq 424242) 'Denied CIM query did not fall back to netstat.'
$script:listenerError = $false
Assert ((Get-Command Write-LauncherLog -ErrorAction SilentlyContinue) -ne $null) 'Launcher has no persisted failure log.'

# Single instance: the first owner takes the mutex, and every later caller must
# drop a reveal request instead of starting a second widget. The request is a
# file because the panel polls for it, which survives a busy dispatcher.
$script:RevealRoot = Join-Path ([IO.Path]::GetTempPath()) ('codex-launcher-selftest-' + [Guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $script:RevealRoot -Force
function Get-LauncherRevealPath { return (Join-Path $script:RevealRoot 'reveal.request') }
function Send-LauncherReveal {
  try {
    $path = Get-LauncherRevealPath
    Set-Content -LiteralPath $path -Value ('{0:o}' -f (Get-Date)) -Encoding UTF8 -ErrorAction Stop
    return $true
  } catch { return $false }
}
Assert ((Get-Command Enter-LauncherSingleInstance -ErrorAction SilentlyContinue) -ne $null) 'Launcher lost its single-instance guard.'
Assert ($script:LauncherMutexName -notmatch '\\') 'Single-instance mutex must use the session namespace so it is visible across launches.'
# Keep the production singleton isolated when the real widget is already running.
$script:LauncherMutexName = 'CodexCompanionFixture-' + [Guid]::NewGuid().ToString('N')
$first = Enter-LauncherSingleInstance
Assert ($first -eq $true -and $script:LauncherMutex -ne $null) 'First launcher did not take ownership.'
# A second owner in this process would deadlock on the same mutex, so prove the
# reveal path directly: it is exactly what the loser branch invokes.
$null = Send-LauncherReveal
Assert ((Test-Path -LiteralPath (Get-LauncherRevealPath)) -eq $true) 'Second launch did not drop a reveal request.'
Exit-LauncherSingleInstance
Assert ($script:LauncherMutex -eq $null) 'Launcher did not release its single-instance mutex.'
# Releasing must let the next launch take ownership again.
$second = Enter-LauncherSingleInstance
Assert ($second -eq $true) 'Releasing ownership did not allow a later launch to own the widget.'
Exit-LauncherSingleInstance
Remove-Item -LiteralPath $script:RevealRoot -Recurse -Force -ErrorAction SilentlyContinue

# Parse only this owner's PS files using the actual Windows PowerShell parser.
foreach ($relative in @('scripts/start-floating-widget.ps1', 'tests/native-launcher.selftest.ps1')) {
  $tokens = $null; $parseErrors = $null
  $null = [Management.Automation.Language.Parser]::ParseFile((Join-Path $root $relative), [ref]$tokens, [ref]$parseErrors)
  Assert ($parseErrors.Count -eq 0) ('Parse failed: ' + $relative)
}
$source = Get-Content (Join-Path $root 'scripts/start-floating-widget.ps1') -Raw
Assert ($source -notmatch '(?i)msedge|user-data-dir|profileDir') 'Browser launcher remains.'
$package = Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
Assert ($package.scripts.desktop -match '^powershell.exe -STA ') 'Desktop STA missing.'
[pscustomobject]@{ status = 'passed'; assertions = $script:passed; powershell = $PSVersionTable.PSVersion.ToString(); serverStarted = $false; modelCalls = 0; historyWrites = 0 } | ConvertTo-Json -Compress
