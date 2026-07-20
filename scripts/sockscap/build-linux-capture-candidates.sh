#!/usr/bin/env bash
# Canonical build entry for capture-capable Linux package candidates.
# Signing and same-host verification happen after this command; ordinary
# AppImage/updater builds must never use this overlay.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
OVERLAY="$ROOT_DIR/src-tauri/tauri.sockscap.linux.conf.json"
POLICY="$ROOT_DIR/src-tauri/platform/sockscap/linux/release-policy.json"

die() {
  echo "build-linux-capture-candidates: $*" >&2
  exit 1
}

lint_only=false
if [[ "${1:-}" == "--lint" ]]; then
  [[ $# -eq 1 ]] || die "--lint accepts no additional arguments"
  lint_only=true
else
  [[ $# -eq 0 ]] || die "unexpected arguments"
fi

[[ -f "$OVERLAY" && ! -L "$OVERLAY" ]] || die "Linux capture overlay is missing or unsafe"
[[ -f "$POLICY" && ! -L "$POLICY" ]] || die "Linux release policy is missing or unsafe"
jq -e '
  .bundle.targets == ["deb", "rpm"]
  and .bundle.createUpdaterArtifacts == false
  and (.bundle.linux | has("appimage") | not)
  and .bundle.icon == [
    "platform/sockscap/linux/staged/icons/32x32.png",
    "platform/sockscap/linux/staged/icons/128x128.png",
    "platform/sockscap/linux/staged/icons/128x128@2x.png"
  ]
' "$OVERLAY" >/dev/null || die "overlay must remain DEB/RPM-only with updater artifacts disabled"

if [[ "$lint_only" == "true" ]]; then
  exit 0
fi

[[ "$(uname -s)" == "Linux" ]] || die "capture package candidates can only be built on Linux"
umask 022
for variable in \
  SOCKSCAP_LINUX_STAGE_TEST \
  SOCKSCAP_LINUX_STAGE_DIR \
  SOCKSCAP_LINUX_APPLICATION_BIN \
  SOCKSCAP_LINUX_HELPER_BIN; do
  [[ -z "${!variable:-}" ]] || die "$variable is forbidden in a candidate build"
done

case "$(uname -m)" in
  x86_64) architecture=x86_64 ;;
  aarch64|arm64) architecture=aarch64 ;;
  *) die "unsupported build architecture $(uname -m)" ;;
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
' "$POLICY" >/dev/null \
  || die "reviewed architecture, dependency contract, and complete DEB/RPM signer identities are not configured"

cd "$ROOT_DIR"
exec pnpm tauri build --ci \
  --config src-tauri/tauri.sockscap.linux.conf.json \
  --bundles deb,rpm
