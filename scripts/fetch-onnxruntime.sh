#!/bin/sh
# Fetches the official ONNX Runtime (MIT) for macOS arm64, pinned by URL, size
# and SHA-256, and places its library where the app bundle picks it up
# (src-tauri/frameworks, bundled into Contents/Frameworks and signed with the
# app). Dictation's voice activity detection loads it at run time. Idempotent.
set -eu
VERSION="1.31.0"
URL="https://github.com/microsoft/onnxruntime/releases/download/v${VERSION}/onnxruntime-osx-arm64-${VERSION}.tgz"
ARCHIVE_BYTES=36549009
ARCHIVE_SHA256="1031b36dd3bdaa8d976a6130d9cf2a05e9be320b93ae804f8427b91dc3432afc"
LIBRARY_SHA256="2a50a63e7f41f8d4d551d3ee47248df3864f6540109fce8ad520ca3b51af4b70"

root="$(cd "$(dirname "$0")/.." && pwd)"
cache="$root/src-tauri/target/onnxruntime"
destination="$root/src-tauri/frameworks/libonnxruntime.1.dylib"
archive="$cache/onnxruntime-osx-arm64-${VERSION}.tgz"

sha256() { shasum -a 256 "$1" | cut -d' ' -f1; }

if [ -f "$destination" ] && [ "$(sha256 "$destination")" = "$LIBRARY_SHA256" ]; then
  exit 0
fi
mkdir -p "$cache" "$(dirname "$destination")"
if [ ! -f "$archive" ] || [ "$(sha256 "$archive")" != "$ARCHIVE_SHA256" ]; then
  rm -f "$archive.part"
  curl --fail --location --silent --show-error --proto '=https' --output "$archive.part" "$URL"
  size="$(wc -c < "$archive.part" | tr -d ' ')"
  if [ "$size" != "$ARCHIVE_BYTES" ] || [ "$(sha256 "$archive.part")" != "$ARCHIVE_SHA256" ]; then
    rm -f "$archive.part"
    echo "ONNX Runtime download failed verification." >&2
    exit 1
  fi
  mv "$archive.part" "$archive"
fi
extracted="$cache/extracted"
rm -rf "$extracted"
mkdir -p "$extracted"
tar -xzf "$archive" -C "$extracted" "onnxruntime-osx-arm64-${VERSION}/lib/libonnxruntime.${VERSION}.dylib"
library="$extracted/onnxruntime-osx-arm64-${VERSION}/lib/libonnxruntime.${VERSION}.dylib"
if [ "$(sha256 "$library")" != "$LIBRARY_SHA256" ]; then
  echo "ONNX Runtime library failed verification." >&2
  exit 1
fi
cp "$library" "$destination"
echo "ONNX Runtime ${VERSION} ready at src-tauri/frameworks/libonnxruntime.1.dylib"
