#!/usr/bin/env bash
# Build, sign, notarize and publish a PzzaCode release, including the signed
# updater artifacts + latest.json that the in-app updater consumes.
#
#   scripts/release.sh            # release the version in src-tauri/tauri.conf.json
#   NOTES=path/to/notes.md scripts/release.sh
#
# Needs: the Tauri updater private key at ~/.tauri/pzzacode.key (in 1Password:
# "PzzaCode Tauri updater signing key"), the Developer ID cert in the login
# Keychain, the notarytool API key at ~/.private_keys, and `gh` logged in.
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=$(python3 -c 'import json;print(json.load(open("src-tauri/tauri.conf.json"))["version"])')
TAG="v$VERSION"
REPO="pzzaworks/pzza-code"
KEY="${TAURI_SIGNING_PRIVATE_KEY_PATH:-$HOME/.tauri/pzzacode.key}"
[ -f "$KEY" ] || { echo "updater signing key not found at $KEY"; exit 1; }
# The bundler reads the key *content* from TAURI_SIGNING_PRIVATE_KEY (the
# _PATH form is only honoured by `tauri signer sign`), so load it here; the
# key never leaves this process's environment.
export TAURI_SIGNING_PRIVATE_KEY="$(cat "$KEY")"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"
export APPLE_SIGNING_IDENTITY="${APPLE_SIGNING_IDENTITY:-Developer ID Application: Berke Kiran (U7SA296AP6)}"
export PATH="$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin:$PATH"
# CI=true makes Tauri's DMG bundler skip the AppleScript that mounts the image
# and opens a Finder window to arrange icons - so a build never pops the DMG open.
export CI=true

echo "==> Building $TAG (universal)"
npm run tauri build -- --target universal-apple-darwin --bundles app,dmg

BUNDLE="src-tauri/target/universal-apple-darwin/release/bundle"
APP="$BUNDLE/macos/PzzaCode.app"
DMG="$BUNDLE/dmg/PzzaCode_${VERSION}_universal.dmg"
TARGZ="$BUNDLE/macos/PzzaCode.app.tar.gz"
SIG="$TARGZ.sig"
for f in "$APP" "$DMG" "$TARGZ" "$SIG"; do [ -e "$f" ] || { echo "missing artifact: $f"; exit 1; }; done

echo "==> Notarizing"
xcrun notarytool submit "$DMG" --key "$HOME/.private_keys/AuthKey_F583398JAT.p8" --key-id F583398JAT \
  --issuer c203e675-87f8-43a8-89f8-8581ba23de62 --wait | tail -2
xcrun stapler staple "$DMG" | tail -1
xcrun stapler staple "$APP" | tail -1

echo "==> Writing latest.json"
URL="https://github.com/$REPO/releases/download/$TAG/PzzaCode.app.tar.gz"
# Read the signature and notes from files inside Python (argv would mangle
# newlines and control characters), and strip the signature so the JSON is
# exactly what the updater plugin expects.
python3 - "$VERSION" "$URL" "$SIG" "${NOTES:-}" > /tmp/latest.json <<'PY'
import json, sys, datetime, pathlib
v, url, sig_path, notes_path = sys.argv[1:5]
sig = pathlib.Path(sig_path).read_text().strip()
notes = pathlib.Path(notes_path).read_text().strip() if notes_path else f"PzzaCode {v}"
entry = {"signature": sig, "url": url}
print(json.dumps({
  "version": v,
  "notes": notes,
  "pub_date": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
  "platforms": {"darwin-universal": entry, "darwin-aarch64": entry, "darwin-x86_64": entry},
}, indent=2, ensure_ascii=True))
PY
python3 -c 'import json;json.load(open("/tmp/latest.json"))' || { echo "latest.json is not valid JSON"; exit 1; }

echo "==> Publishing $TAG"
git tag -a "$TAG" -m "PzzaCode $VERSION" 2>/dev/null || true
git push origin "$TAG"
if gh release view "$TAG" -R "$REPO" >/dev/null 2>&1; then
  gh release upload "$TAG" "$DMG" "$TARGZ" "$SIG" /tmp/latest.json -R "$REPO" --clobber
else
  gh release create "$TAG" "$DMG" "$TARGZ" "$SIG" /tmp/latest.json -R "$REPO" --title "PzzaCode $VERSION" --latest \
    $( [ -n "${NOTES:-}" ] && echo "--notes-file $NOTES" || echo "--notes PzzaCode $VERSION" )
fi
echo "==> Done: https://github.com/$REPO/releases/tag/$TAG"
