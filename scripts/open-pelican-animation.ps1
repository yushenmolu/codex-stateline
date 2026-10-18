[CmdletBinding()]
param([switch]$SelfTest)
$ErrorActionPreference = 'Stop'
$window = $null
$timer = $null
$playback = $null
$state = @{ Failure = $null; Ticks = 0; Frames = @(); Times = @(); Pixels = @(); ChangedPixels = 0; Closed = $false }
function Capture-Frame([string]$Path) {
    $image.UpdateLayout()
    $w = [int][Math]::Ceiling($image.ActualWidth)
    $h = [int][Math]::Ceiling($image.ActualHeight)
    if ($w -le 0 -or $h -le 0) { throw '动画视图尚未完成布局。' }
    $bitmap = New-Object Windows.Media.Imaging.RenderTargetBitmap $w,$h,96,96,([Windows.Media.PixelFormats]::Pbgra32)
    $bitmap.Render($image)
    $pixels = New-Object byte[] ($w * $h * 4)
    $bitmap.CopyPixels($pixels,($w * 4),0)
    $encoder = New-Object Windows.Media.Imaging.PngBitmapEncoder
    $encoder.Frames.Add([Windows.Media.Imaging.BitmapFrame]::Create($bitmap))
    $stream = [IO.File]::Create($Path)
    try { $encoder.Save($stream) } finally { $stream.Dispose() }
    $state.Pixels += ,$pixels
    $state.Frames += $Path
}
try {
    if ([Threading.Thread]::CurrentThread.ApartmentState -ne 'STA') { throw '请使用 powershell.exe -STA 启动鹈鹕动画。' }
    & (Join-Path $PSScriptRoot 'native-widget.ps1') -LoadOnly
    $svgPath = Join-Path $PSScriptRoot '../output/pelican-362f3c3d-animated.svg'
    if (-not (Test-Path -LiteralPath $svgPath -PathType Leaf)) { throw ('找不到已保存的动画 SVG：' + $svgPath) }
    $parsed = [CodexNative.SafeSvg]::Parse([IO.File]::ReadAllText($svgPath))
    if ($null -eq $parsed.Image -or $parsed.ErrorCode) { throw ('SVG 被原生安全解析器拒绝：' + $parsed.ErrorCode + '。' + $parsed.Error) }
    if ($parsed.Animations.Count -eq 0) { throw '已保存的 SVG 是静态图，没有可播放的动画。' }
    $playback = [CodexNative.SafeSvg]::CreatePlayback($parsed)
    $window = New-Object Windows.Window
    $window.Title = '鹈鹕动画'
    $window.Width = 640
    $window.Height = 500
    $window.MinWidth = 360
    $window.MinHeight = 300
    $window.ResizeMode = [Windows.ResizeMode]::CanResize
    $window.WindowStartupLocation = [Windows.WindowStartupLocation]::CenterScreen
    $window.Background = [Windows.Media.BrushConverter]::new().ConvertFromString('#18212B')
    $window.Foreground = [Windows.Media.Brushes]::WhiteSmoke
    $panel = New-Object Windows.Controls.DockPanel
    $panel.Margin = New-Object Windows.Thickness 12
    $label = New-Object Windows.Controls.TextBlock
    $label.Text = '已保存的原始动画作品 · 非新评分结果'
    $label.TextWrapping = [Windows.TextWrapping]::Wrap
    $label.Margin = New-Object Windows.Thickness 0,0,0,10
    [Windows.Controls.DockPanel]::SetDock($label,[Windows.Controls.Dock]::Top)
    $null = $panel.Children.Add($label)
    $controls = New-Object Windows.Controls.StackPanel
    $controls.Orientation = [Windows.Controls.Orientation]::Horizontal
    $controls.HorizontalAlignment = [Windows.HorizontalAlignment]::Center
    $controls.Margin = New-Object Windows.Thickness 0,10,0,0
    [Windows.Controls.DockPanel]::SetDock($controls,[Windows.Controls.Dock]::Bottom)
    $toggle = New-Object Windows.Controls.Button
    $toggle.Content = '暂停'
    $toggle.Padding = New-Object Windows.Thickness 18,5,18,5
    $toggle.Margin = New-Object Windows.Thickness 0,0,10,0
    $restart = New-Object Windows.Controls.Button
    $restart.Content = '重新开始'
    $restart.Padding = New-Object Windows.Thickness 18,5,18,5
    $null = $controls.Children.Add($toggle)
    $null = $controls.Children.Add($restart)
    $null = $panel.Children.Add($controls)
    $image = New-Object Windows.Controls.Image
    $image.Stretch = [Windows.Media.Stretch]::Uniform
    $image.Source = $playback.Image
    $null = $panel.Children.Add($image)
    $window.Content = $panel
    $clock = New-Object Diagnostics.Stopwatch
    $timer = New-Object Windows.Threading.DispatcherTimer
    $timer.Interval = [TimeSpan]::FromMilliseconds(34)
    $toggle.Add_Click({
        if ($clock.IsRunning) { $clock.Stop(); $timer.Stop(); $toggle.Content = '播放' }
        else { $clock.Start(); $timer.Start(); $toggle.Content = '暂停' }
    })
    $restart.Add_Click({
        try {
            $clock.Restart(); $playback.Sample(0); $toggle.Content = '暂停'; $timer.Start()
        } catch { $state.Failure = $_.Exception.Message; $window.Close() }
    })
    if ($SelfTest) {
        $toggle.IsEnabled = $false
        $restart.IsEnabled = $false
        $captureDir = Join-Path ([IO.Path]::GetTempPath()) ('pelican-animation-' + [Guid]::NewGuid().ToString('N'))
        $null = [IO.Directory]::CreateDirectory($captureDir)
    }
    $timer.Add_Tick({
        try {
            $state.Ticks++
            $elapsed = $clock.Elapsed.TotalSeconds
            $playback.Sample($elapsed)
            if ($SelfTest) {
                if ($state.Frames.Count -eq 0 -and $elapsed -ge 0.350) {
                    Capture-Frame (Join-Path $captureDir 'frame-350ms.png')
                    $state.Times += $elapsed
                } elseif ($state.Frames.Count -eq 1 -and $elapsed -ge 1.050) {
                    Capture-Frame (Join-Path $captureDir 'frame-1050ms.png')
                    $state.Times += $elapsed
                    $first = $state.Pixels[0]
                    $second = $state.Pixels[1]
                    if ($first.Length -ne $second.Length) { throw '自测帧尺寸不一致。' }
                    for ($i = 0; $i -lt $first.Length; $i += 4) {
                        if ($first[$i] -ne $second[$i] -or $first[$i+1] -ne $second[$i+1] -or $first[$i+2] -ne $second[$i+2] -or $first[$i+3] -ne $second[$i+3]) { $state.ChangedPixels++ }
                    }
                    if ($state.ChangedPixels -eq 0) { throw '动画自测失败：两帧像素完全相同。' }
                    $window.Close()
                }
                if ($elapsed -gt 8 -and -not $state.Closed) { throw '动画自测超时：未捕获两帧。' }
            }
        } catch { $state.Failure = $_.Exception.Message; $window.Close() }
    })
    $window.Add_ContentRendered({ $clock.Start(); $timer.Start() })
    $window.Add_Closed({
        $state.Closed = $true
        $timer.Stop()
        $clock.Stop()
        $image.Source = $null
        $playback.Dispose()
    })
    $null = $window.ShowDialog()
    if ($state.Failure) { throw $state.Failure }
    if ($SelfTest) {
        if ($state.Frames.Count -ne 2 -or $state.ChangedPixels -le 0) { throw '动画自测未完成两帧对比。' }
        [pscustomobject]@{ status = 'PASS'; timerIntervalMs = 34; ticks = $state.Ticks; captureSeconds = $state.Times; changedPixels = $state.ChangedPixels; frames = $state.Frames; cleanup = 'window closed; timer stopped; playback disposed' } | ConvertTo-Json -Compress
    }
} catch {
    $message = '鹈鹕动画无法播放：' + $_.Exception.Message
    if (-not $SelfTest) {
        $messageShown = $false
        try {
            if ('Windows.MessageBox' -as [type]) {
                $null = [Windows.MessageBox]::Show($message,'鹈鹕动画',[Windows.MessageBoxButton]::OK,[Windows.MessageBoxImage]::Error)
                $messageShown = $true
            }
        } catch { }
        if (-not $messageShown) {
            try {
                $shell = New-Object -ComObject WScript.Shell
                $null = $shell.Popup($message,0,'鹈鹕动画',16)
            } catch { }
        }
    }
    [Console]::Error.WriteLine($message)
    exit 1
} finally {
    if ($null -ne $timer) { $timer.Stop() }
    if ($null -ne $window -and $window.IsVisible) { $window.Close() }
    if ($null -ne $playback) { $playback.Dispose() }
}
