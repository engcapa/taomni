#!/usr/bin/env bash
# Linux SocksCap bundle preflight.
#
# Tauri copies `resources/sockscap/**/*` itself. Do not copy files directly
# into target/bundle here: Tauri can recreate that directory later in the same
# build. This script verifies the Linux runtime material and package metadata
# before Tauri produces DEB/RPM/AppImage artifacts.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "Skipping Linux SocksCap bundle preflight on $(uname -s)."
  exit 0
fi

if [[ "${1:-}" != "--check" && $# -ne 0 ]]; then
  echo "Usage: $0 [--check]" >&2
  exit 2
fi

config="$repo_root/src-tauri/tauri.conf.json"
runtime_doc="$repo_root/src-tauri/resources/sockscap/linux/README.md"

test -f "$runtime_doc"
grep -Fq 'resources/sockscap/**/*' "$config"
grep -Fq '"nftables"' "$config"

echo "Linux SocksCap bundle preflight passed: nftables dependency and runtime documentation are staged by Tauri resources."
