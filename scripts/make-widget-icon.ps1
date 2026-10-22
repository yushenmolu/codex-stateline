# Regenerates assets/codex-widget.ico from code so the icon stays versionable
# without shipping a binary blob that nobody can edit.
#
# Compatibility matters more than compactness here: Explorer, the .lnk shell and
# System.Drawing.Icon all disagree about PNG-compressed ICO frames. Small sizes
# therefore use classic 32bpp DIB frames (universally readable), and only the
# 256 px frame uses PNG (the format's own size limit makes a DIB impractical).
[CmdletBinding()]
param([string]$OutputPath)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not $PSBoundParameters.ContainsKey('OutputPath') -or [string]::IsNullOrEmpty($OutputPath)) {
  $OutputPath = Join-Path $root 'assets/codex-widget.ico'
}
Add-Type -AssemblyName System.Drawing

# Same palette as the tray icon so the shortcut, tray hover and panel agree.
$surface = [System.Drawing.Color]::FromArgb(255, 20, 21, 24)
$accent = [System.Drawing.Color]::FromArgb(255, 74, 90, 214)
$ink = [System.Drawing.Color]::FromArgb(255, 237, 238, 242)

function New-IconBitmap([int]$size) {
  $bitmap = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.Clear([System.Drawing.Color]::Transparent)
    # Keep the stroke readable at 16 px without swallowing the interior.
    $inset = [Math]::Max(0.5, $size * 0.031)
    $stroke = [Math]::Max(1.0, $size * 0.0625)
    $radius = $size * 0.28
    $bounds = New-Object System.Drawing.RectangleF $inset, $inset, ($size - 2 * $inset), ($size - 2 * $inset)
    $diameter = $radius * 2

    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    try {
      $path.AddArc($bounds.X, $bounds.Y, $diameter, $diameter, 180, 90)
      $path.AddArc(($bounds.Right - $diameter), $bounds.Y, $diameter, $diameter, 270, 90)
      $path.AddArc(($bounds.Right - $diameter), ($bounds.Bottom - $diameter), $diameter, $diameter, 0, 90)
      $path.AddArc($bounds.X, ($bounds.Bottom - $diameter), $diameter, $diameter, 90, 90)
      $path.CloseFigure()

      $fill = New-Object System.Drawing.SolidBrush $surface
      $border = New-Object System.Drawing.Pen $accent, $stroke
      $bar = New-Object System.Drawing.SolidBrush $ink
      try {
        $graphics.FillPath($fill, $path)
        $graphics.DrawPath($border, $path)
        # Two stacked bars echo the pelican panel's status rows.
        $graphics.FillRectangle($bar, [single]($size * 0.25), [single]($size * 0.34), [single]($size * 0.50), [single]($size * 0.10))
        $graphics.FillRectangle($bar, [single]($size * 0.25), [single]($size * 0.55), [single]($size * 0.31), [single]($size * 0.10))
      } finally {
        $fill.Dispose(); $border.Dispose(); $bar.Dispose()
      }
    } finally {
      $path.Dispose()
    }
  } finally {
    $graphics.Dispose()
  }
  return $bitmap
}

# Classic 32bpp DIB frame: BITMAPINFOHEADER + bottom-up BGRA XOR mask + empty AND mask.
function Get-DibFrameBytes([System.Drawing.Bitmap]$Bitmap) {
  $w = $Bitmap.Width
  $h = $Bitmap.Height
  $stream = New-Object System.IO.MemoryStream
  $writer = New-Object System.IO.BinaryWriter $stream
  try {
    $writer.Write([UInt32]40)              # biSize
    $writer.Write([Int32]$w)               # biWidth
    $writer.Write([Int32]($h * 2))         # biHeight: XOR + AND masks together
    $writer.Write([UInt16]1)               # biPlanes
    $writer.Write([UInt16]32)              # biBitCount
    $writer.Write([UInt32]0)               # biCompression = BI_RGB
    $writer.Write([UInt32]($w * $h * 4))   # biSizeImage (XOR mask only)
    $writer.Write([Int32]0)                # biXPelsPerMeter
    $writer.Write([Int32]0)                # biYPelsPerMeter
    $writer.Write([UInt32]0)               # biClrUsed
    $writer.Write([UInt32]0)               # biClrImportant

    # DIB rows run bottom-up.
    for ($y = $h - 1; $y -ge 0; $y--) {
      for ($x = 0; $x -lt $w; $x++) {
        $c = $Bitmap.GetPixel($x, $y)
        $writer.Write([byte]$c.B)
        $writer.Write([byte]$c.G)
        $writer.Write([byte]$c.R)
        $writer.Write([byte]$c.A)
      }
    }

    # AND mask: 1 = transparent, one bit per pixel, rows padded to 32 bits.
    $rowBytes = [Math]::Floor(($w + 31) / 32) * 4
    for ($y = $h - 1; $y -ge 0; $y--) {
      $bits = New-Object 'bool[]' ($rowBytes * 8)
      for ($x = 0; $x -lt $w; $x++) {
        if ($Bitmap.GetPixel($x, $y).A -lt 128) { $bits[$x] = $true }
      }
      for ($i = 0; $i -lt $rowBytes; $i++) {
        $value = 0
        for ($bit = 0; $bit -lt 8; $bit++) {
          if ($bits[$i * 8 + $bit]) { $value = $value -bor (128 -shr $bit) }
        }
        $writer.Write([byte]$value)
      }
    }
    $writer.Flush()
    return $stream.ToArray()
  } finally {
    $writer.Dispose(); $stream.Dispose()
  }
}

function Get-PngFrameBytes([System.Drawing.Bitmap]$Bitmap) {
  $stream = New-Object System.IO.MemoryStream
  try {
    $Bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
    return $stream.ToArray()
  } finally {
    $stream.Dispose()
  }
}

# PNG only for 256 px; every smaller size stays a DIB so legacy readers work.
$frames = @()
foreach ($size in @(16, 24, 32, 48, 64, 128, 256)) {
  $bitmap = New-IconBitmap $size
  try {
    if ($size -ge 256) { $frames += ,@($size, (Get-PngFrameBytes $bitmap)) }
    else { $frames += ,@($size, (Get-DibFrameBytes $bitmap)) }
  } finally {
    $bitmap.Dispose()
  }
}

$dir = Split-Path -Parent $OutputPath
if (-not (Test-Path -LiteralPath $dir)) { $null = New-Item -ItemType Directory -Path $dir -Force }

$stream = New-Object System.IO.MemoryStream
$writer = New-Object System.IO.BinaryWriter $stream
try {
  $writer.Write([UInt16]0)                # reserved
  $writer.Write([UInt16]1)                # type: icon
  $writer.Write([UInt16]$frames.Count)    # image count
  $offset = 6 + 16 * $frames.Count
  foreach ($frame in $frames) {
    $size = [int]$frame[0]
    $data = [byte[]]$frame[1]
    # A 256 px frame stores 0 in the byte-sized width/height fields.
    $writer.Write([byte]($(if ($size -ge 256) { 0 } else { $size })))
    $writer.Write([byte]($(if ($size -ge 256) { 0 } else { $size })))
    $writer.Write([byte]0)                # palette size
    $writer.Write([byte]0)                # reserved
    $writer.Write([UInt16]1)              # color planes
    $writer.Write([UInt16]32)             # bits per pixel
    $writer.Write([UInt32]$data.Length)
    $writer.Write([UInt32]$offset)
    $offset += $data.Length
  }
  foreach ($frame in $frames) { $writer.Write([byte[]]$frame[1]) }
  $writer.Flush()
  [IO.File]::WriteAllBytes($OutputPath, $stream.ToArray())
} finally {
  $writer.Dispose(); $stream.Dispose()
}

# Read the container back so a corrupt write fails here, not on the desktop.
$bytes = [IO.File]::ReadAllBytes($OutputPath)
$count = [BitConverter]::ToUInt16($bytes, 4)
if ($count -ne $frames.Count) { throw "Icon frame count mismatch: wrote $($frames.Count), read $count." }
$icon = New-Object System.Drawing.Icon $OutputPath
try {
  $bitmap = $icon.ToBitmap()
  try {
    # The first frame is 16 px; a solid-white sample means the shell-style
    # reader produced the blank-page fallback instead of real artwork.
    $sample = $bitmap.GetPixel([int]($bitmap.Width / 2), [int]($bitmap.Height / 2))
    if ($sample.A -eq 255 -and $sample.R -gt 240 -and $sample.G -gt 240 -and $sample.B -gt 240) {
      throw 'Icon decoded as a blank white square.'
    }
    Write-Output ("wrote {0} ({1} bytes, {2} frames, {3} px base, centre={4})" -f $OutputPath, $bytes.Length, $count, $bitmap.Width, $sample)
  } finally { $bitmap.Dispose() }
} finally { $icon.Dispose() }
