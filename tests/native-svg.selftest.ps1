[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
if ($PSVersionTable.PSVersion.Major -ne 5) { throw 'Run with Windows PowerShell 5.1 -STA.' }
& (Join-Path $PSScriptRoot '../scripts/native-widget.ps1') -LoadOnly
$script:checks=0
$script:failures=New-Object 'Collections.Generic.List[string]'
function Assert($condition,[string]$message) {
    $script:checks++
    if (-not $condition) { $script:failures.Add($message) }
}
function Svg([string]$body,[string]$attrs='width="100" height="100"') {
    $r=[CodexNative.SafeSvg]::Parse('<svg xmlns="http://www.w3.org/2000/svg" '+$attrs+'>'+$body+'</svg>')
    if ($null -eq $r.Image) { throw ('Fixture rejected: '+$body+' '+$r.Error) }
    return $r.Image
}
function Shape($img) { return $img.Drawing.Children[1].Children[0].Children[0].Children[0] }
function Pixels($img,[int]$w=100,[int]$h=100) {
    $visual=New-Object Windows.Media.DrawingVisual
    $dc=$visual.RenderOpen()
    try { $dc.DrawImage($img,(New-Object Windows.Rect 0,0,$w,$h)) } finally { $dc.Close() }
    $bitmap=New-Object Windows.Media.Imaging.RenderTargetBitmap $w,$h,96,96,([Windows.Media.PixelFormats]::Pbgra32)
    $bitmap.Render($visual)
    $bytes=New-Object byte[] ($w*$h*4)
    $bitmap.CopyPixels($bytes,($w*4),0)
    return ,$bytes
}
function Alpha($bytes,[int]$x,[int]$y,[int]$w=100) { return $bytes[($y*$w+$x)*4+3] }
function Reject([string]$body) {
    $r=[CodexNative.SafeSvg]::Parse($body)
    Assert ($null -eq $r.Image -and $null -ne $r.Error) ('unsafe/invalid SVG accepted: '+$body.Substring(0,[Math]::Min(100,$body.Length)))
}

# W3 regressions: old renderer rejects both local instances and animation.
$useRegression=[CodexNative.SafeSvg]::Parse('<svg xmlns="http://www.w3.org/2000/svg"><defs><rect id="r" width="10" height="10"/></defs><use href="#r"/></svg>')
Assert ($null -ne $useRegression.Image) 'W3 local use must render'
$animationRegression=[CodexNative.SafeSvg]::Parse('<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"><animateTransform attributeName="transform" type="translate" from="0" to="20" dur="1s"/></rect></svg>')
Assert ($null -ne $animationRegression.Image) 'W3 translate animation must parse'

# Regression: the persisted answer uses inert metadata and internal vertical gradients.
$gradient='<defs><linearGradient id="sky" x2="0" y2="1"><stop stop-color="#ff0000"/><stop offset="1" stop-color="#0000ff"/></linearGradient></defs>'
$answer=([char]96).ToString()*3+'svg'+[char]10+'<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" role="img" aria-labelledby="title desc"><title id="title">Pelican</title><desc id="desc">Gradient</desc>'+$gradient+'<rect width="100" height="100" fill="url(#sky)"/></svg>'+[char]10+([char]96).ToString()*3
$regression=[CodexNative.SafeSvg]::Parse($answer)
Assert ($null -ne $regression.Image -and $null -eq $regression.Error) 'internal gradient and inert accessibility regression'
Assert ($regression.Source -ceq $answer) 'gradient fenced source preserved exactly'
if($regression.Image){
    $px=Pixels $regression.Image
    Assert ($px[(10*100+50)*4+2] -gt 220 -and $px[(90*100+50)*4] -gt 220) 'vertical gradient direction and colors'
}

# Numeric userSpaceOnUse coordinates stay in local user space, without bbox scaling.
$userGradient='<defs><linearGradient id="user" gradientUnits="userSpaceOnUse" x1="10" y1="0" x2="90" y2="0"><stop stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient></defs>'
$userResult=[CodexNative.SafeSvg]::Parse('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect x="20" y="10" width="60" height="80" fill="url(#user)"/>'+$userGradient+'</svg>')
Assert ($null -ne $userResult.Image -and $null -eq $userResult.ErrorCode) 'numeric userSpaceOnUse parses'
if($userResult.Image){
    $brush=(Shape $userResult.Image).Brush
    Assert ($brush.MappingMode -eq [Windows.Media.BrushMappingMode]::Absolute -and $brush.Transform.Value.IsIdentity -and $brush.StartPoint.X -eq 10 -and $brush.EndPoint.X -eq 90) 'user space brush keeps absolute endpoints and identity transform'
    $px=Pixels $userResult.Image
    Assert ($px[(50*100+30)*4+2] -ge 187 -and $px[(50*100+30)*4+2] -le 191) 'user space offset rectangle red pixel follows absolute coordinates'
    $transformed=Svg ($userGradient+'<g transform="translate(5 0)"><rect x="20" y="10" width="60" height="80" fill="url(#user)"/></g>')
    $moved=Pixels $transformed
    Assert ($px[(50*100+30)*4+2] -eq $moved[(50*100+35)*4+2]) 'user space gradient follows local shape transform'
}
foreach($coord in @('10%','NaN','Infinity','1000001','-1000001')){
    Reject ('<svg xmlns="http://www.w3.org/2000/svg">'+$userGradient.Replace('x1="10"','x1="'+$coord+'"')+'</svg>')
}
Reject ('<svg xmlns="http://www.w3.org/2000/svg">'+$userGradient.Replace('x2="90"','x2="100%"')+'</svg>')
Reject ('<svg xmlns="http://www.w3.org/2000/svg">'+$userGradient.Replace('userSpaceOnUse','unknown')+'</svg>')
Assert ($null -ne [CodexNative.SafeSvg]::Parse('<svg xmlns="http://www.w3.org/2000/svg">'+$userGradient.Replace('x1="10"','x1="-1000000"').Replace('x2="90"','x2="1000000"')+'</svg>').Image) 'user space finite coordinate limits inclusive'
# A diagonal gradient projects in normalized objectBoundingBox space before scaling.
$diagonal='<defs><linearGradient id="diagonal" x2="1" y2="1"><stop stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient></defs>'
$img=Svg ($diagonal+'<rect width="100" height="20" fill="url(#diagonal)"/>') 'width="100" height="20"'
$px=Pixels $img 100 20
$sample= [pscustomobject]@{x=80;y=5;width=100;height=20;R=[int]$px[(5*100+80)*4+2];G=[int]$px[(5*100+80)*4+1];B=[int]$px[(5*100+80)*4];A=[int]$px[(5*100+80)*4+3]}
Write-Output ('diagonalPixel: '+($sample | ConvertTo-Json -Compress))
Assert ($sample.R -eq 117 -and $sample.G -eq 0 -and $sample.B -eq 138 -and $sample.A -eq 255) 'nonsquare diagonal objectBoundingBox pixel at (80,5): expected R117 G0 B138 A255'

# Geometric bounds, transforms, per-use opacity, and definitions after use.
$img=Svg ('<g transform="translate(5 5)"><rect x="10" y="10" width="60" height="20" fill="url(#sky)" stroke="black" stroke-width="8"/><rect x="10" y="50" width="30" height="40" fill="url(#sky)" fill-opacity="0.5"/></g>'+$gradient)
$px=Pixels $img
Assert ($px[(20*100+40)*4+2] -gt 175 -and $px[(29*100+40)*4] -gt 175) 'nonsquare thick stroke transformed fill uses unstroked bounds'
Assert ((Alpha $px 30 60) -ge 126 -and (Alpha $px 30 60) -le 129 -and (Alpha $px 40 20) -eq 255) 'per-use opacity does not contaminate other gradient shape'
$img=Svg ('<rect width="100" height="100" fill="url(#g)"/><defs><linearGradient id="g"><stop stop-color="red" stop-opacity="0.5"/><stop offset="100%" stop-color="blue"/></linearGradient></defs>')
$px=Pixels $img
Assert ($px[(50*100+5)*4+2] -gt $px[(50*100+5)*4] -and $px[(50*100+95)*4] -gt $px[(50*100+95)*4+2]) 'default horizontal gradient with percentage offset'
Assert ((Alpha $px 5 50) -gt 127 -and (Alpha $px 5 50) -lt 150) 'stop opacity participates in pixels'
$img=Svg '<defs><linearGradient id="g"><stop stop-color="red"/></linearGradient></defs><rect width="100" height="100" fill="url(#g)"/>'
$px=Pixels $img
Assert ($px[(50*100+50)*4+2] -eq 255) 'single stop solid color'
$img=Svg $gradient
Assert ((Alpha (Pixels $img) 50 50) -eq 0) 'defs never paint independently'
$img=Svg ($gradient+'<rect width="0" height="20" fill="url(#sky)"/><path d="M10 10 L10 50" fill="url(#sky)"/>')
Assert ((Alpha (Pixels $img) 10 20) -eq 0) 'zero-area gradient has no fill'
foreach($body in @(
    $gradient.Replace('x2="0" y2="1"','x2="0" y2="0"'),
    '<defs><linearGradient id="g"/></defs>',
    ('<g>'+$gradient+'</g>'),
    '<defs><linearGradient id="g" href="#sky"><stop/></linearGradient></defs>',
    '<defs><linearGradient id="g" gradientUnits="userSpaceOnUse"><stop/></linearGradient></defs>',
    '<defs><linearGradient id="g" gradientTransform="scale(2)"><stop/></linearGradient></defs>',
    '<defs><linearGradient id="g"><stop offset="NaN"/></linearGradient></defs>',
    '<defs><linearGradient id="g"><stop offset="0.8"/><stop offset="0.2"/></linearGradient></defs>',
    '<defs><linearGradient id="g"><stop stop-opacity="2"/></linearGradient></defs>',
    '<defs><linearGradient id="g"><stop style="stop-color:red"/></linearGradient></defs>',
    '<defs><linearGradient id="g"><stop><script/></stop></linearGradient></defs>',
    '<defs><linearGradient id="g"><stop xmlns:x="urn:x" x:offset="0"/></linearGradient></defs>',
    '<defs><linearGradient id="g"><stop/></linearGradient><linearGradient id="g"><stop/></linearGradient></defs>',
    '<rect id="g"/><title id="g">duplicate</title>',
    '<title id="g">wrong target</title><rect fill="url(#g)"/>',
    ($gradient+'<rect width="1" height="1" stroke="url(#sky)"/>'),
    '<g role="img"/>','<rect aria-labelledby="title"/>','<title aria-hidden="true"/>',
    '<defs><script/></defs>'
)){Reject ('<svg xmlns="http://www.w3.org/2000/svg">'+$body+'</svg>')}
foreach($paint in @('url(#missing)','url(#sky) red','url(https://invalid/#sky)','url(file:///x)','url(data:image/svg+xml,x)','url(other.svg#sky)')){
    Reject ('<svg xmlns="http://www.w3.org/2000/svg">'+$gradient+'<rect fill="'+$paint+'"/></svg>')
}
$stops='<stop/>'*64
$defs='<defs>'+((0..31 | ForEach-Object {'<linearGradient id="g'+$_+'">'+$stops+'</linearGradient>'}) -join '')+'</defs>'
Assert ($null -ne [CodexNative.SafeSvg]::Parse('<svg xmlns="http://www.w3.org/2000/svg">'+$defs+'</svg>').Image) '32 gradients and 64 stops exact limits'
Assert ($null -ne [CodexNative.SafeSvg]::Parse(('<svg xmlns="http://www.w3.org/2000/svg">'+$defs.Replace('</defs>','<linearGradient id="extra"><stop/></linearGradient></defs>')+'</svg>')).Image) 'amended gradient source budget accepts beyond legacy limit'
Assert ($null -ne [CodexNative.SafeSvg]::Parse(('<svg xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g">'+$stops+'<stop/></linearGradient></defs></svg>')).Image) 'amended gradient source budget accepts beyond legacy limit'
$inst='<defs><linearGradient id="g">'+$stops+'</linearGradient></defs>'+('<rect width="1" height="1" fill="url(#g)"/>'*256)
Assert ($null -ne [CodexNative.SafeSvg]::Parse('<svg xmlns="http://www.w3.org/2000/svg">'+$inst+'</svg>').Image) '16384 instantiated stops exact limit'
Reject ('<svg xmlns="http://www.w3.org/2000/svg">'+$inst+'<rect width="1" height="1" fill="url(#g)"/></svg>')
$nodeDefs='<defs><linearGradient id="g"><stop/></linearGradient></defs>'
Assert ($null -ne [CodexNative.SafeSvg]::Parse('<svg xmlns="http://www.w3.org/2000/svg">'+$nodeDefs+('<g/>'*4090)+'</svg>').Image) 'final wrappers count toward exact 4096 drawing node limit'
Reject ('<svg xmlns="http://www.w3.org/2000/svg">'+$nodeDefs+('<g/>'*4092)+'</svg>')
Assert ($null -ne [CodexNative.SafeSvg]::Parse('<svg xmlns="http://www.w3.org/2000/svg">'+('<g>'*29)+('</g>'*29)+'</svg>').Image) 'final wrapper depth 32'

# Open figures fill by implicit closure; only supplied edges are stroked.
$img=Svg '<polyline points="10,10 90,10 90,90"/>'
$d=Shape $img
Assert ($null -ne $d.Brush -and $d.Brush.Color -eq [Windows.Media.Colors]::Black -and $null -eq $d.Pen) 'polyline default black fill/no stroke'
Assert ($d.Geometry.FillContains((New-Object Windows.Point 75,25))) 'polyline implicit fill closure geometry'
$px=Pixels $img
Assert ((Alpha $px 75 25) -eq 255 -and $px[(25*100+75)*4] -eq 0) 'polyline default black pixel'
Assert ((Alpha $px 25 75) -eq 0) 'polyline exterior transparent pixel'
$img=Svg '<polyline points="10,10 90,10 90,90" fill="red" stroke="blue" stroke-width="4"/>'
$d=Shape $img
Assert ($d.Brush.Color -eq [Windows.Media.Colors]::Red) 'polyline explicit fill'
Assert ($d.Geometry.StrokeContains($d.Pen,(New-Object Windows.Point 50,10))) 'polyline supplied edge stroke geometry'
Assert (-not $d.Geometry.StrokeContains($d.Pen,(New-Object Windows.Point 50,50))) 'polyline must not stroke closing edge'
$px=Pixels $img
Assert ($px[(10*100+50)*4] -eq 255) 'polyline blue open edge pixel'
Assert ($px[(50*100+50)*4] -eq 0) 'polyline no blue closing edge pixel'
$img=Svg '<polyline points="10,10 90,10 90,90" fill="none" stroke="blue" stroke-width="4"/>'
Assert ((Alpha (Pixels $img) 75 25) -eq 0) 'polyline fill none pixel'

# Zero dimensions disable painting, including omitted dimensions.
foreach($body in @('<rect x="40" y="40" width="0" height="20"/>','<rect x="40" y="40" width="20" height="0"/>','<rect x="40" y="40"/>','<circle cx="50" cy="50" r="0"/>','<circle cx="50" cy="50"/>','<ellipse cx="50" cy="50" rx="0" ry="20"/>','<ellipse cx="50" cy="50" rx="20" ry="0"/>','<ellipse cx="50" cy="50"/>')) {
    $img=Svg ($body.Replace('/>',' fill="red" stroke="blue" stroke-width="10"/>'))
    Assert ($img.Drawing.Children[1].Children[0].Children[0].Children.Count -eq 0) ('zero size drawing geometry: '+$body)
    $px=Pixels $img
    $painted=0
    for($i=3;$i -lt $px.Length;$i+=4) { if($px[$i] -ne 0){$painted++} }
    Assert ($painted -eq 0) ('zero size pixels: '+$body)
}
$img=Svg '<path d="M10 40 L60 50 L10 60" fill="none" stroke="black" stroke-width="2"/>'
$d=Shape $img
Assert ($d.Pen.MiterLimit -eq 4) 'SVG default miter limit 4'
$expected=$img.Clone()
$ref=Shape $expected
$ref.Pen.MiterLimit=4
Assert ([Math]::Abs($d.Bounds.Width-$ref.Bounds.Width) -lt 0.000001) 'miter geometry bounds match limit 4'
$actualPixels=Pixels $img
$expectedPixels=Pixels $expected
$diff=0
for($i=0;$i -lt $actualPixels.Length;$i++){if($actualPixels[$i] -ne $expectedPixels[$i]){$diff++}}
Assert ($diff -eq 0) 'miter rendered pixels match limit 4'
Assert ((Alpha $expectedPixels 30 44) -gt 0) 'miter fixture renders a real stroke'

# Existing accepted geometry, viewport and safety semantics.
$img=Svg '<path d="M10 10 h80 v80 h-80 z m20 20 v40 h40 v-40 z"/>'
$d=Shape $img
Assert ($d.Geometry.FillContains((New-Object Windows.Point 15,15))) 'relative path outer geometry'
Assert (-not $d.Geometry.FillContains((New-Object Windows.Point 50,50))) 'default nonzero hole geometry'
$px=Pixels $img
Assert ((Alpha $px 15 15) -eq 255 -and (Alpha $px 50 50) -eq 0) 'relative/nonzero pixels'
$img=Svg '<rect width="100" height="100"/>' 'width="200" height="100" viewBox="0 0 100 100"'
Assert ($img.Drawing.Children[1].Transform.Matrix.OffsetX -eq 50) 'viewport centering geometry'
$px=Pixels $img 200 100
Assert ((Alpha $px 20 50 200) -eq 0 -and (Alpha $px 75 50 200) -eq 255 -and (Alpha $px 180 50 200) -eq 0) 'viewport pixels'
$p=[CodexNative.SafeSvg]::Transform('translate(10 20) scale(2)').Transform((New-Object Windows.Point 3,4))
Assert ($p.X -eq 16 -and $p.Y -eq 28) 'transform order'
foreach($body in @('<rect width="0" height="-1"/>','<rect width="0" height="1" x="NaN"/>','<rect width="0" height="1" rx="-1"/>','<circle r="0" cx="NaN"/>','<ellipse rx="0" ry="-1"/>','<ellipse rx="0" ry="1" cy="NaN"/>','<rect width="0" fill="url(#x)"/>','<circle r="0" stroke-width="-1"/>','<circle r="0" opacity="2"/>','<circle r="0" transform="scale(1000000) scale(1000000)"/>','<circle r="0"><rect width="1" height="1"/></circle>','<script/>','<image href="https://invalid/"/>','<rect width="1" height="1" onload="x"/>','<path d="M NaN 0"/>')) {
    Reject ('<svg xmlns="http://www.w3.org/2000/svg">'+$body+'</svg>')
}
Reject '<!DOCTYPE svg [<!ENTITY a SYSTEM "file:///C:/Windows/win.ini">]><svg xmlns="http://www.w3.org/2000/svg">&a;</svg>'
Reject '<?evil test?><svg xmlns="http://www.w3.org/2000/svg"/>'
Reject ('<svg xmlns="http://www.w3.org/2000/svg">'+('<g>'*33)+('</g>'*33)+'</svg>')
Reject ('<svg xmlns="http://www.w3.org/2000/svg">'+('<rect width="1" height="1"/>'*4097)+'</svg>')
Reject ('<svg xmlns="http://www.w3.org/2000/svg"><path d="'+('M0 0 '*7000)+'"/></svg>')
Reject ('<svg xmlns="http://www.w3.org/2000/svg">'+(' '*262145)+'</svg>')
Reject '<svg xmlns="http://www.w3.org/2000/svg" width="4097"/>'
$fence=([char]96).ToString()*3
Reject ($fence+'javascript'+[char]10+'<svg xmlns="http://www.w3.org/2000/svg"/>'+[char]10+$fence)
Assert ($null -ne [CodexNative.SafeSvg]::Parse($fence+'svg'+[char]10+'<svg xmlns="http://www.w3.org/2000/svg"/>'+[char]10+$fence).Image) 'accepted SVG fence'
# Frozen W3/W4 API, independent expanded instances, deterministic time and pixels.
function Parsed([string]$body) {
    return [CodexNative.SafeSvg]::Parse('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">'+$body+'</svg>')
}
function Target($playback,$descriptor) {
    $node=$playback.Image.Drawing
    foreach($index in $descriptor.InstancePath){$node=$node.Children[$index]}
    return $node
}
function Code([string]$body,[string]$expected) {
    $r=Parsed $body
    Assert ($null -eq $r.Image -and $r.Animations.Count -eq 0 -and $r.ErrorCode -ceq $expected) ('error code '+$expected+' actual '+$r.ErrorCode)
}
$motion='<animateTransform attributeName="transform" type="translate" values="0 0;40 0;0 0" dur="2s" repeatCount="indefinite"/>'
$r=Parsed ('<defs><g id="moving"><rect x="5" y="5" width="10" height="10" fill="red"/>'+$motion+'</g></defs><use href="#moving"/><use href="#moving" y="40"/>')
Assert ($null -ne $r.Image -and $r.Image.IsFrozen -and $r.Animations.Count -eq 2 -and $null -eq $r.ErrorCode) 'frozen parsed image and two expanded animation instances'
if($r.Image){
    Assert (($r.Animations[0].InstancePath -join '/') -ne ($r.Animations[1].InstancePath -join '/')) 'unique use instance paths'
    Assert ($r.Animations.IsReadOnly -and $r.Animations[0].InstancePath.IsReadOnly -and $r.Animations[0].Values.IsReadOnly) 'descriptor collections are read-only'
    $play=[CodexNative.SafeSvg]::CreatePlayback($r)
    $t0=Pixels $play.Image
    $play.Sample(0.5);$tQuarter=Pixels $play.Image
    Assert ((Alpha $t0 8 8) -gt 0 -and (Alpha $tQuarter 28 8) -gt 0 -and (Alpha $tQuarter 8 8) -eq 0) 'quarter-period pixels move'
    $play.Sample(1);$tHalf=Pixels $play.Image
    Assert ((Alpha $tHalf 48 8) -gt 0 -and (Alpha $tHalf 28 8) -eq 0) 'half-period pixels move again'
    Assert ((Target $play $r.Animations[0]).Transform.Matrix.OffsetX -eq 40 -and (Target $play $r.Animations[1]).Transform.Matrix.OffsetX -eq 40) 'both instances sample independently'
    $play.Sample(1);Assert ((Target $play $r.Animations[0]).Transform.Matrix.OffsetX -eq 40) 'same input deterministic'
    $play.Sample(2);Assert ((Target $play $r.Animations[0]).Transform.Matrix.IsIdentity) 'internal cycle boundary returns start'
    Assert ((Alpha (Pixels $r.Image) 8 8) -gt 0) 'playback does not mutate frozen parse result'
    foreach($invalid in @(-1,[double]::NaN,[double]::PositiveInfinity)){ $threw=$false;try{$play.Sample($invalid)}catch{$threw=$true};Assert $threw 'invalid sample time rejected' }
    $play.Dispose();$play.Dispose();Assert ($null -eq $play.Image) 'dispose idempotently releases drawing'
}
foreach($fill in @('remove','freeze')){
    $r=Parsed ('<rect width="10" height="10"><animateTransform attributeName="transform" type="translate" from="0" to="20" begin="500ms" dur="1s" repeatCount="2" fill="'+$fill+'"/></rect>')
    $play=[CodexNative.SafeSvg]::CreatePlayback($r)
    $play.Sample(0.25);Assert ((Target $play $r.Animations[0]).Transform.Matrix.IsIdentity) 'before begin identity'
    $play.Sample(1.5);Assert ((Target $play $r.Animations[0]).Transform.Matrix.IsIdentity) 'finite internal boundary start'
    $play.Sample(2.5);Assert ((Target $play $r.Animations[0]).Transform.Matrix.OffsetX -eq $(if($fill -eq 'freeze'){20}else{0})) ('finite end '+$fill)
    $play.Dispose()
}
$r=Parsed '<g><rect x="55" y="48" width="20" height="4"/><animateTransform attributeName="transform" type="rotate" from="0 50 50" to="360 50 50" dur="4s" repeatCount="indefinite"/></g>'
$play=[CodexNative.SafeSvg]::CreatePlayback($r);$play.Sample(1)
Assert ([Math]::Abs((Target $play $r.Animations[0]).Transform.Matrix.M12-1) -lt 0.000001) 'rotate quarter-period matrix'
Assert ((Alpha (Pixels $play.Image) 50 65) -gt 0) 'rotate quarter-period pixel'
$play.Dispose()
Code ('<defs>'+((0..256 | ForEach-Object {'<linearGradient id="g'+$_+'"><stop/></linearGradient>'}) -join '')+'</defs>') 'svg_budget_exceeded'
Code ('<defs><g id="many">'+('<rect width="1" height="1"/>'*30)+'</g></defs>'+('<use href="#many"/>'*70)) 'svg_budget_exceeded'
$r=Parsed '<defs><rect id="r" width="10" height="10"/></defs><use href="#r" fill="blue"/>'
Assert ((Pixels $r.Image)[(5*100+5)*4] -eq 255) 'use style inherited when target has no explicit style'
$r=Parsed '<g><animateTransform attributeName="transform" type="translate" from="0" to="20" dur="1s"/></g>'
Assert ($null -ne $r.Image -and $r.Animations[0].RepeatCount -eq 1 -and $r.Animations[0].Fill -eq [CodexNative.AnimationFill]::Remove) 'default repeat and fill contract'
Code '<g xmlns:unused="urn:unsafe"/>' 'svg_unsupported_feature'
Code '<defs><g id="bad"><use href="#absent"/></g></defs>' 'svg_missing_reference'
Code '<g style="animation:spin 1s"/>' 'svg_animation_unsupported'
Code ('<defs><path id="p" d="'+('M0 0 '*2000)+'"/></defs>'+('<use href="#p"/>'*4)) 'svg_budget_exceeded'
Code '<g transform="scale(2)"><rect x="400000" width="10" height="10"/><animateTransform attributeName="transform" type="translate" from="0" to="200000" dur="1s"/></g>' 'svg_animation_invalid'
Code '<g transform="scale(2)"><g><rect x="400000" width="10" height="10"/><animateTransform attributeName="transform" type="translate" from="0" to="200000" dur="1s"/></g></g>' 'svg_geometry_out_of_range'
Code '<rect x="999999" width="1" height="1" stroke="black" stroke-width="10"/>' 'svg_geometry_out_of_range'
$r=Parsed '<rect width="10" height="10"><animateTransform attributeName="transform" type="translate" from="0" to="20" dur="1s"/></rect>'
$play=[CodexNative.SafeSvg]::CreatePlayback($r);$play.Sample(1)
Assert ((Target $play $r.Animations[0]).Transform.Matrix.IsIdentity) 'default fill remove'
$play.Dispose()
$img=Svg '<use href="#r" x="5" transform="scale(2)" fill="blue"/><defs><rect id="r" x="1" width="2" height="2" transform="translate(3 0)" fill="red"/></defs>'
$px=Pixels $img;Assert ($px[(1*100+20)*4+2] -eq 255 -and $px[(1*100+20)*4] -eq 0) 'target transform then xy then use transform, target style overrides inherited'
$r=Parsed '<defs><rect id="r" width="10" height="10"/></defs><use xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="#r"/>'
Assert ($null -ne $r.Image) 'exact xlink namespace supported'
Code '<use href="other.svg#r"/>' 'svg_unsafe_reference'
Code '<use href="#missing"/>' 'svg_missing_reference'
Code '<defs><use id="r" href="#r"/></defs>' 'svg_reference_cycle'
Code '<g id="same"/><rect id="same"/>' 'svg_duplicate_id'
Code '<use xmlns:xlink="http://www.w3.org/1999/xlink" href="#a" xlink:href="#b"/>' 'svg_unsafe_reference'
Code '<defs><rect id="r" onload="bad"/></defs>' 'svg_unsupported_feature'
Code '<rect><animate attributeName="x"/></rect>' 'svg_animation_unsupported'
Code ('<g transform="translate(1)">'+$motion+'</g>') 'svg_animation_invalid'
Code ('<g>'+$motion+$motion+'</g>') 'svg_animation_invalid'
Code '<g><animateTransform attributeName="transform" type="rotate" from="0 1 2" to="90 2 2" dur="1s"/></g>' 'svg_animation_invalid'
Code '<g><animateTransform attributeName="transform" type="translate" from="0" to="1" dur="0.01s"/></g>' 'svg_animation_invalid'
Code '<g><animateTransform attributeName="transform" type="translate" from="0" to="1" dur="1s" begin="click"/></g>' 'svg_animation_invalid'
Code '<g><animateTransform attributeName="transform" type="translate" from="0" to="1" dur="1s" additive="sum"/></g>' 'svg_animation_unsupported'
$animatedDef='<defs><g id="r"><rect width="1" height="1"/>'+$motion+'</g></defs>'
Assert ($null -ne (Parsed ($animatedDef+('<use href="#r"/>'*64))).Image) '64 expanded animated instances accepted'
Code ($animatedDef+('<use href="#r"/>'*65)) 'svg_budget_exceeded'
Code '<g><g><rect width="10" height="10"/><animateTransform attributeName="transform" type="translate" from="0" to="600000" dur="1s"/></g><animateTransform attributeName="transform" type="translate" from="0" to="600000" dur="1s"/></g>' 'svg_geometry_out_of_range'
Code '<g><rect x="800000" y="800000" width="10" height="10"/><animateTransform attributeName="transform" type="rotate" from="0" to="360" dur="1s"/></g>' 'svg_geometry_out_of_range'
# Coordinates cancel the translations, but the composed matrix still exceeds the limit.
$cancelMotion='<animateTransform attributeName="transform" type="translate" from="0" to="600000" dur="1s" repeatCount="indefinite"/>'
Code ('<g><g><rect x="-600000" width="1" height="1"/>'+$cancelMotion+'</g>'+$cancelMotion+'</g>') 'svg_geometry_out_of_range'
Code ('<defs><g id="cancel"><rect x="-600000" width="1" height="1"/>'+$cancelMotion+'</g></defs><use href="#cancel" x="600000"/>') 'svg_geometry_out_of_range'
$scaledMotion=$cancelMotion.Replace('600000','300000')
$scaledBody='<g><g><rect x="-300000" width="1" height="1"/>'+$scaledMotion+'</g>'+$scaledMotion+'</g>'
$scaledResult=[CodexNative.SafeSvg]::Parse('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 100 100">'+$scaledBody+'</svg>')
Assert ($null -eq $scaledResult.Image -and $scaledResult.ErrorCode -eq 'svg_geometry_out_of_range') 'viewport composed animated matrix must be bounded'
# Rotation translations must also be composed with their ancestors.
Code '<g transform="translate(600000)"><g><rect x="300000" width="1" height="1"/><animateTransform attributeName="transform" type="rotate" from="0 300000 0" to="360 300000 0" dur="1s"/></g></g>' 'svg_geometry_out_of_range'
$safeMotion=$cancelMotion.Replace('600000','400000')
$safeResult=Parsed ('<g><g><rect x="-400000" width="1" height="1"/>'+$safeMotion+'</g>'+$safeMotion+'</g>')
Assert ($null -ne $safeResult.Image -and $safeResult.Animations.Count -eq 2) 'safe nested composed matrix rejected'
$limitMotion=$cancelMotion.Replace('600000','1000000')
Assert ($null -ne (Parsed ('<g><rect x="-500000" width="1" height="1"/>'+$limitMotion+'</g>')).Image) 'exact translation matrix limit rejected'
$r=Parsed '<rect width="10" height="10"/>';$play=[CodexNative.SafeSvg]::CreatePlayback($r);$play.Sample(100)
Assert ($r.Animations.Count -eq 0 -and (Alpha (Pixels $play.Image) 5 5) -eq 255) 'static playback remains static'
$play.Dispose()
[pscustomobject]@{status=$(if($script:failures.Count){'FAIL'}else{'PASS'});checks=$script:checks;failures=@($script:failures.ToArray());powershell=$PSVersionTable.PSVersion.ToString();windowsShown=0;liveApiCalls=0;rendering='offscreen RenderTargetBitmap'} | ConvertTo-Json -Depth 4
if($script:failures.Count){throw ('SVG selftest failed: '+$script:failures.Count+' assertions')}
