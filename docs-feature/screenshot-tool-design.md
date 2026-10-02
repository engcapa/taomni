# Screenshot and Screen Recording

Branch: `feat/screenshot-tool`. System screenshot/recording is independent of the terminal-tab renderer capture. Windows, macOS and Linux desktop compatibility is required; browser mode verifies renderer contracts only.

## Current architecture

- `src-tauri/src/screenshot/mod.rs`: commands, overlay/recorder/pin state, hidden-window restoration, output actions and raw binary artifact transport.
- `capture.rs`: Tauri physical monitor enumeration, capture/crop/mapping, BGRA-stride conversion and process-owned temporary artifacts.
- `record.rs`: persistent screen source, bounded capture/encode queue, real timestamps, built-in GIF/OpenH264/MP4 encoding. No system ffmpeg requirement.
- `scroll.rs`: OS wheel injection and consecutive-frame overlap matching, retaining sticky header/footer once.
- `ocr.rs`: optional Tesseract process, English/Chinese language fallback, TSV word/line boxes and sensitive-token detection.
- `shortcut.rs`: configurable OS-global shortcut, persisted registration status and conflict handling.
- `qa.rs`: fixed scenario commands guarded by debug mode and the isolated `com.taomni.app.qa` identifier.
- React overlay, annotation canvas, recorder and pin render in separate labeled native windows. Browser stubs route by hash without claiming native effects.

### Shared RDP capture implementation

Recording owns `servers::rdp::capture::Capturer` on the capture thread: Windows WGC/GDI, macOS ScreenCaptureKit/legacy capture and Linux X11/portal capture remain behind their platform gates. Backends are thread-affine and must not be moved across threads. Frames carry BGRA bytes and explicit stride; macOS surfaces may be copied lazily. Still capture on Windows/macOS uses the existing xcap path; Linux uses the shared capturer.

Do not use an RDP server connection, network loopback or its transport/encoder for screenshots. No merge from `origin/feat/rdp-server-parity` is required for this reuse. Future shared-capture changes must retain both consumers.

### Coordinates and artifacts

Display IDs derive from physical desktop origin. Selection/annotation use CSS coordinates; independent `naturalWidth / viewportWidth` and `naturalHeight / viewportHeight` map export, crop and mosaic/blur sampling to physical pixels. Crop edges are rounded and clamped. Native fixture checks verify physical dimensions and row heights.

Artifacts live under the current process's `temp_dir()/taomni-screenshot/<pid>/`. Read/copy/OCR/record preview source paths are canonicalized and confined there. `screenshot_read_file` returns raw IPC bytes; the frontend creates same-origin blob URLs, avoiding asset-scope failures and canvas taint. Blob URLs have explicit ownership and teardown. Capture/record outputs are purged at session close; pins use independent copies removed on window destruction. User-selected saved files and QA evidence copies outlive session cleanup.

### Session lifecycle

Opening is serialized and repeated triggers focus the existing overlay or recorder, including the stopped preview. Capture hides only currently visible app windows, merges their labels and restores them on failure or close. Screenshot tool/QA fixture windows are excluded. A generation check cancels stale opens/record starts. Native tool-window destruction restores the app through off-event-loop cleanup.

Recording has an exclusive lease spanning startup, live capture and finalization; timeout cleanup retains it until worker threads exit. Invalid partial region payloads are rejected rather than accidentally recording the entire screen. A capture failure is an error even when encoding produced a partial file; failed output is deleted. Stop/cancel cannot clear another recording's state.

## User workflows

- Camera button: immediate capture or delayed 3/5/10 second entry with cancellation.
- Default OS shortcut: `Control+Alt+A` on Windows/Linux, `Control+Super+A` on macOS. Settings allow change/reset/disable and show registration/probe errors. Native focused-app fallback runs only if OS registration failed; browser mode uses that fallback. Editable fields retain keystrokes, and child tool windows do not reopen the tool. The old Ctrl+Shift+A conflict with Code Workspace Find Action is removed.
- Region or fullscreen selection defaults to selection mode. Choose drawing tools explicitly. Handles move/resize the crop while preserving shapes; selecting elsewhere resets the crop/history. Tiny selections are ignored.
- Tools: rectangle, ellipse, arrow, line, pen, highlighter, text, balloon, mosaic, blur, numbered markers and eraser. Snapshot history supports undo/redo, batch auto-redaction and undoable erasing. Text editor owns Enter/Escape rather than invoking output shortcuts.
- Copy/save/pin export natural-size annotations plus selected crop/watermark. Failed output remains retryable; canceled save dialog leaves the overlay open. Picker copies a sampled color. OCR offers text/copy; auto-redaction adds detected boxes in one history step. Automatic detection is not a guarantee that every secret was found: users must inspect the result.
- Scroll: hide overlay, move pointer to the selection and inject wheel, capture/stitch, then replace background and clear stale annotations. Matching compares consecutive frames, not a growing stitched image. Lost overlap is not passed as a duplicated long screenshot.
- Recorder: timer, stop/cancel; stopped GIF or MP4 preview includes actual dimensions/frame count/duration. Save/Done restore the app; GIF copy deliberately copies its first frame because the clipboard has no animated-image contract.

## Recording contract

| Format | Default fps | Maximum time | Width cap | Encoding |
|---|---:|---:|---:|---|
| GIF | 10 | 60 s | 960 px | `gif` crate, timestamp-derived centiseconds, infinite loop |
| MP4 | 15 | 300 s | 1920 px | Built-in OpenH264 screen-content H264 + `mp4` muxer, timescale 1000 |

FPS is clamped to 1–30, output is even-sized and at least 2x2. Capture and encoding are separate threads with a bounded four-frame queue. Accepted frames alone update dedup state; a pending changed image survives backpressure, is retried during idle capture and is flushed before the end timestamp. Unchanged pixels extend prior duration rather than distort wall-clock playback. SPS/PPS and length-prefixed H264 samples form a valid AVC track.

Main IPC payloads use camelCase. Displays include `scaleFactor`; recordings return `path,width,height,frames,durationMs`; probe returns `permission,controlPermission,mp4Available,ocrAvailable,summary`; shortcut status includes configured/default accelerator, enabled/registered/error.

## Acceptance and verification mapping

| Acceptance | Implementation | Executable evidence |
|---|---|---|
| AC-01 Real full/region pixels and correct physical size | capture/raw blob transport | TC-SHOT-N1, N10; screenshot geometry/unit tests |
| AC-02 Selection, all annotations, undo/redo and recrop | Overlay/AnnotationCanvas | TC-SHOT-001–017, 021; mounted overlay/annotation tests; N3 native clipboard |
| AC-03 Copy/save/pin/cleanup and restored main | mod.rs/PinnedImage | TC-SHOT-002, 005, 019; N3/N4 and native saved bytes/pin cleanup |
| AC-04 Full original long-page content without gaps/duplication/reordering/squashing | scroll.rs + qa_oracle | N2/N9 actual OS wheel + complete original-pixel/24x24 tile comparison and row oracle; corrupted-page rejection unit tests |
| AC-05 GIF/MP4 records the actual original scene, state order/timing and native playback | record.rs/RecorderBar + qa_oracle | N5–N8 every decoded frame versus actual saved source PNG/id/nonce/timeline; unrelated multi-frame GIF/MP4 negative tests; real WebView playback |
| AC-06 Shortcut configuration/disable and safe routing | shortcut/settings/app fallback | TC-SHOT-004/011/018; N4 real OS injection; settings/shortcut tests |
| AC-07 OCR and batch redaction | ocr.rs/overlay | TC-SHOT-017 renderer stub; N1 real Tesseract and clipboard pixels; OCR unit regressions |

Native test commands use a fixed `native_screenshot_scenario` verb, never side-effecting `eval_readonly`. Async IPC settles into a slot before synchronous WebDriver reads, including the macOS WKWebView bridge. Native scenarios automate child-window DOM interaction, not physical pointer fidelity; scroll/hotkey inject actual OS input. A successful scenario requires its stated postconditions and retained files, not a signature/header check or synthetic injected recording frame.

Hosted workflow: `.github/workflows/qa-ui-auto-platforms.yml`, selected F27 cases on Linux/Windows/macOS in browser/native modes. English/Chinese OCR data is pinned and checked. Linux native uses an isolated X11/Xvfb desktop and real WebKitGTK. All native builds use `com.taomni.app.qa` with separate data/config/cache. Native outputs are staged under each entry's report root, outside signed `run-*` receipt directories, so upload layout cannot hide provenance. GIF/MP4/stitched PNGs and output hashes are retained for downloading and review.

## Verification status — 2026-10-02

Local execution remains unit/static only, per the requested boundary. Current screenshot Rust suite: 47 passed (including crop-before-conversion equivalence/stride bounds, encoder roundtrip, queue backpressure, GIF clipboard decode, original visibility intervals and restart-safe evidence names); shared Windows RDP backend/regressions: 35 passed. Focused frontend: 109 passed across six files; TypeScript build check passed. Native command/schema/behavior-contract checks, 41 QA infrastructure unit tests and combined catalog/audit gate have passed. These local checks are not native UI passes.

Hosted run `36953666030` tested commit `5da3c3e537941a090e5350ada1ca5b27a406f92a`. All three browser entries passed 21/21 with zero skips, verified source/receipt identities. macOS native passed 10/10. Linux native passed 9/10: the real three-second GIF contained eleven distinct frames, below the retained twelve-frame minimum (TC-SHOT-N5); duration/size were correct. Windows native completed with 0/10 cases passing: every child-window scenario timed out at the strict mounted-root readiness check, while its full-display command passed. This is not a three-platform success despite the workflow conclusion. Child screenshot WebViews now share the same isolated profile and EdgeDriver arguments as the main QA WebView on Windows, and QA evaluation adds explicit expression return/error and document/URL diagnostics. Follow-up run `36956493957` on `012e315fb99f9ed72f3a46b3d6a8a7e142d36884` passed all ten native cases on each platform; original receipts, matching source/binary hashes and artifacts are downloaded. Linux GIF then decoded to nineteen frames/3.08s; macOS twenty frames/3.13s. These old-oracle passes do not satisfy the later original-content comparison requirement. Prior run `36951867859` on `381fae6d` exposed transient toolbar history, optional blob Fetch metadata and reserved Linux hotkey QA issues; these were repaired in `15ca66e7`/`5da3c3e5` without weakening their postconditions. Windows native in that prior run was cancelled during build, not passed.

To address recording overhead, region capture now copies/converts only the selected BGRA rows before retaining/cloning the frame and reuses the first readiness image instead of polling again. It avoids full-desktop channel conversion and two full-image clones per region tick. The native GIF/MP4 retained cases N5–N8 still assert real timing/frame count/motion and platform playback; the twelve-frame GIF minimum is unchanged. Unit regressions verify the optimized crop is pixel-identical to full conversion plus crop, including padded strides and invalid buffers. The retained cases passed under this optimization in run36956493957 on all three platforms; no matched performance speedup is claimed.

Earlier full frontend sweep had two pre-existing failures in `TerminalPanel.test.tsx`; do not claim that suite completely green. Earlier hosted run `36854784738` on SHA `4df5f4aa` had real scroll/recording failures and a broken multi-root artifact layout; its weak/synthetic checks cannot certify repaired functionality.

Verification tasks: TASK-VERIFY-01 catalog/audit and exact selection completed; TASK-VERIFY-02 repaired builds ran in all six hosted combinations; TASK-VERIFY-03 outputs/reports downloaded and inspected, including independent Pillow GIF/PyAV H264 decoding and receipt/source/binary hashes; TASK-VERIFY-04 resolved the old Linux GIF throughput and Windows child-window readiness failures; TASK-VERIFY-05 now requires stronger complete original-content comparisons on all three platforms. Keep first-failure evidence; repeat on the new source SHA and record actual case results, not merely a green workflow.

## Original-content comparison contract — 2026-10-02

The native fixture draws ordinary canvas content and saves original PNG pixels at those actual draw calls. It never writes into the capture/encode path. Screen capture still samples the real OS composited window. The reference is independent of the captured/encoded output and is not reconstructed from decoded pixels.

- Scrolling source is a complete 32-row page with text, distinct colored bands, separators, checker/bars and a sloped shape across the width. Capture continues to the actual bottom within the existing forty-frame bound. Its full output size must equal the original crop, and every pixel/24x24 tile must match. PNG limits are mean RGB absolute error <=2, materially different pixel fraction <=1 percent and no tile mean above5. Retain full source, expected crop, stitched PNG and amplified difference; row order/heights remain an additional assertion.
- Animation source retains original PNG states with frame id, actual monotonic draw time and random per-run nonce encoded as complementary light/dark fiducials in the visible content. Every GIF/H264 frame must decode and carry this id/nonce, match its actual original crop at every tile (mean RGB error <=8, materially different pixels <=2 percent, no tile mean above20), and follow source temporal order. The source timeline must cover >=70 percent clip duration; anchored time must lie within <=250ms of the original state's real visibility interval (actual draw through next actual draw); no unexplained interframe/final stall >700ms after subtracting real held-original visibility. Raw gaps and unexplained gaps are both retained; a held source does not excuse missing changes once that source state ends. Existing frame/duration/motion/preview assertions still apply. Multiple frames or changing hashes alone cannot pass.
- Expected scroll width and encoded GIF/MP4 dimensions are derived from original source geometry and the documented format caps, never from decoded output dimensions. A truncated or stretched output cannot redefine its own expected crop.
- Retain all actual source PNG states, original timeline, every decoded frame PNG (including unidentified failures), per-decoded-frame errors/ids, actual GIF/MP4 and original/decoded/amplified-difference contact sheets. References are saved before decoding; decoder failures retain diagnostics. These are external-review evidence, not fabricated passes.
- Negative unit tests reject black/wrong-region/color-swapped frames, missing local content, duplicated/missing/reordered/stretched long-page bands, static/reversed/sped-up/stalled timelines and genuinely encoded changing but unrelated GIF/MP4 frames. Lossy quantization alone is tolerated by fixed documented thresholds.

Original-content hosted run `36961897882` on `172ede4d928eaf96c01d309359da8e688b12c785` completed with Linux 7/10, Windows 7/10 and macOS 8/10, zero skips. Selection/source/binary identities and report/output hashes were verified after downloading the original artifacts. This remains a failure despite the successful report workflow. Linux pixels differed only in the last captured column where WebKit's overlay scrollbar covered canvas content; a dedicated fixture gutter now excludes the scrollbar without changing pixel thresholds. Windows frames matched original pixels but WGC callback backpressure retained stale frames, producing 350–400ms drift; a receiver pump now continuously drains xcap into a single latest-frame mailbox, drops obsolete frames, safely joins before callback shutdown and retains native capture timestamps through conversion/encoding. Shared RDP consumers receive the same bounded latest-state contract and have focused mailbox/teardown unit regressions. macOS failing samples matched pixels while the real source state was held through a delayed next draw; timing now compares each actual visibility interval instead of treating its draw timestamp as a zero-length state. Static/reversed/sped-up/stale/stalled rejection tests remain mandatory and the 250ms bound is unchanged.

Independent Pillow/PyAV review also detected process counter reuse: restarting the QA app between cases could overwrite earlier original PNG filenames, invalidating external GIF comparisons even when in-process comparisons passed. Every copied output/reference/JSON now carries a random process UUID as well as a counter. First-failure evidence is retained at `qa-ui-auto-report/hosted-36961897882/independent-content-verification.json`; it must not be cited as full content acceptance. Follow-up run `36967681133` on `07e812a631be93912c02d370f345c66d8b1b16e1` passed Linux 10/10, Windows 9/10 and macOS 9/10. All full-page outputs were pixel-identical to originals; independent Pillow/PyAV decoding matched every GIF/H264 frame to the correct process-unique retained PNG/nonce, with valid report/output hashes. Windows N7 still exceeded anchored timing by 279.8ms: xcap exposes only delivered RGBA, losing WGC's original sampling instant. Shared capture now owns WGC directly, retaining the latest native surface and `SystemRelativeTime`, reading BGRA lazily on the consumer into a reusable staging texture. This removes callback CPU conversion and preserves sample age rather than changing the 250ms threshold. macOS N8 had a 718ms raw gap while the same original remained visible for 790ms; the validator now records raw gaps separately and rejects only unexplained gaps after that original's actual visibility ended. A held-source regression passes; missing moving-source intervals still fail.

Acceptance run `36973502375` on `fb0f02c55c2d68b68151ff9af03d21b970c2ae74` passed every selected native case on all three platforms: Linux 10/10, Windows 10/10 and macOS 10/10, zero failures and zero skips. Selection/source/binary identities, signed runner receipts, case digests and every staged output hash were verified offline. Independent Pillow/PyAV review matched every decoded GIF/H264 frame to its process-unique retained original (correct frame id and per-run nonce, every 24x24 tile within the fixed lossy limits) and reproduced the timeline acceptance: worst drift 18.5–97ms, longest unexplained gap ≤263ms, unexplained tail ≤159ms, source coverage ≥94 percent. Every stitched long page and region capture was pixel-identical to its original crop (mean error 0, no bad tile). Evidence: `qa-ui-auto-report/hosted-36973502375/independent-content-verification.json` plus each entry's `screenshot-outputs/` (originals, decoded frames, GIF/MP4, stitched PNG, difference images, per-frame JSON). TASK-VERIFY-05 is complete for the hosted single-display environments; mixed-DPI/multi-monitor and Wayland remain the boundaries listed below.

## Platform boundaries and follow-ups

- macOS screen recording and Accessibility permissions must be genuinely available; denial is a failure, not a pass. Mixed-DPI/multi-display Quartz mapping still needs native multi-monitor evidence.
- Linux hosted verification is X11. Wayland portal source selection and permission/input support must be validated separately; the X11 result does not certify Wayland wheel/global hotkey behavior.
- Native browser codec availability is verified by loaded metadata/pixels and playback advancement, not video tag presence. No audio track is provided.
- Visual review must inspect annotations/redactions/scroll seams and play retained clips. Color/row/decoder assertions do not establish every aspect of visual fidelity.
- Window auto-detection, audio capture and cloud upload remain outside this scope.
