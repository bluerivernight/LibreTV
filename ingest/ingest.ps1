# ││ Libre — ingestion (PowerShell mirror of ingest.sh). Hermetic Windows runner. ││
# Utilisation is byte-identical to ingest.sh (see ingest.sh header). Flags:
#   -Source <path>  ·  -Episode <id>  ·  -Dir <name>  ·  -AssetPrefix <pfx>
#   -Renditions <csv>  ·  -Force  ·  -DryRun  ·  -OnlyShellTest <N>
# Exit codes match ingest.sh: 0 ok · 1 usage · 2 missing tool · 3 source invalid
# · 4 output failed HLS validation · 5 duplicate storage_key (no overwrite)
# · 6 R2 upload failed · 7 D1 record failed.

[CmdletBinding()]
param(
  [string]$Source,
  [string]$Episode,
  [string]$Dir,
  [string]$AssetPrefix = 'ast_',
  [string]$Renditions = '720p,480p',
  [switch]$Force,
  [switch]$DryRun,
  [int]$OnlyShellTest = -1
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
function Die([string]$msg, [int]$code) {
  Write-Error "[ingest] ERROR: $msg"
  exit $code
}
function Test-Tool([string]$name) {
  $null -ne (Get-Command $name -ErrorAction SilentlyContinue)
}

if (-not $Episode)   { Die '--episode is required' 1 }
if (-not $Source -and $OnlyShellTest -lt 0) { Die '--source is required' 1 }
if (-not $Dir)       { $Dir = $Episode }

# ── hermetic shell-test (no ffmpeg; used by bash-CI on win) ────────────────────
if ($OnlyShellTest -ge 0) {
  $out = Join-Path $repoRoot '.ingest-shell-test'
  if (Test-Path $out) { Remove-Item -Recurse -Force $out }
  foreach ($rend in $Renditions.Split(',')) {
    $rd = Join-Path $out $rend
    New-Item -ItemType Directory -Force -Path $rd | Out-Null
    $play = "#EXTM3U`n#EXT-X-VERSION:3`n#EXT-X-TARGETDURATION:2`n#EXT-X-MEDIA-SEQUENCE:0`n"
    for ($i = 0; $i -lt $OnlyShellTest; $i++) {
      Set-Content -Path (Join-Path $rd ("seg{0:D4}.ts" -f $i)) -Value 'dummy' -NoNewline
      $play += "#EXTINF:2.0,`nseg{0:D4}.ts`n" -f $i
    }
    $play += '#EXT-X-ENDLIST'
    Set-Content -Path (Join-Path $rd 'playlist.m3u8') -Value $play -NoNewline
  }
  $master = "#EXTM3U`n#EXT-X-VERSION:3`n#EXT-X-INDEPENDENT-SEGMENTS`n"
  foreach ($rend in $Renditions.Split(',')) {
    $master += "#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720`n$rend/playlist.m3u8`n"
  }
  Set-Content -Path (Join-Path $out 'master.m3u8') -Value $master -NoNewline
  Write-Output ("{{""ok"":true,""dryRun"":{0},""onlyShellTest"":true,""episode"":""{1}"",""dir"":""{2}"",""renditions"":""{3}""}}" -f `
    ($(if ($DryRun) { 'true' } else { 'false' })) , $Episode, $Dir, $Renditions)
  exit 0
}

if ($DryRun) {
  Write-Output ("{{""ok"":true,""dryRun"":true,""episode"":""{0}"",""dir"":""{1}"",""renditions"":""{2}""}}" -f $Episode, $Dir, $Renditions)
  exit 0
}

# ── tool presence ──────────────────────────────────────────────────────────────
if (-not (Test-Tool 'ffprobe'))  { Die 'ffprobe not found' 2 }
if (-not (Test-Tool 'ffmpeg'))   { Die 'ffmpeg not found' 2 }
if (-not (Test-Tool 'wrangler')) { Die 'wrangler not found' 2 }

# ── probe (source invalid → exit 3, nothing written) ───────────────────────────
if (-not (Test-Path -LiteralPath $Source)) { Die "source not found: $Source" 3 }
$probe = & ffprobe -v error -print_format json -show_format -show_streams `
  -show_entries stream=index,codec_type,codec_name,width,height $Source 2>$null
if ($LASTEXITCODE -ne 0 -or -not $probe) { Die "ffprobe failed — cannot build ABR ladder" 3 }
$hasVideo = $probe -match '"codec_type"\s*:\s*"video"'
if (-not $hasVideo) { Die 'source has no video stream — ABR ladder requires a video track' 3 }

# ── ABR ladder → transcode → verify ───────────────────────────────────────────
$now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$prefix = $AssetPrefix + $Dir -replace '-', '_'
$outRoot = Join-Path $repoRoot ('.ingest-out');

function Invoke-Transcode([string]$rend, [string]$res, [string]$bw, [string]$outRoot, [string]$Source) {
  $rd = Join-Path $outRoot $rend
  New-Item -ItemType Directory -Force -Path $rd | Out-Null
  $playlist = Join-Path $rd 'playlist.m3u8'
  & ffmpeg -y -v error -i $Source `
    -vf "scale=$res:flags=lanczos" -c:v libx264 -preset veryfast `
    -b:v $bw -maxrate $bw -bufsize ($bw * 2) `
    -g 48 -keyint_min 48 -sc_threshold 0 `
    -c:a aac -b:a 128k -ac 2 `
    -f hls -hls_time 2 -hls_list_size 0 -hls_segment_filename (Join-Path $rd 'seg%04d.ts') `
    -hls_playlist_type vod $playlist 2>$null
  if ($LASTEXITCODE -ne 0) { Die "ffmpeg exit $LASTEXITCODE for $rend — transcode failed" 4 }
  $segCount = (Get-ChildItem (Join-Path $rd 'seg*.ts') -ErrorAction SilentlyContinue).Count
  if ($segCount -eq 0) { Die "rendition $rend produced no segments" 4 }
  return $segCount
}

$renditions = @()
$segCountTotal = 0
foreach ($rend in $Renditions.Split(',')) {
  switch ($rend) {
    '720p' { $res = '1280x720'; $bw = 2400000 }
    '480p' { $res = '854x480';  $bw = 1200000 }
    default { Die "unsupported rendition: $rend" 4 }
  }
  $segCountTotal += Invoke-Transcode $rend $res $bw $outRoot $Source
  $renditions += $rend
}

# ── master playlist (§9.1) ────────────────────────────────────────────────────
$master = "#EXTM3U`n#EXT-X-VERSION:3`n#EXT-X-INDEPENDENT-SEGMENTS`n"
foreach ($rend in $renditions) {
  switch ($rend) {
    '720p' { $master += "#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720,CODECS=""avc1.64001f,mp4a.40.2""`n$rend/playlist.m3u8`n" }
    '480p' { $master += "#EXT-X-STREAM-INF:BANDWIDTH=1200000,RESOLUTION=854x480,CODECS=""avc1.4d401f,mp4a.40.2""`n$rend/playlist.m3u8`n" }
  }
}
Set-Content -Path (Join-Path $outRoot 'master.m3u8') -Value $master -NoNewline

# ── verify output parses as HLS (§8: fail with exit 4, do not upload) ─────────
$masterTxt = Get-Content -Raw (Join-Path $outRoot 'master.m3u8')
if (-not $masterTxt.StartsWith('#EXTM3U')) { Die 'master.m3u8 malformed' 4 }
foreach ($rend in $renditions) {
  $play = Join-Path $outRoot "$rend/playlist.m3u8"
  if (-not (Test-Path $play)) { Die "missing playlist: $rend" 4 }
  $txt = Get-Content -Raw $play
  if (-not $txt.Contains('#EXT-X-TARGETDURATION')) { Die "playlist.m3u8 malformed ($rend)" 4 }
  if (-not $txt.Contains('#EXTINF:'))               { Die "playlist.m3u8 malformed ($rend)" 4 }
  if (-not $txt.Contains('#EXT-X-ENDLIST'))         { Die "playlist.m3u8 malformed ($rend)" 4 }
}

# ── duplicate guard (§9: storage_key unique; abort without --force) ────────────
$dupQ = "SELECT COUNT(*) AS n FROM assets WHERE storage_key IN ('media/$Dir/master.m3u8'"
foreach ($rend in $renditions) { $dupQ += ",'media/$Dir/$rend/playlist.m3u8'" }
$dupQ += ');'
$dup = & wrangler d1 execute libre-db --command $dupQ --pretty=false 2>$null
$dupN = 0
$dup | ForEach-Object { if ($_ -match '"n"\s*:\s*(\d+)') { $dupN = [int]$Matches[1] } }
if ($dupN -gt 0 -and -not $Force) {
  Die "duplicate storage_key (n=$dupN) — re-run with -Force to overwrite" 5
}

# ── R2 put (exit 6 on failure) ─────────────────────────────────────────────────
foreach ($rend in $renditions) {
  Get-ChildItem (Join-Path $outRoot "$rend/seg*.ts") | ForEach-Object {
    & wrangler r2 object put "libre-media/media/$Dir/$rend/$($_.Name)" --file $_.FullName 2>$null
    if ($LASTEXITCODE -ne 0) { Die "R2 upload failed ($rend/$($_.Name))" 6 }
  }
  & wrangler r2 object put "libre-media/media/$Dir/$rend/playlist.m3u8" --file (Join-Path $outRoot "$rend/playlist.m3u8") 2>$null
  if ($LASTEXITCODE -ne 0) { Die "R2 upload failed ($rend/playlist.m3u8)" 6 }
}
& wrangler r2 object put "libre-media/media/$Dir/master.m3u8" --file (Join-Path $outRoot 'master.m3u8') 2>$null
if ($LASTEXITCODE -ne 0) { Die 'R2 upload failed (master.m3u8)' 6 }

# ── D1 record (exit 7 on failure) ─────────────────────────────────────────────
$values = @()
foreach ($rend in $renditions) {
  $plSize = (Get-Item (Join-Path $outRoot "$rend/playlist.m3u8")).Length
  Get-ChildItem (Join-Path $outRoot "$rend/seg*.ts") | ForEach-Object {
    $id = "$prefix`_$rend`_seg$([regex]::Match($_.Name, '(\d+)$').Groups[1].Value)"
    $values += "('$id', '$Episode', 'media/$Dir/$rend/$($_.Name)', 'hls', '$rend', 'ts', '{}', $($_.Length), 2.0, 1, $now)"
  }
  $id = "$prefix`_$rend`_pl"
  $values += "('$id', '$Episode', 'media/$Dir/$rend/playlist.m3u8', 'hls', '$rend', 'ts', '{}', $plSize, NULL, 1, $now)"
}
$values += "'$prefix`_master', '$Episode', 'media/$Dir/master.m3u8', 'hls', NULL, NULL, '{}', $((Get-Item (Join-Path $outRoot 'master.m3u8')).Length), NULL, 1, $now"
$valuesJoined = $values -join '),('
$sql = "INSERT OR REPLACE INTO assets (id, episode_id, storage_key, media_type, rendition, container, codecs_json, byte_size, duration_seconds, is_enabled, created_at) VALUES $valuesJoined);"
$tmp = Join-Path $repoRoot '.ingest-d1.sql'
Set-Content -Path $tmp -Value $sql -NoNewline
& wrangler d1 execute libre-db --file $tmp 2>$null
if ($LASTEXITCODE -ne 0) { Die 'D1 record failed' 7 }
Remove-Item -LiteralPath $tmp -ErrorAction SilentlyContinue

# ── report (same shape as ingest.sh) ──────────────────────────────────────────
$keys = @(
  "media/$Dir/master.m3u8",
  ($renditions | ForEach-Object { "media/$Dir/$_/playlist.m3u8" })
) | ForEach-Object { $_ }
Write-Output ("{{""ok"":true,""episode"":""{0}"",""dir"":""{1}"",""storageKeys"":[{2}],""segmentCount"":{3},""assetPrefix"":""{4}""}}" -f `
  $Episode, $Dir, (($keys -replace '"', '\"') -join ','), $segCountTotal, $AssetPrefix)
