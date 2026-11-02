[CmdletBinding()]
param([string]$ExePath)
$ErrorActionPreference = 'Stop'
function Write-CiError([string]$Message) {
    if ($env:GITHUB_ACTIONS -eq 'true') {
        $escaped = $Message.Replace('%', '%25').Replace("`r", '%0D').Replace("`n", '%0A')
        Write-Host ('::error title=Portable EXE verification::' + $escaped)
    }
}
trap {
    Write-CiError ($_.Exception.Message + "`n" + $_.ScriptStackTrace)
    throw
}
if (-not $ExePath) { $ExePath = Join-Path $PSScriptRoot '../dist/Codex-Stateline.exe' }
$ExePath = [IO.Path]::GetFullPath($ExePath)
if (-not (Test-Path -LiteralPath $ExePath -PathType Leaf)) { throw 'Build the portable EXE before running this check.' }
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$testRoot = Join-Path $workspace ('.test-tmp/portable-' + [Guid]::NewGuid().ToString('N'))
$downloads = Join-Path $testRoot ('download space ' + [char]0x4E2D + [char]0x6587)
$localData = Join-Path $testRoot ('local app data ' + [char]0x6D4B + [char]0x8BD5)
$null = [IO.Directory]::CreateDirectory($downloads)
$null = [IO.Directory]::CreateDirectory($localData)
$singleExe = Join-Path $downloads 'Codex-Stateline.exe'
[IO.File]::Copy($ExePath, $singleExe)
$script:checks = 0
function Assert($Condition, [string]$Message) { if (-not $Condition) { throw $Message }; $script:checks++ }
function Run-Package([string]$Mode, [string]$Name, [int]$ExpectedExit = 0) {
    $report = Join-Path $testRoot ($Name + '.json')
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName = $singleExe
    $start.Arguments = $Mode + ' "' + $report + '"'
    $start.WorkingDirectory = $downloads
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
    $start.EnvironmentVariables['LOCALAPPDATA'] = $localData
    $start.EnvironmentVariables['PATH'] = $env:WINDIR + ';' + (Join-Path $env:WINDIR 'System32') + ';' + (Join-Path $env:WINDIR 'System32/WindowsPowerShell/v1.0')
    $start.EnvironmentVariables['NODE_OPTIONS'] = '--require=portable-test-must-not-load-this'
    $start.EnvironmentVariables['NODE_PATH'] = 'portable-test-must-not-load-this'
    $start.EnvironmentVariables['CODEX_EXE'] = (Join-Path $testRoot 'must-not-call-codex.exe')
    $process = [Diagnostics.Process]::Start($start)
    try {
        if (-not $process.WaitForExit(120000)) { $process.Kill(); throw ('Packaged runtime timed out: ' + $Name) }
        if ($process.ExitCode -ne $ExpectedExit -and (Test-Path -LiteralPath $report)) {
            $content = Get-Content -LiteralPath $report -Raw -Encoding UTF8
            Write-Output $content
            $failure = $content | ConvertFrom-Json
            Write-CiError ('Packaged ' + $Name + ': ' + $failure.Error + "`n" + $failure.Stack)
        }
        Assert ($process.ExitCode -eq $ExpectedExit) ('Unexpected package exit for ' + $Name + ': ' + $process.ExitCode + '; report: ' + $report)
    } finally { $process.Dispose() }
    Assert (Test-Path -LiteralPath $report) ('Package did not emit its report: ' + $Name)
    return (Get-Content -LiteralPath $report -Raw -Encoding UTF8 | ConvertFrom-Json)
}

$cold = Run-Package '--verify' 'cold'
Assert ($cold.Status -eq 'PASS' -and $cold.Architecture -eq 'x64' -and $cold.Files -gt 20) 'Cold extraction did not verify the full payload.'
$cache = $cold.CacheRoot
Assert ($cache.StartsWith(($localData + '\'), [StringComparison]::OrdinalIgnoreCase)) 'Package did not use its user-local cache.'
Assert (Test-Path -LiteralPath (Join-Path $cache 'runtime/NODE-LICENSE.txt')) 'Node license was not included.'
$nodeTime = (Get-Item -LiteralPath (Join-Path $cache 'runtime/node.exe')).LastWriteTimeUtc.Ticks
$warm = Run-Package '--verify' 'warm'
Assert ($warm.CacheRoot -ceq $cache -and (Get-Item -LiteralPath (Join-Path $cache 'runtime/node.exe')).LastWriteTimeUtc.Ticks -eq $nodeTime) 'Warm launch rewrote a verified runtime.'

$html = Join-Path $cache 'src/public/index.html'
$original = (Get-FileHash -LiteralPath $html -Algorithm SHA256).Hash
$bytes = [IO.File]::ReadAllBytes($html); $bytes[0] = $bytes[0] -bxor 1; [IO.File]::WriteAllBytes($html, $bytes)
$repaired = Run-Package '--verify' 'repair'
Assert ($repaired.Status -eq 'PASS' -and (Get-FileHash -LiteralPath $html -Algorithm SHA256).Hash -ceq $original) 'Same-size cache corruption was not repaired.'
Assert (@(Get-ChildItem -LiteralPath (Split-Path -Parent $cache) -Directory -Filter 'damaged-*').Count -eq 1) 'Damaged cache was not retained separately.'

$outside = Join-Path $testRoot 'outside-cache'
$null = [IO.Directory]::CreateDirectory($outside)
$sentinel = Join-Path $outside 'sentinel.txt'; [IO.File]::WriteAllText($sentinel, 'do not change')
$junction = Join-Path $cache 'unsafe-link'
$null = New-Item -ItemType Junction -Path $junction -Target $outside
try {
    $refused = Run-Package '--verify' 'reparse' 1
    Assert ($refused.Status -eq 'FAIL' -and $refused.Error -match 'reparse point') 'Cache reparse point was not refused.'
    Assert ([IO.File]::ReadAllText($sentinel) -ceq 'do not change') 'Cache verification modified an external target.'
} finally {
    if (-not [IO.Path]::GetFullPath($junction).StartsWith(($testRoot + '\'), [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe fixture cleanup path.' }
    [IO.Directory]::Delete($junction)
}

# Unit-check path/quoting helpers without relaxing .NET's policy on loading an external EXE as an assembly.
# The extraction, repair, reparse and server/UI checks execute the actual packaged EXE independently.
Add-Type -Path (Join-Path $workspace 'scripts/portable/PortableLauncher.cs') -ReferencedAssemblies @(
    'System.dll','System.Core.dll','System.IO.Compression.dll','System.IO.Compression.FileSystem.dll',
    'System.Web.Extensions.dll','System.Windows.Forms.dll')
$assembly = [CodexStateline.Portable.PackageManifest].Assembly
$program = $assembly.GetType('CodexStateline.Portable.Program', $true)
$validate = $program.GetMethod('ValidateName', [Reflection.BindingFlags]'Static,NonPublic')
foreach ($bad in @('../escape', '/absolute', 'C:/absolute', 'a\escape', 'a/../escape', 'a/file:stream', 'a//empty', 'a/trailing.', 'CON.txt', 'a/LPT1')) {
    $threw = $false
    try { $null = $validate.Invoke($null, @($bad)) } catch { $threw = $_.Exception.GetBaseException() -is [IO.IOException] }
    Assert $threw ('Unsafe archive path accepted: ' + $bad)
}
$null = $validate.Invoke($null, @('src/public/index.html'))
$quote = $program.GetMethod('Quote', [Reflection.BindingFlags]'Static,NonPublic')
Assert ($quote.Invoke($null, @('C:\folder with space\')) -ceq '"C:\folder with space\\"') 'Windows argument quoting lost a trailing backslash.'

$smoke = Run-Package '--self-test' 'runtime'
Assert ($smoke.Status -eq 'PASS' -and $smoke.UiOpened -and $smoke.ServerStopped -and $smoke.RealModelCalls -eq 0) 'Packaged server/UI/cleanup acceptance failed.'
Assert ($smoke.NodePath -ceq (Join-Path $cache 'runtime/node.exe') -and $smoke.NodeVersion -ceq ('v' + $cold.NodeVersion)) 'Packaged service used a system Node runtime.'
Assert (@(Get-ChildItem -LiteralPath $downloads -Force).Count -eq 1) 'Single-file download wrote adjacent runtime/config files.'
Write-Output (@{status='PASS'; checks=$script:checks; pathWithoutNode=$true; unicodeAndSpaces=$true;
    singleFile=$true; realModelCalls=0; evidence=$testRoot; screenshot=$smoke.Screenshot} | ConvertTo-Json -Compress)
