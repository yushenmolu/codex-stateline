# Continuous process sampler for the local-tail attribution.
# One PowerShell process loops internally with Get-Process (35-75ms per call);
# spawning pwsh per sample costs ~1.4s, which is useless for a ~10s tail.
# Writes a line only when the observed process set changes.
# Usage: powershell -File output/speed-sampler.ps1 -LogPath <path> -IntervalMs 100 -BudgetMs 1200000
param(
  [string]$LogPath = 'output/speed-sampler.log',
  [int]$IntervalMs = 100,
  [int]$BudgetMs = 1200000,
  [string[]]$Names = @('codex', 'node_repl', 'codex-computer-use')
)

$started = Get-Date
Set-Content -LiteralPath $LogPath -Value '' -Encoding utf8
$last = $null

while (((Get-Date) - $started).TotalMilliseconds -lt $BudgetMs) {
  $t0 = Get-Date
  $parts = @()
  foreach ($n in $Names) {
    $procs = @(Get-Process -Name $n -ErrorAction SilentlyContinue)
    foreach ($p in $procs) {
      $cpu = if ($null -ne $p.CPU) { [math]::Round($p.CPU, 1) } else { -1 }
      $parts += "$($p.Id)|$n|cpu=$cpu"
    }
  }
  $text = if ($parts.Count -eq 0) { '-' } else { ($parts | Sort-Object) -join ',' }
  if ($text -ne $last) {
    $last = $text
    $sampleMs = [int]((Get-Date) - $t0).TotalMilliseconds
    Add-Content -LiteralPath $LogPath -Encoding utf8 -Value ("{0}`t{1}`tsample_ms={2}`t{3}" -f (Get-Date).ToUniversalTime().ToString('o'), [int]((Get-Date) - $started).TotalMilliseconds, $sampleMs, $text)
  }
  Start-Sleep -Milliseconds $IntervalMs
}

Add-Content -LiteralPath $LogPath -Encoding utf8 -Value ("{0}`t{1}`tSTOP" -f (Get-Date).ToUniversalTime().ToString('o'), [int]((Get-Date) - $started).TotalMilliseconds)
