#!/usr/bin/env bash
# Package an already-built GUI; used locally and on CI.
set +x
set -euo pipefail
unset APPLE_PASSWORD

pnpm tauri bundle
unset TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD
unset APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD

APP="target/release/bundle/macos/Anchor.app"
codesign --verify --deep --strict --verbose=2 "$APP"
# The real test: what Gatekeeper says on a machine that has never seen this app.
spctl --assess --type execute -vvv "$APP"
xcrun stapler validate "$APP"

# Tauri notarizes the .app but NOT the .dmg it then wraps around it, and the dmg
# is what users actually download — so it carries the quarantine flag and gets
# assessed on mount. Submit and staple it too, or every user sees "Apple could
# not verify this app" even though the app inside is notarized.
VERSION=$(node -p "require('./apps/desktop/src-tauri/tauri.conf.json').version")
DMG="target/release/bundle/dmg/Anchor_${VERSION}_aarch64.dmg"
[ -f "$DMG" ] || { echo "missing current release DMG: $DMG" >&2; exit 1; }
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
