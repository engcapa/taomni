# Screenshot enhancement QA handoff

Branch: `feat/screenshot-complete`

Implementation stage commit: `7ed6fca6` (`feat(screenshot): complete cross-platform capture editing workflow`).
The next stage contains only native QA scenario registration and testcase/handoff documentation.

## Local validation completed

- `node node_modules/typescript/bin/tsc -b --pretty false` — passed.
- Vite production build — passed. Bundled assets are under `dist/screenshot-ocr/`:
  worker, LSTM scalar/SIMD cores, English and Simplified Chinese models, and license files.
- Focused screenshot frontend tests — **141 passed / 11 files**.
- `cargo check --manifest-path src-tauri/Cargo.toml --lib` — passed; repository emitted existing warnings only.
- Screenshot Rust unit tests — **74 passed**.
- Browser/native QA UI cases were **not executed**, per request.

## Browser cases to run

| Case | Scope | Expected coverage |
|---|---|---|
| `TC-SHOT-035-solid-partial-erase.testcase.yaml` | Browser + native companion | Filled rectangle, filled ellipse, filled closed freehand, Shift-constrained geometry, partial eraser keeps the parent stroke, object-erasing compatibility. |
| `TC-SHOT-036-watermark-editor-pin-board.testcase.yaml` | Browser | Full-image scattered watermark controls, in-place rotate + image undo/redo, external editor handoff, pin note and batch actions. |
| Existing `TC-SHOT-007`, `TC-SHOT-014`, `TC-SHOT-017`, `TC-SHOT-021`, `TC-SHOT-023`, `TC-SHOT-028`, `TC-SHOT-030`, `TC-SHOT-031`, `TC-SHOT-032`, `TC-SHOT-033` | Browser regression | Existing annotation, OCR/redaction, watermark panel, scroll, pin, and responsive toolbar behavior. Recheck because the toolbar now has a `More tools` row and scroll capture has an explicit planning step. |

Recommended browser order: 035 → 036 → existing OCR/watermark cases → existing scroll cases → existing pin cases.

## Native cases to run

| Case | Platforms | Expected coverage |
|---|---|---|
| `TC-SHOT-N20-pin-arrangement-wayland.testcase.yaml` | Linux X11/Wayland, Windows, macOS | Native notes, independent pin originals, arrange/tile/cascade/edge behavior; Wayland switches to the combined board because arbitrary top-level positioning is compositor-controlled. |
| `TC-SHOT-N21-scroll-auto-target-activation.testcase.yaml` | Linux X11/Wayland, Windows, macOS | Windows target activation before wheel injection; Linux X11 native wheel; Wayland RemoteDesktop portal input sharing; macOS Accessibility permission path. |
| Existing `TC-SHOT-N17-pin-tools-favorites.testcase.yaml` | Linux/Windows/macOS | Pin topmost, drag, opacity, collapse, copy/save, favorites. Re-run with note/event changes. |
| Existing `TC-SHOT-N2`, `TC-SHOT-N9`, `TC-SHOT-N16`, `TC-SHOT-N15`, `TC-SHOT-N19` | Linux X11/Wayland, macOS as applicable | Scroll output, content pixels, manual mode, permission failure and recovery. Re-run after auto-input and hide barrier changes. |
| Existing `TC-SHOT-N3`, `TC-SHOT-N10`, `TC-SHOT-N11`, `TC-SHOT-N12`, `TC-SHOT-N13`, `TC-SHOT-N14` | Native platform matrix | Capture fidelity, freehand alpha, controls, full-display behavior, macOS source and native overlay regression. |

### Native platform notes

- **Windows:** Check the scrolling fixture is the foreground target before each synthesized wheel. Elevated target windows may reject activation/input; the UI reports this and allows manual takeover instead of silently producing a one-screen result.
- **Linux X11:** Check border/control geometry and X11 topmost evidence. Automatic scroll uses X11 input synthesis.
- **Linux Wayland:** Check portal consent for both ScreenCast and RemoteDesktop. The capture surface is a fullscreen transparent GTK/WebKit surface whose input shape is limited to the bottom control strip; pins use a combined board because Wayland does not guarantee arbitrary window positioning.
- **macOS:** Check Screen Recording and Accessibility permission paths; Vision OCR should not require Tesseract.

## Changed native QA registration

- Added `screenshot_qa_annotation_tools` to the isolated QA command list.
- Added `annotation-tools` to `screenshot_scenarios.py` and the testcase schema enum.
- Added `TC-SHOT-N20` and `TC-SHOT-N21` as downstream native platform cases.

## Feature-to-testcase map

- Solid shapes / Shift constrain / partial eraser: `TC-SHOT-035`, native `annotation-tools` scenario, existing `TC-SHOT-014`.
- Large/full-screen scroll planning and controls: existing `TC-SHOT-003`, `027`, `031`; native `N2`, `N9`, `N16`, `N21`.
- Scattered watermark and offline OCR: existing `TC-SHOT-017`, `021`, `023`; native `TC-SHOT-N3` / `N10` plus a future native OCR run if language-pack fixtures are available.
- Pin note / arrangements / batch actions / Wayland board: `TC-SHOT-036`, `TC-SHOT-N20`, existing `TC-SHOT-033`, `TC-SHOT-N17`.
- In-place editor / external editor: `TC-SHOT-036`; native downstream check should verify the copied working file opens in the platform image app and that the pin remains independent.
- Linux compositor hide barrier: existing native capture/scroll/record cases (`N1`, `N2`, `N5`–`N9`, `N12`, `N13`, `N16`).

## Known local-only limitations

- No browser/native QA case was run in this development session.
- Rust was compiled on Windows only; macOS Vision and Linux GTK/portal code was type-checked by shared APIs and guarded platform code, but needs the corresponding hosted native matrix.
- Existing repository warnings (unrelated unused/deprecated code) remain; `cargo check` had no errors.
- Offline Tesseract WASM is deliberately same-origin and bundled. CSP explicitly allows `wasm-unsafe-eval` only for WebAssembly; no ordinary JavaScript eval or external OCR CDN is enabled.
