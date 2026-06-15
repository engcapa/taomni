#!/usr/bin/env bash
# Make the macOS app self-contained w.r.t. MIT Kerberos (krb5).
#
# The default `hbase-kerberos` feature links cross-krb5 -> libgssapi, which on
# macOS dynamically links Homebrew's keg-only krb5 at an ABSOLUTE path
# (/usr/local/opt/krb5/... on Intel, /opt/homebrew/opt/krb5/... on Apple Silicon).
# That path is baked into the binary with no @rpath fallback and the dylibs are
# not shipped, so the app aborts at launch (dyld "Library missing" / SIGABRT) on
# any machine lacking that exact Homebrew keg. This copies the krb5 dependency
# closure into src-tauri/frameworks/ (bundled into Taomni.app/Contents/Frameworks
# via bundle.macOS.frameworks), rewrites every install name / cross-reference to
# @rpath, ad-hoc signs them (required on Apple Silicon), and rewrites the compiled
# binary's krb5 load command to @rpath. With the @executable_path/../Frameworks
# rpath added in build.rs, krb5 resolves from inside the bundle.
#
# Two phases, because tauri_build::build() validates bundle.macOS.frameworks at
# COMPILE time (in build.rs), before the binary exists:
#   stage  - copy + fix + sign the dylibs   (tauri.conf beforeBuildCommand, pre-compile)
#   fixbin - rewrite + sign the executable  (tauri.conf beforeBundleCommand, post-compile)
set -euo pipefail

# macOS only; Linux/Windows bundles ignore bundle.macOS.frameworks.
[ "$(uname -s)" = "Darwin" ] || exit 0

MODE="${1:-all}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
TAURI_DIR="$ROOT_DIR/src-tauri"
DEST_DIR="$TAURI_DIR/frameworks"

# krb5 dependency closure of libgssapi_krb5 (verified: these 5 + only system libs).
# Keep in sync with bundle.macOS.frameworks in tauri.conf.json.
DYLIBS=(
  libgssapi_krb5.2.2.dylib
  libkrb5.3.3.dylib
  libk5crypto.3.1.dylib
  libcom_err.3.0.dylib
  libkrb5support.1.1.dylib
)

is_known() { local b="$1" k; for k in "${DYLIBS[@]}"; do [ "$b" = "$k" ] && return 0; done; return 1; }

# Rewrite any absolute load path whose basename is one of our dylibs to @rpath.
retarget_to_rpath() {
  local file="$1" dep base
  while IFS= read -r dep; do
    case "$dep" in
      /*) base="$(basename "$dep")"; if is_known "$base"; then install_name_tool -change "$dep" "@rpath/$base" "$file"; fi ;;
    esac
  done < <(otool -L "$file" | tail -n +2 | awk '{print $1}')
  return 0
}

stage_dylibs() {
  local prefix="${LIBGSSAPI_PREFIX:-}" name src
  [ -n "$prefix" ] || prefix="$(brew --prefix krb5 2>/dev/null || true)"
  if [ -z "$prefix" ] || [ ! -d "$prefix/lib" ]; then
    echo "bundle-krb5: cannot locate krb5 (set LIBGSSAPI_PREFIX or 'brew install krb5')." >&2
    exit 1
  fi
  echo "bundle-krb5[stage]: $prefix/lib -> $DEST_DIR"
  rm -rf "$DEST_DIR"; mkdir -p "$DEST_DIR"
  for name in "${DYLIBS[@]}"; do
    src="$prefix/lib/$name"
    if [ ! -f "$src" ]; then
      echo "bundle-krb5: expected dylib not found: $src" >&2
      echo "bundle-krb5: krb5 soname versions likely changed; update DYLIBS here and bundle.macOS.frameworks in tauri.conf.json." >&2
      exit 1
    fi
    cp -f "$src" "$DEST_DIR/$name"; chmod u+w "$DEST_DIR/$name"
    install_name_tool -id "@rpath/$name" "$DEST_DIR/$name"
  done
  for name in "${DYLIBS[@]}"; do
    retarget_to_rpath "$DEST_DIR/$name"
    codesign --force --sign - "$DEST_DIR/$name"
  done
}

fix_binary() {
  local triple="${TAURI_ENV_TARGET_TRIPLE:-}" bin="" c
  if [ -z "$triple" ]; then
    case "${TAURI_ENV_ARCH:-}" in
      x86_64) triple="x86_64-apple-darwin" ;;
      aarch64|arm64) triple="aarch64-apple-darwin" ;;
    esac
  fi
  for c in "${triple:+$TAURI_DIR/target/$triple/release/taomni}" "$TAURI_DIR/target/release/taomni"; do
    [ -n "$c" ] && [ -f "$c" ] && { bin="$c"; break; }
  done
  if [ -z "$bin" ]; then
    echo "bundle-krb5: could not locate compiled 'taomni' binary under src-tauri/target." >&2
    exit 1
  fi
  echo "bundle-krb5[fixbin]: $bin"
  retarget_to_rpath "$bin"
  codesign --force --sign - "$bin"
}

case "$MODE" in
  stage) stage_dylibs ;;
  fixbin) fix_binary ;;
  all) stage_dylibs; fix_binary ;;
  *) echo "usage: $(basename "$0") [stage|fixbin|all]" >&2; exit 2 ;;
esac
echo "bundle-krb5: done ($MODE)."
