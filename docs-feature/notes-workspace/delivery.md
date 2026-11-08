# Notes Workspace delivery

Implementation baseline: `1baeb208e`. Branch: `feat/notes-workspace-and-windows-caret`.

The built-in Notes space uses stable note IDs backed by the existing `notes.db`. It shares title/body drafts with Tao Notes, reuses the Workspace Markdown editor/preview, and keeps task metadata in the original model. No physical `.md` files or data migration are introduced. Compact editing remains available; the large Preview opens the main Workspace, including from a real detached Notes window.

Focused linked fields now render glyphs, selection and caret through their actual input/textarea. The URL overlay is hidden while editing and restored on blur. Source inspection establishes a competing-layout defect; the Windows 11 font/DPI contribution remains an inference requiring physical-device confirmation.

## Evidence collected locally

- 39 focused tests passed across shared drafts, pending saves, storage/conflict handling, independent recovery journals, protected Notes space, existing Notes component behavior and Workspace shell shortcuts.
- A further 22 tests passed for live Notes Save Action/menu ownership, existing note URL/store behavior, main-menu routing and Workspace command registration.
- TypeScript, `pnpm build`, `pnpm check:refactor`, and Rust formatting passed. Build output retains the repository's existing bundle-size warnings.
- Old-source browser probe: `qa-ui-auto-report/notes-caret-baseline-clean/run-20261109-000107-077732595`. Identity stable; source SHA-256 `fdff839bf8ab0e0f267a7cc10438f461d82a1b96e871821acb402b7e1a9c37fc`. Step 7 failed because the URL title overlay remained visible while the input owned focus. Baseline is an independent archive of `1baeb208e`, with only an isolated Vite cache setting and the new regression probe added. This establishes the dual-layer rendering behavior, not physical Win11 DPI/IME reproduction.
- Earlier baseline attempt `notes-caret-baseline/run-20261108-233015-647897228` is invalid because source changed during execution. It is not used as evidence.
- Workspace candidate `notes-workspace-candidate/run-20261108-235811-921660946` passed the main edit/save/return and close/reopen flows, then failed because the case assumed reload restored navigation mode. Existing app startup intentionally opens Home; the case now enters Workspace explicitly before checking recovery.
- The next candidate exposed an unscoped selector selecting the first background document when multiple note tabs were mounted. Cases now target the active document, which also carries `aria-hidden` for background panes.
- QA catalog gate initially found one new orphan, the Notes tab close button; its ownership/selector was added. Other reported catalog gaps predate this change and are not suppressed or ratcheted away.

Final current-source browser, Rust and GitHub results will be appended after execution. A dry-run is a schema/verb check, not native runtime evidence.

## Required hosted execution

Run `.github/workflows/qa-ui-auto-platforms.yml` on this branch with selected Notes 001–004, 008–011 plus the complete `crash-regression` tag, platforms `linux,windows,macos`, modes `browser,native`, and `native_release=true`. Do not publish issues. Inspect the aggregate summary and original receipts, including identity stability and selected/pass/fail/skip counts.

## Platform limits

Hosted Windows uses Server 2025/WebView2; it does not certify physical Windows 11 display scaling, input methods or font fallback. Manual Win11 checks at 100/125/150/200% scaling remain open. The native runner proves packaged WebView/Rust boundaries. Its key events and direct AppKit activation do not prove physical OS shortcut delivery or menu-bar pointer clicks. macOS versions/architectures outside the hosted macOS 15 ARM64 target remain untested.

Current browser evidence: `qa-ui-auto-report/notes-browser-verified/run-20261109-000533-195724834`; 6 selected / 6 passed / 0 failed / 0 skipped; identity stable, source SHA-256 `abd35456f88576392869c6e1d269d6b4dfdf310d347ff22dda4b007c147e99d6`. TC-NOTES-001–004 preserve original workflows; 008 verifies focused text/keyboard insertion; 009 verifies edit/preview/return, pinned metadata, close/reopen/reload recovery, search, both creation entries and stable multi-tab selection. The final 009 screenshot was inspected: Notes sidebar, three tabs and the corresponding Markdown preview render without overlap or truncation at 1440×900.

Rust: `cargo test --manifest-path src-tauri/Cargo.toml --lib notes::db -- --nocapture` passed all 16 tests, including the three new real-SQLite content-save regressions. Raw log: `qa-ui-auto-report/_local/notes-rust-tests.log`.
