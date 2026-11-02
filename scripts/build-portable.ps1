[CmdletBinding()]
param([string]$OutputDirectory, [string]$NodeArchive)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $root 'dist' }
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
$package = Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
$runtime = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'portable/node-runtime.json') -Raw | ConvertFrom-Json
if ($package.version -notmatch '^\d+\.\d+\.\d+$' -or $runtime.version -notmatch '^\d+\.\d+\.\d+$' -or
    $runtime.architecture -cne 'x64' -or $runtime.archive -cne ('node-v' + $runtime.version + '-win-x64.zip') -or
    $runtime.sha256 -cnotmatch '^[0-9a-f]{64}$') { throw 'Invalid package/runtime version manifest.' }
Add-Type -AssemblyName System.IO.Compression,System.IO.Compression.FileSystem
$utf8 = New-Object Text.UTF8Encoding $false
$build = Join-Path $root ('build/portable/' + [Guid]::NewGuid().ToString('N'))
$payload = Join-Path $build 'payload'
$null = [IO.Directory]::CreateDirectory($payload)
$null = [IO.Directory]::CreateDirectory($OutputDirectory)

if (-not $NodeArchive) {
    $downloads = Join-Path $root 'build/downloads'
    $null = [IO.Directory]::CreateDirectory($downloads)
    $NodeArchive = Join-Path $downloads $runtime.archive
    if (-not (Test-Path -LiteralPath $NodeArchive)) {
        $url = 'https://nodejs.org/dist/v' + $runtime.version + '/' + $runtime.archive
        Write-Output ('Downloading official Node.js runtime: ' + $url)
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -Uri $url -OutFile $NodeArchive -UseBasicParsing -TimeoutSec 180
    }
}
$NodeArchive = [IO.Path]::GetFullPath($NodeArchive)
if ((Get-FileHash -LiteralPath $NodeArchive -Algorithm SHA256).Hash.ToLowerInvariant() -cne $runtime.sha256) {
    throw 'Node archive SHA-256 mismatch. No unverified runtime will be packaged.'
}

# Copy only executable assets; never enumerate runtime evidence, home/config files or the whole repository.
$files = @('package.json', 'scripts/start-floating-widget.ps1', 'scripts/native-widget.ps1',
    'scripts/native/SafeSvg.cs', 'scripts/native/WidgetClient.cs', 'scripts/native/BrowserPreview.cs',
    'scripts/native/CockpitBrowserGuard.cs', 'scripts/native/TrayIcon.cs', 'scripts/portable/portable-selftest.ps1')
$files += @(Get-ChildItem -LiteralPath (Join-Path $root 'src') -File -Recurse | ForEach-Object {
    $_.FullName.Substring($root.Length + 1).Replace('\', '/')
})
foreach ($name in $files) {
    $source = Join-Path $root $name
    if ((Get-Item -LiteralPath $source -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw ('Reparse point in package input: ' + $name) }
    $target = Join-Path $payload $name
    $null = [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target))
    [IO.File]::Copy($source, $target)
}

$zip = [IO.Compression.ZipFile]::OpenRead($NodeArchive)
try {
    $prefix = 'node-v' + $runtime.version + '-win-x64/'
    foreach ($asset in @(@{Source='node.exe'; Target='runtime/node.exe'}, @{Source='LICENSE'; Target='runtime/NODE-LICENSE.txt'})) {
        $entry = $zip.GetEntry($prefix + $asset.Source)
        if (-not $entry) { throw ('Missing official runtime asset: ' + $asset.Source) }
        $target = Join-Path $payload $asset.Target
        $null = [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target))
        [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $false)
    }
} finally { $zip.Dispose() }
$actualVersion = & (Join-Path $payload 'runtime/node.exe') --version
if ($LASTEXITCODE -ne 0 -or $actualVersion -cne ('v' + $runtime.version)) { throw 'Bundled Node runtime version check failed.' }

$fileTable = @()
$archivePath = Join-Path $build 'payload.zip'
$stream = [IO.File]::Open($archivePath, [IO.FileMode]::CreateNew)
$archive = New-Object IO.Compression.ZipArchive($stream, [IO.Compression.ZipArchiveMode]::Create, $false)
try {
    foreach ($file in (Get-ChildItem -LiteralPath $payload -Recurse -File | Sort-Object FullName)) {
        $relative = $file.FullName.Substring($payload.Length + 1).Replace('\', '/')
        $fileTable += [ordered]@{Path=$relative; Length=$file.Length; Sha256=(Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}
        $entry = $archive.CreateEntry($relative, [IO.Compression.CompressionLevel]::Optimal)
        $entry.LastWriteTime = [DateTimeOffset]::new(2020, 1, 1, 0, 0, 0, [TimeSpan]::Zero)
        $input = [IO.File]::OpenRead($file.FullName)
        $output = $entry.Open()
        try { $input.CopyTo($output) } finally { $output.Dispose(); $input.Dispose() }
    }
} finally { $archive.Dispose(); $stream.Dispose() }
$revision = (& git -C $root rev-parse --short=12 HEAD 2>$null)
if ($LASTEXITCODE -ne 0) { $revision = 'source-archive' }
$manifest = [ordered]@{FormatVersion=1; Version=$package.version; Architecture='x64'; NodeVersion=$runtime.version;
    Revision=$revision; PayloadSha256=(Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant(); Files=$fileTable}
$manifestPath = Join-Path $build 'package-manifest.json'
[IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 6), $utf8)
$metadataPath = Join-Path $build 'Version.cs'
$metadata = 'using System.Reflection;[assembly:AssemblyTitle("Codex Stateline")][assembly:AssemblyProduct("Codex Stateline Portable")]' +
    '[assembly:AssemblyVersion("' + $package.version + '.0")][assembly:AssemblyFileVersion("' + $package.version + '.0")]' +
    '[assembly:AssemblyInformationalVersion("' + $package.version + '+' + $revision + '")]'
[IO.File]::WriteAllText($metadataPath, $metadata, $utf8)
$framework = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319'
$compiler = Join-Path $framework 'csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { throw 'Windows x64 .NET Framework C# compiler not found.' }
$compiled = Join-Path $build 'Codex-Stateline.exe'
$response = @('/nologo', '/target:winexe', '/platform:x64', '/optimize+', ('/out:"' + $compiled + '"'),
    ('/win32icon:"' + (Join-Path $root 'assets/codex-widget.ico') + '"'),
    ('/win32manifest:"' + (Join-Path $PSScriptRoot 'portable/app.manifest') + '"'),
    ('/resource:"' + $archivePath + '",CodexPortable.Payload'), ('/resource:"' + $manifestPath + '",CodexPortable.Manifest'))
foreach ($reference in @('System.dll','System.Core.dll','System.IO.Compression.dll','System.IO.Compression.FileSystem.dll','System.Web.Extensions.dll','System.Windows.Forms.dll')) {
    $response += '/reference:"' + (Join-Path $framework $reference) + '"'
}
$response += '"' + (Join-Path $PSScriptRoot 'portable/PortableLauncher.cs') + '"'
$response += '"' + $metadataPath + '"'
$responsePath = Join-Path $build 'compiler.rsp'
[IO.File]::WriteAllLines($responsePath, $response, (New-Object Text.UTF8Encoding $true))
& $compiler ('@' + $responsePath)
if ($LASTEXITCODE -ne 0) { throw 'Portable launcher compilation failed.' }
$exe = Join-Path $OutputDirectory 'Codex-Stateline.exe'
[IO.File]::Copy($compiled, $exe, $true)
$sha = (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant()
[IO.File]::WriteAllText((Join-Path $OutputDirectory 'SHA256SUMS.txt'), ($sha + '  Codex-Stateline.exe' + "`n"), $utf8)
Write-Output ('Built: ' + $exe)
Write-Output ('Size MiB: ' + [Math]::Round((Get-Item -LiteralPath $exe).Length / 1MB, 2))
Write-Output ('SHA256: ' + $sha)
Write-Output ('Manifest: ' + $manifestPath)
