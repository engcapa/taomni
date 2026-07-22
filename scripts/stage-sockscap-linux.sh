#!/bin/bash
# Stage sockscap-helper + Linux resources for Tauri DEB/RPM release.

set -e

TAURI_DIR="src-tauri"
CONFIG="release"
TARGET="x86_64-unknown-linux-gnu"
BUNDLE="deb"

echo "Staging sockscap for Linux ($CONFIG, $TARGET, $BUNDLE)..."

# Build helper if needed (optional for Linux, no elevated helper yet)
cargo build --bin sockscap-helper --target $TARGET --release

# Copy resources
mkdir -p $TAURI_DIR/target/release/bundle/$BUNDLE/resources/sockscap/linux
cp -r src-tauri/resources/sockscap/* $TAURI_DIR/target/release/bundle/$BUNDLE/resources/sockscap/ || true

# For Linux, copy any additional files (cgroup scripts, etc.)
echo "Linux sockscap staged successfully."