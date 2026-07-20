# Sockscap platform release gates

These assets intentionally separate ordinary Taomni preview builds from native
capture releases. The default `src-tauri/Entitlements.plist` remains unchanged;
it does not claim a Network Extension capability.

## Windows

Copy `src-tauri/platform/sockscap/windows/release-manifest.template.json` into a
release staging directory and fill it with paths and candidate build identity.
Signer identities and accepted third-party values do not come from that
editable manifest: `release-policy.json` is the version-controlled allowlist
consumed independently by both release verifiers. Its first-party publisher and
certificate are deliberately `unconfigured` in source. A reviewed publisher
subject and signer-certificate SHA-256 must be committed before any non-lint
release run can pass; the manifest cannot supply or override them.

```powershell
pwsh scripts/sockscap/verify-windows-release.ps1 `
  -ManifestPath path/to/windows-release-manifest.json |
  Tee-Object -FilePath path/to/evidence/artifact-gate.json
```

The production contract is deliberately narrower than the historical
prototype: application/PID capture must use WinDivert. WFP and an unselected
provider are rejected. The pinned official WinDivert package currently makes
this gate x86_64-only; Windows ARM64 must remain capability-disabled until an
official signed native driver is available and the contract is revised.
The disabled template also fixes the reviewed Wintun 0.14.1 official ZIP,
x64 DLL, and license by canonical URL and SHA-256. The staged DLL and license
must byte-match that ZIP, and the DLL's exact Authenticode signer subject must
be copied into the real release manifest and verified on the Windows release
host.

The verifier requires a timestamped, valid Authenticode chain for Taomni, the
privileged helper, and Wintun. The official WinDivert DLL is not Authenticode
signed, so the manifest must explicitly pin its signature mode as
`unsigned_official` and leave its signer subject empty; claiming a DLL signer
fails the gate. The embedded driver has an independent, non-empty signer pin
and must pass SignTool's kernel policy. The verifier also requires the original
official ZIP, enforces its canonical HTTPS URL and SHA-256, and byte-compares
the staged DLL, driver, and license with the corresponding ZIP entries. It
parses every PE header to reject architecture mismatches and verifies the ZIP's
VERSION plus the driver's major/minor file version against the exact
three-part release pin. No rebuilt, patched, or test-signed driver is accepted.
`captureReleaseEnabled=false` always blocks release verification. The
committed template remains disabled but names `windivert` explicitly so lint
cannot preserve an obsolete provider branch.

The committed policy pins the exact Taomni app/helper signer subject and leaf
certificate fingerprint as well as the Wintun and WinDivert certificate pins.
The receipt carries its policy digest, candidate commit/build ID, manifest
digest and every staged package/file hash; the aggregate Python Gate compares
these fields to the same policy and re-hashes the receipt-listed artifacts on
that host. Changing a publisher, certificate, provider version, variant, hash
or driver certificate therefore requires an explicit reviewed policy revision,
not an edited staging manifest.

## macOS

The release-only Tauri overlay is
`src-tauri/tauri.sockscap.macos.conf.json`. It expects a separately built and
signed system extension under the ignored `staged/` directory. The extension
must be produced by a real Xcode Network Extension target using the committed
Info.plist and provider entitlements.

```bash
bash scripts/sockscap/verify-macos-release.sh \
  path/to/macos-release-manifest.json \
  > path/to/evidence/artifact-gate.json
```

The verifier checks the actual signed app and provider, their bundle/team IDs,
Developer ID authorities and exact leaf-certificate fingerprint, signed
entitlements, provisioning profiles, architectures, Gatekeeper assessment, and
stapled notarization ticket. The fixed policy's Team ID, certificate and
architecture list are deliberately `unconfigured`; they require a reviewed
commit and cannot be overridden by a staging manifest. The template is disabled
so it cannot be mistaken for release evidence.
Provisioning profiles and stapled notarization are mandatory and cannot be
disabled by manifest switches. Both app and provider executables must contain
every declared architecture; profiles are bound to their exact application
identifiers and Network Extension entitlements, and each profile must authorize
the exact leaf certificate that signed the corresponding bundle. The app's
Info.plist identifier is checked independently of the code-signing identifier.
The receipt records the commit/build ID and executable, signed-entitlement and
profile hashes. It also records a policy-pinned deterministic digest of the
complete verified `.app` tree (relative paths, file types, modes, symlink
targets, extended attributes, and all regular-file bytes). The release verifier
also requires that digest to remain unchanged across its signing/profile/notary
checks. Later aggregation therefore detects changes to profiles, Info.plists,
signatures, nested code, or resources—not only changes to the two Mach-O
executables.

Static template checks can run on a non-release host:

```bash
bash scripts/sockscap/verify-macos-release.sh --lint \
  src-tauri/platform/sockscap/macos/release-manifest.template.json
```

Neither verifier obtains certificates, Apple managed capabilities, Microsoft
driver signatures, or lab evidence. Those are external release inputs, and the
gate remains red until the real artifacts are supplied.

## Linux

Capture-capable Linux delivery is deliberately limited to installed DEB/RPM
packages. Ordinary AppImage and updater builds do not install the fixed root
helper, helper policy, or polkit action and therefore must keep every capture
capability disabled. The sole candidate-build entry is:

```bash
bash scripts/sockscap/build-linux-capture-candidates.sh
```

It invokes Tauri with `src-tauri/tauri.sockscap.linux.conf.json` and only the
`deb,rpm` bundle set. It rejects test staging overrides and refuses to build
until the committed policy contains a reviewed architecture, a complete
per-distro package dependency contract, and complete DEB/RPM signer
fingerprints. Both policy states are intentionally `unconfigured` today, so
`--lint` is the only passing source-only mode:

```bash
bash scripts/sockscap/build-linux-capture-candidates.sh --lint
bash scripts/sockscap/stage-linux-package.sh --lint
python3 scripts/sockscap/verify-linux-release.py --lint \
  src-tauri/platform/sockscap/linux/release-manifest.template.json
```

The release-only Tauri hook builds the fixed `sockscap-helper`, hashes the
final application and helper into an exact-installed-only helper policy, and
stages that policy with the fixed polkit action. Package hooks install the
files as root with fixed modes and refuse upgrade/removal while cgroup, nft,
TUN, policy-route, unsafe runtime, or unknown tombstone state remains. They do
not delete recovery evidence, and the old package's post-remove hook preserves
the new runtime directory during upgrade.

After the final DEB/RPM is signed and installed on the verification host, copy
the disabled Linux manifest to an evidence directory, fill every hash/path and
run:

```bash
python3 scripts/sockscap/verify-linux-release.py \
  path/to/linux-release-manifest.json \
  > path/to/evidence/artifact-gate.json
```

The verifier pins the fixed policy, package type, full OpenPGP signer
fingerprint, package payload and maintainer scripts, installed paths,
root ownership/modes, absence of helper file capabilities, helper policy, and
polkit defaults. It emits a hash-bound package manifest. This is same-host
artifact evidence, not proof that clean install, dirty-state blocking,
upgrade, rollback, uninstall, and final-residue checks ran under a real package
manager; the aggregate platform Gate requires that separate typed lab receipt.

The current aggregate verifier deliberately keeps Linux lab-runner attestation
unconfigured. It validates the typed lifecycle receipt and all five classes of
hash-pinned raw evidence, then fails with
`LINUX_INSTALL_PROVENANCE_ATTESTATION_UNCONFIGURED`; self-reported `PASS` fields
cannot produce a Linux release `PASS`. Before enabling this path, implement a
protected package-manager lab runner and commit its reviewed identity/public
key plus a fixed signature and verification protocol. This is an intentional
external release blocker, not a source-lint failure.

## Core performance and lifecycle soak

The headless core gate uses the production policy matcher, bounded live-flow
sampler, SQLite recovery journal, and capture transaction coordinator. Its
adapter is deliberately synthetic and never mutates host networking.

```bash
export SOCKSCAP_EVIDENCE_DIR="/absolute/path/outside/taomni/sockscap-evidence"
mkdir -p "$SOCKSCAP_EVIDENCE_DIR"
cd src-tauri
export SOCKSCAP_GATE_GIT_COMMIT="$(git rev-parse HEAD)"
cargo run --release --bin sockscap-gate -- quick \
  --output "$SOCKSCAP_EVIDENCE_DIR/sockscap-core-quick.json"
target/release/sockscap-gate soak --duration-seconds 86400 \
  --output "$SOCKSCAP_EVIDENCE_DIR/sockscap-core-soak-24h.json"
cd ..
python3 scripts/sockscap/verify-performance-gate.py core \
  "$SOCKSCAP_EVIDENCE_DIR/sockscap-core-soak-24h.json" \
  --min-duration-seconds 86400
```

Quick mode fixes the software thresholds at 10,000 rules / 20,000 timed
matches with P99 below 100 microseconds, 100 complete start/stop transactions,
a clean final journal, and bounded RSS/open-file growth. The binary refuses to
green a debug build. Soak mode keeps one transaction Active, persists helper
heartbeats, exercises matching and bounded Dashboard events, then proves clean
stop. Both receipts say `releaseEligible=false`: they are not packet-capture
evidence.

## Platform performance and 24-hour release gate

Copy
`src-tauri/platform/sockscap/performance-release-manifest.template.json` into
the platform lab's evidence directory. Keep every referenced artifact in that
directory, fill its SHA-256 pin, and verify on the same operating system:

```bash
python3 scripts/sockscap/verify-performance-gate.py platform \
  path/to/performance-release-manifest.json \
  --expected-commit "$SOCKSCAP_GATE_GIT_COMMIT"
```

`evidence.artifactGate` must point to the final JSON receipt emitted by the
same-host Windows/macOS/Linux verifier, never its lint output. The aggregate
Gate binds each receipt to the committed platform policy and re-hashes every
receipt-listed app/helper/provider/package/policy/manifest path on the
verification host; copying only a PASS JSON without its exact candidate files
is rejected. Linux additionally requires `evidence.linuxInstallProvenance`, a
typed real-package-manager receipt for install/upgrade/rollback/uninstall and
dirty-state/final-residue checks.

`evidence.nativeSmoke` must point to schema v1
`sockscap_native_capture_smoke` evidence with
`evidenceClass=real_host_capture`, `releaseEligible=true`, native PASS, and a
passing unique `TC-SOCKSCAP-native-capture-smoke`. It is bound to the exact
platform, architecture, provider, commit, build ID, artifact-Gate receipt hash,
and app/privileged/provider hashes (plus Wintun and WinDivert hashes on
Windows, and the complete candidate app-bundle digest on macOS). Its capture
matrix must prove global, application, PID, TCP, UDP,
IPv4, IPv6, DNS, reinjection and zero cleanup residue. The existing
`qa-ui-auto.summary.v1` `TC-SOCKSCAP-native-window-smoke` remains useful UI/IPC
evidence, but does not start capture and is intentionally rejected here. A real
native capture producer and platform cases still need to be implemented.

This gate cannot be shortened or made synthetic. It requires signed-artifact
verification, native smoke, matching quick and 24-hour core receipts, real
global/application/PID capture coverage, at least 100 TCP-connect samples with
less than 10 ms median overhead, at least 60 seconds of throughput at 80% of
direct on a link of at least 1 Gbps (whose direct baseline must itself reach
80% of link capacity), 100 real start/stop cleanup checks, zero
residue/crashes, bounded RSS/handle growth, kill/restart/sleep/NIC/VPN
recovery, and DNS/IPv4/IPv6/UDP leak audits. Evidence paths cannot escape the
manifest directory and every file is hash-pinned. The committed template is
disabled and never passes the release verifier.

These same-host JSON and file-consistency checks are not producer attestation.
A production workflow must also verify protected-lab/CI provenance (for example
in-toto, SLSA or an equivalent signed attestation) and bind every typed receipt
to one candidate ID and final app/helper/provider/installer hashes. On macOS,
that provenance must additionally prove that the final DMG/PKG/updater payload
contains the same full `.app` candidate digest exercised by native smoke; a
standalone package hash does not establish that relation. Until this and a real
capture-smoke producer exist, a green self-reported platform manifest cannot
enable a capture capability.
