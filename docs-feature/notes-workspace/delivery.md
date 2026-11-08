# Notes Workspace delivery

Implementation baseline: `1baeb208e`. Branch: `feat/notes-workspace-and-windows-caret`. Current implementation/QA commit: `48521c61b3cc99b1039205edb5d7ef5459f0d9d6`.

## Resulting behavior

The protected default Notes space references stable note IDs in the existing `notes.db`, shares title/body drafts with Tao Notes, and uses the normal Workspace CodeMirror editor and Markdown preview. Search, refresh, creation, multiple tabs, edit/split/preview and explicit Save are available. Compact Tao Notes editing remains available; large Preview opens the same note in Workspace, including from a real detached Notes window. Returning to Tao Notes opens the corresponding note.

Content saves use an atomic SQLite comparison against the actual previous title/body, preserving task metadata, steps, tags and reminders. Per-note saves are serialized and flush typing that continues during an earlier save. Closing a tab or switching spaces retains recovery drafts. Independent main/floating journals and cross-window notifications preserve conflicting drafts until explicit retry or confirmed reload. No physical `.md` files, data migration, network access or new dependencies are introduced.

Focused linked fields now draw text, selection and caret through their actual input/textarea. The decorative URL overlay is hidden during editing and restored on blur. Source inspection establishes a competing-layout defect; physical Windows 11 font/DPI and IME behavior remains unverified.

## Local and contract evidence

- 67 focused feature tests passed across shared drafts, pending saves, conflict/storage handling, recovery, protected Notes space, existing Notes/Workspace behavior, Save Action/menu ownership and platform entry routing.
- 20 QA keyboard/default-action and real CodeMirror translation tests passed after the macOS bridge correction. These cover input/textarea caret insertion, range collapse/extension, surrogate movement, canceled keydown and disabled inputs.
- Real SQLite: `cargo test --manifest-path src-tauri/Cargo.toml --lib notes::db -- --nocapture` passed all 16 tests, including three new content-save regressions. Log: `qa-ui-auto-report/_local/notes-rust-tests.log`.
- TypeScript, `pnpm build`, `pnpm check:refactor`, Rust formatting and the QA catalog gate passed. No coverage baseline was changed; four existing control orphans remain. Development case contract sees the product change and four executable QA cases. Existing bundle-size warnings remain.
- The complete hosted frontend gate on `6decbd3a8` passed 6,375 tests with one existing skip. The `48521c61b` gate passed 6,380 tests with one existing skip (700 test files). Raw log: `qa-ui-auto-report/github/42503054521/job-128800195412.log`.
- Current hosted Workspace/Mobile native Rust contracts passed 97/97 in job `128800195374`. RDP contracts are outside this selection and are not claimed.
- Local browser `notes-browser-verified/run-20261109-000533-195724834`: 6/6 passed. After the QA synchronization correction, `notes-browser-followup/run-20261109-010043-682163926`: 2/2 passed with stable inputs. These are supplementary to the hosted runs below.

## Current hosted validation

Workflow: `.github/workflows/qa-ui-auto-platforms.yml`. Run [42503054521](https://github.com/engcapa/taomni/actions/runs/42503054521) is fixed to `48521c61b3cc99b1039205edb5d7ef5459f0d9d6`, using browser/native and `native_release=true`, with issue publication disabled.

Selection includes Notes 001–004 and 008–011 as applicable to each mode/platform, plus the complete `crash-regression` tag. It has 15 execution entries: 45 browser and 40 native executions, with no selection gaps or unreviewed cases. Each browser platform has six Notes cases and nine crash regressions. Native has three Notes cases and ten crash regressions per platform, plus macOS AppKit case 011.

| Hosted platform | Browser | Release native |
| --- | --- | --- |
| Ubuntu 24.04 X64 / Xvfb | 15/15 passed | Pending; 13 selected |
| Windows Server 2025 X64 / WebView2 | 15/15 passed | Pending; 13 selected |
| macOS 15 ARM64 / WKWebView | 15/15 passed | 12 passed / 2 QA failures; corrected rerun pending |

Current source SHA-256: `fa28f0d3066d520948c9b7f1bb7fa01dd14ba2718d6fcbdd99cf266aa94e7b78`. Browser and all macOS native reports have stable identities. The macOS reports identify `com.taomni.app.qa`, profile `release`, with the same build-source hash. Completed macOS cases include 008 (focused caret editing) and 011 (actual AppKit Save availability/activation and persisted content).

Raw artifacts, receipts and selection are retained under `qa-ui-auto-report/github/42503054521/`. Final acceptance still requires the remaining native results, corrected cases 009/010 and aggregate receipt verification. Successful report-upload jobs alone are not case passes.

The current three-platform browser screenshots from TC-NOTES-009 were visually inspected at 1440×900: sidebar, active tab, mode/save/return controls and Markdown content align; long tab titles use ellipsis. The macOS 011 native screenshot was also inspected and shows the saved content in both Workspace and compact Tao Notes. These screenshots do not establish physical input or native window-frame compatibility.

## Acceptance mapping

| Acceptance | Evidence |
| --- | --- |
| AC-01: focused text/caret and retained Notes editing | Notes unit regressions, browser 001–004/008 and current macOS native 008; physical Win11 checks below remain open |
| AC-02: metadata-preserving content saves and recoverable conflicts | Shared-store tests, 16 real-SQLite tests; Linux native 010 passed on `6decbd3a8`; current native rerun pending |
| AC-03: default Notes browsing, stable tabs, Preview/return, recovery | Workspace unit tests and hosted browser 009 on all platforms; current native 009 pending |
| AC-04: actual floating window, navigation, cross-window refresh | Linux native 010 on `6decbd3a8` passed through conflict preservation, confirmed reload, clean refresh and docking; final matching-source rerun pending |
| AC-05: branch, detailed English commits and hosted regression selection | Branch pushed; final hosted aggregate pending |
| macOS Save Action and installed native menu | Mounted ownership tests and current native 011 passed; physical Cmd+S/menu-bar clicking remains outside the bridge |

## Diagnostic history retained

- Stable old-source caret probe: `qa-ui-auto-report/notes-caret-baseline-clean/run-20261109-000107-077732595`, source SHA-256 `fdff839bf8ab0e0f267a7cc10438f461d82a1b96e871821acb402b7e1a9c37fc`. Step 7 failed because the URL title overlay remained visible while the input owned focus. The baseline is an independent archive of `1baeb208e`, with an isolated Vite cache setting and the regression probe added. It proves the competing rendering, not physical Win11 reproduction.
- Earlier probe `notes-caret-baseline/run-20261108-233015-647897228` changed source during execution and is invalid evidence.
- Browser candidates exposed a reload-navigation assumption (startup intentionally opens Home), then an unscoped selector selecting a mounted background document. The cases now enter Workspace after reload and target `data-active`; inactive documents carry `aria-hidden`. The Notes tab-close control's catalog ownership was added without hiding existing catalog gaps.
- Run `42498424608` on `1a3c0cbb0` was cancelled before accepting evidence. Restoring the main window from floating Notes required `core:window:allow-unminimize`, added in `00f6c47a8` within the existing window scope.
- Run [42498592710](https://github.com/engcapa/taomni/actions/runs/42498592710) on `00f6c47a8`: browser 45/45 passed. The full frontend gate found three assertions counting only one system workspace; `6decbd3a8` now asserts ordered Default/Notes/project IDs while retaining reuse/deduplication checks. Linux native was blocked by that gate. Windows native 009 also had a setup timeout before any test step (`document root is not mounted`); this is preserved as a failure, not a Notes behavior pass.
- Native reports from that run exposed two QA defects. WKWebView untrusted ArrowLeft events lacked the browser input-selection default, so typing appended at the end; the opt-in bridge now applies supported selection defaults while respecting cancellation and ownership. Notes 009/010/011 also read the asynchronous pinned state too early: failure HTML already contained `aria-pressed="true"` after the assertion read `false`. Checkpoints now wait for the same required state, retaining metadata/content expectations. Commit `48521c61b` includes these corrections and their focused verification.
- Run [42500544064](https://github.com/engcapa/taomni/actions/runs/42500544064) on `6decbd3a8`: Linux browser 15/15, release native 12/13; only 009 failed at the old immediate pinned checkpoint. All ten Linux native crash regressions and floating conflict case 010 passed; aggregate had no infrastructure errors. Run [42501348112](https://github.com/engcapa/taomni/actions/runs/42501348112) is the corresponding Windows/macOS attempt before the QA correction; its original reports are preserved and superseded for the modified cases.

Current macOS native follow-up on `48521c61b` passed 12/14, including every crash regression, caret case 008 and AppKit case 011. Case 010 reached the real cross-window conflict but checked it before the notification arrived; its failure screenshot/HTML contains the correct conflict alert and intact main draft. Its checkpoint now waits for that same conflict state. Case 009 passed save/return and close/reopen recovery, then tried to refresh a hidden sidebar. Investigation established that native `open` is a no-op: the case had not reloaded, and clicking the already-selected Workspace rail collapsed the sidebar. Step 38 now uses the existing cross-platform `reload_window` action, so native recovery is exercised and the following Workspace navigation starts from the actual fresh Home state. Creation checkpoints also wait for the exact two/three-tab counts and the new tab's note kind. Browser case 009 passed after the actual reload and readiness corrections in `qa-ui-auto-report/notes-reload-browser-checked/`. This is a case correction with unchanged product/runner source identity; cases 009/010 require new execution evidence.

## Platform limits

Hosted Windows Server 2025/WebView2 does not certify physical Windows 11 display scaling, font fallback or input methods. Manual Win11 checks remain open at 100/125/150/200% scaling, including mixed Chinese/Latin text, wrapping, horizontal/vertical scrolling, selection and IME composition. See [caret fix design](../../docs-issue/notes-windows-caret-design.md).

The native runner establishes packaged WebView/Rust boundaries. WKWebView constructed keys and direct AppKit activation do not prove physical OS shortcut delivery, menu-bar pointer clicks or native window controls. macOS versions/architectures beyond hosted macOS 15 ARM64 remain untested. No matched performance claim is made.
