#!/usr/bin/env bash
# Signed + notarized release build. Everything secret comes from the login
# keychain, so nothing sensitive lives in the repo or your shell history.
set -euo pipefail

: "${APPLE_ID:?set APPLE_ID to the Apple ID that owns the developer membership}"

# Picks the Developer ID cert out of the keychain so the identity is never
# hardcoded — fails loudly if step 1 (cert install) was skipped.
APPLE_SIGNING_IDENTITY=$(security find-identity -v -p codesigning \
  | sed -n 's/.*"\(Developer ID Application: .*\)"/\1/p' | head -1)
[ -n "$APPLE_SIGNING_IDENTITY" ] || {
  echo "no Developer ID Application certificate in the keychain" >&2; exit 1; }

# The team ID is the parenthesised suffix of the identity name.
APPLE_TEAM_ID=$(printf '%s' "$APPLE_SIGNING_IDENTITY" | sed -n 's/.*(\(.*\))$/\1/p')
APPLE_PASSWORD=$(security find-generic-password -s anchor -w)

# Separate from the Apple cert: this key signs the update manifest so shipped
# copies will accept the download. Losing it means no client can ever update.
KEY_PATH="${TAURI_KEY_PATH:-$HOME/.tauri/anchor.key}"
[ -f "$KEY_PATH" ] || { echo "no updater key at $KEY_PATH" >&2; exit 1; }
TAURI_SIGNING_PRIVATE_KEY=$(cat "$KEY_PATH")
TAURI_SIGNING_PRIVATE_KEY_PASSWORD=$(security find-generic-password -s anchor-updater-key -w)

export APPLE_SIGNING_IDENTITY APPLE_TEAM_ID APPLE_PASSWORD APPLE_ID
export TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD
echo "signing as $APPLE_SIGNING_IDENTITY"

pnpm build

APP="target/release/bundle/macos/Anchor.app"
codesign --verify --deep --strict --verbose=2 "$APP"
# The real test: what Gatekeeper says on a machine that has never seen this app.
spctl --assess --type execute -vvv "$APP"
