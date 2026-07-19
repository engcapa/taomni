# Sockscap platform release gates

These assets intentionally separate ordinary Taomni preview builds from native
capture releases. The default `src-tauri/Entitlements.plist` remains unchanged;
it does not claim a Network Extension capability.

## Windows

Copy `src-tauri/platform/sockscap/windows/release-manifest.template.json` into a
release staging directory and fill it with paths, SHA-256 pins, exact signer
subjects, and the Windows capture provider selected by the amended ADR.

```powershell
pwsh scripts/sockscap/verify-windows-release.ps1 `
  -ManifestPath path/to/windows-release-manifest.json |
  Tee-Object -FilePath path/to/evidence/artifact-gate.json
```

The verifier requires a timestamped, valid Authenticode chain for Taomni, the
privileged helper, Wintun, and the user-mode provider. Kernel binaries are also
checked with SignTool's kernel policy. A WFP package must provide a signed
catalog and matching INF; a WinDivert package must provide its license and an
embedded release-signed driver. `captureReleaseEnabled=false` or an unselected
WinDivert/WFP provider always blocks release verification.

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
Developer ID authorities, signed entitlements, provisioning profiles,
architectures, Gatekeeper assessment, and stapled notarization ticket. The
template is disabled so it cannot be mistaken for release evidence.

Static template checks can run on a non-release host:

```bash
bash scripts/sockscap/verify-macos-release.sh --lint \
  src-tauri/platform/sockscap/macos/release-manifest.template.json
```

Neither verifier obtains certificates, Apple managed capabilities, Microsoft
driver signatures, or lab evidence. Those are external release inputs, and the
gate remains red until the real artifacts are supplied.

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
same-host Windows/macOS verifier, never its lint output. A Linux packaging
pipeline must emit an equivalent PASS receipt containing the exact
architecture/provider, installed app/helper/policy paths, and true package
signature, root-helper ownership, and helper-policy checks.
`evidence.nativeSmoke` must point to the `qa-ui-auto.summary.v1` JSON from a
native-mode run containing a passing `TC-SOCKSCAP-native-window-smoke`; a
browser or dry-run summary is rejected.

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
