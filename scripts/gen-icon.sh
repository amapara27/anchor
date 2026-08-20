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
echo "wrote $OUT/Anchor.icns + $OUT/Assets.car"
