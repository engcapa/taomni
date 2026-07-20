#!/usr/bin/env bash
# Stage the exact privileged files consumed by the release-only Linux overlay.
# This hook runs after Tauri has produced the final application ELF.  It never
# enables capture for the ordinary AppImage/updater build.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
TAURI_DIR="$ROOT_DIR/src-tauri"
DEFAULT_STAGE_DIR="$TAURI_DIR/platform/sockscap/linux/staged"
POLKIT_SOURCE="$TAURI_DIR/platform/sockscap/linux/com.taomni.sockscap.policy"
POLICY_GENERATOR="$SCRIPT_DIR/generate-linux-helper-policy.py"
RELEASE_POLICY="$TAURI_DIR/platform/sockscap/linux/release-policy.json"
LINUX_OVERLAY="$TAURI_DIR/tauri.sockscap.linux.conf.json"
PACKAGE_ICONS=(
  "$TAURI_DIR/icons/32x32.png"
  "$TAURI_DIR/icons/128x128.png"
  "$TAURI_DIR/icons/128x128@2x.png"
)
STAGED_ICON_NAMES=(
  "32x32.png"
  "128x128.png"
  "128x128@2x.png"
)

die() {
  echo "stage-linux-package: $*" >&2
  exit 1
}

if [[ "${1:-}" == "--lint" ]]; then
  [[ $# -eq 1 ]] || die "--lint accepts no additional arguments"
  [[ -f "$POLKIT_SOURCE" && ! -L "$POLKIT_SOURCE" ]] || die "polkit source is missing or unsafe"
  [[ -f "$POLICY_GENERATOR" && ! -L "$POLICY_GENERATOR" ]] || die "policy generator is missing or unsafe"
  python3 -m py_compile "$POLICY_GENERATOR"
  exit 0
fi
[[ $# -eq 0 ]] || die "unexpected arguments"

[[ "${TAURI_ENV_PLATFORM:-}" == "linux" ]] || die "release staging is Linux-only"
[[ "${TAURI_ENV_DEBUG:-}" == "false" ]] || die "capture packages require a release Tauri build"

test_mode="${SOCKSCAP_LINUX_STAGE_TEST:-}"
case "$test_mode" in
  "")
    [[ -z "${SOCKSCAP_LINUX_STAGE_DIR:-}" \
      && -z "${SOCKSCAP_LINUX_APPLICATION_BIN:-}" \
      && -z "${SOCKSCAP_LINUX_HELPER_BIN:-}" ]] \
      || die "stage or binary overrides are test-only"
    ;;
  1)
    [[ -n "${SOCKSCAP_LINUX_STAGE_DIR:-}" \
      && -n "${SOCKSCAP_LINUX_APPLICATION_BIN:-}" \
      && -n "${SOCKSCAP_LINUX_HELPER_BIN:-}" ]] \
      || die "test staging requires stage, application, and helper overrides together"
    ;;
  *)
    die "SOCKSCAP_LINUX_STAGE_TEST must be unset or exactly 1"
    ;;
esac

stage_dir="${SOCKSCAP_LINUX_STAGE_DIR:-$DEFAULT_STAGE_DIR}"
[[ "$stage_dir" == /* ]] || die "stage directory must be absolute"
stage_dir="$(realpath -m -- "$stage_dir")"
if [[ "$test_mode" == "1" ]]; then
  [[ "$stage_dir" != "$(realpath -m -- "$DEFAULT_STAGE_DIR")" ]] \
    || die "test staging must not target the committed package stage directory"
else
  case "$(umask)" in
    0022|022) ;;
    *) die "capture package construction requires process umask 0022" ;;
  esac
  [[ -f "$RELEASE_POLICY" && ! -L "$RELEASE_POLICY" ]] \
    || die "Linux release policy is missing or unsafe"
  [[ -f "$LINUX_OVERLAY" && ! -L "$LINUX_OVERLAY" ]] \
    || die "Linux capture overlay is missing or unsafe"

  case "${TAURI_ENV_TARGET_TRIPLE:-}" in
    x86_64-*) architecture=x86_64 ;;
    aarch64-*) architecture=aarch64 ;;
    "")
      case "$(uname -m)" in
        x86_64) architecture=x86_64 ;;
        aarch64|arm64) architecture=aarch64 ;;
        *) die "unsupported build architecture $(uname -m)" ;;
      esac
      ;;
    *) die "unsupported Linux target triple ${TAURI_ENV_TARGET_TRIPLE}" ;;
  esac

  jq -e --arg architecture "$architecture" '
    def reviewed_fingerprint:
      type == "string"
      and test("^(?:[0-9A-Fa-f]{40}|[0-9A-Fa-f]{64})$")
      and (test("^0+$") | not);
    .configurationState == "configured"
    and .packageDependencyContractState == "configured"
    and (.supportedArchitectures | index($architecture) != null)
    and .capturePackageKinds == ["deb", "rpm"]
    and .appImageCaptureDisabled == true
    and (.packageSignatures.deb.signerFingerprint | reviewed_fingerprint)
    and (.packageSignatures.rpm.signerFingerprint | reviewed_fingerprint)
  ' "$RELEASE_POLICY" >/dev/null \
    || die "reviewed architecture, dependency contract, and complete DEB/RPM signer identities are not configured"
  jq -e '
    .bundle.targets == ["deb", "rpm"]
    and .bundle.createUpdaterArtifacts == false
    and (.bundle.linux | has("appimage") | not)
    and .bundle.icon == [
      "platform/sockscap/linux/staged/icons/32x32.png",
      "platform/sockscap/linux/staged/icons/128x128.png",
      "platform/sockscap/linux/staged/icons/128x128@2x.png"
    ]
  ' "$LINUX_OVERLAY" >/dev/null \
    || die "capture overlay must remain DEB/RPM-only without updater artifacts"
fi

target_dir="${CARGO_TARGET_DIR:-$TAURI_DIR/target}"
if [[ "$target_dir" != /* ]]; then
  target_dir="$ROOT_DIR/$target_dir"
fi
target_triple="${TAURI_ENV_TARGET_TRIPLE:-}"
profile_dir="$target_dir/release"
if [[ -n "$target_triple" ]]; then
  profile_dir="$target_dir/$target_triple/release"
fi

application="${SOCKSCAP_LINUX_APPLICATION_BIN:-$profile_dir/taomni}"
helper="${SOCKSCAP_LINUX_HELPER_BIN:-}"
if [[ -z "$helper" ]]; then
  cargo_args=(
    build
    --locked
    --release
    --manifest-path "$TAURI_DIR/Cargo.toml"
    --bin sockscap-helper
  )
  if [[ -n "$target_triple" ]]; then
    cargo_args+=(--target "$target_triple")
  fi
  cargo "${cargo_args[@]}"
  helper="$profile_dir/sockscap-helper"
fi

for entry in "$application" "$helper"; do
  [[ "$entry" == /* ]] || die "binary paths must be absolute"
  [[ -f "$entry" && ! -L "$entry" && -s "$entry" && -x "$entry" ]] \
    || die "release binary is missing, empty, non-executable, or a symlink: $entry"
  readelf -h "$entry" >/dev/null 2>&1 || die "release binary is not a valid ELF: $entry"
done

chmod 0755 "$application" || die "final application mode could not be normalized"
if [[ "$test_mode" != "1" ]]; then
  for icon in "${PACKAGE_ICONS[@]}"; do
    [[ -f "$icon" && ! -L "$icon" && -s "$icon" ]] \
      || die "fixed Linux package icon is missing or unsafe: $icon"
  done
fi

mkdir -p "$stage_dir"
[[ -d "$stage_dir" && ! -L "$stage_dir" ]] || die "stage directory is unsafe"
chmod 0755 "$stage_dir" || die "stage directory mode could not be normalized"
temporary="$(mktemp -d "$stage_dir/.stage.XXXXXX")"
cleanup() {
  rm -rf -- "$temporary"
}
trap cleanup EXIT

install -m 0755 "$helper" "$temporary/sockscap-helper"
install -m 0644 "$POLKIT_SOURCE" "$temporary/com.taomni.sockscap.policy"
if [[ "$test_mode" != "1" ]]; then
  mkdir -m 0755 "$temporary/icons"
  for index in "${!PACKAGE_ICONS[@]}"; do
    install -m 0644 \
      "${PACKAGE_ICONS[$index]}" \
      "$temporary/icons/${STAGED_ICON_NAMES[$index]}"
  done
fi
python3 "$POLICY_GENERATOR" \
  --application "$application" \
  --helper "$temporary/sockscap-helper" \
  --output "$temporary/sockscap-helper-policy.json"

mv -f -- "$temporary/sockscap-helper" "$stage_dir/sockscap-helper"
mv -f -- "$temporary/sockscap-helper-policy.json" "$stage_dir/sockscap-helper-policy.json"
mv -f -- "$temporary/com.taomni.sockscap.policy" "$stage_dir/com.taomni.sockscap.policy"
if [[ "$test_mode" != "1" ]]; then
  if [[ -e "$stage_dir/icons" || -L "$stage_dir/icons" ]]; then
    [[ -d "$stage_dir/icons" && ! -L "$stage_dir/icons" ]] \
      || die "staged icon directory is unsafe"
  else
    mkdir -m 0755 "$stage_dir/icons"
  fi
  chmod 0755 "$stage_dir/icons"
  for icon_name in "${STAGED_ICON_NAMES[@]}"; do
    mv -f -- "$temporary/icons/$icon_name" "$stage_dir/icons/$icon_name"
    chmod 0644 "$stage_dir/icons/$icon_name"
  done
fi
chmod 0755 "$stage_dir/sockscap-helper"
chmod 0644 "$stage_dir/sockscap-helper-policy.json" "$stage_dir/com.taomni.sockscap.policy"

echo "stage-linux-package: staged final helper, generated policy, and polkit action"
