#!/usr/bin/env bash
set -euo pipefail

converter="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
manifest="$converter/Cargo.toml"
target=wasm32-unknown-unknown
build_dir="${CARGO_TARGET_DIR:-$converter/target}"
output="$converter/target/frontend"
bindgen_version=0.2.130

if [[ "$(wasm-bindgen --version)" != "wasm-bindgen $bindgen_version" ]]; then
  echo "Install wasm-bindgen-cli $bindgen_version to build the TaOffice PowerPoint converter." >&2
  exit 1
fi

RUSTFLAGS="-C link-arg=--max-memory=268435456 -C link-arg=-zstack-size=2097152" \
  cargo build --manifest-path "$manifest" --target-dir "$build_dir" --target "$target" --release --locked
mkdir -p "$output"
wasm-bindgen "$build_dir/$target/release/taoffice_legacy_ppt.wasm" \
  --target web --omit-default-module-path --no-typescript --out-dir "$output" --out-name ppt-converter

cargo metadata --manifest-path "$manifest" --filter-platform "$target" \
  --format-version 1 --locked >"$output/cargo-metadata.json"
python3 "$converter/../../../../scripts/rust-wasm-notices.py" \
  "$output/cargo-metadata.json" "$(rustc --print sysroot)" >"$output/ppt-converter-NOTICES.txt"
rm "$output/cargo-metadata.json"
