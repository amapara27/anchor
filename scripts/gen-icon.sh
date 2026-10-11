#!/usr/bin/env bash
# Compiles apps/desktop/src-tauri/Anchor.icon (an Icon Composer document) into
# the Assets.car + .icns that macOS 26 reads to build the Default / Dark / Clear
# / Tinted appearances of the app icon. Needs full Xcode, not just the Command
# Line Tools — so the products are committed and this only runs when art changes.
# Paths must be absolute: actool proxies to an ibtoold daemon with its own cwd.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT="$ROOT/apps/desktop/src-tauri/icons"
xcrun actool "$ROOT/apps/desktop/src-tauri/Anchor.icon" \
  --compile "$OUT" \
  --app-icon Anchor \
  --output-partial-info-plist "$(mktemp -t anchor-icon)".plist \
  --platform macosx \
  --minimum-deployment-target 26.0 \
  --output-format human-readable-text
# Unbundled dev builds can't use Assets.car, so src/dev_icon.rs sets one of these
# per-appearance renders instead, padded to the macOS icon grid (824 of 1024).
ICTOOL="$(xcode-select -p)/../Applications/Icon Composer.app/Contents/Executables/ictool"
mkdir -p "$OUT/dev"
for r in Default Dark ClearLight ClearDark TintedLight TintedDark; do
  "$ICTOOL" "$ROOT/apps/desktop/src-tauri/Anchor.icon" --export-image --output-file "$OUT/dev/$r.png" \
    --platform macOS --rendition "$r" --width 256 --height 256 --scale 2 >/dev/null
  sips -Z 412 "$OUT/dev/$r.png" >/dev/null && sips --padToHeightWidth 512 512 "$OUT/dev/$r.png" >/dev/null
done
echo "wrote $OUT/Anchor.icns + $OUT/Assets.car + $OUT/dev/*.png"
