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
  -ManifestPath path/to/windows-release-manifest.json
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
  path/to/macos-release-manifest.json
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
