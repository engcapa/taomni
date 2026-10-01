//! Feishu-style system screenshot & screen recording tool.
//!
//! Unlike the per-tab xterm-render capture (`src/lib/capture`), this module
//! captures the real OS screen on any display: fullscreen, region, scrolling
//! (auto-scroll + stitch), and video recording to GIF / MP4. Windows, macOS
//! and Linux are all supported.
//!
//! The overlay UX is static-background: [`screenshot_open_overlay`] hides the
//! app windows, captures the display, then opens a fullscreen overlay window
//! that renders the captured PNG while the user selects / annotates. This
//! avoids transparent-window focus and click-through problems on Linux.

pub mod capture;
pub mod ocr;
pub mod record;
pub mod scroll;

use std::borrow::Cow;
use std::sync::{Mutex, OnceLock};

use serde::Serialize;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

use capture::{DisplayInfo, ScreenshotFile};
use scroll::ScrollCaptureResult;

const OVERLAY_LABEL: &str = "screenshot-overlay";
const RECORDER_LABEL: &str = "screenshot-recorder";
const PIN_LABEL_PREFIX: &str = "screenshot-pin-";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PinInit {
    pub path: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayInit {
    pub path: String,
    pub display_id: Option<String>,
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenshotProbe {
    /// `granted`, `denied`, or `notRequired` — OS screen-capture permission.
    pub permission: String,
    /// Accessibility / input-injection permission (macOS scroll capture).
    pub control_permission: String,
    pub ffmpeg_available: bool,
    pub summary: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingStarted {
    pub recording_id: String,
}

static OVERLAY_INIT: OnceLock<Mutex<Option<OverlayInit>>> = OnceLock::new();
static HIDDEN_WINDOWS: OnceLock<Mutex<Vec<String>>> = OnceLock::new();
static CURRENT_RECORDING: OnceLock<Mutex<Option<String>>> = OnceLock::new();
static PIN_INIT: OnceLock<Mutex<Option<PinInit>>> = OnceLock::new();
static PIN_COUNTER: OnceLock<std::sync::atomic::AtomicU64> = OnceLock::new();

fn overlay_init_slot() -> &'static Mutex<Option<OverlayInit>> {
    OVERLAY_INIT.get_or_init(|| Mutex::new(None))
}

fn pin_init_slot() -> &'static Mutex<Option<PinInit>> {
    PIN_INIT.get_or_init(|| Mutex::new(None))
}

fn pin_counter() -> &'static std::sync::atomic::AtomicU64 {
    PIN_COUNTER.get_or_init(|| std::sync::atomic::AtomicU64::new(1))
}

/// Directory where test-only commands stash visual artifacts (captured PNGs,
/// recorded GIFs/MP4s) for CI upload. Best-effort: failures are ignored so
/// tests never fail because artifact saving failed.
/// Prefers RUNNER_TEMP (GitHub Actions) so the workflow can upload it.
fn qa_artifact_dir() -> std::path::PathBuf {
    let base = std::env::var("RUNNER_TEMP")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir());
    base.join("taomni-qa-artifacts")
}

fn save_qa_artifact(src_path: &str, name: &str) {
    let dir = qa_artifact_dir();
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let dest = dir.join(name);
    let _ = std::fs::copy(src_path, &dest);
}

fn hidden_windows_slot() -> &'static Mutex<Vec<String>> {
    HIDDEN_WINDOWS.get_or_init(|| Mutex::new(Vec::new()))
}

fn current_recording_slot() -> &'static Mutex<Option<String>> {
    CURRENT_RECORDING.get_or_init(|| Mutex::new(None))
}

fn internal_error(e: anyhow::Error) -> String {
    format!("{e:#}")
}

// ---------------------------------------------------------------------------
// Still capture
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn screenshot_list_displays(app: AppHandle) -> Result<Vec<DisplayInfo>, String> {
    tokio::task::spawn_blocking(move || capture::list_displays(&app))
        .await
        .map_err(|e| format!("display enumeration task failed: {e}"))?
        .map_err(internal_error)
}

#[tauri::command]
pub async fn screenshot_capture_full(
    app: AppHandle,
    display_id: Option<String>,
) -> Result<ScreenshotFile, String> {
    tokio::task::spawn_blocking(move || capture::capture_display_png(&app, display_id.as_deref()))
        .await
        .map_err(|e| format!("capture task failed: {e}"))?
        .map_err(internal_error)
        .map(|(path, width, height)| ScreenshotFile {
            path: path.to_string_lossy().into_owned(),
            width,
            height,
        })
}

#[tauri::command]
pub async fn screenshot_capture_region(
    app: AppHandle,
    display_id: Option<String>,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
) -> Result<ScreenshotFile, String> {
    tokio::task::spawn_blocking(move || {
        capture::capture_region_png(&app, display_id.as_deref(), x, y, width, height)
    })
    .await
    .map_err(|e| format!("capture task failed: {e}"))?
    .map_err(internal_error)
    .map(|(path, width, height)| ScreenshotFile {
        path: path.to_string_lossy().into_owned(),
        width,
        height,
    })
}

#[tauri::command]
pub async fn screenshot_scroll_capture(
    app: AppHandle,
    display_id: Option<String>,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
) -> Result<ScrollCaptureResult, String> {
    // Enigo is not `Send` on macOS; the whole flow owns its OS thread.
    tokio::task::spawn_blocking(move || {
        let origin = capture::display_origin(&app, display_id.as_deref());
        scroll::scroll_capture(&app, display_id.as_deref(), origin, x, y, width, height)
    })
    .await
    .map_err(|e| format!("scroll capture task failed: {e}"))?
    .map_err(internal_error)
}

#[tauri::command]
pub async fn screenshot_copy_image(path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let image = image::open(&path)
            .map_err(|e| anyhow::anyhow!("open image: {e}"))?
            .to_rgba8();
        let (width, height) = (image.width() as usize, image.height() as usize);
        let mut clipboard =
            arboard::Clipboard::new().map_err(|e| anyhow::anyhow!("open clipboard: {e}"))?;
        clipboard
            .set_image(arboard::ImageData {
                width,
                height,
                bytes: Cow::Owned(image.into_raw()),
            })
            .map_err(|e| anyhow::anyhow!("write image to clipboard: {e}"))
    })
    .await
    .map_err(|e| format!("clipboard task failed: {e}"))?
    .map_err(internal_error)
}

#[tauri::command]
pub async fn screenshot_save_image(path: String, dest: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        std::fs::copy(&path, &dest)
            .map(|_| ())
            .map_err(|e| anyhow::anyhow!("save image: {e}"))
    })
    .await
    .map_err(|e| format!("save task failed: {e}"))?
    .map_err(internal_error)
}

/// Decode a `data:image/png;base64,...` URL from the annotation canvas and
/// write it as a temp PNG. Returns the file for copy/save.
#[tauri::command]
pub async fn screenshot_save_data_url(data_url: String) -> Result<ScreenshotFile, String> {
    tokio::task::spawn_blocking(move || {
        use base64::{Engine, engine::general_purpose::STANDARD as BASE64};
        let payload = data_url
            .split_once(',')
            .map(|(_, rest)| rest)
            .unwrap_or(&data_url);
        let bytes = BASE64
            .decode(payload.trim())
            .map_err(|e| anyhow::anyhow!("decode data url: {e}"))?;
        if bytes.len() < 8 || &bytes[..8] != b"\x89PNG\r\n\x1a\n" {
            anyhow::bail!("not a PNG data url");
        }
        let path = capture::temp_artifact_path("annotated", "png")?;
        std::fs::write(&path, &bytes).map_err(|e| anyhow::anyhow!("write png: {e}"))?;
        let image = image::open(&path).map_err(|e| anyhow::anyhow!("read png: {e}"))?;
        Ok::<ScreenshotFile, anyhow::Error>(ScreenshotFile {
            path: path.to_string_lossy().into_owned(),
            width: image.width(),
            height: image.height(),
        })
    })
    .await
    .map_err(|e| format!("save task failed: {e}"))?
    .map_err(internal_error)
}

#[tauri::command]
pub async fn screenshot_probe() -> Result<ScreenshotProbe, String> {
    let base = tokio::task::spawn_blocking(|| crate::servers::rdp::capture::probe())
        .await
        .map_err(|e| format!("probe task failed: {e}"))?
        .map_err(internal_error)?;
    Ok(ScreenshotProbe {
        permission: base.permission,
        control_permission: base.control_permission,
        ffmpeg_available: record::ffmpeg_available(),
        summary: format!(
            "{}. MP4 recording {}.",
            base.summary,
            if record::ffmpeg_available() {
                "is available (ffmpeg found)"
            } else {
                "needs ffmpeg on PATH (GIF always works)"
            }
        ),
    })
}

/// Read the first `len` bytes of a file as lowercase hex. Test-only helper
/// for QA to verify recording file headers (GIF87a/89a, MP4 ftyp).
#[tauri::command]
pub async fn screenshot_read_file_header(path: String, len: u32) -> Result<String, String> {
    let len = len.min(64) as usize;
    let bytes = tokio::task::spawn_blocking(move || {
        use std::io::Read;
        let mut f = std::fs::File::open(&path).map_err(|e| format!("open failed: {e}"))?;
        let mut buf = vec![0u8; len];
        let n = f.read(&mut buf).map_err(|e| format!("read failed: {e}"))?;
        buf.truncate(n);
        Ok::<Vec<u8>, String>(buf)
    })
    .await
    .map_err(|e| format!("read task failed: {e}"))??;
    Ok(bytes.iter().map(|b| format!("{:02x}", *b)).collect())
}

/// Test-only: capture full screen and stash the PNG for CI artifact upload.
/// Returns the same ScreenshotFile as screenshot_capture_full.
#[tauri::command]
pub async fn screenshot_test_capture_full(
    app: AppHandle,
    display_id: Option<String>,
) -> Result<ScreenshotFile, String> {
    let file = screenshot_capture_full(app, display_id).await?;
    save_qa_artifact(&file.path, "n1-screen-capture.png");
    Ok(file)
}

/// Test-only: capture screen, draw test annotations (rectangle, arrow, circle),
/// and save for visual QA. Returns "OK path=...".
/// Used by N3 to verify the annotation pipeline produces a valid image.
#[tauri::command]
pub async fn screenshot_test_annotate(
    app: AppHandle,
    display_id: Option<String>,
) -> Result<String, String> {
    let file = screenshot_capture_full(app, display_id).await?;
    let annotated_path = tokio::task::spawn_blocking(move || {
        use image::{Rgb, RgbImage};
        let mut img = image::open(&file.path)
            .map_err(|e| format!("open screenshot: {e}"))?
            .to_rgb8();
        let (w, h) = (img.width(), img.height());
        let red = Rgb([255, 0, 0]);
        let green = Rgb([0, 255, 0]);
        let blue = Rgb([0, 0, 255]);

        // Helper to draw a thick line via Bresenham.
        fn draw_line(img: &mut RgbImage, x0: i32, y0: i32, x1: i32, y1: i32, color: Rgb<u8>) {
            let (mut x0, mut y0) = (x0, y0);
            let dx = (x1 - x0).abs();
            let dy = -(y1 - y0).abs();
            let sx = if x0 < x1 { 1 } else { -1 };
            let sy = if y0 < y1 { 1 } else { -1 };
            let mut err = dx + dy;
            loop {
                for ox in -1..=1 {
                    for oy in -1..=1 {
                        let (px, py) = (x0 + ox, y0 + oy);
                        if px >= 0
                            && py >= 0
                            && (px as u32) < img.width()
                            && (py as u32) < img.height()
                        {
                            img.put_pixel(px as u32, py as u32, color);
                        }
                    }
                }
                if x0 == x1 && y0 == y1 {
                    break;
                }
                let e2 = 2 * err;
                if e2 >= dy {
                    err += dy;
                    x0 += sx;
                }
                if e2 <= dx {
                    err += dx;
                    y0 += sy;
                }
            }
        }

        // Red hollow rectangle (top-left).
        let (rx, ry, rw, rh) = (w as i32 / 8, h as i32 / 8, w as i32 / 4, h as i32 / 4);
        draw_line(&mut img, rx, ry, rx + rw, ry, red);
        draw_line(&mut img, rx + rw, ry, rx + rw, ry + rh, red);
        draw_line(&mut img, rx + rw, ry + rh, rx, ry + rh, red);
        draw_line(&mut img, rx, ry + rh, rx, ry, red);

        // Green arrow (diagonal).
        let (ax0, ay0) = (w as i32 * 6 / 10, h as i32 * 6 / 10);
        let (ax1, ay1) = (w as i32 * 8 / 10, h as i32 * 4 / 10);
        draw_line(&mut img, ax0, ay0, ax1, ay1, green);
        draw_line(&mut img, ax1, ay1, ax1 - 15, ay1 + 5, green);
        draw_line(&mut img, ax1, ay1, ax1 - 5, ay1 + 15, green);

        // Blue circle (polygon approximation).
        let (cx, cy, r) = (w as i32 * 3 / 10, h as i32 * 7 / 10, 30);
        let mut prev = (cx + r, cy);
        for i in 1..=24 {
            let a = i as f32 * std::f32::consts::PI * 2.0 / 24.0;
            let curr = (
                cx + (r as f32 * a.cos()) as i32,
                cy + (r as f32 * a.sin()) as i32,
            );
            draw_line(&mut img, prev.0, prev.1, curr.0, curr.1, blue);
            prev = curr;
        }

        let out = capture::temp_artifact_path("annotated-test", "png")
            .map_err(|e| format!("temp path: {e}"))?;
        img.save(&out).map_err(|e| format!("save annotated: {e}"))?;
        Ok::<String, String>(out.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| format!("annotate task failed: {e}"))??;
    save_qa_artifact(&annotated_path, "n3-annotated.png");
    Ok(format!("OK path={}", annotated_path))
}

/// Test-only: run scroll capture and verify multi-frame stitching in one call.
/// Returns "OK frames=N height=H" where N>1 and H>requested height prove
/// the wheel scrolled and frames were stitched.
/// Saves a full-display screenshot as the visual QA artifact (the 200x200
/// scroll region is black on headless CI VMs; the full display shows the
/// actual desktop content for visual inspection).
#[tauri::command]
pub async fn screenshot_test_scroll_capture(
    app: AppHandle,
    width: u32,
    height: u32,
) -> Result<String, String> {
    let r = screenshot_scroll_capture(app.clone(), None, 0, 0, width, height).await?;
    // Save full display for visual artifact (scroll region is empty on CI).
    if let Ok(full) = screenshot_capture_full(app, None).await {
        save_qa_artifact(&full.path, "n2-scroll-stitch.png");
    } else {
        save_qa_artifact(&r.path, "n2-scroll-stitch.png");
    }
    let ok = r.frames > 1 && r.height > height;
    Ok(format!(
        "{} frames={} height={}",
        if ok { "OK" } else { "FAIL" },
        r.frames,
        r.height
    ))
}

/// Test-only: record a short clip and verify its file header in one call.
/// Starts a recording, waits `secs` seconds, stops it, reads the first 12
/// bytes as hex. Returns "OK <hex>" on success. Avoids JS promise chaining
/// (banned by the QA audit) in native test cases.
/// Bypasses the recorder-bar window (UI) used by the interactive flow.
/// Moves the cursor during recording so the clip shows visible movement.
#[tauri::command]
pub async fn screenshot_test_recording(
    app: AppHandle,
    format: String,
    secs: u64,
) -> Result<String, String> {
    let recording_id = {
        let app_clone = app.clone();
        let format_clone = format.clone();
        tokio::task::spawn_blocking(move || {
            record::start_recording(
                &app_clone,
                None,
                Some((0, 0, 200, 200)),
                &format_clone,
                Some(5),
            )
        })
        .await
        .map_err(|e| format!("start recording task failed: {e}"))?
        .map_err(internal_error)?
    };
    // Move cursor during recording for visible movement in the clip.
    let move_handle = tokio::task::spawn_blocking(move || {
        use enigo::{Coordinate, Enigo, Mouse, Settings};
        if let Ok(mut enigo) = Enigo::new(&Settings::default()) {
            let points = [(50, 50), (150, 50), (150, 150), (50, 150)];
            for (x, y) in points {
                let _ = enigo.move_mouse(x, y, Coordinate::Abs);
                std::thread::sleep(std::time::Duration::from_millis(400));
            }
        }
    });
    tokio::time::sleep(std::time::Duration::from_secs(secs.min(10))).await;
    let _ = move_handle.await;
    let file = tokio::task::spawn_blocking(move || record::stop_recording(&recording_id))
        .await
        .map_err(|e| format!("stop recording task failed: {e}"))?
        .map_err(internal_error)?;
    let header = screenshot_read_file_header(file.path.clone(), 12).await?;
    // Save the recording for CI artifact upload (visual inspection).
    // N5 passes format="gif", N6 passes format="mp4".
    let artifact_name = format!("n56-recording-{}.{}", format, format);
    save_qa_artifact(&file.path, &artifact_name);
    Ok(format!("OK path={} header={}", file.path, header))
}

/// Test-only: record a GIF and verify frame completeness by decoding it.
/// Checks frame count is within 20% of expected (secs * fps) and dimensions
/// match. Returns "OK frames=N width=W height=H".
/// Moves the cursor in a square pattern during recording so the GIF shows
/// visible cursor movement (not static blank frames on headless CI).
#[tauri::command]
pub async fn screenshot_test_gif_complete(
    app: AppHandle,
    secs: u64,
    fps: u32,
) -> Result<String, String> {
    let recording_id = {
        let app_clone = app.clone();
        tokio::task::spawn_blocking(move || {
            record::start_recording(&app_clone, None, Some((0, 0, 200, 200)), "gif", Some(fps))
        })
        .await
        .map_err(|e| format!("start task failed: {e}"))?
        .map_err(internal_error)?
    };
    // Move cursor in a square pattern during recording for visible movement.
    let move_handle = tokio::task::spawn_blocking(move || {
        use enigo::{Coordinate, Enigo, Mouse, Settings};
        if let Ok(mut enigo) = Enigo::new(&Settings::default()) {
            let points = [(50, 50), (150, 50), (150, 150), (50, 150), (50, 50)];
            for (x, y) in points {
                let _ = enigo.move_mouse(x, y, Coordinate::Abs);
                std::thread::sleep(std::time::Duration::from_millis(400));
            }
        }
    });
    tokio::time::sleep(std::time::Duration::from_secs(secs.min(10))).await;
    let _ = move_handle.await;
    let file = tokio::task::spawn_blocking(move || record::stop_recording(&recording_id))
        .await
        .map_err(|e| format!("stop task failed: {e}"))?
        .map_err(internal_error)?;
    let path = file.path.clone();
    save_qa_artifact(&path, "n7-gif-complete.gif");
    let (frames, width, height) = tokio::task::spawn_blocking(move || {
        let f = std::fs::File::open(&path).map_err(|e| format!("open failed: {e}"))?;
        let mut decoder = gif::DecodeOptions::new()
            .read_info(f)
            .map_err(|e| format!("gif decode failed: {e}"))?;
        let (w, h) = (decoder.width() as u32, decoder.height() as u32);
        let mut count = 0u32;
        while decoder
            .read_next_frame()
            .map_err(|e| format!("frame read failed: {e}"))?
            .is_some()
        {
            count += 1;
        }
        Ok::<(u32, u32, u32), String>((count, w, h))
    })
    .await
    .map_err(|e| format!("decode task failed: {e}"))??;
    let expected = secs as u32 * fps;
    let ok = frames >= expected * 8 / 10
        && frames <= expected * 12 / 10
        && width == 200
        && height == 200;
    Ok(format!(
        "{} frames={} width={} height={} expected={}",
        if ok { "OK" } else { "FAIL" },
        frames,
        width,
        height,
        expected
    ))
}

/// Test-only: record MP4 and verify via ffprobe (duration, codec, dims).
/// Returns "OK duration=D codec=C width=W height=H".
/// Moves the cursor during recording so the video shows visible movement.
#[tauri::command]
pub async fn screenshot_test_mp4_complete(
    app: AppHandle,
    secs: u64,
    fps: u32,
) -> Result<String, String> {
    let recording_id = {
        let app_clone = app.clone();
        tokio::task::spawn_blocking(move || {
            record::start_recording(&app_clone, None, Some((0, 0, 200, 200)), "mp4", Some(fps))
        })
        .await
        .map_err(|e| format!("start task failed: {e}"))?
        .map_err(internal_error)?
    };
    // Move cursor in a square pattern during recording for visible movement.
    let move_handle = tokio::task::spawn_blocking(move || {
        use enigo::{Coordinate, Enigo, Mouse, Settings};
        if let Ok(mut enigo) = Enigo::new(&Settings::default()) {
            let points = [(50, 50), (150, 50), (150, 150), (50, 150), (50, 50)];
            for (x, y) in points {
                let _ = enigo.move_mouse(x, y, Coordinate::Abs);
                std::thread::sleep(std::time::Duration::from_millis(400));
            }
        }
    });
    tokio::time::sleep(std::time::Duration::from_secs(secs.min(10))).await;
    let _ = move_handle.await;
    let file = tokio::task::spawn_blocking(move || record::stop_recording(&recording_id))
        .await
        .map_err(|e| format!("stop task failed: {e}"))?
        .map_err(internal_error)?;
    let path = file.path.clone();
    save_qa_artifact(&path, "n8-mp4-complete.mp4");
    let info = tokio::task::spawn_blocking(move || {
        let out = std::process::Command::new("ffprobe")
            .args([
                "-v",
                "quiet",
                "-print_format",
                "json",
                "-show_format",
                "-show_streams",
                &path,
            ])
            .output()
            .map_err(|e| format!("ffprobe failed: {e}"))?;
        let json: serde_json::Value =
            serde_json::from_slice(&out.stdout).map_err(|e| format!("json parse failed: {e}"))?;
        let stream = json["streams"]
            .as_array()
            .and_then(|s| s.iter().find(|v| v["codec_type"] == "video"))
            .ok_or_else(|| "no video stream".to_string())?;
        let duration: f64 = json["format"]["duration"]
            .as_str()
            .and_then(|d| d.parse().ok())
            .unwrap_or(0.0);
        let codec = stream["codec_name"].as_str().unwrap_or("?").to_string();
        let w = stream["width"].as_u64().unwrap_or(0);
        let h = stream["height"].as_u64().unwrap_or(0);
        Ok::<(f64, String, u64, u64), String>((duration, codec, w, h))
    })
    .await
    .map_err(|e| format!("probe task failed: {e}"))??;
    let (duration, codec, w, h) = info;
    let ok = duration >= secs as f64 - 0.5
        && duration <= secs as f64 + 1.5
        && codec == "h264"
        && w == 200
        && h == 200;
    Ok(format!(
        "{} duration={:.2} codec={} width={} height={}",
        if ok { "OK" } else { "FAIL" },
        duration,
        codec,
        w,
        h
    ))
}

/// Test-only: verify scroll-stitch content is real (not duplicated frames).
/// Divides the stitched image into 3 vertical thirds and checks at least 2
/// have different average colors, proving the wheel actually scrolled.
#[tauri::command]
pub async fn screenshot_test_scroll_content(
    app: AppHandle,
    width: u32,
    height: u32,
) -> Result<String, String> {
    let r = screenshot_scroll_capture(app, None, 0, 0, width, height).await?;
    let path = r.path.clone();
    save_qa_artifact(&path, "n9-scroll-content.png");
    let differ = tokio::task::spawn_blocking(move || {
        let img = image::open(&path)
            .map_err(|e| format!("open failed: {e}"))?
            .to_rgba8();
        let (w, h) = img.dimensions();
        let third = h / 3;
        let mut avgs = Vec::new();
        for i in 0..3 {
            let y0 = i * third;
            let y1 = if i == 2 { h } else { (i + 1) * third };
            let mut sr: u64 = 0;
            let mut sg: u64 = 0;
            let mut sb: u64 = 0;
            let mut n: u64 = 0;
            // Sample every 7th pixel for speed.
            for y in (y0..y1).step_by(7) {
                for x in (0..w).step_by(7) {
                    let p = img.get_pixel(x, y);
                    sr += p[0] as u64;
                    sg += p[1] as u64;
                    sb += p[2] as u64;
                    n += 1;
                }
            }
            avgs.push((sr / n, sg / n, sb / n));
        }
        let mut differ = 0;
        for a in 0..3 {
            for b in (a + 1)..3 {
                let dr = (avgs[a].0 as i64 - avgs[b].0 as i64).abs();
                let dg = (avgs[a].1 as i64 - avgs[b].1 as i64).abs();
                let db = (avgs[a].2 as i64 - avgs[b].2 as i64).abs();
                if dr + dg + db > 30 {
                    differ += 1;
                }
            }
        }
        Ok::<u32, String>(differ)
    })
    .await
    .map_err(|e| format!("content task failed: {e}"))??;
    Ok(format!(
        "{} differing_thirds={}",
        if differ >= 1 { "OK" } else { "FAIL" },
        differ
    ))
}

/// Test-only: capture the screen twice and verify the captures are nearly
/// identical (proving deterministic, faithful capture).
#[tauri::command]
pub async fn screenshot_test_capture_fidelity(app: AppHandle) -> Result<String, String> {
    let cap = |app: &AppHandle| {
        let app_clone = app.clone();
        capture::capture_display_png(&app_clone, None).map_err(|e| format!("capture failed: {e}"))
    };
    let (p1, _, _) = cap(&app)?;
    let (p2, _, _) = cap(&app)?;
    save_qa_artifact(&p1.to_string_lossy(), "n10-capture-1.png");
    save_qa_artifact(&p2.to_string_lossy(), "n10-capture-2.png");
    let diff_pct = tokio::task::spawn_blocking(move || {
        let a = image::open(&p1)
            .map_err(|e| format!("open1 failed: {e}"))?
            .to_rgba8();
        let b = image::open(&p2)
            .map_err(|e| format!("open2 failed: {e}"))?
            .to_rgba8();
        let (w, h) = a.dimensions();
        if b.dimensions() != (w, h) {
            return Ok::<f64, String>(100.0);
        }
        let mut diff: u64 = 0;
        let mut total: u64 = 0;
        for y in (0..h).step_by(3) {
            for x in (0..w).step_by(3) {
                let pa = a.get_pixel(x, y);
                let pb = b.get_pixel(x, y);
                let d = (pa[0] as i32 - pb[0] as i32).abs()
                    + (pa[1] as i32 - pb[1] as i32).abs()
                    + (pa[2] as i32 - pb[2] as i32).abs();
                if d > 30 {
                    diff += 1;
                }
                total += 1;
            }
        }
        Ok::<f64, String>(diff as f64 * 100.0 / total as f64)
    })
    .await
    .map_err(|e| format!("diff task failed: {e}"))??;
    Ok(format!(
        "{} diff_pct={:.2}",
        if diff_pct < 5.0 { "OK" } else { "FAIL" },
        diff_pct
    ))
}

// ---------------------------------------------------------------------------
// Overlay window
// ---------------------------------------------------------------------------

/// Hide app windows, capture the display, and open the fullscreen annotation
/// overlay. Split from the Tauri command so the global-shortcut handler can
/// reuse it.
pub async fn open_overlay(app: &AppHandle, display_id: Option<String>) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window(OVERLAY_LABEL) {
        let _ = existing.close();
    }
    // Hide every visible app window (no label assumptions about the main
    // window); they are reshown by `screenshot_close_overlay`.
    let mut hidden = Vec::new();
    for (label, window) in app.webview_windows() {
        if label == OVERLAY_LABEL || label == RECORDER_LABEL {
            continue;
        }
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
            hidden.push(label);
        }
    }
    *hidden_windows_slot().lock().unwrap() = hidden;

    let origin = capture::display_origin(app, display_id.as_deref());
    let app_clone = app.clone();
    let display_clone = display_id.clone();
    let (path, width, height) = tokio::task::spawn_blocking(move || {
        capture::capture_display_png(&app_clone, display_clone.as_deref())
    })
    .await
    .map_err(|e| format!("capture task failed: {e}"))?
    .map_err(internal_error)?;
    // Save QA artifact for macOS N4 test (which triggers overlay via UI click
    // and cannot invoke test commands directly). Only in CI (RUNNER_TEMP set).
    if std::env::var("RUNNER_TEMP").is_ok() {
        save_qa_artifact(&path.to_string_lossy(), "n4-macos-capture.png");
    }
    *overlay_init_slot().lock().unwrap() = Some(OverlayInit {
        path: path.to_string_lossy().into_owned(),
        display_id,
        width,
        height,
    });

    let url = WebviewUrl::App("index.html#screenshot-overlay".into());
    WebviewWindowBuilder::new(app, OVERLAY_LABEL, url)
        .title("Screenshot")
        .position(origin.0 as f64, origin.1 as f64)
        .fullscreen(true)
        .decorations(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .build()
        .map_err(|e| format!("open overlay window: {e}"))?;
    Ok(())
}

/// Tauri command wrapper for [`open_overlay`].
#[tauri::command]
pub async fn screenshot_open_overlay(
    app: AppHandle,
    display_id: Option<String>,
) -> Result<(), String> {
    open_overlay(&app, display_id).await
}

/// One-shot fetch of the pending overlay payload, set by
/// [`screenshot_open_overlay`].
#[tauri::command]
pub async fn screenshot_overlay_init() -> Result<OverlayInit, String> {
    overlay_init_slot()
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "no pending screenshot overlay".to_string())
}

/// Close the overlay (and recorder bar) and reshow hidden app windows.
#[tauri::command]
pub async fn screenshot_close_overlay(app: AppHandle) -> Result<(), String> {
    for label in [OVERLAY_LABEL, RECORDER_LABEL] {
        if let Some(window) = app.get_webview_window(label) {
            let _ = window.close();
        }
    }
    let hidden: Vec<String> = std::mem::take(&mut *hidden_windows_slot().lock().unwrap());
    for label in hidden {
        if let Some(window) = app.get_webview_window(&label) {
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Pin to screen
// ---------------------------------------------------------------------------

/// Open a frameless always-on-top window showing the given image file.
/// Returns the new window label.
#[tauri::command]
pub async fn screenshot_pin_to_screen(app: AppHandle, path: String) -> Result<String, String> {
    let (width, height) = tokio::task::spawn_blocking({
        let path = path.clone();
        move || -> Result<(u32, u32), String> {
            let img = image::open(&path).map_err(|e| format!("open pin image: {e}"))?;
            Ok((img.width(), img.height()))
        }
    })
    .await
    .map_err(|e| format!("pin task failed: {e}"))??;

    // Cap the initial window size so huge screenshots don't cover the screen.
    const MAX_DIM: f64 = 640.0;
    let scale = (MAX_DIM / width.max(height) as f64).min(1.0);
    let win_w = (width as f64 * scale).round();
    let win_h = (height as f64 * scale).round();

    let id = pin_counter().fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let label = format!("{PIN_LABEL_PREFIX}{id}");
    *pin_init_slot().lock().unwrap() = Some(PinInit {
        path,
        width,
        height,
    });

    let url = WebviewUrl::App("index.html#screenshot-pin".into());
    WebviewWindowBuilder::new(&app, &label, url)
        .title("Pinned Screenshot")
        .inner_size(win_w, win_h)
        .decorations(false)
        .resizable(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .build()
        .map_err(|e| format!("open pin window: {e}"))?;
    Ok(label)
}

/// One-shot fetch of the pending pin payload, set by [`screenshot_pin_to_screen`].
#[tauri::command]
pub async fn screenshot_pin_init() -> Result<PinInit, String> {
    pin_init_slot()
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "no pending screenshot pin".to_string())
}

/// Close a pinned screenshot window by label.
#[tauri::command]
pub async fn screenshot_close_pin(app: AppHandle, label: String) -> Result<(), String> {
    if !label.starts_with(PIN_LABEL_PREFIX) {
        return Err("not a pin window".to_string());
    }
    if let Some(window) = app.get_webview_window(&label) {
        let _ = window.close();
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// OCR & auto-redact
// ---------------------------------------------------------------------------

/// Extract text from an image file via tesseract (if installed).
#[tauri::command]
pub async fn screenshot_ocr(path: String) -> Result<ocr::OcrResult, String> {
    tokio::task::spawn_blocking(move || ocr::ocr_image(&path))
        .await
        .map_err(|e| format!("ocr task failed: {e}"))?
}

/// Find sensitive tokens (e-mail / phone / ID) in an image via OCR.
/// Returns bounding boxes in physical pixels relative to the image.
#[tauri::command]
pub async fn screenshot_auto_redact(path: String) -> Result<ocr::RedactResult, String> {
    tokio::task::spawn_blocking(move || {
        let result = ocr::ocr_image(&path)?;
        let boxes = ocr::find_sensitive(&result.words);
        Ok::<_, String>(ocr::RedactResult {
            count: boxes.len(),
            boxes,
        })
    })
    .await
    .map_err(|e| format!("redact task failed: {e}"))?
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn screenshot_start_recording(
    app: AppHandle,
    display_id: Option<String>,
    x: Option<u32>,
    y: Option<u32>,
    width: Option<u32>,
    height: Option<u32>,
    format: String,
    fps: Option<u32>,
) -> Result<RecordingStarted, String> {
    // Recording owns an OS thread; also give the overlay a chance to hide by
    // opening the tiny recorder bar window first (frontend hides the overlay
    // before invoking this).
    let region = match (x, y, width, height) {
        (Some(x), Some(y), Some(w), Some(h)) => Some((x, y, w, h)),
        _ => None,
    };
    let recording_id = {
        let app_clone = app.clone();
        tokio::task::spawn_blocking(move || {
            record::start_recording(&app_clone, display_id, region, &format, fps)
        })
        .await
        .map_err(|e| format!("start recording task failed: {e}"))?
        .map_err(internal_error)?
    };
    *current_recording_slot().lock().unwrap() = Some(recording_id.clone());

    open_recorder_bar(&app)?;
    Ok(RecordingStarted { recording_id })
}

#[tauri::command]
pub async fn screenshot_stop_recording(recording_id: String) -> Result<ScreenshotFile, String> {
    let file = tokio::task::spawn_blocking(move || record::stop_recording(&recording_id))
        .await
        .map_err(|e| format!("stop recording task failed: {e}"))?
        .map_err(internal_error)?;
    *current_recording_slot().lock().unwrap() = None;
    Ok(file)
}

#[tauri::command]
pub async fn screenshot_cancel_recording(recording_id: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || record::cancel_recording(&recording_id))
        .await
        .map_err(|e| format!("cancel recording task failed: {e}"))?
        .map_err(internal_error)?;
    *current_recording_slot().lock().unwrap() = None;
    Ok(())
}

/// The recorder bar window reads this to learn which recording it controls.
#[tauri::command]
pub async fn screenshot_current_recording() -> Result<Option<String>, String> {
    Ok(current_recording_slot().lock().unwrap().clone())
}

fn open_recorder_bar(app: &AppHandle) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window(RECORDER_LABEL) {
        let _ = existing.close();
    }
    let url = WebviewUrl::App("index.html#screenshot-recorder".into());
    // Position: bottom-center of the primary display area; the bar frontend
    // recenters itself on its own display via the window API if needed.
    WebviewWindowBuilder::new(app, RECORDER_LABEL, url)
        .title("Recording")
        .inner_size(300.0, 72.0)
        .decorations(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .build()
        .map_err(|e| format!("open recorder bar: {e}"))?;
    Ok(())
}
