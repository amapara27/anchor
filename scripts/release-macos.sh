#!/usr/bin/env bash
# Signed + notarized release build. No secret is ever passed as a command-line
# argument: the cert lives in the keychain, and notarization uses an App Store
# Connect API key that Tauri hands to notarytool as a file path.
set -euo pipefail

# Picks the Developer ID cert out of the keychain so the identity is never
# hardcoded — fails loudly if step 1 (cert install) was skipped.
APPLE_SIGNING_IDENTITY=$(security find-identity -v -p codesigning \
  | sed -n 's/.*"\(Developer ID Application: .*\)"/\1/p' | head -1)
[ -n "$APPLE_SIGNING_IDENTITY" ] || {
  echo "no Developer ID Application certificate in the keychain" >&2; exit 1; }

# Notarization auth. Deliberately API-key-only: Tauri hands notarytool a file
# path, whereas an app-specific password would go in argv where any process on
# the machine can read it. Do not add a password fallback.
NOTARY_VARS=""
APPLE_API_KEY_PATH=$(ls "$HOME"/private_keys/AuthKey_*.p8 2>/dev/null | head -1) || true
if [ -n "$APPLE_API_KEY_PATH" ] && [ -f "$HOME/private_keys/issuer_id" ]; then
  # Key ID is the filename suffix Apple assigns; the issuer is account-level,
  # so both live beside the key rather than in this file.
  APPLE_API_KEY=$(basename "$APPLE_API_KEY_PATH" .p8 | sed 's/^AuthKey_//')
  APPLE_API_ISSUER=$(cat "$HOME/private_keys/issuer_id")
  NOTARY_VARS="APPLE_API_KEY APPLE_API_ISSUER APPLE_API_KEY_PATH"
  echo "notarizing with API key $APPLE_API_KEY"
else
  echo "no notarization credentials: need ~/private_keys/AuthKey_*.p8" >&2
  echo "and ~/private_keys/issuer_id (App Store Connect API key)" >&2
  exit 1
fi

# Separate from the Apple cert: this key signs the update manifest so shipped
# copies will accept the download. Losing it means no client can ever update.
KEY_PATH="${TAURI_KEY_PATH:-$HOME/.tauri/anchor.key}"
[ -f "$KEY_PATH" ] || { echo "no updater key at $KEY_PATH" >&2; exit 1; }
TAURI_SIGNING_PRIVATE_KEY=$(cat "$KEY_PATH")
TAURI_SIGNING_PRIVATE_KEY_PASSWORD=$(security find-generic-password -s anchor-updater-key -w)

# shellcheck disable=SC2086  # NOTARY_VARS is a deliberate word-split list
export APPLE_SIGNING_IDENTITY $NOTARY_VARS
export TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD
echo "signing as $APPLE_SIGNING_IDENTITY"

pnpm build

APP="target/release/bundle/macos/Anchor.app"
codesign --verify --deep --strict --verbose=2 "$APP"
# The real test: what Gatekeeper says on a machine that has never seen this app.
spctl --assess --type execute -vvv "$APP"
xcrun stapler validate "$APP"

# Tauri notarizes the .app but NOT the .dmg it then wraps around it, and the dmg
# is what users actually download — so it carries the quarantine flag and gets
# assessed on mount. Submit and staple it too, or every user sees "Apple could
# not verify this app" even though the app inside is notarized.
DMG=$(ls target/release/bundle/dmg/*.dmg | head -1)
xcrun notarytool submit "$DMG" --key "$APPLE_API_KEY_PATH" \
  --key-id "$APPLE_API_KEY" --issuer "$APPLE_API_ISSUER" --wait
xcrun stapler staple "$DMG"
# Stapling lets Gatekeeper clear it offline; --context matches how a mount is judged.
spctl --assess --type open --context context:primary-signature -vv "$DMG"

# writes current version for updater plugin to compare to
VERSION=$(node -p "require('./apps/desktop/src-tauri/tauri.conf.json').version")
OUT="target/release/bundle/latest.json"
node -e '
const fs = require("fs");
const [version, sig] = [process.argv[1], fs.readFileSync(process.argv[2], "utf8").trim()];
fs.writeFileSync(process.argv[3], JSON.stringify({
  version,
  pub_date: new Date().toISOString(),
  platforms: {
    // Apple Silicon only: the build is aarch64 and Anchor targets M-series.
    "darwin-aarch64": {
      signature: sig,
      url: `https://github.com/amapara27/anchor/releases/download/v${version}/Anchor.app.tar.gz`,
    },
  },
}, null, 2) + "\n");
' "$VERSION" "$APP.tar.gz.sig" "$OUT"
echo "wrote $OUT for v$VERSION"
