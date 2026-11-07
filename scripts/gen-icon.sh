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
# Legacy macOS and Finder fall back to the black/purple icon.
FALLBACK=$(mktemp -d -t anchor-icon-fallback)
mkdir "$FALLBACK/Anchor.iconset"
"$ICTOOL" "$ROOT/apps/desktop/src-tauri/Anchor.icon" --export-image --output-file "$FALLBACK/dark.png" \
  --platform macOS --rendition Dark --width 1024 --height 1024 --scale 1 >/dev/null
sips -Z 824 "$FALLBACK/dark.png" >/dev/null
sips --padToHeightWidth 1024 1024 "$FALLBACK/dark.png" >/dev/null
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$FALLBACK/dark.png" --out "$FALLBACK/Anchor.iconset/icon_${size}x${size}.png" >/dev/null
  sips -z "$((size * 2))" "$((size * 2))" "$FALLBACK/dark.png" --out "$FALLBACK/Anchor.iconset/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$FALLBACK/Anchor.iconset" -o "$OUT/Anchor.icns"
rm -r "$FALLBACK"
echo "wrote $OUT/Anchor.icns + $OUT/Assets.car + $OUT/dev/*.png"
