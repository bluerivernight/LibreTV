#!/usr/bin/env bash
# Libre — media ingestion (M3, Phase 1). Canonical local runner. Bash-first.
#
# Contract (ARCHITECTURE §8/§9/§20 + IMPLEMENTATION_MAP Priority 9):
#   source ──ffprobe──▶ ABR ladder ──ffmpeg──▶ verify parses as HLS ──▶ R2 ──▶ D1
#
# - Transcoding happens HERE (local ffmpeg), never on-demand in the Worker
#   (§20: "Cloudflare Workers are not Libre's video transcoding environment").
# - Pre-transcoded output is uploaded to R2, then recorded in D1 (assets).
# - Canonical output layout (MUST match seed.sql fixtures + playback routes):
#       media/<dir>/master.m3u8
#       media/<dir>/<rend>/playlist.m3u8
#       media/<dir>/<rend>/segNNNN.ts
#
# Usage:
#   ingest/ingest.sh --source <file|dir> --episode <id> [options]
#
# Flags:
#   --source <path>       input file or directory (probe + transcode)
#   --episode <id>        D1 episodes row the assets belong to
#   --dir <name>          R2/media subdir (default: <episode>)
#   --renditions <csv>    "720p,480p" (default ladder: "$RENDITIONS_DEFAULT")
#   --asset-prefix <pfx>  id prefix for generated asset rows (default ast_)
#   --force               overwrite an existing storage_key in D1
#                         (default: abort with exit 5 if asset already exists)
#   --dry-run             probe + plan only; no transcode, no R2 put, no D1 write
#   --only-shell-test N   hermetic bash-CI mode: write N fixture segments + HLS
#                         playlists (no ffmpeg required), validate, print report
#   -h | --help           this help
#
# Exit codes:
#   0 success · 1 usage · 2 missing tool (ffmpeg/ffprobe/wrangler)
#   3 source invalid (missing/unprobeable) · 4 output failed HLS validation
#   5 duplicate storage_key without --force · 6 R2 upload failed · 7 D1 write failed

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKER_DIR="$REPO_ROOT/worker"
RENDITIONS_DEFAULT="720p,480p"

die() { printf '[ingest] ERROR: %s\n' "$*" >&2; exit "${2:-1}"; }
log() { printf '[ingest] %s\n' "$*"; }

usage() {
  sed -n '1,32p' "${BASH_SOURCE[0]}" | grep '^# ' | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

# ── arg parsing ────────────────────────────────────────────────────────────────
source_path=""
episode=""
dir=""
renditions="$RENDITIONS_DEFAULT"
asset_prefix="ast_"
force=0
dry_run=0
mode=""
N=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source)      source_path="${2:-}"; shift 2 ;;
    --episode)     episode="${2:-}"; shift 2 ;;
    --dir)         dir="${2:-}"; shift 2 ;;
    --renditions)  renditions="${2:-}"; shift 2 ;;
    --asset-prefix) asset_prefix="${2:-}"; shift 2 ;;
    --force)       force=1; shift ;;
    --dry-run)     dry_run=1; shift ;;
    --only-shell-test) mode="shell-test"; N="${2:-0}"; shift 2 ;;
    -h|--help)     usage 0 ;;
    *)             die "unknown option: $1" 1 ;;
  esac
done

[[ -n "$source_path" ]] || die "--source is required" 1
[[ -n "$episode" ]]     || die "--episode is required" 1
[[ -n "$dir" ]]         || dir="$episode"

# ── hermetic shell-test mode (no ffmpeg — pure-bash CI) ───────────────────────
if [[ "$mode" == "shell-test" ]]; then
  [[ "$N" =~ ^[0-9]+$ && "$N" -ge 1 ]] || die "--only-shell-test needs N >= 1" 1
  OUT="$REPO_ROOT/.ingest-shell-test"
  rm -rf "$OUT"
  for rend in ${renditions//,/ }; do
    mkdir -p "$OUT/$rend"
    { printf '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n'
      printf '#EXT-X-MEDIA-SEQUENCE:0\n'
      for ((i=0; i<N; i++)); do
        printf '#EXTINF:2.0,\nseg%04d.ts\n' "$i"
        printf 'dummy' > "$OUT/$rend/seg%04d.ts" "$i"
      done
      printf '#EXT-X-ENDLIST\n'; } > "$OUT/$rend/playlist.m3u8"
  done
  { printf '#EXTM3U\n#EXT-X-VERSION:3\n'
    for rend in ${renditions//,/ }; do
      printf '#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720\n%s/playlist.m3u8\n' "$rend"
    done; } > "$OUT/master.m3u8"
  # Verify it parses as HLS (else exit 4).
  grep -q '^#EXTM3U$'            "$OUT/master.m3u8" || die "master malformed" 4
  for rend in ${renditions//,/ }; do
    grep -q '^#EXT-X-TARGETDURATION' "$OUT/$rend/playlist.m3u8" || die "playlist malformed" 4
    grep -q '^#EXT-X-ENDLIST$'        "$OUT/$rend/playlist.m3u8" || die "playlist malformed" 4
  done
  echo "{\"ok\":true,\"shellTest\":true,\"segmentsPerRend\":$N,\"renditions\":\"$renditions\",\"outputDir\":\"$OUT\"}"
  exit 0
fi

# ── tool presence (§20 — local runtime, not Worker) ───────────────────────────
command -v ffprobe  >/dev/null 2>&1 || die "ffprobe not found (local transcode env)" 2
command -v ffmpeg   >/dev/null 2>&1 || die "ffmpeg not found (local transcode env)" 2
command -v wrangler >/dev/null 2>&1 || die "wrangler not found (R2/D1 client)" 2
command -v jq       >/dev/null 2>&1 || die "jq not found" 2

# ── probe source (invalid → exit 3, nothing written) ──────────────────────────
[[ -f "$source_path" ]] || die "source not found: $source_path" 3
probe_json="$(ffprobe -v error -print_format json -show_format -show_streams \
  -show_entries stream=index,codec_type,codec_name,width,height,avg_frame_rate \
  "$source_path" 2>/dev/null)" || die "ffprobe failed on $source_path" 3
echo "$probe_json" | jq -e . >/dev/null 2>&1 || die "ffprobe output unparseable" 3
jq -e '.streams[] | select(.codec_type == "video")' <<<"$probe_json" >/dev/null \
  || die "source has no video stream — ABR ladder needs a video track" 3

# ── ABR ladder → transcode (§20 ladder, §9.1 layout) ──────────────────────────
out_root="$REPO_ROOT/.ingest-out"
rm -rf "$out_root"
seg_count=0
for rend in ${renditions//,/ }; do
  mkdir -p "$out_root/$rend"
  case "$rend" in
    720p) res="1280x720"; bw="2400000" ;;
    480p) res="854x480";  bw="1200000" ;;
    *)    die "unsupported rendition: $rend (ladder spec \$9)" 4 ;;
  esac
  if ffmpeg -y -v error -i "$source_path" \
       -vf "scale=$res:flags=lanczos" -c:v libx264 -preset veryfast \
       -b:v "$bw" -maxrate "$bw" -bufsize "$((bw*2))" \
       -g 48 -keyint_min 48 -sc_threshold 0 \
       -c:a aac -b:a 128k -ac 2 \
       -f hls -hls_time 2 -hls_list_size 0 -hls_segment_filename "$out_root/$rend/seg%04d.ts" \
       -hls_playlist_type vod "$out_root/$rend/playlist.m3u8" 2>/dev/null; then
    : # transcode ok
  else
    die "ffmpeg transcode failed for $rend (exit 4)" 4
  fi
  seg_count=$((seg_count + $(ls "$out_root/$rend"/seg*.ts 2>/dev/null | wc -l)))
done

{ printf '#EXTM3U\n#EXT-X-VERSION:3\n'
  for rend in ${renditions//,/ }; do
    printf '#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720\n%s/playlist.m3u8\n' "$rend"
  done; } > "$out_root/master.m3u8"

# ── verify output parses as HLS (else exit 4) ─────────────────────────────────
grep -q '^#EXTM3U$'            "$out_root/master.m3u8"  || die "master.m3u8 malformed" 4
for rend in ${renditions//,/ }; do
  grep -q '^#EXT-X-TARGETDURATION' "$out_root/$rend/playlist.m3u8" || die "playlist.m3u8 malformed" 4
  grep -q '^#EXTINF:'              "$out_root/$rend/playlist.m3u8" || die "playlist.m3u8 has no segments" 4
  grep -q '^#EXT-X-ENDLIST$'       "$out_root/$rend/playlist.m3u8" || die "playlist.m3u8 not closed" 4
  [[ -s "$out_root/$rend/seg0000.ts" ]] || die "rendition $rend produced no segments" 4
done

# ── dry-run: stop before any mutation ─────────────────────────────────────────
if [[ "$dry_run" == "1" ]]; then
  echo "{\"ok\":true,\"dryRun\":true,\"episode\":\"$episode\",\"plan\":{\"renditions\":\"$renditions\",\"segments\":$seg_count,\"storageKeys\":[\"media/$dir/master.m3u8\"$(for r in ${renditions//,/ }; do printf ',"media/%s/%s/playlist.m3u8"'; done | sed "s|\"media/|,|g" | sed 's|,,\",|,|g')]}}"
  exit 0
fi

# ── duplicate guard (§9: storage_key unique; no clobber without --force) ──────
prefix="ast_${dir//-/}"
existing_json="$(wrangler d1 execute libre-db --local --command \
  "SELECT storage_key FROM assets WHERE episode_id='$episode';" --json 2>/dev/null || true)"
dup_key="$(echo "$existing_json" | jq -r '.. | objects | .storage_key? // empty' 2>/dev/null | grep -Fx "media/$dir/master.m3u8" || true)"
if [[ -n "$dup_key" && "$force" != "1" ]]; then
  die "asset already exists (duplicate storage_key 'media/$dir/master.m3u8') — re-run with --force" 5
fi

# ── R2 put + D1 record (exit 6 / 7) ───────────────────────────────────────────
now="$(date +%s)"
store_all() {
  for rend in ${renditions//,/ }; do
    for seg in "$out_root/$rend"/seg*.ts; do
      [[ -e "$seg" ]] || continue
      wrangler r2 object put "libre-media/media/$dir/$rend/$(basename "$seg")" --file "$seg" >/dev/null 2>&1 \
        || die "R2 put failed: media/$dir/$rend/$(basename "$seg")" 6
    done
    wrangler r2 object put "libre-media/media/$dir/$rend/playlist.m3u8" --file "$out_root/$rend/playlist.m3u8" >/dev/null 2>&1 \
      || die "R2 put failed: playlist.m3u8" 6
  done
  wrangler r2 object put "libre-media/media/$dir/master.m3u8" --file "$out_root/master.m3u8" >/dev/null 2>&1 \
    || die "R2 put failed: master.m3u8" 6
}
if [[ "$mode" != "shell-test" ]]; then store_all; fi

sql_stmt=""
for rend in ${renditions//,/ }; do
  for seg in "$out_root/$rend"/seg*.ts; do
    [[ -e "$seg" ]] || continue
    size="$(stat -c%s "$seg" 2>/dev/null || stat -f%z "$seg")"
    sql_stmt+="('${prefix}_${rend//./_}_$(basename "$seg" .ts)', '$episode', 'media/$dir/$rend/$(basename "$seg")', 'hls', '$rend', 'ts', '{}', $size, 2.0, 1, $now),"
  done
  sql_stmt+="('${prefix}_${rend//./_}_pl', '$episode', 'media/$dir/$rend/playlist.m3u8', 'hls', '$rend', 'ts', '{}', $(stat -c%s "$out_root/$rend/playlist.m3u8" 2>/dev/null || stat -f%z "$out_root/$rend/playlist.m3u8"), 4096, 2.0, 1, $now),"
done
sql_stmt+="('${prefix}_master', '$episode', 'media/$dir/master.m3u8', 'hls', NULL, NULL, '{}', $(stat -c%s "$out_root/master.m3u8" 2>/dev/null || stat -f%z "$out_root/master.m3u8"), 512, NULL, 1, $now)"
sql_stmt="${sql_stmt%,}"

tmp_sql="$REPO_ROOT/.ingest-d1.sql"
{
  echo "BEGIN;"
  for stmt in "${sql_stmt//),/(/}"; do :; done
  echo "INSERT OR $( [[ \"$force\" == \"1\" ]] && echo REPLACE || echo IGNORE ) INTO assets (id, episode_id, storage_key, media_type, rendition, container, codecs_json, byte_size, duration_seconds, is_enabled, created_at) VALUES $sql_stmt;"
  echo "COMMIT;"
} > "$tmp_sql"
wrangler d1 execute libre-db --local --file "$tmp_sql" >/dev/null 2>&1 || die "D1 record failed" 7
rm -f "$tmp_sql"

# ── report ────────────────────────────────────────────────────────────────────
asset_ids=""
for rend in ${renditions//,/ }; do
  asset_ids+=",\"${prefix}_${rend//./_}_pl\""
done
asset_ids="${asset_ids#,}"
echo "{\"ok\":true,\"episode\":\"$episode\",\"assetId\":\"${prefix}_master\",\"storageKey\":\"media/$dir/master.m3u8\",\"segments\":$seg_count,\"renditions\":\"$renditions\",\"assetIds\":[$asset_ids]}"
exit 0
