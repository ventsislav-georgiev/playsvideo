#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

TARGET="${1:-audio}"
case "$TARGET" in
  audio)
    DOCKERFILE="$SCRIPT_DIR/Dockerfile.ffmpeg-audio"
    OUT_DIR="$SCRIPT_DIR/out"
    VENDOR_DIR="$PROJECT_DIR/src/vendor/ffmpeg-core-audio"
    DESCRIPTION="minimal ffmpeg.wasm (audio-only: AC3/EAC3/DTS → AAC)"
    ;;
  av1)
    DOCKERFILE="$SCRIPT_DIR/Dockerfile.ffmpeg-av1"
    OUT_DIR="$SCRIPT_DIR/out-av1"
    VENDOR_DIR="$PROJECT_DIR/src/vendor/ffmpeg-core-av1"
    DESCRIPTION="AV1-capable ffmpeg.wasm (libdav1d AV1 decode → H.264/AAC)"
    ;;
  *)
    echo "Usage: $0 [audio|av1]"
    exit 1
    ;;
esac

echo "Building $DESCRIPTION..."
docker buildx build \
  -f "$DOCKERFILE" \
  -o "$OUT_DIR" \
  "$PROJECT_DIR"

echo ""
echo "Output:"
ls -lh "$OUT_DIR/"

# Copy to vendor directory
mkdir -p "$VENDOR_DIR"
cp "$OUT_DIR/ffmpeg-core.js" "$OUT_DIR/ffmpeg-core.wasm" \
   "$VENDOR_DIR/"

echo ""
echo "Installed to ${VENDOR_DIR#$PROJECT_DIR/}/"
ls -lh "$VENDOR_DIR/"
