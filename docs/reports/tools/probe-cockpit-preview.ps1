[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$InstanceId,
  [Parameter(Mandatory=$true)][string]$RunId,
  [Parameter(Mandatory=$true)][string]$ContentDigest,
  [int]$TimeoutSeconds = 75
)
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot '../../../scripts/native-widget.ps1') -LoadOnly
$preview = New-Object CodexNative.BrowserPreview
$flags = [Reflection.BindingFlags]::Instance -bor [Reflection.BindingFlags]::NonPublic
$target = New-Object CodexNative.PreviewTarget
$target.InstanceId = $InstanceId
$target.RunId = $RunId
$target.Mode = 'cockpit'
$target.Version = 'pelican-cockpit-v1'
$target.ServiceGeneration = 1
$target.WindowGeneration = 1
$target.SelectionGeneration = 1
$presentationField = $target.GetType().GetField('Presentation', $flags)
$presentationField.SetValue($target, [Enum]::Parse($presentationField.FieldType, 'Inline'))
$target.GetType().GetField('CaptureFrames', $flags).SetValue($target, $true)
$target.GetType().GetField('ContentDigest', $flags).SetValue($target, $ContentDigest)
$started = [Diagnostics.Stopwatch]::StartNew()
$guardField = $preview.GetType().GetField('guard', $flags)
try {
  $null = $preview.SetTargetAsync($target, [CodexNative.PreviewOpenReason]::ExplicitOpen)
  $lastState = ''
  for ($i = 0; $i -lt $TimeoutSeconds * 2; $i++) {
    $snapshot = $preview.Snapshot
    if ($snapshot.State -ne $lastState) {
      [pscustomobject]@{事件='状态';耗时秒=[math]::Round($started.Elapsed.TotalSeconds, 1);状态=$snapshot.State;错误=$snapshot.ErrorCode} | Format-List
      $lastState = $snapshot.State
    }
    if ($snapshot.State -eq 'error' -or ($snapshot.State -eq 'closed' -and $lastState -in @('starting', 'open'))) { break }
    $guard = $guardField.GetValue($preview)
    $guardReady = $null -ne $guard -and [bool]$guard.GetType().GetProperty('InputReady', $flags).GetValue($guard)
    if ($guardReady) {
      [pscustomobject]@{事件='画面与交互已就绪';耗时秒=[math]::Round($started.Elapsed.TotalSeconds, 1);状态=$snapshot.State} | Format-List
      break
    }
    Start-Sleep -Milliseconds 500
  }
  $guard = $guardField.GetValue($preview)
  $guardReady = $null -ne $guard -and [bool]$guard.GetType().GetProperty('InputReady', $flags).GetValue($guard)
  if (-not $guardReady -and $preview.Snapshot.State -notin @('error', 'closed')) {
    [pscustomobject]@{事件='等待超时';耗时秒=[math]::Round($started.Elapsed.TotalSeconds, 1);状态=$preview.Snapshot.State} | Format-List
  }
  $guardState = if ($null -ne $guard) { $guard.GetType().GetProperty('SecurityState', $flags).GetValue($guard) } else { '尚未创建' }
  [pscustomobject]@{诊断=$preview.GuardDiagnostic;浏览器状态=$guardState} | Format-List
} finally {
  $preview.Dispose()
}
