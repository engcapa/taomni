#!/usr/bin/env bash
set -euo pipefail

mode="verify"
if [[ "${1:-}" == "--lint" ]]; then
  mode="lint"
  shift
fi

manifest_path="${1:-}"
if [[ -z "$manifest_path" || ! -f "$manifest_path" ]]; then
  echo "MACOS_MANIFEST_MISSING: usage: $0 [--lint] <release-manifest.json>" >&2
  exit 2
fi

fail() {
  local code="$1"
  shift
  echo "$code: $*" >&2
  exit 1
}

need_command() {
  command -v "$1" >/dev/null 2>&1 || fail "MACOS_TOOL_MISSING" "required command '$1' is unavailable"
}

need_command jq
need_command python3
script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
policy_path="$script_directory/../../src-tauri/platform/sockscap/macos/release-policy.json"
[[ -f "$policy_path" ]] || fail "MACOS_RELEASE_POLICY_MISSING" "committed macOS release policy is unavailable"
jq -e . "$manifest_path" >/dev/null || fail "MACOS_MANIFEST_INVALID" "manifest is not valid JSON"
jq -e . "$policy_path" >/dev/null || fail "MACOS_RELEASE_POLICY_INVALID" "release policy is not valid JSON"
[[ "$(jq -r '.schemaVersion // 0' "$manifest_path")" == "1" ]] || fail "MACOS_MANIFEST_INVALID" "schemaVersion must be 1"
enabled="$(jq -r '.captureReleaseEnabled | if type == "boolean" then tostring else "invalid" end' "$manifest_path")"
[[ "$enabled" == "true" || "$enabled" == "false" ]] || fail "MACOS_MANIFEST_INVALID" "captureReleaseEnabled must be boolean"
jq -e '.requireProvisioningProfiles == true' "$manifest_path" >/dev/null || fail "MACOS_MANIFEST_INVALID" "requireProvisioningProfiles must be boolean true"
jq -e '.requireNotarizationTicket == true' "$manifest_path" >/dev/null || fail "MACOS_MANIFEST_INVALID" "requireNotarizationTicket must be boolean true"
jq -e '(.gitCommit | type) == "string" and (.buildId | type) == "string"' "$manifest_path" >/dev/null || fail "MACOS_MANIFEST_INVALID" "gitCommit and buildId must be strings"
python3 - "$manifest_path" "$policy_path" <<'PY' || fail "MACOS_RELEASE_POLICY_MISMATCH" "manifest identity or architecture scope differs from the committed release policy"
import json
import sys

with open(sys.argv[1], encoding="utf-8") as source:
    manifest = json.load(source)
with open(sys.argv[2], encoding="utf-8") as source:
    policy = json.load(source)
if policy.get("schemaVersion") != 1:
    raise SystemExit(1)
for key in (
    "appBundleIdentifier",
    "providerBundleIdentifier",
    "teamIdentifier",
    "signerIdentityContains",
    "candidateBundleDigestAlgorithm",
    "requiredArchitectures",
):
    if manifest.get(key) != policy.get(key):
        raise SystemExit(1)
PY
policy_sha256="$(python3 - "$policy_path" <<'PY'
import hashlib
import sys

with open(sys.argv[1], "rb") as source:
    print(hashlib.sha256(source.read()).hexdigest())
PY
)"
provider_relative="$(jq -r '.providerRelativePath // empty' "$manifest_path")"
[[ -n "$provider_relative" ]] || fail "MACOS_MANIFEST_INVALID" "providerRelativePath is required"
case "$provider_relative" in
  /*|..|../*|*/../*|*/..) fail "MACOS_MANIFEST_INVALID" "providerRelativePath must stay inside the app bundle" ;;
esac

manifest_directory="$(cd "$(dirname "$manifest_path")" && pwd -P)"
source_app_entitlements="$(jq -r '.sourceEntitlements.application // empty' "$manifest_path")"
source_provider_entitlements="$(jq -r '.sourceEntitlements.provider // empty' "$manifest_path")"
[[ -f "$manifest_directory/$source_app_entitlements" ]] || fail "MACOS_ENTITLEMENTS_MISSING" "application entitlement source is missing"
[[ -f "$manifest_directory/$source_provider_entitlements" ]] || fail "MACOS_ENTITLEMENTS_MISSING" "provider entitlement source is missing"

if command -v plutil >/dev/null 2>&1; then
  plutil -lint "$manifest_directory/$source_app_entitlements" >/dev/null
  plutil -lint "$manifest_directory/$source_provider_entitlements" >/dev/null
else
  need_command xmllint
  xmllint --noout "$manifest_directory/$source_app_entitlements"
  xmllint --noout "$manifest_directory/$source_provider_entitlements"
fi

python3 - "$manifest_directory/$source_app_entitlements" "$manifest_directory/$source_provider_entitlements" <<'PY' || fail "MACOS_ENTITLEMENTS_INVALID" "source entitlements differ from the release allowlist"
import plistlib
import sys

with open(sys.argv[1], "rb") as source:
    app = plistlib.load(source)
with open(sys.argv[2], "rb") as source:
    provider = plistlib.load(source)
network_extension = ["app-proxy-provider-systemextension"]
expected_app = {
    "com.apple.security.device.audio-input": True,
    "com.apple.security.device.camera": True,
    "com.apple.developer.system-extension.install": True,
    "com.apple.developer.networking.networkextension": network_extension,
}
expected_provider = {
    "com.apple.developer.networking.networkextension": network_extension,
}
if app != expected_app or provider != expected_provider:
    raise SystemExit(1)
PY

if [[ "$mode" == "lint" ]]; then
  policy_state="$(jq -r '.configurationState // empty' "$policy_path")"
  jq -cn --arg enabled "$enabled" --arg policy_state "$policy_state" --arg policy_sha256 "$policy_sha256" '{gateSchemaVersion:1,gateKind:"sockscap_macos_artifact",platform:"macos",mode:"lint",captureReleaseEnabled:($enabled == "true"),releasePolicySchemaVersion:1,releasePolicyConfigurationState:$policy_state,releasePolicySha256:$policy_sha256,result:"PASS"}'
  exit 0
fi

[[ "$(uname -s)" == "Darwin" ]] || fail "MACOS_HOST_REQUIRED" "signature/notarization verification must run on macOS"
[[ "$enabled" == "true" ]] || fail "MACOS_CAPTURE_RELEASE_DISABLED" "captureReleaseEnabled is false"
policy_state="$(jq -r '.configurationState // empty' "$policy_path")"
policy_certificate_sha256="$(jq -r '.signerCertificateSha256 // empty' "$policy_path")"
[[ "$policy_state" == "configured" ]] || fail "MACOS_FIRST_PARTY_POLICY_UNCONFIGURED" "set the reviewed Team ID, signer certificate SHA-256, and architecture scope in release-policy.json before release verification"
[[ "$policy_certificate_sha256" =~ ^[0-9a-fA-F]{64}$ && "$policy_certificate_sha256" != "0000000000000000000000000000000000000000000000000000000000000000" ]] || fail "MACOS_FIRST_PARTY_POLICY_INVALID" "signer certificate SHA-256 is not a releasable identity"

git_commit="$(jq -r '.gitCommit // empty' "$manifest_path")"
build_id="$(jq -r '.buildId // empty' "$manifest_path")"
[[ "$git_commit" =~ ^[0-9a-fA-F]{40}$ ]] || fail "MACOS_BUILD_IDENTITY_INVALID" "gitCommit must be a full 40-character commit"
[[ "$build_id" =~ ^[A-Za-z0-9._-]{1,128}$ ]] || fail "MACOS_BUILD_IDENTITY_INVALID" "buildId contains unsupported characters"

for command in codesign spctl xcrun security lipo shasum; do
  need_command "$command"
done
[[ -x /usr/libexec/PlistBuddy ]] || fail "MACOS_TOOL_MISSING" "/usr/libexec/PlistBuddy is unavailable"

app_path_value="$(jq -r '.appBundlePath // empty' "$manifest_path")"
[[ -n "$app_path_value" ]] || fail "MACOS_MANIFEST_INVALID" "appBundlePath is required"
if [[ "$app_path_value" == /* ]]; then
  app_bundle="$app_path_value"
else
  app_bundle="$manifest_directory/$app_path_value"
fi
[[ -d "$app_bundle" ]] || fail "MACOS_APP_MISSING" "app bundle is missing: $app_bundle"
app_bundle="$(cd "$app_bundle" && pwd -P)"
provider_bundle="$app_bundle/$provider_relative"
[[ -d "$provider_bundle" ]] || fail "MACOS_PROVIDER_MISSING" "system extension is missing: $provider_bundle"
provider_bundle="$(cd "$provider_bundle" && pwd -P)"
case "$provider_bundle/" in
  "$app_bundle/"*) ;;
  *) fail "MACOS_PROVIDER_PATH_INVALID" "system extension resolves outside the application bundle" ;;
esac

app_bundle_id="$(jq -r '.appBundleIdentifier // empty' "$manifest_path")"
provider_bundle_id="$(jq -r '.providerBundleIdentifier // empty' "$manifest_path")"
team_id="$(jq -r '.teamIdentifier // empty' "$manifest_path")"
signer_contains="$(jq -r '.signerIdentityContains // empty' "$manifest_path")"
[[ -n "$app_bundle_id" && -n "$provider_bundle_id" && -n "$team_id" && -n "$signer_contains" ]] || fail "MACOS_MANIFEST_INVALID" "bundle ids, teamIdentifier, and signerIdentityContains are required"
candidate_bundle_digest_algorithm="$(jq -r '.candidateBundleDigestAlgorithm // empty' "$manifest_path")"
[[ "$candidate_bundle_digest_algorithm" == "taomni-directory-tree-sha256-v1" ]] || fail "MACOS_BUNDLE_DIGEST_INVALID" "unsupported candidate bundle digest algorithm"
candidate_bundle_sha256_before="$(python3 "$script_directory/candidate_digest.py" "$app_bundle")" || fail "MACOS_BUNDLE_DIGEST_INVALID" "cannot digest the application bundle before verification"
[[ "$candidate_bundle_sha256_before" =~ ^[0-9a-f]{64}$ ]] || fail "MACOS_BUNDLE_DIGEST_INVALID" "initial candidate bundle digest is invalid"

codesign --verify --deep --strict --verbose=4 "$app_bundle"
codesign --verify --strict --verbose=4 "$provider_bundle"

codesign_details() {
  codesign -dv --verbose=4 "$1" 2>&1
}

assert_signing_identity() {
  local bundle="$1"
  local expected_id="$2"
  local details
  details="$(codesign_details "$bundle")"
  grep -Fqx "Identifier=$expected_id" <<<"$details" || fail "MACOS_BUNDLE_ID_MISMATCH" "unexpected bundle identifier for $bundle"
  grep -Fqx "TeamIdentifier=$team_id" <<<"$details" || fail "MACOS_TEAM_ID_MISMATCH" "unexpected TeamIdentifier for $bundle"
  grep -F "Authority=" <<<"$details" | grep -F "$signer_contains" >/dev/null || fail "MACOS_SIGNER_INVALID" "Developer ID authority is missing for $bundle"
  grep -Fqx "Signature=adhoc" <<<"$details" && fail "MACOS_SIGNER_INVALID" "ad-hoc signature is forbidden for $bundle"
}

assert_signing_identity "$app_bundle" "$app_bundle_id"
assert_signing_identity "$provider_bundle" "$provider_bundle_id"

temporary_directory="$(mktemp -d "${TMPDIR:-/tmp}/taomni-sockscap-gate.XXXXXX")"
cleanup() {
  rm -rf -- "$temporary_directory"
}
trap cleanup EXIT

extract_signer_certificate_sha256() {
  local bundle="$1"
  local prefix="$2"
  codesign -d --extract-certificates "$prefix" "$bundle" >/dev/null 2>&1
  [[ -f "${prefix}0" ]] || fail "MACOS_SIGNER_CERTIFICATE_MISSING" "leaf signing certificate is unavailable for $bundle"
  shasum -a 256 "${prefix}0" | awk '{print $1}'
}

app_signer_certificate_sha256="$(extract_signer_certificate_sha256 "$app_bundle" "$temporary_directory/app-signer-")"
provider_signer_certificate_sha256="$(extract_signer_certificate_sha256 "$provider_bundle" "$temporary_directory/provider-signer-")"
[[ "$app_signer_certificate_sha256" == "$policy_certificate_sha256" ]] || fail "MACOS_SIGNER_CERTIFICATE_MISMATCH" "application signer certificate differs from the committed policy"
[[ "$provider_signer_certificate_sha256" == "$policy_certificate_sha256" ]] || fail "MACOS_SIGNER_CERTIFICATE_MISMATCH" "provider signer certificate differs from the committed policy"

app_signed_entitlements="$temporary_directory/app-entitlements.plist"
provider_signed_entitlements="$temporary_directory/provider-entitlements.plist"
codesign -d --entitlements :- "$app_bundle" >"$app_signed_entitlements" 2>/dev/null
codesign -d --entitlements :- "$provider_bundle" >"$provider_signed_entitlements" 2>/dev/null
plutil -lint "$app_signed_entitlements" >/dev/null
plutil -lint "$provider_signed_entitlements" >/dev/null

python3 - "$app_signed_entitlements" "$provider_signed_entitlements" "$team_id" "$app_bundle_id" "$provider_bundle_id" <<'PY' || fail "MACOS_SIGNED_ENTITLEMENTS_INVALID" "signed entitlements differ from the release allowlist"
import plistlib
import sys

with open(sys.argv[1], "rb") as source:
    app = plistlib.load(source)
with open(sys.argv[2], "rb") as source:
    provider = plistlib.load(source)
team_id, app_bundle_id, provider_bundle_id = sys.argv[3:]
network_extension = ["app-proxy-provider-systemextension"]

def normalized(actual):
    actual = dict(actual)
    if actual.get("com.apple.security.get-task-allow") is False:
        actual.pop("com.apple.security.get-task-allow")
    return actual

expected_app = {
    "com.apple.security.device.audio-input": True,
    "com.apple.security.device.camera": True,
    "com.apple.developer.system-extension.install": True,
    "com.apple.developer.networking.networkextension": network_extension,
    "com.apple.developer.team-identifier": team_id,
    "com.apple.application-identifier": f"{team_id}.{app_bundle_id}",
}
expected_provider = {
    "com.apple.developer.networking.networkextension": network_extension,
    "com.apple.developer.team-identifier": team_id,
    "com.apple.application-identifier": f"{team_id}.{provider_bundle_id}",
}
if normalized(app) != expected_app or normalized(provider) != expected_provider:
    raise SystemExit(1)
PY

plist_print() {
  /usr/libexec/PlistBuddy -c "Print :$2" "$1" 2>/dev/null
}

[[ "$(plist_print "$app_signed_entitlements" 'com.apple.developer.system-extension.install')" == "true" ]] || fail "MACOS_APP_ENTITLEMENT_MISSING" "system-extension.install is absent from the signed app"
plist_print "$app_signed_entitlements" 'com.apple.developer.networking.networkextension' | grep -Eq '(^|[[:space:]])app-proxy-provider-systemextension($|[[:space:]])' || fail "MACOS_APP_ENTITLEMENT_MISSING" "app-proxy-provider-systemextension is absent from the signed app"
plist_print "$provider_signed_entitlements" 'com.apple.developer.networking.networkextension' | grep -Eq '(^|[[:space:]])app-proxy-provider-systemextension($|[[:space:]])' || fail "MACOS_PROVIDER_ENTITLEMENT_MISSING" "app-proxy-provider-systemextension is absent from the signed provider"
[[ "$(plist_print "$app_signed_entitlements" 'com.apple.developer.team-identifier')" == "$team_id" ]] || fail "MACOS_TEAM_ID_MISMATCH" "signed app entitlement TeamIdentifier is wrong"
[[ "$(plist_print "$provider_signed_entitlements" 'com.apple.developer.team-identifier')" == "$team_id" ]] || fail "MACOS_TEAM_ID_MISMATCH" "signed provider entitlement TeamIdentifier is wrong"

provider_info="$provider_bundle/Contents/Info.plist"
[[ -f "$provider_info" ]] || fail "MACOS_PROVIDER_INFO_MISSING" "provider Info.plist is absent"
[[ "$(plist_print "$provider_info" 'CFBundleIdentifier')" == "$provider_bundle_id" ]] || fail "MACOS_BUNDLE_ID_MISMATCH" "provider Info.plist bundle id is wrong"
[[ "$(plist_print "$provider_info" 'NSExtension:NSExtensionPointIdentifier')" == "com.apple.networkextension.app-proxy" ]] || fail "MACOS_PROVIDER_INFO_INVALID" "provider extension point is not app-proxy"
[[ -n "$(plist_print "$provider_info" 'NSExtension:NSExtensionPrincipalClass')" ]] || fail "MACOS_PROVIDER_INFO_INVALID" "provider principal class is missing"

app_info="$app_bundle/Contents/Info.plist"
[[ -f "$app_info" ]] || fail "MACOS_APP_INFO_MISSING" "application Info.plist is absent"
[[ "$(plist_print "$app_info" 'CFBundleIdentifier')" == "$app_bundle_id" ]] || fail "MACOS_BUNDLE_ID_MISMATCH" "application Info.plist bundle id is wrong"
app_executable_name="$(plist_print "$app_info" 'CFBundleExecutable')"
provider_executable_name="$(plist_print "$provider_info" 'CFBundleExecutable')"
[[ -n "$app_executable_name" && -n "$provider_executable_name" ]] || fail "MACOS_EXECUTABLE_MISSING" "bundle executable name is missing"
app_executable="$app_bundle/Contents/MacOS/$app_executable_name"
provider_executable="$provider_bundle/Contents/MacOS/$provider_executable_name"
[[ -f "$app_executable" && -f "$provider_executable" ]] || fail "MACOS_EXECUTABLE_MISSING" "app or provider executable is missing"

app_profile="$app_bundle/Contents/embedded.provisionprofile"
provider_profile="$provider_bundle/Contents/embedded.provisionprofile"
app_profile_decoded="$temporary_directory/app-profile.plist"
provider_profile_decoded="$temporary_directory/provider-profile.plist"
for pair in "$app_profile:$app_profile_decoded" "$provider_profile:$provider_profile_decoded"; do
  profile="${pair%%:*}"
  decoded="${pair#*:}"
  [[ -f "$profile" ]] || fail "MACOS_PROVISIONING_PROFILE_MISSING" "profile is missing: $profile"
  security cms -D -i "$profile" >"$decoded"
  [[ "$(plist_print "$decoded" 'TeamIdentifier:0')" == "$team_id" ]] || fail "MACOS_PROVISIONING_PROFILE_INVALID" "profile TeamIdentifier is wrong: $profile"
done
[[ "$(plist_print "$app_profile_decoded" 'Entitlements:application-identifier')" == "$team_id.$app_bundle_id" ]] || fail "MACOS_PROVISIONING_PROFILE_INVALID" "app profile application identifier is wrong"
[[ "$(plist_print "$provider_profile_decoded" 'Entitlements:application-identifier')" == "$team_id.$provider_bundle_id" ]] || fail "MACOS_PROVISIONING_PROFILE_INVALID" "provider profile application identifier is wrong"
[[ "$(plist_print "$app_profile_decoded" 'Entitlements:com.apple.developer.system-extension.install')" == "true" ]] || fail "MACOS_PROVISIONING_PROFILE_INVALID" "app profile lacks system-extension.install"
plist_print "$app_profile_decoded" 'Entitlements:com.apple.developer.networking.networkextension' | grep -Eq '(^|[[:space:]])app-proxy-provider-systemextension($|[[:space:]])' || fail "MACOS_PROVISIONING_PROFILE_INVALID" "app profile lacks Network Extension entitlement"
plist_print "$provider_profile_decoded" 'Entitlements:com.apple.developer.networking.networkextension' | grep -Eq '(^|[[:space:]])app-proxy-provider-systemextension($|[[:space:]])' || fail "MACOS_PROVISIONING_PROFILE_INVALID" "provider profile lacks Network Extension entitlement"

python3 - "$app_profile_decoded" "$provider_profile_decoded" "$team_id" "$app_bundle_id" "$provider_bundle_id" "$policy_certificate_sha256" <<'PY' || fail "MACOS_PROVISIONING_PROFILE_INVALID" "profile identity, signer certificate, lifetime, or release entitlements are invalid"
from datetime import datetime, timezone
import hashlib
import plistlib
import sys

team_id, app_bundle_id, provider_bundle_id, signer_certificate_sha256 = sys.argv[3:]
now = datetime.now(timezone.utc)

for path, bundle_id, needs_install in (
    (sys.argv[1], app_bundle_id, True),
    (sys.argv[2], provider_bundle_id, False),
):
    with open(path, "rb") as source:
        profile = plistlib.load(source)
    expiration = profile.get("ExpirationDate")
    if not isinstance(expiration, datetime):
        raise SystemExit(1)
    if expiration.tzinfo is None:
        expiration = expiration.replace(tzinfo=timezone.utc)
    if expiration <= now:
        raise SystemExit(1)
    if profile.get("TeamIdentifier") != [team_id]:
        raise SystemExit(1)
    developer_certificates = profile.get("DeveloperCertificates")
    if (
        not isinstance(developer_certificates, list)
        or not developer_certificates
        or any(not isinstance(certificate, bytes) for certificate in developer_certificates)
        or signer_certificate_sha256.lower()
        not in {
            hashlib.sha256(certificate).hexdigest()
            for certificate in developer_certificates
        }
    ):
        raise SystemExit(1)
    entitlements = profile.get("Entitlements")
    if not isinstance(entitlements, dict):
        raise SystemExit(1)
    if entitlements.get("application-identifier") != f"{team_id}.{bundle_id}":
        raise SystemExit(1)
    if entitlements.get("com.apple.developer.team-identifier") != team_id:
        raise SystemExit(1)
    if entitlements.get("com.apple.security.get-task-allow") is not False:
        raise SystemExit(1)
    if entitlements.get("com.apple.developer.networking.networkextension") != [
        "app-proxy-provider-systemextension"
    ]:
        raise SystemExit(1)
    if needs_install and entitlements.get(
        "com.apple.developer.system-extension.install"
    ) is not True:
        raise SystemExit(1)
PY

app_architectures="$(lipo -archs "$app_executable")"
provider_architectures="$(lipo -archs "$provider_executable")"
python3 - "$manifest_path" "$app_architectures" "$provider_architectures" <<'PY' || fail "MACOS_ARCHITECTURE_INVALID" "manifest, app, and provider architecture sets must match exactly"
import json
import sys

with open(sys.argv[1], encoding="utf-8") as source:
    manifest = json.load(source)
required = manifest.get("requiredArchitectures")
app = sys.argv[2].split()
provider = sys.argv[3].split()
allowed = {"arm64", "x86_64"}
if (
    not isinstance(required, list)
    or not required
    or any(not isinstance(item, str) for item in required)
    or len(set(required)) != len(required)
    or not set(required) <= allowed
    or len(set(app)) != len(app)
    or len(set(provider)) != len(provider)
    or set(app) != set(required)
    or set(provider) != set(required)
):
    raise SystemExit(1)
PY

spctl --assess --type execute --verbose=4 "$app_bundle"
xcrun stapler validate "$app_bundle"
candidate_bundle_sha256="$(python3 "$script_directory/candidate_digest.py" "$app_bundle")" || fail "MACOS_BUNDLE_DIGEST_INVALID" "cannot digest the verified application bundle"
[[ "$candidate_bundle_sha256" =~ ^[0-9a-f]{64}$ ]] || fail "MACOS_BUNDLE_DIGEST_INVALID" "candidate bundle digest is invalid"
[[ "$candidate_bundle_sha256" == "$candidate_bundle_sha256_before" ]] || fail "MACOS_BUNDLE_CHANGED_DURING_VERIFICATION" "application bundle changed while release checks were running"

jq -cn \
  --arg git_commit "$git_commit" \
  --arg build_id "$build_id" \
  --arg app "$app_bundle" \
  --arg provider "$provider_bundle" \
  --arg app_executable "$app_executable" \
  --arg provider_executable "$provider_executable" \
  --arg app_bundle_id "$app_bundle_id" \
  --arg provider_bundle_id "$provider_bundle_id" \
  --arg candidate_bundle_digest_algorithm "$candidate_bundle_digest_algorithm" \
  --arg candidate_bundle_sha256 "$candidate_bundle_sha256" \
  --arg policy_sha256 "$policy_sha256" \
  --arg app_signer_certificate_sha256 "$app_signer_certificate_sha256" \
  --arg provider_signer_certificate_sha256 "$provider_signer_certificate_sha256" \
  --arg app_sha256 "$(shasum -a 256 "$app_executable" | awk '{print $1}')" \
  --arg provider_sha256 "$(shasum -a 256 "$provider_executable" | awk '{print $1}')" \
  --arg app_entitlements_sha256 "$(shasum -a 256 "$app_signed_entitlements" | awk '{print $1}')" \
  --arg provider_entitlements_sha256 "$(shasum -a 256 "$provider_signed_entitlements" | awk '{print $1}')" \
  --arg app_profile_sha256 "$(shasum -a 256 "$app_profile" | awk '{print $1}')" \
  --arg provider_profile_sha256 "$(shasum -a 256 "$provider_profile" | awk '{print $1}')" \
  --arg team_id "$team_id" \
  --arg app_architectures "$app_architectures" \
  --arg provider_architectures "$provider_architectures" \
  '{gateSchemaVersion:1,gateKind:"sockscap_macos_artifact",platform:"macos",mode:"release",gitCommit:$git_commit,buildId:$build_id,releasePolicySchemaVersion:1,releasePolicySha256:$policy_sha256,app:$app,provider:$provider,appExecutable:$app_executable,providerExecutable:$provider_executable,appBundleIdentifier:$app_bundle_id,providerBundleIdentifier:$provider_bundle_id,candidateBundleDigestAlgorithm:$candidate_bundle_digest_algorithm,candidateBundleSha256:$candidate_bundle_sha256,appExecutableSha256:$app_sha256,providerExecutableSha256:$provider_sha256,appSignerCertificateSha256:$app_signer_certificate_sha256,providerSignerCertificateSha256:$provider_signer_certificate_sha256,appEntitlementsSha256:$app_entitlements_sha256,providerEntitlementsSha256:$provider_entitlements_sha256,appProvisioningProfileSha256:$app_profile_sha256,providerProvisioningProfileSha256:$provider_profile_sha256,teamIdentifier:$team_id,architectures:($app_architectures|split(" ")),providerArchitectures:($provider_architectures|split(" ")),provisioningProfilesVerified:true,notarizationTicketVerified:true,result:"PASS"}'
