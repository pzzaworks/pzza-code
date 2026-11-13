#!/usr/bin/env bash
# Build, sign, notarize and publish a PzzaCode release, including the signed
# updater artifacts + latest.json that the in-app updater consumes.
#
#   scripts/release.sh            # release the version in src-tauri/tauri.conf.json
#   NOTES=path/to/notes.md scripts/release.sh
#
# Secrets and signing identifiers are pulled from 1Password at run time, so
# nothing identifying lives in the repo. Needs: `op` signed in (1Password CLI),
# the Tauri updater private key at ~/.tauri/pzzacode.key (1Password item
# "PzzaCode Tauri updater signing key"), the Developer ID cert in the login
# Keychain, and `gh` logged in. The Apple signing identity, App Store Connect
# notary key id / issuer and the .p8 key all come from the 1Password items
# referenced below (Personal vault, by opaque id). Any of the env vars can be
# set to override 1Password.
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=$(python3 -c 'import json;print(json.load(open("src-tauri/tauri.conf.json"))["version"])')
TAG="v$VERSION"
REPO="pzzaworks/pzza-code"

# 1Password references (Personal vault). The item holds the Apple signing
# identity + notary key id / issuer; the document is the notary .p8 private key.
OP_NOTARY_ITEM="op://Personal/qz5upvymqlr4il7gkvad5l2gtm"
OP_P8_DOC="hu6q7jbcg5w2bubye4fptjioei"

KEY="${TAURI_SIGNING_PRIVATE_KEY_PATH:-$HOME/.tauri/pzzacode.key}"
[ -f "$KEY" ] || { echo "updater signing key not found at $KEY"; exit 1; }
# The bundler reads the key *content* from TAURI_SIGNING_PRIVATE_KEY (the
# _PATH form is only honoured by `tauri signer sign`), so load it here; the
# key never leaves this process's environment.
export TAURI_SIGNING_PRIVATE_KEY="$(cat "$KEY")"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"
export APPLE_SIGNING_IDENTITY="${APPLE_SIGNING_IDENTITY:-$(op read "$OP_NOTARY_ITEM/signing identity")}"
NOTARY_KEY_ID="${NOTARY_KEY_ID:-$(op read "$OP_NOTARY_ITEM/key id")}"
NOTARY_ISSUER="${NOTARY_ISSUER:-$(op read "$OP_NOTARY_ITEM/issuer")}"
export PATH="$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin:$PATH"
# CI=true makes Tauri's DMG bundler skip the AppleScript that mounts the image
# and opens a Finder window to arrange icons - so a build never pops the DMG open.
export CI=true

# CARGO_TARGET_DIR moves the whole build elsewhere: a release must never
# overwrite a bundle that a running terminal helper was started from, since
# that helper owns every local terminal session on this Mac.
BUNDLE="${CARGO_TARGET_DIR:-src-tauri/target}/aarch64-apple-darwin/release/bundle"
APP="$BUNDLE/macos/PzzaCode.app"
# A fresh target folder has no bundle yet; create it so the path resolves.
mkdir -p "$(dirname "$APP")"
APP_BINARY="$(cd "$(dirname "$APP")" 2>/dev/null && pwd)/PzzaCode.app/Contents/MacOS/pzzacode"
# Paths compare without case (the volume is case-insensitive), against every
# process including the launchd-started helper.
if ps -axo command= | awk -v binary="$APP_BINARY" 'index(tolower($0), tolower(binary)) == 1 { found = 1 } END { exit !found }'; then
  echo "A running PzzaCode process uses $APP_BINARY. Set CARGO_TARGET_DIR to another folder so the release does not replace it."
  exit 1
fi

echo "==> Building $TAG (Apple Silicon)"
npm run tauri build -- --target aarch64-apple-darwin --bundles app,dmg

DMG="$BUNDLE/dmg/PzzaCode_${VERSION}_aarch64.dmg"
TARGZ="$BUNDLE/macos/PzzaCode.app.tar.gz"
SIG="$TARGZ.sig"
for f in "$APP" "$DMG" "$TARGZ" "$SIG"; do [ -e "$f" ] || { echo "missing artifact: $f"; exit 1; }; done

# Boot the device agent exactly as the built app ships it. A bundle missing a
# module would leave every user on "Agent unreachable", so it never gets published.
echo "==> Checking the bundled agent starts"
node scripts/agent-smoke.mjs "$APP/Contents/Resources/server"

echo "==> Notarizing"
# Pull the .p8 notary key from 1Password into a temp file for the duration of
# the submit, then shred it - the private key never lands in the repo or a
# persistent path here.
P8="$(mktemp)"; trap 'rm -f "$P8"' EXIT
op document get "$OP_P8_DOC" --out-file "$P8" --force >/dev/null
xcrun notarytool submit "$DMG" --key "$P8" --key-id "$NOTARY_KEY_ID" \
  --issuer "$NOTARY_ISSUER" --wait | tail -2
rm -f "$P8"
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
  "platforms": {"darwin-aarch64": entry},
}, indent=2, ensure_ascii=True))
PY
python3 -c 'import json;json.load(open("/tmp/latest.json"))' || { echo "latest.json is not valid JSON"; exit 1; }

echo "==> Publishing $TAG"
git tag -a "$TAG" -m "PzzaCode $VERSION" 2>/dev/null || true
git push origin "$TAG"
if gh release view "$TAG" -R "$REPO" >/dev/null 2>&1; then
  gh release upload "$TAG" "$DMG" "$TARGZ" "$SIG" /tmp/latest.json -R "$REPO" --clobber
else
  # Notes are passed as a proper array: an unquoted "--notes PzzaCode $VERSION"
  # word-splits and gh then treats the version as a missing asset file.
  if [ -n "${NOTES:-}" ]; then NOTE_ARGS=(--notes-file "$NOTES"); else NOTE_ARGS=(--notes "PzzaCode $VERSION"); fi
  gh release create "$TAG" "$DMG" "$TARGZ" "$SIG" /tmp/latest.json -R "$REPO" --title "PzzaCode $VERSION" --latest "${NOTE_ARGS[@]}"
fi
echo "==> Done: https://github.com/$REPO/releases/tag/$TAG"
