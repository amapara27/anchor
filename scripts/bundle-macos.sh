#!/usr/bin/env bash
# Package an already-built GUI; used locally and on CI.
set +x
set -euo pipefail
unset APPLE_PASSWORD

pnpm tauri bundle ${ANCHOR_FLOOR_OVERRIDE:+--config "$ANCHOR_FLOOR_OVERRIDE"}
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

# update.json is what guarded copies read; it carries the macOS floor they check before installing.
# latest.json serves copies older than the guard: the bridge itself, then that same bridge forever.
VERSION=$(node -p "require('./apps/desktop/src-tauri/tauri.conf.json').version")
BUNDLE="target/release/bundle"
node -e '
const fs = require("fs");
const [version, sig, out, override] = [process.argv[1], fs.readFileSync(process.argv[2], "utf8").trim(), process.argv[3], process.argv[4]];
const config = JSON.parse(fs.readFileSync("apps/desktop/src-tauri/tauri.conf.json", "utf8"));
const minimum = (override ? JSON.parse(override) : config).bundle?.macOS?.minimumSystemVersion ?? "10.13";
fs.writeFileSync(out, JSON.stringify({
  version,
  pub_date: new Date().toISOString(),
  minimum_system_version: minimum,
  platforms: {
    // Apple Silicon only: the build is aarch64 and Anchor targets M-series.
    "darwin-aarch64": {
      signature: sig,
      url: `https://github.com/amapara27/anchor/releases/download/v${version}/Anchor.app.tar.gz`,
    },
  },
}, null, 2) + "\n");
' "$VERSION" "$APP.tar.gz.sig" "$BUNDLE/update.json" "${ANCHOR_FLOOR_OVERRIDE:-}"
if [ -n "${ANCHOR_FLOOR_OVERRIDE:-}" ]; then
  cp "$BUNDLE/update.json" "$BUNDLE/latest.json"
else
  curl -fsSL -o "$BUNDLE/latest.json" https://github.com/amapara27/anchor/releases/latest/download/latest.json
  node -e '
const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const floor = m.minimum_system_version;
if (!m.platforms?.["darwin-aarch64"]?.url || (floor && floor !== "11.0" && floor !== "10.13")) {
  console.error("the live latest.json is not a floor-free bridge; refusing to strand pre-guard copies");
  process.exit(1);
}
' "$BUNDLE/latest.json"
fi
echo "wrote update.json and latest.json for v$VERSION"
