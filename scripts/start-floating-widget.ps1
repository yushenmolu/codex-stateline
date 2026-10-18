# Windows PowerShell 5.1. Dot-sourcing loads functions without starting services.
$ErrorActionPreference = 'Stop'
$script:CompanionOrigin = 'http://127.0.0.1:4173'

function Invoke-LauncherHttp([string]$Path, [string]$Method = 'GET', [hashtable]$ExtraHeaders = @{}) {
  if ($Path -notin @('/api/capabilities', '/api/nonce', '/api/shutdown')) { throw 'Unsupported launcher endpoint.' }
  $request = [Net.HttpWebRequest]::Create($script:CompanionOrigin + $Path)
  $request.Proxy = $null
  $request.AllowAutoRedirect = $false
  $request.Timeout = 2000
  $request.ReadWriteTimeout = 2000
  $request.Method = $Method
  $request.Accept = 'application/json'
  $request.Headers['Origin'] = $script:CompanionOrigin
  foreach ($key in $ExtraHeaders.Keys) { $request.Headers[$key] = $ExtraHeaders[$key] }
  $response = $null
  $stream = $null
  $clock = [Diagnostics.Stopwatch]::StartNew()
  try {
    if ($Method -eq 'POST') {
      $request.ContentType = 'application/json'
      $request.ContentLength = 2
      $body = $request.GetRequestStream()
      try { $body.Write([Text.Encoding]::UTF8.GetBytes('{}'), 0, 2) } finally { $body.Dispose() }
    }
    $response = $request.GetResponse()
    if ([int]$response.StatusCode -ne 200 -or $response.ContentType -notmatch '^application/json(?:;|$)') { throw 'Expected successful JSON response.' }
    $stream = $response.GetResponseStream()
    $buffer = New-Object byte[] 4096
    $output = New-Object IO.MemoryStream
    try {
      while ($true) {
        $remaining = 2000 - [int]$clock.ElapsedMilliseconds
        if ($remaining -le 0) { throw 'Launcher request deadline exceeded.' }
        $stream.ReadTimeout = $remaining
        $count = $stream.Read($buffer, 0, $buffer.Length)
        if ($count -eq 0) { break }
        if ($output.Length + $count -gt 65536) { throw 'Launcher response exceeds 64 KiB.' }
        $output.Write($buffer, 0, $count)
      }
      return @{ Data = ([Text.Encoding]::UTF8.GetString($output.ToArray()) | ConvertFrom-Json); Nonce = $response.Headers['X-Codex-Companion-Nonce'] }
    } finally { $output.Dispose() }
  } finally {
    if ($stream) { $stream.Dispose() }
    if ($response) { $response.Dispose() }
    $request.Abort()
  }
}
function Get-LauncherCapabilities { return (Invoke-LauncherHttp '/api/capabilities').Data }
function Test-LauncherCapabilities($Capabilities) {
  if ($null -eq $Capabilities -or $Capabilities.product -cne 'codex-companion' -or
      $Capabilities.protocolVersion -isnot [int] -or $Capabilities.protocolVersion -ne 1 -or
      $Capabilities.instanceId -isnot [string] -or
      $Capabilities.instanceId -cnotmatch '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$') { return $false }
  if ($Capabilities.capabilities -isnot [array]) { return $false }
  foreach ($item in $Capabilities.capabilities) { if ($item -isnot [string]) { return $false } }
  foreach ($required in @('configured-defaults', 'pelican-svg-v2', 'versioned-scoring')) {
    if ($Capabilities.capabilities -cnotcontains $required) { return $false }
  }
  return $true
}
function Get-LauncherListeners {
  # Query failure is an error, never evidence of an idle port. Include wildcard listeners.
  return @(Get-NetTCPConnection -State Listen -ErrorAction Stop |
    Where-Object { $_.LocalPort -eq 4173 -and $_.LocalAddress -in @('127.0.0.1', '0.0.0.0', '::', '::1') })
}
function Test-LauncherProcess($Owner) {
  try {
    $Owner.Process.Refresh()
    if ($Owner.Process.HasExited -or $Owner.Process.StartTime.ToUniversalTime().Ticks -ne $Owner.StartTicks) { return $false }
    $current = Get-Process -Id $Owner.Process.Id -ErrorAction Stop
    try { return ($current.StartTime.ToUniversalTime().Ticks -eq $Owner.StartTicks) } finally { $current.Dispose() }
  } catch { return $false }
}
function Test-LauncherListener($Owner) {
  try {
    $listeners = @(Get-LauncherListeners)
    return ($listeners.Count -gt 0 -and @($listeners | Where-Object { $_.OwningProcess -ne $Owner.Process.Id }).Count -eq 0)
  } catch { return $false }
}
function Revoke-LauncherOwner($Owner) { $Owner.Revoked = $true; $Owner.Token = $null }
function Bind-LauncherOwner($Owner, $Capabilities) {
  if ($Owner.Revoked -or $Owner.InstanceId -or -not (Test-LauncherCapabilities $Capabilities) -or
      -not (Test-LauncherProcess $Owner) -or -not (Test-LauncherListener $Owner)) {
    Revoke-LauncherOwner $Owner
    return $false
  }
  # Confirm the handshake again inside the verified listener interval.
  try {
    $confirmed = Get-LauncherCapabilities
    if (-not (Test-LauncherCapabilities $confirmed) -or $confirmed.instanceId -cne $Capabilities.instanceId -or
        -not (Test-LauncherProcess $Owner) -or -not (Test-LauncherListener $Owner)) { throw 'Initial handshake changed.' }
  } catch { Revoke-LauncherOwner $Owner; return $false }
  $Owner.InstanceId = $Capabilities.instanceId
  return $true
}
function Test-LauncherOwner($Owner) {
  if ($null -eq $Owner) { return $false }
  if ($Owner.Revoked -or -not $Owner.InstanceId -or -not $Owner.Token) { Revoke-LauncherOwner $Owner; return $false }
  try {
    if (-not (Test-LauncherProcess $Owner) -or -not (Test-LauncherListener $Owner)) { throw 'Ownership changed.' }
    $capabilities = Get-LauncherCapabilities
    if (-not (Test-LauncherCapabilities $capabilities) -or $capabilities.instanceId -cne $Owner.InstanceId -or
        -not (Test-LauncherProcess $Owner) -or -not (Test-LauncherListener $Owner)) { throw 'Server instance changed.' }
    return $true
  } catch { Revoke-LauncherOwner $Owner; return $false }
}
function Wait-LauncherExit($Owner) { return $Owner.Process.WaitForExit(10000) }
function Stop-LauncherTree($Owner) {
  & taskkill.exe /PID $Owner.Process.Id /T /F | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Owned tree termination was not confirmed.' }
}
function Stop-LauncherUnboundProcess($Owner) {
  # No service authority exists before binding. Discard the credential and use
  # only the original Process handle, never the listener PID or a process tree.
  Revoke-LauncherOwner $Owner
  if (-not (Test-LauncherProcess $Owner)) { return 'exited-or-identity-changed' }
  $null = $Owner.Process.Handle
  if (-not (Test-LauncherProcess $Owner)) { return 'exited-or-identity-changed' }
  if (Wait-LauncherExit $Owner) { return 'exited' }
  if (-not (Test-LauncherProcess $Owner)) { return 'exited-or-identity-changed' }
  $Owner.Process.Kill()
  if ($Owner.Process.WaitForExit(2000)) { return 'terminated' }
  return 'cleanup-unconfirmed'
}
function Stop-LauncherOwnedServer($Owner) {
  if ($null -eq $Owner) { return 'reused' }
  if (-not $Owner.InstanceId) { return (Stop-LauncherUnboundProcess $Owner) }
  if (-not (Test-LauncherProcess $Owner)) { Revoke-LauncherOwner $Owner; return 'exited-or-identity-changed' }
  if (-not (Test-LauncherOwner $Owner)) { return 'ownership-revoked' }
  try {
    $nonce = (Invoke-LauncherHttp '/api/nonce').Nonce
    if (-not $nonce) { throw 'Shutdown nonce unavailable.' }
    # Nonce retrieval may race replacement; recheck before sending the credential.
    if (-not (Test-LauncherOwner $Owner)) { return 'ownership-revoked' }
    Invoke-LauncherHttp '/api/shutdown' 'POST' @{
      'X-Codex-Companion-Nonce' = $nonce
      'X-Codex-Companion-Shutdown-Token' = $Owner.Token
    } | Out-Null
  } catch { Write-Warning 'Graceful shutdown unavailable; waiting for the owned process.' }
  if (Wait-LauncherExit $Owner) { Revoke-LauncherOwner $Owner; return 'exited' }
  if (-not (Test-LauncherOwner $Owner)) { return 'ownership-revoked' }
  Stop-LauncherTree $Owner
  if ($Owner.Process.WaitForExit(2000)) { Revoke-LauncherOwner $Owner; return 'terminated' }
  return 'cleanup-unconfirmed'
}
function Show-LauncherDiagnostic([string]$Message) {
  Add-Type -AssemblyName PresentationFramework
  [Windows.MessageBox]::Show($Message, 'Codex native widget', 'OK', 'Warning') | Out-Null
}
function Start-NativeLauncher {
  $projectRoot = Split-Path -Parent $PSScriptRoot
  $nativePath = Join-Path $PSScriptRoot 'native-widget.ps1'
  $owner = $null
  try {
    if ($PSVersionTable.PSVersion.Major -ne 5 -or [Threading.Thread]::CurrentThread.ApartmentState -ne 'STA') {
      throw 'Use Windows PowerShell 5.1 STA: powershell.exe -STA -NoProfile -ExecutionPolicy Bypass -File scripts/start-floating-widget.ps1'
    }
    if (-not (Test-Path -LiteralPath $nativePath -PathType Leaf)) { throw 'Native UI unavailable: scripts/native-widget.ps1. Complete the native UI installation before launching.' }
    $listeners = @(Get-LauncherListeners)
    if ($listeners.Count -eq 0) {
      $node = Get-Command node.exe -ErrorAction Stop
      $bytes = New-Object byte[] 32
      $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
      try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
      $token = [BitConverter]::ToString($bytes).Replace('-', '').ToLowerInvariant()
      $previous = [Environment]::GetEnvironmentVariable('CODEX_COMPANION_SHUTDOWN_TOKEN', 'Process')
      try {
        [Environment]::SetEnvironmentVariable('CODEX_COMPANION_SHUTDOWN_TOKEN', $token, 'Process')
        $process = Start-Process -FilePath $node.Source -ArgumentList @('src/server.js') -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru
        $owner = @{ Process = $process; StartTicks = $process.StartTime.ToUniversalTime().Ticks; InstanceId = $null; Token = $token; Revoked = $false }
        # Retain the original OS handle before startup polling or PID reuse.
        $null = $process.Handle
      } finally {
        [Environment]::SetEnvironmentVariable('CODEX_COMPANION_SHUTDOWN_TOKEN', $previous, 'Process')
        $token = $null
      }
      $ready = $false
      for ($attempt = 0; $attempt -lt 40; $attempt++) {
        if (-not (Test-LauncherProcess $owner)) { throw 'The owned local server exited during startup.' }
        try {
          $capabilities = Get-LauncherCapabilities
          $ready = Test-LauncherCapabilities $capabilities
        } catch { $ready = $false }
        if ($ready) { break }
        Start-Sleep -Milliseconds 250
      }
      if (-not $ready -or -not (Bind-LauncherOwner $owner $capabilities)) {
        throw 'Native protocol v1 could not be bound to the owned listener. An old or unknown service may occupy port 4173. No foreign service will be stopped.'
      }
    } else {
      try { $capabilities = Get-LauncherCapabilities } catch { $capabilities = $null }
      if (-not (Test-LauncherCapabilities $capabilities)) {
        throw 'Port 4173 is occupied by an old, unknown or incompatible service. Native Codex protocol v1 is required. Stop that service manually and retry; this launcher will not terminate it.'
      }
    }
    # Same PS5 STA process; UI owns windows only. Shutdown follows main-window close.
    & $nativePath
  } catch {
    Show-LauncherDiagnostic $_.Exception.Message
    throw
  } finally {
    if ($owner) {
      try {
        $cleanup = Stop-LauncherOwnedServer $owner
        if ($cleanup -notin @('exited', 'terminated')) { Write-Warning ('Server cleanup: ' + $cleanup + '. No unverified process was stopped.') }
      } catch { Write-Warning 'Server cleanup could not be confirmed; inspect the owned process manually.' }
      finally { $owner.Token = $null; $owner.Process.Dispose() }
    }
  }
}
if ($MyInvocation.InvocationName -ne '.') { Start-NativeLauncher }
