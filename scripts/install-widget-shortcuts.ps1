# Creates the desktop launch button for the portable Codex widget.
# No installer and no registry: the shortcut points at wscript.exe hosting the
# VBS, so a double-click never flashes a console window.
[CmdletBinding()]
param(
  [switch]$Startup,
  [switch]$Uninstall,
  [string]$Name = 'Codex 小组件'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$vbs = Join-Path $root 'Start-Codex-Widget.vbs'
$sourceIcon = Join-Path $root 'assets/codex-widget.ico'

# A .lnk IconLocation is a `path,index` string. Explorer resolves it with a
# naive comma/space split, so an icon under a path containing spaces (as this
# checkout is: "...\claude code\;...") renders as a blank generic page no
# matter how the value is quoted. Staging the icon under %LOCALAPPDATA% - which
# never contains spaces - is what actually fixes the white shortcut.
$iconStage = Join-Path (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'codex-companion') 'widget.ico'

if ($Uninstall) {
  $removed = @()
  foreach ($dir in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Startup'))) {
    $path = Join-Path $dir ($Name + '.lnk')
    if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force; $removed += $path }
  }
  if ($removed.Count -eq 0) { Write-Output 'nothing to remove' } else { Write-Output ('removed: ' + ($removed -join '; ')) }
  return
}

if (-not (Test-Path -LiteralPath $vbs -PathType Leaf)) { throw "Missing launcher: $vbs" }
$wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
if (-not (Test-Path -LiteralPath $wscript -PathType Leaf)) { throw "Missing wscript.exe: $wscript" }

# Regenerate the source icon when it is absent.
if (-not (Test-Path -LiteralPath $sourceIcon -PathType Leaf)) {
  $maker = Join-Path $PSScriptRoot 'make-widget-icon.ps1'
  if (Test-Path -LiteralPath $maker -PathType Leaf) {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $maker -OutputPath $sourceIcon | Out-Null
  }
}

$iconForShortcut = $null
if (Test-Path -LiteralPath $sourceIcon -PathType Leaf) {
  if ($iconStage -match '\s') {
    throw "Refusing to stage the icon at '$iconStage': shortcut icon paths cannot contain spaces."
  }
  $stageDir = Split-Path -Parent $iconStage
  if (-not (Test-Path -LiteralPath $stageDir)) { $null = New-Item -ItemType Directory -Path $stageDir -Force }
  Copy-Item -LiteralPath $sourceIcon -Destination $iconStage -Force
  $iconForShortcut = $iconStage
  Write-Output ('icon staged: ' + $iconStage)
}

$targets = @(Join-Path ([Environment]::GetFolderPath('Desktop')) ($Name + '.lnk'))
if ($Startup) { $targets += Join-Path ([Environment]::GetFolderPath('Startup')) ($Name + '.lnk') }

$written = @()
foreach ($target in $targets) {
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($target)
  # wscript.exe is a GUI host: it never allocates a console for the VBS.
  $shortcut.TargetPath = $wscript
  $shortcut.Arguments = '"' + $vbs + '"'
  $shortcut.WorkingDirectory = $root
  $shortcut.WindowStyle = 7
  $shortcut.Description = '启动 Codex 状态桌面小组件'
  if ($iconForShortcut) { $shortcut.IconLocation = $iconForShortcut + ',0' }
  $shortcut.Save()

  # Read back so a silent WScript.Shell failure cannot ship a broken button.
  $check = $shell.CreateShortcut($target)
  if ($check.TargetPath -ne $wscript) { throw "Shortcut target mismatch in $target" }
  if ($check.Arguments -notlike ('*' + $vbs + '*')) { throw "Shortcut arguments mismatch in $target" }
  if ($iconForShortcut -and $check.IconLocation -notlike ($iconForShortcut + '*')) {
    throw "Shortcut icon mismatch in $target (got '$($check.IconLocation)')"
  }
  $written += $target
}
Write-Output ('created: ' + ($written -join '; '))
if ($written.Count -gt 1) { Write-Output 'startup entry enabled' }
