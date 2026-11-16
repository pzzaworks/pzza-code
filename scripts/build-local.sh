#!/usr/bin/env bash
# Build PzzaCode to try changes on this Mac: the app bundle only, signed with
# this Mac's Developer ID certificate, under the release app's name and bundle
# identifier. macOS then sees it as the same app as the release, so privacy
# permissions (Full Disk Access, Microphone, Automation, ...) granted to one
# hold for the other, and switching between them never asks again. Nothing is
# notarized, published or prepared for the updater.
#
#   scripts/build-local.sh            # or: npm run build:local
#
# The signing identity is the keychain's Developer ID Application certificate,
# looked up at run time so nothing identifying lives in the repo;
# APPLE_SIGNING_IDENTITY overrides it.
set -euo pipefail
cd "$(dirname "$0")/.."

IDENTITY="${APPLE_SIGNING_IDENTITY:-$(security find-identity -v -p codesigning | awk -F'"' '/"Developer ID Application: / { print $2; exit }')}"
if [ -z "$IDENTITY" ]; then
  echo "No Developer ID Application certificate in the keychain. An unsigned build would be a different app to macOS and break the release app's permissions, so nothing was built."
  exit 1
fi
export APPLE_SIGNING_IDENTITY="$IDENTITY"
export PATH="$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin:$PATH"
# Keeps Tauri's bundler from opening Finder windows during the build.
export CI=true

# The bundle may be the one the terminal helper was started from (a local
# build shares the release app's terminal service); replacing it under a
# running helper would break every terminal it owns.
# Cargo runs inside src-tauri, so a relative target folder is made absolute
# here: the build and this check then mean the same folder.
TARGET_DIR="${CARGO_TARGET_DIR:-src-tauri/target}"
case "$TARGET_DIR" in /*) ;; *) TARGET_DIR="$PWD/$TARGET_DIR" ;; esac
export CARGO_TARGET_DIR="$TARGET_DIR"
BUNDLE="$TARGET_DIR/aarch64-apple-darwin/release/bundle"
APP="$BUNDLE/macos/PzzaCode.app"
mkdir -p "$(dirname "$APP")"
APP_BINARY="$(cd "$(dirname "$APP")" && pwd)/PzzaCode.app/Contents/MacOS/pzzacode"
if ps -axo command= | awk -v binary="$APP_BINARY" 'index(tolower($0), tolower(binary)) == 1 { found = 1 } END { exit !found }'; then
  echo "A running PzzaCode process uses $APP_BINARY. Quit it (and open the installed app once, so the terminals move back to it), or set CARGO_TARGET_DIR to another folder."
  exit 1
fi

npm run tauri build -- --target aarch64-apple-darwin --bundles app --config '{"bundle":{"createUpdaterArtifacts":false}}' "$@"
echo "Built $APP"
