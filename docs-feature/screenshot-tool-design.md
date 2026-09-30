# Screenshot & Screen-Recording Tool — Design

> Branch: `feat/screenshot-tool`. Feishu-like system screenshot tool: fullscreen /
> region capture on any display (not limited to the terminal), scrolling (long)
> screenshot, annotation, and screen recording to GIF / MP4. Windows / Linux /
> macOS.

## Goals / non-goals

- Goals: fullscreen capture per display, region select with magnifier,
  scrolling capture (auto-scroll + stitch), annotation toolbar
  (rect/ellipse/arrow/line/pen/text/mosaic, undo/redo), copy to clipboard,
  save to file, screen recording to GIF and MP4.
- Non-goals (v1): global hotkey (no `tauri-plugin-global-shortcut` yet),
  window auto-detect, cloud upload, audio capture. The old per-tab xterm-render
  capture (`src/lib/capture`) stays untouched.

## Architecture

```text
React overlay (fullscreen window "screenshot-overlay")
  selection + magnifier + AnnotationCanvas + toolbar
             |  Tauri invoke (src/lib/screenshot.ts)
             v
src-tauri/src/screenshot/
  mod.rs      Tauri commands, overlay/recorder window management, shared state
  capture.rs  display enumeration, fullscreen / region capture -> temp PNG
  scroll.rs   scrolling capture: enigo wheel synthesis + overlap stitching
  record.rs   GIF (gif crate) and MP4 (ffmpeg pipe) recording sessions
```

Overlay UX is static-background: backend captures fullscreen first, then the
overlay window shows that PNG while the main window hides. This avoids
transparent-window focus/click-through issues on Linux and freezes the frame
exactly like Feishu does during annotation.

Scroll capture: overlay hides -> backend captures region, synthesizes wheel
scrolls at region center via `enigo`, captures again, stitches by vertical
overlap detection -> overlay reopens on the stitched image for annotation.

Recording: overlay region-select -> "record" -> overlay hides -> `record.rs`
spawns a capture loop (frames -> gif encoder / ffmpeg stdin) -> tiny
always-on-top "screenshot-recorder" window with stop button + timer ->
on stop the file is finalized and offered for save/copy.

## Reuse (do not reinvent)

- Capture backends: `crate::servers::rdp::capture` on Linux (X11 SHM/Damage,
  Wayland portal/PipeWire); `xcap::Monitor` on Windows/macOS (both are
  non-optional target deps). Same split as `lanchat/transfer.rs`.
- Scroll injection: `enigo` 0.6 (already a dependency; `scroll(length, axis)`).
- Image clipboard: `arboard` 3 (`set_image`).
- PNG encode/crop/stitch: `image` 0.25 (png feature).
- GIF encode: new `gif` 0.13 dependency (pure Rust).

## IPC contract (Tauri commands, `Result<_, String>`)

- `screenshot_list_displays() -> Vec<ScreenshotDisplay>`
  `{ id, name, width, height, x, y, primary }` (physical pixels; `x/y` display origin)
- `screenshot_capture_full(display_id?: string) -> ScreenshotFile`
- `screenshot_capture_region(display_id?: string, x, y, width, height) -> ScreenshotFile`
- `screenshot_scroll_capture(display_id?: string, x, y, width, height) -> ScrollCaptureResult`
  `ScreenshotFile { path, width, height }` (temp PNG path; frontend loads via `convertFileSrc`);
  `ScrollCaptureResult { path, width, height, frames }`. Blocking — runs in `spawn_blocking`.
- `screenshot_copy_image(path: string) -> ()`
- `screenshot_save_image(path: string, dest: string) -> ()`
- `screenshot_save_data_url(data_url: string) -> ScreenshotFile` — annotated
  canvas PNG round-trip for copy/save
- `screenshot_probe() -> ScreenshotProbe { permission, control_permission, ffmpeg_available, summary }`
- `screenshot_open_overlay(display_id?: string) -> ()` — hides main window,
  captures fullscreen, opens `screenshot-overlay` window; overlay frontend then
  calls `screenshot_overlay_init() -> OverlayInit { path, display_id, width, height }`.
- `screenshot_close_overlay() -> ()` — closes overlay, reshows main window.
- `screenshot_start_recording(display_id?: string, x?, y?, width?, height?, format: "gif"|"mp4", fps?) -> { recording_id }`
- `screenshot_stop_recording(recording_id) -> ScreenshotFile`
- `screenshot_cancel_recording(recording_id) -> ()`

Frontend mapping: overlay window is fullscreen on the target display, so CSS
pixels map to image pixels by `naturalWidth / window.innerWidth` — no backend
scale factor needed.

## Platform matrix

| | Capture | Scroll inject | GIF | MP4 |
|---|---|---|---|---|
| Windows | xcap WGC (+GDI fallback in rdp backend) | enigo | gif crate | ffmpeg if on PATH |
| macOS | xcap ScreenCaptureKit (Screen Recording permission) | enigo (Accessibility permission) | gif crate | ffmpeg if on PATH |
| Linux X11 | rdp x11 backend | enigo x11rb | gif crate | ffmpeg if on PATH |
| Linux Wayland | rdp portal/PipeWire backend | enigo Wayland / portal input | gif crate | ffmpeg if on PATH |

Permissions are probed, never silently assumed (`screenshot_probe`; macOS
reuses the existing Screen Recording request flow). MP4 without ffmpeg returns
a clear error pointing at ffmpeg or GIF.

## Recording bounds (v1)

- GIF: default 10 fps, cap 60 s, auto-downscale to max 960 px wide, infinite loop.
- MP4: default 15 fps, piped raw RGBA to
  `ffmpeg -f rawvideo -pix_fmt rgba -s WxH -framerate F -i pipe:0 -c:v libx264 -pix_fmt yuv420p -movflags +faststart`.
- Both: region or fullscreen; stop via recorder bar window.

## Frontend files

- `src/lib/screenshot.ts` — invoke wrappers + types (contract above).
- `src/components/screenshot/ScreenshotOverlay.tsx` — fullscreen overlay:
  background image, region drag-select with magnifier + size tooltip, toolbar,
  scroll-capture and record entry points.
- `src/components/screenshot/AnnotationCanvas.tsx` — canvas annotation layer
  (rect/ellipse/arrow/line/pen/text/mosaic, undo/redo, HiDPI-aware).
- `src/components/screenshot/RecorderBar.tsx` — tiny stop/timer window UI.
- `App.tsx` — render overlay/recorder when
  `getCurrentWindow().label` is `screenshot-overlay` / `screenshot-recorder`.
- Trigger: camera button in `ControlBar`'s global window chrome (after the
  divider, next to the tray controls) — independent of any tab.

## Shortcuts

- OS-global hotkey `Ctrl+Shift+A` (`Cmd+Shift+A` on macOS, the Feishu default)
  registered by the Rust backend via `tauri-plugin-global-shortcut`
  (best-effort: restrictive environments such as Wayland log a warning and
  fall back). Fires even when the app is not focused.
- App-local fallback: the same chord handled in `App.tsx` when the main window
  is focused (editable fields keep the keystroke); also the only path in
  browser preview.
- i18n: `screenshot.*` keys in `en.ts` + `zh-CN.ts`.

## Testing

- Rust: unit tests for `scroll.rs` overlap detection + stitching (synthetic
  frames); `record.rs` GIF header sanity on synthetic frames.
- Frontend: vitest for pure geometry helpers (rect normalize, scale mapping).
- Manual matrix: Win / macOS / Linux(X11+Wayland) smoke per AGENTS.md
  (current-platform verification suffices per delivery, others recorded).

## Follow-ups (not v1)

Global hotkey via `tauri-plugin-global-shortcut`; window auto-detect under
cursor; audio track for MP4; native openh264 MP4 path when ffmpeg is absent.
