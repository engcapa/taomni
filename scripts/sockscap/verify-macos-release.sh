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
jq -e . "$manifest_path" >/dev/null || fail "MACOS_MANIFEST_INVALID" "manifest is not valid JSON"
[[ "$(jq -r '.schemaVersion // 0' "$manifest_path")" == "1" ]] || fail "MACOS_MANIFEST_INVALID" "schemaVersion must be 1"
enabled="$(jq -r '.captureReleaseEnabled | if type == "boolean" then tostring else "invalid" end' "$manifest_path")"
[[ "$enabled" == "true" || "$enabled" == "false" ]] || fail "MACOS_MANIFEST_INVALID" "captureReleaseEnabled must be boolean"
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

if [[ "$mode" == "lint" ]]; then
  jq -cn --arg enabled "$enabled" '{platform:"macos",mode:"lint",captureReleaseEnabled:($enabled == "true"),result:"PASS"}'
  exit 0
fi

[[ "$(uname -s)" == "Darwin" ]] || fail "MACOS_HOST_REQUIRED" "signature/notarization verification must run on macOS"
[[ "$enabled" == "true" ]] || fail "MACOS_CAPTURE_RELEASE_DISABLED" "captureReleaseEnabled is false"

for command in codesign spctl xcrun security lipo; do
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

app_bundle_id="$(jq -r '.appBundleIdentifier // empty' "$manifest_path")"
provider_bundle_id="$(jq -r '.providerBundleIdentifier // empty' "$manifest_path")"
team_id="$(jq -r '.teamIdentifier // empty' "$manifest_path")"
signer_contains="$(jq -r '.signerIdentityContains // empty' "$manifest_path")"
[[ -n "$app_bundle_id" && -n "$provider_bundle_id" && -n "$team_id" && -n "$signer_contains" ]] || fail "MACOS_MANIFEST_INVALID" "bundle ids, teamIdentifier, and signerIdentityContains are required"

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

app_signed_entitlements="$temporary_directory/app-entitlements.plist"
provider_signed_entitlements="$temporary_directory/provider-entitlements.plist"
codesign -d --entitlements :- "$app_bundle" >"$app_signed_entitlements" 2>/dev/null
codesign -d --entitlements :- "$provider_bundle" >"$provider_signed_entitlements" 2>/dev/null
plutil -lint "$app_signed_entitlements" >/dev/null
plutil -lint "$provider_signed_entitlements" >/dev/null

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

if [[ "$(jq -r '.requireProvisioningProfiles // true' "$manifest_path")" == "true" ]]; then
  for pair in "$app_bundle/Contents/embedded.provisionprofile:$temporary_directory/app-profile.plist" "$provider_bundle/Contents/embedded.provisionprofile:$temporary_directory/provider-profile.plist"; do
    profile="${pair%%:*}"
    decoded="${pair#*:}"
    [[ -f "$profile" ]] || fail "MACOS_PROVISIONING_PROFILE_MISSING" "profile is missing: $profile"
    security cms -D -i "$profile" >"$decoded"
    [[ "$(plist_print "$decoded" 'TeamIdentifier:0')" == "$team_id" ]] || fail "MACOS_PROVISIONING_PROFILE_INVALID" "profile TeamIdentifier is wrong: $profile"
  done
fi

actual_architectures="$(lipo -archs "$app_bundle/Contents/MacOS/Taomni")"
while IFS= read -r required_architecture; do
  [[ -z "$required_architecture" ]] && continue
  [[ " $actual_architectures " == *" $required_architecture "* ]] || fail "MACOS_ARCHITECTURE_MISSING" "$required_architecture is missing from app executable"
done < <(jq -r '.requiredArchitectures[]?' "$manifest_path")

spctl --assess --type execute --verbose=4 "$app_bundle"
if [[ "$(jq -r '.requireNotarizationTicket // true' "$manifest_path")" == "true" ]]; then
  xcrun stapler validate "$app_bundle"
fi

jq -cn \
  --arg app "$app_bundle" \
  --arg provider "$provider_bundle" \
  --arg architectures "$actual_architectures" \
  '{platform:"macos",app:$app,provider:$provider,architectures:($architectures|split(" ")),result:"PASS"}'
