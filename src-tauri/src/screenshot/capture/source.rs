use super::displays::DisplayInfo;
use super::displays::list_displays;
use super::displays::native_display_id;
#[cfg(not(target_os = "linux"))]
use super::displays::xcap_monitor_for;
#[cfg(target_os = "linux")]
use super::snapshot::wayland_monitor_capture;
#[cfg(target_os = "macos")]
use crate::screenshot::capture::mac_snapshot;
use crate::servers::rdp::capture::Capturer;
use anyhow::Context;
use image::RgbaImage;
use std::time::Instant;
use tauri::AppHandle;

// ---------------------------------------------------------------------------
// Frame sources
// ---------------------------------------------------------------------------

pub(super) enum Backend {
    Persistent(Box<dyn Capturer>),
    OneShot,
    #[cfg(target_os = "linux")]
    Unavailable(String),
    #[cfg(target_os = "macos")]
    MacRegion(anyhow::Result<mac_snapshot::RegionSnapshot>),
}

/// A display frame source. Not `Send`: create it on the thread that uses it.
pub struct FrameSource {
    pub(super) app: AppHandle,
    pub(super) display: DisplayInfo,
    pub(super) backend: Backend,
    pub(super) last: Option<RgbaImage>,
    pub(super) captured_at: Option<Instant>,
    pub(super) region: Option<(u32, u32, u32, u32)>,
    #[cfg(target_os = "windows")]
    pub(super) poll_without_wait: bool,
    #[cfg(target_os = "linux")]
    pub(super) desktop_origin: (i32, i32),
}

// Observe actual constructors/reads in debug QA without replacing capture pixels.
#[cfg(all(debug_assertions, target_os = "macos"))]
pub(super) static QA_STREAM_OPENS: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(0);
#[cfg(all(debug_assertions, target_os = "macos"))]
pub(super) static QA_SNAPSHOT_READS: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(0);
#[cfg(all(debug_assertions, target_os = "macos"))]
pub(in crate::screenshot) fn qa_source_counts() -> (u64, u64) {
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

    pub(super) fn open_with_input(
        app: &AppHandle,
        display: DisplayInfo,
        request_input: bool,
    ) -> Self {
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
}
