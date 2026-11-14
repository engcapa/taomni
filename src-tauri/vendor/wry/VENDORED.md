# Wry 0.57.0: Windows main-frame initialization isolation

Upstream package: `wry` **0.57.0**, crates.io.

- Original `.crate` SHA-256: `a819957a01b3119af85e638a38d242af76dbc87d130dca67bfd0441072e21ff0` (matches the pre-patch application Cargo.lock).
- Upstream revision: see the unchanged `.cargo_vcs_info.json`.
- Upstream licenses: unchanged `LICENSE-APACHE`, `LICENSE-MIT`, `LICENSE.spdx`.
- Retained upstream files: all 45 files under `src/` for Windows, Apple, GTK and Android, plus Cargo manifests, build.rs, README, licenses and revision metadata: **53 files / 528,394 bytes** before this patch.
- Omitted: examples, upstream changelog, upstream Cargo.lock, registry/cache markers and repository tooling. They are not application compilation inputs. The unchanged normalized manifest still lists upstream example targets; this application consumes the library only.

## Local patch

Windows Wry 0.57.0 passed every initialization script to WebView2's `AddScriptToExecuteOnDocumentCreated`, ignoring `InitializationScript::for_main_frame_only`. The native Windows HTML QA artifact in run `43526262110` observed `HTML_QA IPC_GLOBAL object` inside an opaque `taomni-preview` iframe. Parent-origin and network policy restrictions worked, but they did not meet the requirement that untrusted preview content receive no Tauri initialization or invoke credential.

The patch is intentionally confined to Windows document-created script generation:

1. `src/webview2/initialization.rs` owns a small tested `for_frame` function. Main-only scripts are wrapped by `if (window.top === window) { ... }` **before any original script body executes**. Scripts intentionally marked all-frame remain byte-identical.
2. `src/webview2/mod.rs` uses that function for caller initialization scripts and for the Wry IPC bootstrap itself. This matches GTK/macOS's existing main-frame-only IPC bootstrap behavior. Detached application WebViews remain top-level and keep their normal initialization.
3. The public API's Windows limitation comments in `src/lib.rs` describe the new guard rather than promising a native WebView2 per-frame API.

The boundary is engine-owned `WindowProxy` identity, not a URL, token, author-controlled variable or a post-load deletion. An opaque child cannot set `window.top` to itself. Explicit all-frame library scripts are not disabled, and no new frontend/native permission is granted. The WebView2-provided `chrome.webview` primitive may exist in frames; without the bootstrap/initialization the preview does not receive Taomni's invoke key or native API.

## Validation and follow-up boundary

`src-tauri/src/viewer/tests/windows_initialization.rs` imports the exact small script generator and executes generated scripts in Node VM contexts for main frame, opaque child, preserved all-frame intent and IPC bootstrap. This is deterministic source/script validation, **not a substitute for WebView2**. Run the normal Rust viewer unit filter and the script generator's focused tests.

The real Windows `TC-FILE-OPEN-009` must still require `HTML_QA IPC_GLOBAL undefined` and must re-run with this exact binary. Its author script and independent origin/proxy logs also protect local assets, default denial and proxy selection. Do not relax that assertion to accommodate the old runtime. Full native/browser/crash gates belong to the candidate release workflow after the Cargo.lock change.

Keep the patch isolated when updating Wry; remove it only after upstream main-frame initialization and IPC bootstrap provide equivalent behavior verified by the same native case. Third-party source remains under the existing vendor boundary; the new hand-maintained helper/tests are small and no product source-size exception is added.
