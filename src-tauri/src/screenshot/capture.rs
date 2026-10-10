//! Display model, still capture and frame sources for the screenshot tool.
//!
//! Displays come from Tauri's monitor API, so every coordinate the tool
//! exchanges uses Tauri's per-monitor physical coordinates. On Linux, convert
//! those coordinates back to GDK logical geometry for portal/GTK monitor lookup.
//! Capture backends:
//!
//! - Windows / macOS stills: `xcap::Monitor::capture_image` (one shot).
//! - Linux stills: the RDP server's X11 SHM / Wayland portal capturer, which
//!   crops the X11 virtual desktop, or selects the target Wayland monitor stream.
//! - macOS recording: one-shot CoreGraphics snapshots, avoiding the display
//!   stream / selective-sharing path implicated in a macOS 14 WindowServer
//!   crash on a VMware display. Both GIF and MP4 use this compatibility path.
//! - Windows / Linux recording: the RDP server's persistent [`Capturer`]
//!   (WGC on Windows, X11/PipeWire on Linux)
//!   through [`FrameSource`], so the backend is not re-initialised per frame.
//!   A backend that fails to start falls back to one-shot capture.
//!
//! Temp artifacts live in a per-process directory that is only served back
//! to the UI through [`ensure_artifact_path`]-guarded commands.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::Context;
use image::RgbaImage;
use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::servers::rdp::capture::{Capturer, Frame};

#[cfg(target_os = "macos")]
#[path = "mac_snapshot.rs"]
mod mac_snapshot;

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DisplayInfo {
    /// Stable within a session: `"{x},{y}"` of the physical origin.
    pub id: String,
    pub name: String,
    /// Physical pixels.
    pub width: u32,
    pub height: u32,
    /// Physical origin in the virtual desktop.
    pub x: i32,
    pub y: i32,
    pub scale_factor: f64,
    pub primary: bool,
}

impl DisplayInfo {
    #[cfg(target_os = "linux")]
    pub(super) fn logical_rect(&self) -> (i32, i32, i32, i32) {
        let scale = self.scale_factor.max(1.0);
        (
            (self.x as f64 / scale).round() as i32,
            (self.y as f64 / scale).round() as i32,
            (self.width as f64 / scale).round() as i32,
            (self.height as f64 / scale).round() as i32,
        )
    }

    pub fn contains(&self, px: f64, py: f64) -> bool {
        px >= self.x as f64
            && py >= self.y as f64
            && px < self.x as f64 + self.width as f64
            && py < self.y as f64 + self.height as f64
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenshotFile {
    pub path: String,
    pub width: u32,
    pub height: u32,
}

// ---------------------------------------------------------------------------
// Temp artifacts
// ---------------------------------------------------------------------------

/// Stale per-process artifact directories older than this are purged at
/// startup (they belong to crashed or long-gone instances).
const STALE_ARTIFACT_AGE: Duration = Duration::from_secs(24 * 60 * 60);

static TRACKED: OnceLock<Mutex<Vec<PathBuf>>> = OnceLock::new();

fn tracked() -> &'static Mutex<Vec<PathBuf>> {
    TRACKED.get_or_init(|| Mutex::new(Vec::new()))
}

fn artifact_root() -> PathBuf {
    std::env::temp_dir().join("taomni-screenshot")
}

/// Per-process artifact directory (several app instances may run at once,
/// e.g. an installed app next to a QA build).
pub fn artifact_dir() -> anyhow::Result<PathBuf> {
    let dir = artifact_root().join(std::process::id().to_string());
    std::fs::create_dir_all(&dir).context("create screenshot temp dir")?;
    Ok(dir)
}

/// New temp artifact path. Tracked files are deleted when the capture
/// session ends (see [`purge_tracked`]).
pub fn temp_artifact_path(prefix: &str, ext: &str) -> anyhow::Result<PathBuf> {
    let path = untracked_artifact_path(prefix, ext)?;
    tracked().lock().unwrap().push(path.clone());
    Ok(path)
}

/// New temp artifact path owned by the caller (pinned images).
pub fn untracked_artifact_path(prefix: &str, ext: &str) -> anyhow::Result<PathBuf> {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    Ok(artifact_dir()?.join(format!("{prefix}-{nanos}.{ext}")))
}

/// Delete every tracked artifact of the finished capture session.
pub fn purge_tracked() {
    let files = std::mem::take(&mut *tracked().lock().unwrap());
    for file in files {
        let _ = std::fs::remove_file(file);
    }
}

/// Startup cleanup: remove this process's leftovers and stale directories of
/// other instances. Directories of live instances are younger than the stale
/// age and survive.
pub fn purge_stale_artifacts() {
    let root = artifact_root();
    let Ok(entries) = std::fs::read_dir(&root) else {
        return;
    };
    let own = std::process::id().to_string();
    for entry in entries.flatten() {
        let path = entry.path();
        let is_own = entry.file_name().to_string_lossy() == own;
        let stale = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .is_some_and(|age| age > STALE_ARTIFACT_AGE);
        if is_own || stale {
            if path.is_dir() {
                let _ = std::fs::remove_dir_all(&path);
            } else {
                let _ = std::fs::remove_file(&path);
            }
        }
    }
}

/// Validate that `path` is an existing file inside this process's artifact
/// directory. Every command that reads a caller-supplied path goes through
/// this, so the webview cannot use them to read or copy arbitrary files.
pub fn ensure_artifact_path(path: &str) -> anyhow::Result<PathBuf> {
    let dir = artifact_dir()?
        .canonicalize()
        .context("resolve screenshot temp dir")?;
    let file = Path::new(path)
        .canonicalize()
        .with_context(|| format!("screenshot file not found: {path}"))?;
    if !file.starts_with(&dir) || !file.is_file() {
        anyhow::bail!("path is not a screenshot artifact: {path}");
    }
    Ok(file)
}

pub fn save_png(image: &RgbaImage, prefix: &str) -> anyhow::Result<(PathBuf, u32, u32)> {
    let path = temp_artifact_path(prefix, "png")?;
    image.save(&path).context("save screenshot png")?;
    Ok((path, image.width(), image.height()))
}

// ---------------------------------------------------------------------------
// Displays
// ---------------------------------------------------------------------------

pub fn list_displays(app: &AppHandle) -> anyhow::Result<Vec<DisplayInfo>> {
    #[cfg(target_os = "linux")]
    let mut displays = {
        // Tauri's AppHandle monitor APIs access GDK directly on the caller's
        // thread. In particular, reading the work area performs Xlib requests.
        // Snapshot them on GTK's main thread before capture/recording workers
        // use the values, otherwise GTK's X11 reply queue can be corrupted.
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        let main_app = app.clone();
        app.run_on_main_thread(move || {
            let _ = tx.send(read_displays(&main_app));
        })
        .context("dispatch monitor enumeration to GTK")?;
        rx.recv_timeout(Duration::from_secs(5))
            .context("wait for GTK monitor enumeration")??
    };
    #[cfg(not(target_os = "linux"))]
    let mut displays = read_displays(app)?;

    // Starting a capture backend can block; keep the fallback off GTK's thread.
    if displays.is_empty() {
        displays = fallback_displays(app)?;
    }
    if !displays.iter().any(|d| d.primary) {
        displays[0].primary = true;
    }
    Ok(displays)
}

fn read_displays(app: &AppHandle) -> anyhow::Result<Vec<DisplayInfo>> {
    let monitors = app.available_monitors().context("enumerate monitors")?;
    let primary = app.primary_monitor().ok().flatten().map(|m| *m.position());
    Ok(monitors
        .iter()
        .map(|m| {
            let pos = *m.position();
            let size = *m.size();
            DisplayInfo {
                id: format!("{},{}", pos.x, pos.y),
                name: m.name().cloned().unwrap_or_else(|| "Display".to_string()),
                width: size.width,
                height: size.height,
                x: pos.x,
                y: pos.y,
                scale_factor: m.scale_factor(),
                primary: primary == Some(pos),
            }
        })
        .filter(|d| d.width > 0 && d.height > 0)
        .collect())
}

/// Some Linux sessions report no monitors through GDK; fall back to the
/// capture backend's desktop size as a single display.
fn fallback_displays(app: &AppHandle) -> anyhow::Result<Vec<DisplayInfo>> {
    #[cfg(target_os = "linux")]
    {
        let log =
            crate::servers::engine::LogEmitter::new(app.clone(), crate::servers::ServerType::Rdp);
        let capturer =
            crate::servers::rdp::capture::create_capturer(&log).context("init screen capturer")?;
        let (width, height) = capturer.desktop_size();
        Ok(vec![DisplayInfo {
            id: "0,0".to_string(),
            name: "Display".to_string(),
            width: u32::from(width),
            height: u32::from(height),
            x: 0,
            y: 0,
            scale_factor: 1.0,
            primary: true,
        }])
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = app;
        anyhow::bail!("no displays found")
    }
}

/// The requested display, or the primary one when `id` is empty/unknown.
pub fn resolve_display(app: &AppHandle, id: Option<&str>) -> anyhow::Result<DisplayInfo> {
    let displays = list_displays(app)?;
    if let Some(want) = id.filter(|v| !v.trim().is_empty()) {
        if let Some(d) = displays.iter().find(|d| d.id == want) {
            return Ok(d.clone());
        }
        anyhow::bail!("display '{want}' is no longer available");
    }
    Ok(primary_of(displays))
}

/// The display under the mouse pointer (hotkey / button trigger), falling
/// back to the primary display.
pub fn display_at_cursor(app: &AppHandle) -> anyhow::Result<DisplayInfo> {
    #[cfg(target_os = "linux")]
    if crate::servers::rdp::capture::wayland::is_wayland_session() {
        // Wayland cannot expose the global cursor; Tao returns a synthetic
        // (0,0). Choose the invoking/main window's monitor before hiding it.
        if let Some(window) = app.get_webview_window("main") {
            return display_for_window(app, &window);
        }
        return resolve_display(app, None);
    }
    let displays = list_displays(app)?;
    if let Ok(pos) = app.cursor_position() {
        if let Some(d) = displays.iter().find(|d| d.contains(pos.x, pos.y)) {
            return Ok(d.clone());
        }
    }
    Ok(primary_of(displays))
}

#[cfg(target_os = "linux")]
pub(super) fn display_for_window(
    app: &AppHandle,
    window: &tauri::WebviewWindow,
) -> anyhow::Result<DisplayInfo> {
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    let window = window.clone();
    app.run_on_main_thread(move || {
        let _ = tx.send(window.current_monitor().map(|m| {
            m.map(|m| {
                let p = m.position();
                format!("{},{}", p.x, p.y)
            })
        }));
    })
    .context("dispatch invoking monitor lookup to GTK")?;
    let id = rx
        .recv_timeout(Duration::from_secs(5))
        .context("wait for invoking monitor")??;
    resolve_display(app, id.as_deref())
}

fn primary_of(displays: Vec<DisplayInfo>) -> DisplayInfo {
    let index = displays.iter().position(|d| d.primary).unwrap_or(0);
    displays
        .into_iter()
        .nth(index)
        .expect("displays is non-empty")
}

/// Map a display to its xcap monitor. xcap reports physical origins on
/// Windows (the app is per-monitor DPI aware) and logical points on macOS.
#[cfg(not(target_os = "linux"))]
fn xcap_monitor_for(display: &DisplayInfo) -> anyhow::Result<xcap::Monitor> {
    let monitors = xcap::Monitor::all().context("enumerate displays")?;
    let scale = if cfg!(target_os = "macos") {
        display.scale_factor
    } else {
        1.0
    };
    let matches = |m: &xcap::Monitor| {
        let mx = (m.x().unwrap_or(0) as f64 * scale).round() as i32;
        let my = (m.y().unwrap_or(0) as f64 * scale).round() as i32;
        (mx - display.x).abs() <= 2 && (my - display.y).abs() <= 2
    };
    monitors
        .iter()
        .find(|m| matches(m))
        .or_else(|| {
            if display.primary {
                monitors.iter().find(|m| m.is_primary().unwrap_or(false))
            } else {
                None
            }
        })
        .or(if monitors.len() == 1 {
            monitors.first()
        } else {
            None
        })
        .cloned()
        .with_context(|| format!("no capture source for display {}", display.id))
}

/// Native display id for the RDP capture backends (xcap id on Windows,
/// CGDirectDisplayID on macOS). Linux captures the whole desktop.
fn native_display_id(display: &DisplayInfo) -> Option<String> {
    #[cfg(not(target_os = "linux"))]
    {
        xcap_monitor_for(display)
            .ok()
            .and_then(|m| m.id().ok())
            .map(|id| id.to_string())
    }
    #[cfg(target_os = "linux")]
    {
        let _ = display;
        None
    }
}

/// Denial-only fault at the permission boundary. It cannot grant OS access and
/// is available only to an isolated debug QA scenario.
#[cfg(all(debug_assertions, target_os = "macos"))]
static QA_DENY_CAPTURE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[cfg(all(debug_assertions, target_os = "macos"))]
pub(super) struct QaPermissionDenial;

#[cfg(all(debug_assertions, target_os = "macos"))]
impl QaPermissionDenial {
    pub(super) fn new(app: &AppHandle) -> anyhow::Result<Self> {
        anyhow::ensure!(
            app.config().identifier == crate::QA_APP_ID,
            "permission fault requires isolated QA app"
        );
        QA_DENY_CAPTURE.store(true, std::sync::atomic::Ordering::SeqCst);
        Ok(Self)
    }
}

#[cfg(all(debug_assertions, target_os = "macos"))]
impl Drop for QaPermissionDenial {
    fn drop(&mut self) {
        QA_DENY_CAPTURE.store(false, std::sync::atomic::Ordering::SeqCst);
    }
}

#[cfg(target_os = "macos")]
pub(super) fn capture_permission_granted() -> bool {
    #[cfg(debug_assertions)]
    if QA_DENY_CAPTURE.load(std::sync::atomic::Ordering::SeqCst) {
        return false;
    }
    crate::servers::rdp::capture::mac::permission_granted()
}

/// CoreGraphics can return a valid image containing only wallpaper and our
/// own windows without Screen Recording access. A successful image read is
/// therefore insufficient evidence that the whole display was captured.
pub(super) fn ensure_capture_permission() -> anyhow::Result<()> {
    #[cfg(target_os = "macos")]
    if !capture_permission_granted() {
        anyhow::bail!(
            "Screenshot requires macOS Screen Recording permission. Open System Settings > Privacy & Security > Screen Recording and enable Taomni. After an update, re-add the current Taomni.app if the existing authorization no longer works. Quit and reopen the app after granting permission. If macOS names a terminal as the requester, enable and restart that terminal instead."
        );
    }
    Ok(())
}

/// Request consent while the invoking windows remain visible. Prompts belong
/// on the main thread; capturing/recording workers only check permission.
pub(super) async fn request_capture_permission(app: &AppHandle) -> anyhow::Result<()> {
    #[cfg(target_os = "macos")]
    if !capture_permission_granted() {
        #[cfg(debug_assertions)]
        if QA_DENY_CAPTURE.load(std::sync::atomic::Ordering::SeqCst) {
            return ensure_capture_permission();
        }
        let (tx, rx) = tokio::sync::oneshot::channel();
        app.run_on_main_thread(move || {
            let _ = tx.send(crate::servers::rdp::capture::mac::request_permission());
        })
        .context("request Screen Recording permission")?;
        let _ = rx
            .await
            .context("Screen Recording permission request cancelled")?;
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
    // macOS may require a restart even after the user accepts the prompt.
    ensure_capture_permission()
}

/// Capture a whole display (physical pixels), without prompting from workers.
pub fn capture_display(app: &AppHandle, display: &DisplayInfo) -> anyhow::Result<RgbaImage> {
    ensure_capture_permission()?;
    #[cfg(not(target_os = "linux"))]
    {
        let _ = app;
        let monitor = xcap_monitor_for(display)?;
        monitor.capture_image().context("capture display")
    }
    #[cfg(target_os = "linux")]
    {
        let mut source = FrameSource::open(app, display.clone());
        let mut latest = source.grab()?;
        // Portal startup retains its first frame. Drain the stream through a
        // short settling interval so that frame cannot freeze a closing
        // chooser or the tail of the application's compositor animation.
        let until = Instant::now() + Duration::from_millis(250);
        while Instant::now() < until {
            if let Some(image) = source.poll()? {
                latest = image.clone();
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        Ok(latest)
    }
}

/// Clamp a region to the image and crop it.
pub fn crop(image: &RgbaImage, x: u32, y: u32, width: u32, height: u32) -> RgbaImage {
    let (rx, ry, rw, rh) = clamp_region(image.width(), image.height(), (x, y, width, height));
    image::imageops::crop_imm(image, rx, ry, rw, rh).to_image()
}

/// Clamp `(x, y, w, h)` into a `full_w` x `full_h` image (at least 1x1).
pub fn clamp_region(
    full_w: u32,
    full_h: u32,
    region: (u32, u32, u32, u32),
) -> (u32, u32, u32, u32) {
    let (x, y, w, h) = region;
    let x = x.min(full_w.saturating_sub(1));
    let y = y.min(full_h.saturating_sub(1));
    let w = w.min(full_w - x).max(1);
    let h = h.min(full_h - y).max(1);
    (x, y, w, h)
}

/// Map a region given in display physical pixels into a frame whose size
/// differs from the display (e.g. ScreenCaptureKit streams in points).
pub fn map_region(
    region: (u32, u32, u32, u32),
    display: (u32, u32),
    frame: (u32, u32),
) -> (u32, u32, u32, u32) {
    if display == frame || display.0 == 0 || display.1 == 0 {
        return clamp_region(frame.0, frame.1, region);
    }
    let sx = frame.0 as f64 / display.0 as f64;
    let sy = frame.1 as f64 / display.1 as f64;
    let (x, y, w, h) = region;
    clamp_region(
        frame.0,
        frame.1,
        (
            (x as f64 * sx).round() as u32,
            (y as f64 * sy).round() as u32,
            (w as f64 * sx).round() as u32,
            (h as f64 * sy).round() as u32,
        ),
    )
}

/// Convert a BGRA capture frame (any stride) to RGBA.
pub(crate) fn frame_to_rgba(frame: &Frame) -> anyhow::Result<RgbaImage> {
    frame_region_to_rgba(
        frame,
        (0, 0, u32::from(frame.width), u32::from(frame.height)),
    )
}

fn frame_region_to_rgba(frame: &Frame, region: (u32, u32, u32, u32)) -> anyhow::Result<RgbaImage> {
    let width = u32::from(frame.width);
    let height = u32::from(frame.height);
    if width == 0 || height == 0 {
        anyhow::bail!("capturer returned an empty frame");
    }
    let bytes = frame.bgra_bytes().context("read frame pixels")?;
    if frame.stride < width as usize * 4 {
        anyhow::bail!("frame stride is smaller than the visible row");
    }
    let (x, y, width, height) = clamp_region(width, height, region);
    let row_bytes = width as usize * 4;
    let mut rgba = vec![0u8; row_bytes * height as usize];
    for (row, out) in rgba.chunks_exact_mut(row_bytes).enumerate() {
        let start = (row + y as usize) * frame.stride + x as usize * 4;
        let src = bytes
            .get(start..start + row_bytes)
            .context("frame row out of bounds")?;
        out.copy_from_slice(src);
        for px in out.chunks_exact_mut(4) {
            px.swap(0, 2);
        }
    }
    RgbaImage::from_raw(width, height, rgba).context("build rgba image")
}

// ---------------------------------------------------------------------------
// Frame sources
// ---------------------------------------------------------------------------

enum Backend {
    Persistent(Box<dyn Capturer>),
    OneShot,
    #[cfg(target_os = "linux")]
    Unavailable(String),
    #[cfg(target_os = "macos")]
    MacRegion(anyhow::Result<mac_snapshot::RegionSnapshot>),
}

/// A display frame source. Not `Send`: create it on the thread that uses it.
pub struct FrameSource {
    app: AppHandle,
    display: DisplayInfo,
    backend: Backend,
    last: Option<RgbaImage>,
    captured_at: Option<Instant>,
    region: Option<(u32, u32, u32, u32)>,
    #[cfg(target_os = "windows")]
    poll_without_wait: bool,
    #[cfg(target_os = "linux")]
    desktop_origin: (i32, i32),
}

// Observe actual constructors/reads in debug QA without replacing capture pixels.
#[cfg(all(debug_assertions, target_os = "macos"))]
static QA_STREAM_OPENS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
#[cfg(all(debug_assertions, target_os = "macos"))]
static QA_SNAPSHOT_READS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
#[cfg(all(debug_assertions, target_os = "macos"))]
pub(super) fn qa_source_counts() -> (u64, u64) {
    use std::sync::atomic::Ordering;
    (
        QA_STREAM_OPENS.load(Ordering::Relaxed),
        QA_SNAPSHOT_READS.load(Ordering::Relaxed),
    )
}

impl FrameSource {
    /// Persistent backend when available (Linux always needs it for stills).
    pub fn open(app: &AppHandle, display: DisplayInfo) -> Self {
        Self::open_with_input(app, display, false)
    }

    fn open_with_input(app: &AppHandle, display: DisplayInfo, request_input: bool) -> Self {
        #[cfg(all(debug_assertions, target_os = "macos"))]
        QA_STREAM_OPENS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let log =
            crate::servers::engine::LogEmitter::new(app.clone(), crate::servers::ServerType::Rdp);
        let native_id = native_display_id(&display);
        #[cfg(target_os = "linux")]
        let capture = if crate::servers::rdp::capture::wayland::is_wayland_session() {
            wayland_monitor_capture(app, &log, &display, request_input)
        } else {
            crate::servers::rdp::capture::create_capturer_for_display(
                &log,
                native_id.as_deref(),
                request_input,
            )
        };
        #[cfg(not(target_os = "linux"))]
        let capture = crate::servers::rdp::capture::create_capturer_for_display(
            &log,
            native_id.as_deref(),
            request_input,
        );
        let backend = match capture {
            Ok(capturer) => Backend::Persistent(capturer),
            Err(e) => {
                #[cfg(target_os = "linux")]
                if crate::servers::rdp::capture::wayland::is_wayland_session() {
                    // Retrying a generic one-shot source would silently capture
                    // a different monitor and mask denial/metadata errors.
                    return Self {
                        app: app.clone(),
                        display,
                        backend: Backend::Unavailable(format!("{e:#}")),
                        last: None,
                        captured_at: None,
                        region: None,
                        desktop_origin: (0, 0),
                    };
                }
                log::warn!(
                    "screenshot: persistent capture unavailable ({e:#}); using one-shot capture"
                );
                Backend::OneShot
            }
        };
        #[cfg(target_os = "linux")]
        let desktop_origin = list_displays(app)
            .map(|ds| {
                (
                    ds.iter().map(|d| d.x).min().unwrap_or(0),
                    ds.iter().map(|d| d.y).min().unwrap_or(0),
                )
            })
            .unwrap_or((0, 0));
        Self {
            app: app.clone(),
            display,
            backend,
            last: None,
            captured_at: None,
            region: None,
            #[cfg(target_os = "windows")]
            poll_without_wait: false,
            #[cfg(target_os = "linux")]
            desktop_origin,
        }
    }

    /// Wayland capture and input must share the same approved portal session.
    pub fn for_scroll(
        app: &AppHandle,
        display: DisplayInfo,
        automatic: bool,
        region: (u32, u32, u32, u32),
    ) -> Self {
        // Reopening WGC for every sample can capture session/compositor
        // transitions around window edges. Retain one stream; grab() returns
        // the last frame without blocking when the desktop is unchanged.
        #[cfg(target_os = "windows")]
        {
            let _ = automatic;
            let mut source = Self::open(app, display);
            source.region = Some(region);
            source.poll_without_wait = true;
            return source;
        }
        #[cfg(target_os = "linux")]
        if crate::servers::rdp::capture::wayland::is_wayland_session() {
            let mut source = Self::open_with_input(app, display, automatic);
            source.region = Some(region);
            return source;
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = automatic;
            let mut source = Self::one_shot(app, display);
            source.region = Some(region);
            source
        }
    }

    /// Returns false for platforms that use their native input injector.
    pub fn portal_scroll(&mut self, px: u32, py: u32, notches: i32) -> anyhow::Result<bool> {
        #[cfg(target_os = "linux")]
        if crate::servers::rdp::capture::wayland::is_wayland_session() {
            use crate::servers::rdp::capture::PortalInput;
            if !matches!(&self.backend, Backend::Persistent(c) if c.supports_portal_input()) {
                // A manual session deliberately starts without pointer access.
                // Request it only when the user switches to Auto, retaining the
                // working capture source until the replacement is approved.
                let log = crate::servers::engine::LogEmitter::new(
                    self.app.clone(),
                    crate::servers::ServerType::Rdp,
                );
                let replacement = wayland_monitor_capture(&self.app, &log, &self.display, true)?;
                anyhow::ensure!(
                    replacement.supports_portal_input(),
                    "Wayland pointer permission was not granted. Allow remote control to use automatic scrolling, or continue manually."
                );
                self.backend = Backend::Persistent(replacement);
                self.last = None;
                self.captured_at = None;
            }
            let Backend::Persistent(capturer) = &mut self.backend else {
                anyhow::bail!("Wayland portal capture unavailable");
            };
            // Establish the hover target once. Moving on every wheel event
            // steals control of the pointer from the user on Wayland.
            if notches == 0 {
                capturer.inject_portal_input(PortalInput::MotionAbsolute {
                    x: px as f64,
                    y: py as f64,
                })?;
            }
            capturer.inject_portal_input(PortalInput::Scroll {
                horizontal: false,
                steps: notches,
            })?;
            return Ok(true);
        }
        let _ = (px, py, notches);
        Ok(false)
    }

    /// Recording retains only the requested region. Persistent backends crop
    /// before BGRA conversion; macOS snapshots request only this region.
    pub fn for_region(app: &AppHandle, display: DisplayInfo, region: (u32, u32, u32, u32)) -> Self {
        // Select this before opening any persistent stream: WindowServer can
        // crash after a successful start, so an error-based fallback is too late.
        #[cfg(target_os = "macos")]
        let source = {
            log::info!("screenshot recording: using CoreGraphics snapshots on macOS");
            let mut source = Self::one_shot(app, display);
            // Resolve the display once. Enumerating every monitor for every
            // frame adds WindowServer work unrelated to the requested pixels.
            source.backend = Backend::MacRegion((|| {
                let monitor = xcap_monitor_for(&source.display)?;
                mac_snapshot::RegionSnapshot::new(
                    monitor.id().context("recording display id")?,
                    (source.display.width, source.display.height),
                    region,
                )
            })());
            source
        };
        #[cfg(not(target_os = "macos"))]
        let mut source = Self::open(app, display);
        #[cfg(not(target_os = "macos"))]
        {
            source.region = Some(region);
        }
        source
    }

    fn decode_frame(&self, frame: &Frame) -> anyhow::Result<RgbaImage> {
        let Some(region) = self.region else {
            return Ok(self.crop_desktop(frame_to_rgba(frame)?));
        };
        let (width, height) = (u32::from(frame.width), u32::from(frame.height));
        #[cfg(target_os = "linux")]
        let rect = {
            if crate::servers::rdp::capture::wayland::is_wayland_session() {
                map_region(
                    region,
                    (self.display.width, self.display.height),
                    (width, height),
                )
            } else {
                let x = (self.display.x - self.desktop_origin.0).max(0) as u32;
                let y = (self.display.y - self.desktop_origin.1).max(0) as u32;
                (
                    x.saturating_add(region.0),
                    y.saturating_add(region.1),
                    region.2,
                    region.3,
                )
            }
        };
        #[cfg(not(target_os = "linux"))]
        let rect = map_region(
            region,
            (self.display.width, self.display.height),
            (width, height),
        );
        frame_region_to_rgba(frame, rect)
    }

    fn decode_one_shot(&self) -> anyhow::Result<RgbaImage> {
        #[cfg(all(debug_assertions, target_os = "macos"))]
        QA_SNAPSHOT_READS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let full = capture_one_shot(&self.app, &self.display)?;
        match self.region {
            None => Ok(full),
            Some(region) => {
                let (x, y, w, h) = map_region(
                    region,
                    (self.display.width, self.display.height),
                    full.dimensions(),
                );
                Ok(crop(&full, x, y, w, h))
            }
        }
    }

    /// One-shot source for stills and macOS scrolling. Windows scrolling uses
    /// a persistent stream and retains the last frame when the screen is idle.
    pub fn one_shot(app: &AppHandle, display: DisplayInfo) -> Self {
        #[cfg(target_os = "linux")]
        {
            Self::open(app, display)
        }
        #[cfg(not(target_os = "linux"))]
        {
            Self {
                app: app.clone(),
                display,
                backend: Backend::OneShot,
                last: None,
                captured_at: None,
                region: None,
                #[cfg(target_os = "windows")]
                poll_without_wait: false,
            }
        }
    }

    /// Next frame of the display: `Some` when the backend produced a new one,
    /// `None` when the screen is unchanged since the previous call.
    pub fn poll(&mut self) -> anyhow::Result<Option<&RgbaImage>> {
        let image = match &mut self.backend {
            Backend::Persistent(capturer) => match {
                #[cfg(target_os = "windows")]
                if self.poll_without_wait {
                    capturer.poll_frame_now()
                } else {
                    capturer.poll_frame()
                }
                #[cfg(not(target_os = "windows"))]
                capturer.poll_frame()
            }? {
                Some(frame) => {
                    self.captured_at = Some(frame.captured_at);
                    Some(self.decode_frame(&frame)?)
                }
                None => None,
            },
            Backend::OneShot => {
                let image = self.decode_one_shot()?;
                self.captured_at = Some(Instant::now());
                Some(image)
            }
            #[cfg(target_os = "linux")]
            Backend::Unavailable(error) => anyhow::bail!("{error}"),
            #[cfg(target_os = "macos")]
            Backend::MacRegion(snapshot) => {
                ensure_capture_permission()?;
                #[cfg(debug_assertions)]
                QA_SNAPSHOT_READS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                let (image, captured_at) = snapshot
                    .as_ref()
                    .map_err(|error| anyhow::anyhow!("{error:#}"))?
                    .capture()?;
                self.captured_at = Some(captured_at);
                Some(image)
            }
        };
        match image {
            Some(image) => {
                self.last = Some(image);
                Ok(self.last.as_ref())
            }
            None if self.last.is_none() => {
                // Event-driven backends may idle before the first frame;
                // a full capture establishes the baseline.
                let image = match &mut self.backend {
                    Backend::Persistent(capturer) => {
                        let frame = capturer.capture()?;
                        self.captured_at = Some(frame.captured_at);
                        self.decode_frame(&frame)?
                    }
                    Backend::OneShot => {
                        let image = self.decode_one_shot()?;
                        self.captured_at = Some(Instant::now());
                        image
                    }
                    #[cfg(target_os = "linux")]
                    Backend::Unavailable(error) => anyhow::bail!("{error}"),
                    #[cfg(target_os = "macos")]
                    Backend::MacRegion(_) => {
                        unreachable!("region snapshots always return an image")
                    }
                };
                self.last = Some(image);
                Ok(self.last.as_ref())
            }
            None => Ok(None),
        }
    }

    /// Timestamp of the native pixels, before conversion/resizing/encoding.
    pub fn captured_at(&self) -> Option<Instant> {
        self.captured_at
    }

    /// Latest frame (new or unchanged).
    pub fn grab(&mut self) -> anyhow::Result<RgbaImage> {
        self.poll()?;
        self.last.clone().context("no frame captured")
    }

    /// Linux backends capture the virtual desktop; keep only this display.
    fn crop_desktop(&self, desktop: RgbaImage) -> RgbaImage {
        #[cfg(target_os = "linux")]
        {
            if crate::servers::rdp::capture::wayland::is_wayland_session() {
                desktop
            } else {
                crop_desktop_to_display(&self.app, desktop, &self.display)
            }
        }
        #[cfg(not(target_os = "linux"))]
        {
            desktop
        }
    }
}

#[cfg(target_os = "linux")]
fn wayland_monitor_capture(
    app: &AppHandle,
    log: &crate::servers::engine::LogEmitter,
    display: &DisplayInfo,
    request_input: bool,
) -> anyhow::Result<Box<dyn Capturer>> {
    use crate::servers::rdp::capture::wayland::{MonitorTarget, try_new_for_monitor};
    let (x, y, width, height) = display.logical_rect();
    try_new_for_monitor(
        log,
        request_input,
        MonitorTarget {
            position: (x, y),
            size: (width, height),
            single_monitor: list_displays(app)?.len() == 1,
        },
    )
}

fn capture_one_shot(app: &AppHandle, display: &DisplayInfo) -> anyhow::Result<RgbaImage> {
    #[cfg(not(target_os = "linux"))]
    {
        capture_display(app, display)
    }
    #[cfg(target_os = "linux")]
    {
        let log =
            crate::servers::engine::LogEmitter::new(app.clone(), crate::servers::ServerType::Rdp);
        let mut capturer =
            crate::servers::rdp::capture::create_capturer(&log).context("init screen capturer")?;
        let frame = capturer.capture().context("capture frame")?;
        Ok(crop_desktop_to_display(
            app,
            frame_to_rgba(&frame)?,
            display,
        ))
    }
}

#[cfg(target_os = "linux")]
fn crop_desktop_to_display(
    app: &AppHandle,
    desktop: RgbaImage,
    display: &DisplayInfo,
) -> RgbaImage {
    if desktop.dimensions() == (display.width, display.height) {
        return desktop;
    }
    // The X11 root origin is the top-left of the bounding
    // box of all monitors.
    let (min_x, min_y) = list_displays(app)
        .map(|ds| {
            (
                ds.iter().map(|d| d.x).min().unwrap_or(0),
                ds.iter().map(|d| d.y).min().unwrap_or(0),
            )
        })
        .unwrap_or((0, 0));
    let x = (display.x - min_x).max(0) as u32;
    let y = (display.y - min_y).max(0) as u32;
    crop(&desktop, x, y, display.width, display.height)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "linux")]
    #[test]
    fn gdk_geometry_restores_each_monitors_logical_origin_and_size() {
        let display = DisplayInfo {
            id: "-3840,0".into(),
            name: "left 200%".into(),
            x: -3840,
            y: 0,
            width: 2560,
            height: 1440,
            scale_factor: 2.0,
            primary: false,
        };
        assert_eq!(display.logical_rect(), (-1920, 0, 1280, 720));
    }

    #[test]
    fn clamp_region_stays_inside_image() {
        assert_eq!(clamp_region(100, 50, (90, 40, 30, 30)), (90, 40, 10, 10));
        assert_eq!(clamp_region(100, 50, (500, 500, 10, 10)), (99, 49, 1, 1));
        assert_eq!(clamp_region(100, 50, (0, 0, 0, 0)), (0, 0, 1, 1));
    }

    #[test]
    fn map_region_scales_into_point_sized_frames() {
        // A Retina display streamed at points: half the physical size.
        assert_eq!(
            map_region((200, 100, 400, 300), (2880, 1800), (1440, 900)),
            (100, 50, 200, 150)
        );
        assert_eq!(
            map_region((10, 20, 30, 40), (1920, 1080), (1920, 1080)),
            (10, 20, 30, 40)
        );
    }

    #[test]
    fn display_contains_uses_half_open_bounds() {
        let d = DisplayInfo {
            id: "-1920,0".into(),
            name: "Left".into(),
            width: 1920,
            height: 1080,
            x: -1920,
            y: 0,
            scale_factor: 1.0,
            primary: false,
        };
        assert!(d.contains(-1920.0, 0.0));
        assert!(d.contains(-1.0, 1079.0));
        assert!(!d.contains(0.0, 0.0));
    }

    #[test]
    fn artifact_paths_are_confined_to_the_artifact_dir() {
        let (path, _, _) = save_png(&RgbaImage::new(2, 2), "unit").unwrap();
        assert!(ensure_artifact_path(&path.to_string_lossy()).is_ok());
        let outside =
            std::env::temp_dir().join(format!("taomni-outside-{}.png", std::process::id()));
        std::fs::write(&outside, b"x").unwrap();
        assert!(ensure_artifact_path(&outside.to_string_lossy()).is_err());
        let traversal = artifact_dir()
            .unwrap()
            .join("..")
            .join("..")
            .join(outside.file_name().unwrap());
        assert!(ensure_artifact_path(&traversal.to_string_lossy()).is_err());
        std::fs::remove_file(outside).ok();
        std::fs::remove_file(path).ok();
    }

    #[test]
    fn cropped_frame_conversion_matches_full_crop_with_stride_padding() {
        let (width, height, stride) = (7u16, 6u16, 36usize);
        let mut data = vec![0u8; stride * usize::from(height)];
        for y in 0..usize::from(height) {
            for x in 0..usize::from(width) {
                let i = y * stride + x * 4;
                data[i..i + 4].copy_from_slice(&[x as u8, y as u8, (x + y) as u8, 255]);
            }
        }
        let frame = Frame::bgra(data, 0, 0, width, height, stride);
        let full = frame_to_rgba(&frame).unwrap();
        for rect in [(2, 1, 3, 4), (5, 4, 20, 20), (0, 0, 7, 6)] {
            let (x, y, w, h) = rect;
            assert_eq!(
                frame_region_to_rgba(&frame, rect).unwrap(),
                crop(&full, x, y, w, h)
            );
        }
        let small = frame_region_to_rgba(&frame, (2, 1, 3, 4)).unwrap();
        assert_eq!(small.dimensions(), (3, 4));
        assert_eq!(small.get_pixel(0, 0).0, [3, 1, 2, 255]);
    }

    #[test]
    fn cropped_frame_conversion_rejects_incomplete_rows() {
        let frame = Frame::bgra(vec![0u8; 12], 0, 0, 3, 2, 12);
        assert!(frame_region_to_rgba(&frame, (1, 1, 1, 1)).is_err());
        let frame = Frame::bgra(vec![0u8; 24], 0, 0, 3, 2, 8);
        assert!(frame_region_to_rgba(&frame, (0, 0, 1, 1)).is_err());
    }

    #[test]
    fn frame_conversion_swaps_channels_and_honours_stride() {
        // 1x2 frame with 8 bytes of padding per row.
        let mut data = vec![0u8; 2 * 12];
        data[0..4].copy_from_slice(&[10, 20, 30, 255]);
        data[12..16].copy_from_slice(&[1, 2, 3, 4]);
        let frame = Frame::bgra(data, 0, 0, 1, 2, 12);
        let image = frame_to_rgba(&frame).unwrap();
        assert_eq!(image.get_pixel(0, 0).0, [30, 20, 10, 255]);
        assert_eq!(image.get_pixel(0, 1).0, [3, 2, 1, 4]);
    }
}
