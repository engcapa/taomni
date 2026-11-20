#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"
tool=sockscap-redirector-bridge
target_dir="${CARGO_TARGET_DIR:-$repo_root/src-tauri/target}"
staged="src-tauri/resources/sockscap/macos/$tool"
command=(cargo build --manifest-path src-tauri/Cargo.toml --target-dir "$target_dir" --locked
         -p taomni-sockscap-tools --bin "$tool")

if [[ "${1:-}" == "--dev" ]]; then
  "${command[@]}"
  exit
fi

triple="${TAURI_ENV_TARGET_TRIPLE:-${CARGO_BUILD_TARGET:-}}"
if [[ -z "$triple" ]]; then
  case "${TAURI_ENV_ARCH:-}" in
    aarch64 | arm64) triple=aarch64-apple-darwin ;;
    x86_64) triple=x86_64-apple-darwin ;;
    *) triple="$(rustc -vV | sed -n 's/^host: //p')" ;;
  esac
fi
case "$triple" in
  aarch64-apple-darwin) arch=arm64 ;;
  x86_64-apple-darwin) arch=x86_64 ;;
  *) echo "Unsupported Redirector bridge target $triple" >&2; exit 1 ;;
esac

case "${1:-}" in
  --release)
    "${command[@]}" --release --target "$triple"
    install -m 755 "$target_dir/$triple/release/$tool" "$staged"
    ;;
  --check) ;;
  *) echo "Expected --dev, --release or --check" >&2; exit 1 ;;
esac
test -x "$staged"
test "$(lipo -archs "$staged")" = "$arch"
