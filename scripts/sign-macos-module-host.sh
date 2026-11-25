#!/usr/bin/env bash
set -euo pipefail

host_binary="${1:?Pass the staged module host}"
evidence="${2:?Pass the signing evidence directory}"
slug="${MODULE_SLUG:?MODULE_SLUG is required}"
platform="${MODULE_PLATFORM:?MODULE_PLATFORM is required}"
source_sha="${MODULE_SOURCE_SHA:?MODULE_SOURCE_SHA is required}"
certificate="${MACOS_SIGNING_CERT_SHA1:?The fixed signing certificate is required}"
test -d "${MACOS_SIGNING_WORK_DIR:?Import the fixed signing identity first}"
test -f "$host_binary"
test ! -L "$host_binary"
[[ "$slug" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]]
[[ "$source_sha" =~ ^[0-9a-f]{40}$ ]]
[[ "$certificate" =~ ^[0-9A-F]{40}$ ]]

case "$platform" in
  darwin-aarch64) arch=arm64 ;;
  darwin-x86_64) arch=x86_64 ;;
  *) echo "Unsupported macOS module target $platform" >&2; exit 1 ;;
esac
case "${MACOS_SIGNING_MODE:-}" in
  developer-id) timestamp=--timestamp ;;
  self-signed) timestamp=--timestamp=none ;;
  *) echo "The module host requires a certificate signature" >&2; exit 1 ;;
esac
test "$(lipo -archs "$host_binary")" = "$arch"

identifier="com.taomni.module.$slug"
codesign --force --sign "$certificate" --options runtime "$timestamp" \
  --identifier "$identifier" "$host_binary"
codesign --verify --strict "$host_binary"
details="$(codesign -d --verbose=4 "$host_binary" 2>&1)"
grep -Fxq "Identifier=$identifier" <<<"$details"
grep -Eq 'flags=.*\(runtime\)' <<<"$details"

scratch="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/taomni-module-certificate.XXXXXX")"
trap 'rm -rf "$scratch"' EXIT
codesign -d --extract-certificates="$scratch/host" "$host_binary"
actual_certificate="$(shasum -a 1 "$scratch/host0" | awk '{print toupper($1)}')"
test "$actual_certificate" = "$certificate"

mkdir -p "$evidence"
printf '%s\n' "$details" > "$evidence/codesign.txt"
assessment=0
spctl --assess --type execute --verbose=4 "$host_binary" > "$evidence/gatekeeper.txt" 2>&1 || assessment=$?
printf 'sourceSha=%s\nplatform=%s\ncertificateSha1=%s\ngatekeeperExitCode=%d\n' \
  "$source_sha" "$platform" "$actual_certificate" "$assessment" > "$evidence/identity.txt"
shasum -a 256 "$host_binary" > "$evidence/host-sha256.txt"
