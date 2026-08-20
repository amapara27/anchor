#!/usr/bin/env bash
# Builds and publishes the `anchor` CLI as a GitHub release.
# Unlike release-macos.sh, no signing/notarization: it's a plain binary, not an app bundle.
set -euo pipefail

VERSION=$(sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -1)
TAG="cli-v$VERSION"
ARCH=$(uname -m)
ASSET="anchor-cli-$VERSION-macos-$ARCH.tar.gz"

cargo build --release -p anchor-cli

BIN="target/release/anchor"
tar -czf "$ASSET" -C target/release anchor

echo "publishing $TAG ($ASSET)"
gh release create "$TAG" "$ASSET" \
  --title "anchor-cli $VERSION" \
  --generate-notes
