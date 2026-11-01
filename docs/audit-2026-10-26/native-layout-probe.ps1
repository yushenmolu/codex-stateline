[CmdletBinding()]
param([string]$OutputDirectory = $PSScriptRoot)
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot '../../scripts/native-widget.ps1') -LoadOnly
$windows = New-Object 'Collections.Generic.List[System.Windows.Window]'
try {
    function Visuals($root) {
        $root
        for ($i = 0; $i -lt [Windows.Media.VisualTreeHelper]::GetChildrenCount($root); $i++) {
            Visuals ([Windows.Media.VisualTreeHelper]::GetChild($root, $i))
        }
    }
    function GetText($root, $id) {
        Visuals $root | Where-Object { $_ -is [Windows.Controls.TextBlock] -and [Windows.Automation.AutomationProperties]::GetAutomationId($_) -eq $id } | Select-Object -First 1
    }
    $window = New-Object CodexNative.WidgetWindow $true
    $windows.Add($window)
    $window.SetFixture()
    $window.Show()
    $window.UpdateLayout()
    $main = @{
        width = $window.ActualWidth
        height = $window.ActualHeight
        viewportHeight = $window.MainViewport.ViewportHeight
        extentHeight = $window.MainViewport.ExtentHeight
        verticalOffset = $window.MainViewport.VerticalOffset
        maxVerticalOffset = $window.MainViewport.ScrollableHeight
        verticalScrollbarVisibility = [string]$window.MainViewport.ComputedVerticalScrollBarVisibility
        resizeMode = [string]$window.ResizeMode
    }
    $window.OpenSettings()
    $window.SettingsWindow.UpdateLayout()
    $settings = @{
        width = $window.SettingsWindow.ActualWidth
        height = $window.SettingsWindow.ActualHeight
        workAreaWidth = [System.Windows.SystemParameters]::WorkArea.Width
        workAreaHeight = [System.Windows.SystemParameters]::WorkArea.Height
        settingsModelVisible = $window.SettingsModelControl.IsVisible
        settingsEffortVisible = $window.SettingsEffortControl.IsVisible
        settingsModeVisible = $window.SettingsModeControl.IsVisible
    }
    $window.Capture((Join-Path $OutputDirectory 'native-settings.png'))
    $window.OpenUsage()
    $window.UsageWindow.UpdateLayout()
    $usage = @{
        width = $window.UsageWindow.ActualWidth
        height = $window.UsageWindow.ActualHeight
        resizeMode = [string]$window.UsageWindow.ResizeMode
        top = $window.UsageWindow.Top
        left = $window.UsageWindow.Left
        usageSliderVisible = $window.UsageWindow.IsVisible
        overallTotal = (GetText $window.UsageWindow 'LocalTotalTokens').Text
        overallState = $window.OverallStateControl.Text
    }
    $window.Capture((Join-Path $OutputDirectory 'native-usage.png'))
    $result = @{ main = $main; settings = $settings; usage = $usage; fixtureOnly = $true; realModelCalls = 0 }
    $result | ConvertTo-Json -Depth 5
}
finally {
    foreach ($item in $windows) {
        try { $item.Close() } catch { }
    }
}
