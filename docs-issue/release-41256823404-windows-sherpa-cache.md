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

Both release builders run `scripts/refresh-sherpa-onnx-cache.mjs` immediately after Rust cache restoration. The script asks Cargo for the actual target directory, cleans only `sherpa-onnx-sys`, and removes its dedicated prebuilt cache. The next build extracts complete native libraries and restores Windows runtime DLLs beside executables. Other Cargo dependency artifacts remain reusable.

This also handles cold caches and custom `CARGO_TARGET_DIR` paths. Linux and macOS share the same upstream prebuilt cache layout and receive the same refresh. Each release job may download sherpa's archive again; this intentionally trades that small download for reliable native artifacts without vendoring the upstream build system.

## Validation

Windows 11, MSVC 2022, Rust 1.96.0:

```powershell
$env:TAOMNI_SHERPA_NATIVE_TEST = '1'
$env:TAOMNI_SHERPA_TEST_ARCHIVE_DIR = (Resolve-Path src-tauri/target/sherpa-onnx-prebuilt).Path
node --test scripts/sherpa-onnx-cache.test.mjs
corepack pnpm@10 check:refactor
git diff --check
```

The native regression uses the real pinned upstream archive and an isolated Cargo package with a custom target path containing spaces. It checks a cold refresh, compiles and links sherpa, simulates cache pruning, reproduces the exact `LNK1181`, refreshes and rebuilds, then runs the executable with the four restored runtime DLLs in a separate payload directory. The API returns version 1.13.8. Workflow contracts cover refresh placement in both release jobs.

No product UI or runtime feature code changes. Full installer packaging and hosted Linux/macOS builds are outside this local regression's evidence.
