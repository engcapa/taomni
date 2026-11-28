#!/usr/bin/env bash
set -euo pipefail

decoder_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
manifest="$decoder_dir/Cargo.toml"
output="$decoder_dir/target/frontend"
target=wasm32-unknown-unknown
build_dir="${CARGO_TARGET_DIR:-$decoder_dir/target}"
wasm_flags="-C link-arg=--max-memory=268435456 -C link-arg=-zstack-size=2097152"

RUSTFLAGS="$wasm_flags" cargo build --manifest-path "$manifest" --target-dir "$build_dir" \
  --target "$target" --release --locked
mkdir -p "$output"
cp "$build_dir/$target/release/taoffice_heif_preview.wasm" "$output/heif.wasm"

# Include the license texts from the locked crate sources used in this build.
cargo metadata --manifest-path "$manifest" --filter-platform "$target" \
  --format-version 1 --locked >"$output/cargo-metadata.json"
python3 "$decoder_dir/notices.py" "$output/cargo-metadata.json" "$(rustc --print sysroot)" \
  >"$output/heif-third-party-notices.txt"
rm "$output/cargo-metadata.json"
