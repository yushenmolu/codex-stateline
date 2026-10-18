[CmdletBinding()]
param([switch]$Fixture,[switch]$SelfTest,[string]$ScreenshotPath,[string]$ResultScreenshotPath,[switch]$LoadOnly)
$ErrorActionPreference = 'Stop'
if ([Threading.Thread]::CurrentThread.ApartmentState -ne 'STA') { throw 'Run with Windows powershell.exe -STA; launcher must invoke this script in the same STA process.' }
Add-Type -AssemblyName PresentationFramework,PresentationCore,WindowsBase,System.Net.Http,System.Web.Extensions
if (-not ('CodexNative.WidgetWindow' -as [type])) {
    $refs = @('System.dll','System.Core.dll','System.Xml.dll','System.Xaml.dll','System.Net.Http.dll','System.Web.Extensions.dll',([Windows.DependencyObject].Assembly.Location),([Windows.Media.Visual].Assembly.Location),([Windows.Window].Assembly.Location))
    # Each compilation unit has its own imports; compile files together rather than concatenate namespaces.
    Add-Type -Path (Join-Path $PSScriptRoot 'native/SafeSvg.cs'),(Join-Path $PSScriptRoot 'native/WidgetClient.cs'),(Join-Path $PSScriptRoot 'native/BrowserPreview.cs'),(Join-Path $PSScriptRoot 'native/CockpitBrowserGuard.cs') -ReferencedAssemblies $refs
}
if ($LoadOnly) { return }
if ($SelfTest) {
    & (Join-Path $PSScriptRoot '../tests/native-widget.selftest.ps1') -ScreenshotPath $ScreenshotPath -ResultScreenshotPath $ResultScreenshotPath
    return
}
$window = New-Object CodexNative.WidgetWindow ([bool]$Fixture)
if ($ScreenshotPath -or $ResultScreenshotPath) {
    if (-not $Fixture) { throw 'Screenshots require -Fixture.' }
    $captureTimer = New-Object Windows.Threading.DispatcherTimer
    $captureTimer.Interval = [TimeSpan]::FromMilliseconds(900)
    $captureTimer.Add_Tick({
        $captureTimer.Stop()
        if ($ScreenshotPath) { $window.Capture($ScreenshotPath) }
        if ($ResultScreenshotPath) { $window.CaptureResults($ResultScreenshotPath) }
    })
    $captureTimer.Start()
}
$null = $window.ShowDialog()


