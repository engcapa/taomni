#!/usr/bin/env bash
set -euo pipefail

# Replit-native QA toolchain setup.
#
# This file is intended to be sourced by the Replit app workflow and by the
# Linux native runbook. It deliberately does nothing outside the opt-in
# Replit marker so local developer toolchains are not silently replaced.

if [[ "${TAOMNI_REPLIT_NATIVE_QA:-0}" != "1" ]]; then
  return 0
fi

if [[ "$(uname -s)" != "Linux" ]]; then
  return 0
fi

if [[ "${TAOMNI_NATIVE_QA_TOOLCHAIN_READY:-0}" == "1" ]]; then
  return 0
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Replit's pinned Nix modules can lag behind the Rust version declared by the
# application. Use rustup's stable channel for the native QA toolchain so the
# default Cargo stays current instead of silently compiling with an older Nix
# Cargo and --ignore-rust-version.
# Replit's runtime audit loader exhausts static TLS while rustc loads its
# bundled compiler driver. Native QA does not need that audit hook.
unset LD_AUDIT
export CARGO_HOME="${CARGO_HOME:-$HOME/.cargo}"
export PATH="$CARGO_HOME/bin:$HOME/.cargo/bin:$PATH"
if [[ -z "${TAOMNI_NATIVE_QA_TOOLCHAIN:-}" || "${TAOMNI_NATIVE_QA_TOOLCHAIN}" == "stable" ]]; then
  if ! command -v rustup >/dev/null 2>&1; then
    echo "[replit-native-qa] installing rustup stable toolchain" >&2
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs |
      sh -s -- -y --profile minimal --default-toolchain stable --no-modify-path
  else
    echo "[replit-native-qa] updating rustup stable toolchain" >&2
    rustup update stable --no-self-update
  fi
  export PATH="$CARGO_HOME/bin:$HOME/.cargo/bin:$PATH"
  export RUSTUP_TOOLCHAIN="stable"
  export TAOMNI_NATIVE_QA_TOOLCHAIN="stable"

  # The Replit launcher can re-add LD_AUDIT when Tauri/Cargo spawns rustc.
  # Route every compiler invocation through a tiny wrapper that removes the
  # audit hook before loading rustc's bundled compiler driver.
  rustc_real="$(rustup which rustc)"
  rustc_wrapper_dir="${TAOMNI_QA_TOOLS_ROOT:-${XDG_DATA_HOME:-$HOME/.local/share}/taomni-qa-ui-auto}/bin"
  mkdir -p "$rustc_wrapper_dir"
  rustc_wrapper="$rustc_wrapper_dir/rustc"
  cat > "$rustc_wrapper" <<EOF
#!/bin/sh
exec env -u LD_AUDIT "$rustc_real" "\$@"
EOF
  chmod 755 "$rustc_wrapper"
  export PATH="$rustc_wrapper_dir:$PATH"
  export RUSTC="$rustc_wrapper"

  cargo_version="$(cargo --version | awk '{print $2}')"
  cargo_major="${cargo_version%%.*}"
  cargo_minor="${cargo_version#*.}"
  cargo_minor="${cargo_minor%%.*}"
  if [[ "$cargo_major" != "1" || "$cargo_minor" -lt 94 ]]; then
    echo "[replit-native-qa] Cargo ${cargo_version} is below the required 1.94" >&2
    return 2
  fi
else
  echo "[replit-native-qa] using explicitly requested toolchain: ${TAOMNI_NATIVE_QA_TOOLCHAIN}" >&2
fi

# The app is a large Rust crate. A single Cargo job and no dev debuginfo keep
# rustc below the memory limit of the Replit QA environment. Users can
# override either value explicitly.
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-1}"
export CARGO_PROFILE_DEV_DEBUG="${CARGO_PROFILE_DEV_DEBUG:-0}"
export CARGO_PROFILE_DEV_INCREMENTAL="${CARGO_PROFILE_DEV_INCREMENTAL:-false}"

# bindgen can see several Nix libclang outputs, including an incompatible
# 32-bit library. Select an actual x86-64 ELF library and pass GCC's complete
# system-header search path so stdbool.h/stdint.h resolve consistently.
if [[ -z "${LIBCLANG_PATH:-}" ]]; then
  shopt -s nullglob
  clang_version="$(clang --version 2>/dev/null | awk '/version/{print $3; exit}')"
  if [[ -n "$clang_version" ]]; then
    libclang_candidates=(/nix/store/*-clang-"$clang_version"-lib/lib/libclang.so*)
  fi
  if [[ "${#libclang_candidates[@]}" -eq 0 ]]; then
    # Exclude clang-rocm and other nonstandard store outputs. If the exact
    # compiler output is unavailable, use the newest numbered clang output.
    libclang_candidates=(/nix/store/*-clang-[0-9]*-lib/lib/libclang.so*)
  fi
  while IFS= read -r libclang; do
    if file -L "$libclang" 2>/dev/null | grep -q 'ELF 64-bit'; then
      export LIBCLANG_PATH="$(dirname "$libclang")"
      break
    fi
  done < <(printf '%s\n' "${libclang_candidates[@]}" | sort -t- -k3,3Vr)
fi

if [[ -z "${LIBCLANG_PATH:-}" ]]; then
  echo "[replit-native-qa] no 64-bit libclang.so found under /nix/store" >&2
  return 2
fi

gcc_header_args="$(
  gcc -E -v -x c - </dev/null 2>&1 |
    awk '
      /#include <...> search starts here:/{inside=1; next}
      /End of search list./{inside=0}
      inside && /^[[:space:]]*\// {
        gsub(/^[[:space:]]+/, "")
        printf " -isystem %s", $0
      }
    '
)"
if [[ -n "$gcc_header_args" ]]; then
  export BINDGEN_EXTRA_CLANG_ARGS="${BINDGEN_EXTRA_CLANG_ARGS:-}${BINDGEN_EXTRA_CLANG_ARGS:+ }${gcc_header_args}"
  # Cargo/build scripts may look up bindgen flags through the target-specific
  # underscore spelling instead of the generic variable.
  export BINDGEN_EXTRA_CLANG_ARGS_x86_64_unknown_linux_gnu="$BINDGEN_EXTRA_CLANG_ARGS"
fi

# pkg-config normally supplies this path, but the final rust-lld invocation
# does not always inherit it through the GTK/WebKit dependency graph. Add the
# resolved xkbcommon library explicitly without hard-coding a Nix store hash.
xkb_lib="$(pkg-config --libs-only-L xkbcommon 2>/dev/null |
  sed -n 's/.*-L\([^ ]*\).*/\1/p' | head -n 1)"
xkb_pc="$(pkg-config --variable=pcfiledir xkbcommon 2>/dev/null || true)"
if [[ -n "$xkb_lib" ]]; then
  export LIBRARY_PATH="${xkb_lib}${LIBRARY_PATH:+:$LIBRARY_PATH}"
  if [[ "${RUSTFLAGS:-}" != *"-L native=$xkb_lib"* ]]; then
    export RUSTFLAGS="${RUSTFLAGS:-}${RUSTFLAGS:+ }-L native=$xkb_lib"
  fi
fi
if [[ -n "$xkb_pc" ]]; then
  export PKG_CONFIG_PATH="${xkb_pc}${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"
fi

export TAOMNI_NATIVE_QA_TOOLCHAIN_READY=1

# Keep ROOT referenced above so sourced diagnostics point at the repository
# helper location if this script is extended later.
: "$ROOT"