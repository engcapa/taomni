# Release 41256823404: Windows sherpa native cache failure

## Evidence and cause

- Run: https://github.com/engcapa/taomni/actions/runs/41256823404
- Windows job: https://github.com/engcapa/taomni/actions/runs/41256823404/job/124715303892
- Release commit: `d23c199a7760c12158c53859d7e28264fe2f1efd` (`v0.5.4`).
- Failed step: `Verify Windows SocksCap helper and preflight`, before desktop bundle creation.
- Fatal diagnostic: `LINK : fatal error LNK1181: cannot open input file 'sherpa-onnx-c-api.lib'`.
- The linker searched `src-tauri/target/sherpa-onnx-prebuilt/sherpa-onnx-v1.13.8-win-x64-shared-MT-Release-lib/lib`.
- Rust cache `v0-rust-build-Windows_NT-x64-e70cdc14-1e03989e` restored with a full match; `sherpa-onnx-sys` did not rebuild.

`Swatinem/rust-cache` recursively removes files from non-profile target directories while retaining dependency build artifacts and fingerprints. Thus sherpa's prebuilt directory is restored as empty directories, while Cargo reuses its previous successful build-script output. The import library no longer exists. Profile-root runtime DLLs are also pruned, so repairing only the linker search path would be insufficient.

Upstream sherpa-onnx-sys 1.13.8's `download_prebuilt_libs` treats the existence of `lib/` as a complete extraction. Re-running its build script alone would still skip downloading an empty restored directory.

## Fix

Both release builders run `scripts/refresh-sherpa-onnx-cache.mjs` immediately after Rust cache restoration. The script asks Cargo for the actual target directory, cleans only `sherpa-onnx-sys` in both dev and release profiles, and removes its dedicated prebuilt cache. The macOS builder also passes both explicit architecture triples for cleaning. The next build extracts complete native libraries and restores Windows runtime DLLs beside executables. Other Cargo dependency artifacts remain reusable.

This also handles cold caches and custom `CARGO_TARGET_DIR` paths. Linux and macOS share the same upstream prebuilt cache layout and receive the same refresh. Each release job may download sherpa's archive again; this intentionally trades that small download for reliable native artifacts without vendoring the upstream build system.

## Follow-up: release 41264427374

- Windows job: https://github.com/engcapa/taomni/actions/runs/41264427374/job/124724445630
- Release commit: `4d6f5dad8ef1c36846c37d042425df7ab5b236a9`, including the initial cache fix.
- The helper preflight passed all 37 tests and the release application linked successfully.
- NSIS packaging failed: `File: "D:\a\taomni\taomni\src-tauri\target\release\sherpa-onnx-c-api.dll" -> no files found.`

The initial fix used `cargo clean --package sherpa-onnx-sys` without selecting a profile. Package-scoped cleaning defaults to dev, leaving release build-script fingerprints intact. The debug helper repopulated the shared prebuilt import libraries, so release linking succeeded using those libraries, but its cached build script never restored the release runtime DLLs. The original regression exercised only debug, so it missed this sequence.

The updated regression first warms both profiles, removes native payloads and both profiles' DLLs, then runs the refresh and debug-to-release build sequence. Before the follow-up fix it reproduced the missing release DLL despite a successful release link. Explicit `--profile dev` and `--profile release` cleaning resolves it. Optional target triples also invalidate cross-compilation state rather than just host state.

## Validation

Windows 11, MSVC 2022, Rust 1.96.0:

```powershell
$env:TAOMNI_SHERPA_NATIVE_TEST = '1'
$env:TAOMNI_REQUIRE_NSIS_TESTS = '1'
$env:TAOMNI_SHERPA_TEST_ARCHIVE_DIR = (Resolve-Path src-tauri/target/sherpa-onnx-prebuilt).Path
node --test scripts/sherpa-onnx-cache.test.mjs scripts/windows-runtime-bundle.test.mjs scripts/resolve-release-build.test.mjs
corepack pnpm@10 check:refactor
git diff --check
```

All 15 tests pass without skips. The native regression uses the real pinned upstream archive and isolated Cargo packages with custom target paths containing spaces. It checks both host and explicit `x86_64-pc-windows-msvc` builds, cold refreshes, warming both profiles, cache pruning, the original `LNK1181`, and debug/release recovery. Both profiles' executables load the four restored DLLs from separate payload directories and return version 1.13.8. The real production NSIS hook packages each recovered release probe; silent installation, running the installed probe, and uninstallation succeed. Existing NSIS tests also cover overwrites, slash variants, and rejection of each missing DLL. Workflow contracts cover refresh placement, macOS target selection, and mandatory Windows native regressions.

The release workflow now runs the native cache recovery tests alongside installer verification with `TAOMNI_SHERPA_NATIVE_TEST=1` and `TAOMNI_REQUIRE_NSIS_TESTS=1`, using its already downloaded sherpa archive.

No product UI or runtime feature code changes. An additional full local application bundle attempt stopped at WinDivert provisioning: Windows protection rejected the downloaded official archive as a virus or potentially unwanted application. Protection settings were not changed. Thus full application NSIS/MSI packaging and hosted platform builds remain outside the completed local evidence; the real NSIS probe installers and production hook were verified independently.
