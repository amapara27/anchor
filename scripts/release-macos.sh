#!/usr/bin/env bash
# Signed + notarized release build. No secret is ever passed as a command-line
# argument: the cert lives in the keychain, and notarization uses an App Store
# Connect API key that Tauri hands to notarytool as a file path.
set +x # Signing secrets must never appear in shell traces.
set -euo pipefail
unset APPLE_PASSWORD # Enforce API-key notarization even with an old password in the environment.
unset TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD
unset APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD
unset APPLE_API_KEY APPLE_API_ISSUER APPLE_API_KEY_PATH

# Picks the Developer ID cert out of the keychain so the identity is never
# hardcoded — fails loudly if step 1 (cert install) was skipped.
if [ -z "${APPLE_SIGNING_IDENTITY:-}" ]; then
  IDENTITIES=()
  while IFS= read -r identity; do IDENTITIES+=("$identity"); done < <(
    security find-identity -v -p codesigning | sed -n 's/.*) \([A-Fa-f0-9]*\) "Developer ID Application: .*"/\1/p'
  )
  [ "${#IDENTITIES[@]}" -eq 1 ] || { echo "select a Developer ID certificate explicitly with APPLE_SIGNING_IDENTITY" >&2; exit 1; }
  APPLE_SIGNING_IDENTITY="${IDENTITIES[0]}"
fi
[ -n "$APPLE_SIGNING_IDENTITY" ] || {
  echo "no Developer ID Application certificate in the keychain" >&2; exit 1; }

# Notarization auth. Deliberately API-key-only: Tauri hands notarytool a file
# path, whereas an app-specific password would go in argv where any process on
# the machine can read it. Do not add a password fallback.
APPLE_API_KEY_PATH=$(ls "$HOME"/private_keys/AuthKey_*.p8 2>/dev/null | head -1) || true
if [ -n "$APPLE_API_KEY_PATH" ] && [ -f "$HOME/private_keys/issuer_id" ]; then
  # Key ID is the filename suffix Apple assigns; the issuer is account-level,
  # so both live beside the key rather than in this file.
  APPLE_API_KEY=$(basename "$APPLE_API_KEY_PATH" .p8 | sed 's/^AuthKey_//')
  APPLE_API_ISSUER=$(cat "$HOME/private_keys/issuer_id")
  echo "notarizing with API key $APPLE_API_KEY"
else
  echo "no notarization credentials: need ~/private_keys/AuthKey_*.p8" >&2
  echo "and ~/private_keys/issuer_id (App Store Connect API key)" >&2
  exit 1
fi

# Separate from the Apple cert: this key signs the updater archive.
KEY_PATH="${TAURI_KEY_PATH:-$HOME/.tauri/anchor.key}"
[ -f "$KEY_PATH" ] || { echo "no updater key at $KEY_PATH" >&2; exit 1; }

pnpm tauri build --no-bundle --no-sign -- --locked

# Only the bundler and its signing helpers inherit the updater secrets.
(
  TAURI_SIGNING_PRIVATE_KEY=$(cat "$KEY_PATH")
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD=$(security find-generic-password -s anchor-updater-key -w)
  export TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD
  export APPLE_SIGNING_IDENTITY APPLE_API_KEY APPLE_API_ISSUER APPLE_API_KEY_PATH
  echo "signing as $APPLE_SIGNING_IDENTITY"
  bash scripts/bundle-macos.sh
)
