use super::displays::DisplayInfo;
use super::displays::list_displays;
use super::displays::native_display_id;
#[cfg(not(target_os = "linux"))]
use super::displays::xcap_monitor_for;
#[cfg(target_os = "linux")]
use super::snapshot::wayland_monitor_capture;
use anyhow::Context;
use image::RgbaImage;
use std::time::Instant;
use taomni_capture::engine::Capturer;
#[cfg(target_os = "macos")]
use taomni_capture::still::mac_snapshot;
use tauri::AppHandle;

// ---------------------------------------------------------------------------
// Frame sources
// ---------------------------------------------------------------------------

pub(crate) enum Backend {
    Persistent(Box<dyn Capturer>),
    OneShot,
    #[cfg(target_os = "linux")]
    Unavailable(String),
    #[cfg(target_os = "macos")]
    MacRegion(anyhow::Result<mac_snapshot::RegionSnapshot>),
}

/// A display frame source. Not `Send`: create it on the thread that uses it.
pub struct FrameSource {
    pub(crate) app: AppHandle,
    pub(crate) display: DisplayInfo,
    pub(crate) backend: Backend,
    pub(crate) last: Option<RgbaImage>,
    pub(crate) captured_at: Option<Instant>,
    pub(crate) region: Option<(u32, u32, u32, u32)>,
    #[cfg(target_os = "windows")]
    pub(crate) poll_without_wait: bool,
    #[cfg(target_os = "linux")]
    pub(crate) desktop_origin: (i32, i32),
}

// Observe actual constructors/reads in debug QA without replacing capture pixels.
#[cfg(all(debug_assertions, target_os = "macos"))]
pub(crate) static QA_STREAM_OPENS: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(0);
#[cfg(all(debug_assertions, target_os = "macos"))]
pub(crate) static QA_SNAPSHOT_READS: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(0);
#[cfg(all(debug_assertions, target_os = "macos"))]
pub(crate) fn qa_source_counts() -> (u64, u64) {
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

    pub(crate) fn open_with_input(
        app: &AppHandle,
        display: DisplayInfo,
        request_input: bool,
    ) -> Self {
        #[cfg(all(debug_assertions, target_os = "macos"))]
        QA_STREAM_OPENS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let log = crate::capture::log::capture_log();
        let native_id = native_display_id(&display);
        #[cfg(target_os = "linux")]
        let capture = if taomni_capture::engine::wayland::is_wayland_session() {
            wayland_monitor_capture(app, &log, &display, request_input)
        } else {
            taomni_capture::engine::create_capturer_for_display(
                &log,
                native_id.as_deref(),
                request_input,
            )
        };
        #[cfg(not(target_os = "linux"))]
        let capture = taomni_capture::engine::create_capturer_for_display(
            &log,
            native_id.as_deref(),
            request_input,
        );
        let backend = match capture {
            Ok(capturer) => Backend::Persistent(capturer),
            Err(e) => {
                #[cfg(target_os = "linux")]
                if taomni_capture::engine::wayland::is_wayland_session() {
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
}
