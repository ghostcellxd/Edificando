#!/usr/bin/env bash
# Called by nginx-rtmp when a recording finishes.
# $1 = full path to the raw .flv   $2 = basename (e.g. servicio-2025-07-13-1030)
set -euo pipefail

RAW="$1"
BASE="$2"
OUT="/recordings/vod"
mkdir -p "$OUT"

# 1) A downloadable MP4 (stream copy — fast, no re-encode)
ffmpeg -y -i "$RAW" -c copy -movflags +faststart "$OUT/$BASE.mp4"

# 2) HLS VOD for smooth low-bandwidth playback in the app
ffmpeg -y -i "$RAW" \
  -c:v libx264 -preset veryfast -b:v 500k -maxrate 550k -bufsize 1000k -s 640x360 \
  -c:a aac -b:a 64k -ac 1 \
  -f hls -hls_time 6 -hls_playlist_type vod \
  -hls_segment_filename "$OUT/${BASE}_%03d.ts" "$OUT/$BASE.m3u8"

# 3) Audio-only VOD (tiny — for the "Audio" mode on the recording)
ffmpeg -y -i "$RAW" -vn -c:a aac -b:a 48k -ac 1 \
  -f hls -hls_time 6 -hls_playlist_type vod \
  -hls_segment_filename "$OUT/${BASE}_audio_%03d.ts" "$OUT/${BASE}_audio.m3u8"

# keep raw files from piling up (comment out to retain originals)
rm -f "$RAW"
echo "archived: $BASE"
