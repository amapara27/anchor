#!/usr/bin/env bash
# Builds and publishes the `anchor` CLI as a GitHub release.
# Unlike release-macos.sh, no signing/notarization: it's a plain binary, not an app bundle.
set -euo pipefail

VERSION=$(sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -1)
TAG="cli-v$VERSION"
ARCH=$(uname -m)
ASSET="target/release/anchor-cli-$VERSION-macos-$ARCH.tar.gz"

cargo build --release -p anchor-cli

tar -czf "$ASSET" -C target/release anchor

echo "publishing $TAG ($ASSET)"
# --latest=false: GitHub auto-promotes the newest non-prerelease to `latest`, and
# the desktop updater fetches releases/latest/download/latest.json — a CLI release
# taking that pointer would 404 the endpoint for every shipped copy of the app.
gh release create "$TAG" "$ASSET" \
  --title "anchor-cli $VERSION" \
  --latest=false \
  --generate-notes
