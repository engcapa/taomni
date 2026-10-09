#!/usr/bin/env bash
# Post-bundle release gate for the Taomni macOS app. This validates Taomni's
# fixed signing certificate separately from Apple notarization and mitmproxy.
set -Eeuo pipefail
trap 'status=$?; echo "macOS bundle verification failed at line $LINENO (exit $status)." >&2' ERR
export LC_ALL=C
export LANG=C

if [ "$#" -ne 2 ]; then
  echo "Usage: $0 <rust-target-triple> <expected-arch>" >&2
  exit 2
fi

target_triple="$1"
expected_arch="$2"
expected_team_id="${APPLE_TEAM_ID:-}"
signing_mode="${MACOS_SIGNING_MODE:?MACOS_SIGNING_MODE is required}"
expected_certificate="${MACOS_SIGNING_CERT_SHA1:-}"
notarize="${MACOS_NOTARIZE:-false}"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bundle_root="$repo_root/src-tauri/target/$target_triple/release/bundle"
app="$bundle_root/macos/Taomni.app"
main_executable="$app/Contents/MacOS/taomni"
resource_root="$app/Contents/Resources"
pinned_redirector="$repo_root/src-tauri/resources/sockscap/macos/redirector/0.12.11/Mitmproxy Redirector.app.tar"
pinned_manifest="$repo_root/src-tauri/resources/sockscap/macos/redirector/0.12.11/manifest.json"
pinned_license="$repo_root/src-tauri/resources/sockscap/macos/redirector/0.12.11/LICENSE"

test -d "$app" || {
  echo "Taomni app bundle is missing: $app" >&2
  exit 1
}
test -x "$main_executable" || {
  echo "Taomni executable is missing: $main_executable" >&2
  exit 1
}
bash "$repo_root/scripts/verify-macos-runtime-paths.sh" "$app"

case "$signing_mode" in
  developer-id|self-signed)
    [[ "$expected_certificate" =~ ^[A-F0-9]{40}$ ]] || {
      echo "A pinned MACOS_SIGNING_CERT_SHA1 is required for certificate-signed builds." >&2
      exit 1
    }
    ;;
  adhoc)
    test -z "${RELEASE_TAG:-}" || {
      echo "A release must use a fixed certificate; ad-hoc signing is only allowed for workflow artifacts." >&2
      exit 1
    }
    test "$notarize" = false
    ;;
  *) echo "Unknown macOS signing mode: $signing_mode" >&2; exit 1 ;;
esac

verification_dir="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/taomni-bundle-verify.XXXXXX")"
trap 'rm -rf "$verification_dir"' EXIT

verify_certificate_signature() {
  local signed_app="$1"
  local certificate_prefix="$2"
  local signature requirement actual_certificate
  codesign --verify --deep --strict --verbose=2 "$signed_app"
  signature="$(codesign -d --verbose=4 "$signed_app" 2>&1)"
  printf '%s\n' "$signature"
  grep -Fxq 'Identifier=com.taomni.app' <<<"$signature"
  if grep -Fq 'Signature=adhoc' <<<"$signature"; then
    echo "Expected a certificate signature, found ad-hoc: $signed_app" >&2
    return 1
  fi
  if [ "$signing_mode" = developer-id ]; then
    grep -Eq 'flags=.*\(runtime\)' <<<"$signature"
  elif grep -Eq 'flags=.*\(runtime\)' <<<"$signature"; then
    echo "Self-signed bundles must disable hardened runtime to load krb5 libraries without an Apple Team ID." >&2
    return 1
  fi
  codesign -d --extract-certificates="$certificate_prefix" "$signed_app"
  actual_certificate="$(shasum -a 1 "${certificate_prefix}0" | awk '{print toupper($1)}')"
  printf 'Signing certificate SHA-1: %s\n' "$actual_certificate"
  test "$actual_certificate" = "$expected_certificate" || {
    echo "Signing certificate does not match MACOS_SIGNING_CERT_SHA1: $signed_app" >&2
    return 1
  }
  requirement="$(codesign -d -r- "$signed_app" 2>&1 | sed -n 's/^designated => //p')"
  printf 'Designated requirement: %s\n' "$requirement"
  grep -Fq 'identifier "com.taomni.app"' <<<"$requirement"
  grep -Eq 'certificate |anchor( =)? H"' <<<"$requirement"
  if grep -Fq 'cdhash' <<<"$requirement"; then
    echo "The designated requirement depends on a changing binary hash: $signed_app" >&2
    return 1
  fi
  if [ "$signing_mode" = developer-id ] && [ -n "$expected_team_id" ]; then
    grep -Fxq "TeamIdentifier=$expected_team_id" <<<"$signature"
  fi
  printf '%s\n' "$requirement" > "${certificate_prefix}requirement"
}

if [ "$signing_mode" != adhoc ]; then
  verify_certificate_signature "$app" "$verification_dir/app-cert-"
  archive="$app.tar.gz"
  test -s "$archive" || {
    echo "The macOS app archive is missing." >&2
    exit 1
  }
  if [ -n "${RELEASE_TAG:-}${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
    test -s "$archive.sig" || {
      echo "The macOS updater signature is missing." >&2
      exit 1
    }
  fi
  mkdir "$verification_dir/updater"
  tar -xzf "$archive" -C "$verification_dir/updater"
  updater_app="$verification_dir/updater/Taomni.app"
  bash "$repo_root/scripts/verify-macos-runtime-paths.sh" "$updater_app"
  verify_certificate_signature "$updater_app" "$verification_dir/updater-cert-"
  cmp "$main_executable" "$updater_app/Contents/MacOS/taomni"
  cmp "$verification_dir/app-cert-requirement" "$verification_dir/updater-cert-requirement"
else
  echo "Workflow-only build without a certificate; fixed signing and updater signature checks are skipped."
fi

main_architectures="$(lipo -archs "$main_executable")"
test "$main_architectures" = "$expected_arch" || {
  echo "Expected Taomni architecture $expected_arch, found: $main_architectures" >&2
  exit 1
}

xray_count="$(find "$resource_root" -type f -path '*/sockscap/macos/xray' | wc -l | tr -d ' ')"
test "$xray_count" = "1" || {
  echo "Expected one bundled macOS xray executable, found $xray_count" >&2
  exit 1
}
xray="$(find "$resource_root" -type f -path '*/sockscap/macos/xray' -print -quit)"
test -x "$xray" || {
  echo "Bundled xray is not executable: $xray" >&2
  exit 1
}
xray_architectures="$(lipo -archs "$xray")"
test "$xray_architectures" = "$expected_arch" || {
  echo "Expected bundled xray architecture $expected_arch, found: $xray_architectures" >&2
  exit 1
}

redirector_count="$(find "$resource_root" -type f -path '*/sockscap/macos/redirector/0.12.11/Mitmproxy Redirector.app.tar' | wc -l | tr -d ' ')"
test "$redirector_count" = "1" || {
  echo "Expected one bundled Redirector v0.12.11 archive, found $redirector_count" >&2
  exit 1
}
bundled_redirector="$(find "$resource_root" -type f -path '*/sockscap/macos/redirector/0.12.11/Mitmproxy Redirector.app.tar' -print -quit)"
cmp "$pinned_redirector" "$bundled_redirector"

bundled_manifest="$(find "$resource_root" -type f -path '*/sockscap/macos/redirector/0.12.11/manifest.json' -print -quit)"
bundled_license="$(find "$resource_root" -type f -path '*/sockscap/macos/redirector/0.12.11/LICENSE' -print -quit)"
test -n "$bundled_manifest" && cmp "$pinned_manifest" "$bundled_manifest"
test -n "$bundled_license" && cmp "$pinned_license" "$bundled_license"

if [ "$notarize" = true ]; then
  test "$signing_mode" = developer-id && test -n "$expected_team_id"
  gatekeeper="$(spctl --assess --type execute --verbose=4 "$app" 2>&1)"
  grep -Fq 'source=Notarized Developer ID' <<<"$gatekeeper"
  xcrun stapler validate "$app"
  echo "Taomni macOS $expected_arch verified: fixed Developer ID certificate, updater app, notarization, architecture, Xray and Redirector v0.12.11."
else
  echo "Taomni macOS $expected_arch verified: $signing_mode, architecture, Xray and Redirector v0.12.11 (unnotarized build)."
fi
