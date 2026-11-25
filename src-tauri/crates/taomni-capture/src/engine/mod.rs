//! Platform screen-capture abstraction for the RDP server display side.
//!
//! A [`Capturer`] yields full-frame BGRA images. Backends are `#[cfg]`-gated per
//! platform:
//! - **Linux X11**: MIT-SHM + XDamage via `x11rb` (`x11.rs`)
//! - **Linux Wayland**: `xcap` portal fallback when X11 is unreachable (`wayland.rs`)
//! - **macOS**: persistent native display stream via `xcap` (`mac.rs`)
//! - **Windows**: Windows Graphics Capture with a GDI compatibility fallback
//!
//! A captured [`Frame`] is BGRA8888 (`PixelFormat::BgrA32`), top-down, tightly
//! packed at `stride` bytes per row — exactly what `BitmapUpdate` wants, so the
//! display layer can wrap it with zero pixel conversion.

use crate::CaptureLogger;
use serde::Serialize;
#[cfg(target_os = "macos")]
pub mod xcap_backend;

pub mod stage_trace;

#[cfg(target_os = "linux")]
pub mod wayland;
#[cfg(target_os = "linux")]
pub mod x11;

#[cfg(target_os = "macos")]
pub mod mac;

#[cfg(target_os = "windows")]
pub mod win;
#[cfg(target_os = "windows")]
mod win_wgc;

#[cfg(target_os = "linux")]
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum PortalInput {
    Keycode { code: i32, pressed: bool },
    Keysym { keysym: i32, pressed: bool },
    Button { button: i32, pressed: bool },
    MotionAbsolute { x: f64, y: f64 },
    MotionRelative { dx: f64, dy: f64 },
    Scroll { horizontal: bool, steps: i32 },
}

mod frame;
pub use frame::Frame;

/// A platform screen-capture source. Lives on its own OS thread because most
/// native backends hold thread-affine, non-`Send` handles (X11 SHM pointers,
/// native graphics device contexts, …).
pub trait Capturer {
    /// Current desktop size in pixels `(width, height)`.
    fn desktop_size(&self) -> (u16, u16);

    /// Capture the whole screen into a BGRA full-frame [`Frame`]. Blocking.
    fn capture(&mut self) -> anyhow::Result<Frame>;

    /// Whether this backend can change its output dimensions without changing
    /// the captured desktop. ScreenCaptureKit uses this to scale at the source
    /// to the initial size requested by the RDP client.
    #[cfg(target_os = "macos")]
    fn supports_output_resize(&self) -> bool {
        false
    }

    /// Reconfigure the capture output and return the first frame with the new
    /// dimensions. The default keeps legacy fixed-size capture backends honest.
    #[cfg(target_os = "macos")]
    fn resize_output(&mut self, _width: u16, _height: u16) -> anyhow::Result<Frame> {
        anyhow::bail!("capture backend does not support output resizing")
    }

    /// Poll for the next full frame, distinguishing "nothing changed" from
    /// "capture is broken".
    ///
    /// `Ok(None)` means the backend saw no new content within its own idle
    /// budget. That is the normal state of a static desktop, so the caller MUST
    /// keep polling; treating it as an error terminates the capture thread and
    /// freezes the client on its last frame. `Err` is reserved for a capture
    /// source that has genuinely failed.
    ///
    /// The default implementation preserves the older "every call must yield a
    /// frame" contract used by the X11, Wayland and xcap backends.
    fn poll_frame(&mut self) -> anyhow::Result<Option<Frame>> {
        self.capture().map(Some)
    }

    /// Windows scrolling screenshots pace their own stability samples. Do not
    /// add the stream's idle wait to that interval when no new frame exists.
    #[cfg(target_os = "windows")]
    fn poll_frame_now(&mut self) -> anyhow::Result<Option<Frame>> {
        self.poll_frame()
    }

    /// Whether this backend already caps its own frame rate at the source.
    ///
    /// A self-paced backend blocks inside [`Capturer::poll_frame`] until the
    /// next frame is genuinely available, so the caller must NOT add a poll
    /// interval on top: doing so pages in a frame that is already waiting only
    /// at the next tick, adding up to one whole frame interval of staleness.
    ///
    /// Unlike [`Capturer::is_event_driven`], a self-paced backend still returns
    /// full frames, so the caller keeps its dedup hashing.
    fn is_self_paced(&self) -> bool {
        false
    }

    /// Whether the display loop must scan the complete pixel buffer to suppress
    /// duplicate frames.
    ///
    /// Grab-on-demand sources may return the same desktop on every poll and
    /// therefore need the hash. Native change streams such as ScreenCaptureKit
    /// already distinguish an idle tick from a new frame; hashing those Retina
    /// buffers only adds a full-screen memory pass to every real update.
    fn needs_frame_deduplication(&self) -> bool {
        true
    }

    /// Whether this backend drives itself off change notifications (e.g. X11
    /// XDamage) rather than fixed-interval polling. Event-driven backends sleep
    /// until the screen actually changes and return only the changed regions,
    /// so the caller must NOT add its own poll interval or frame-dedup hashing.
    fn is_event_driven(&self) -> bool {
        false
    }

    /// Whether input can be injected through the capture authorization
    /// context. Wayland's RemoteDesktop portal requires capture and input to
    /// share one session; X11 and other platforms keep their native input path.
    #[cfg(target_os = "linux")]
    fn supports_portal_input(&self) -> bool {
        false
    }

    #[cfg(target_os = "linux")]
    fn inject_portal_input(&mut self, _input: PortalInput) -> anyhow::Result<()> {
        anyhow::bail!("capture backend does not provide portal input")
    }

    /// Drive one update step and return zero or more BGRA regions to send.
    ///
    /// - `first` is true only for the very first call on a fresh connection; an
    ///   event-driven backend MUST return a single full-screen frame then, so
    ///   the encoder's framebuffer is initialized before any cropped region is
    ///   sent (the IronRDP encoder only seeds its framebuffer from a
    ///   full-desktop bitmap; cropped updates diff against it).
    /// - An empty result means "idle tick, nothing changed" — the caller can
    ///   loop again (and check for shutdown) without sending anything.
    ///
    /// The default implementation is the polling path: capture one full frame.
    /// The caller is then responsible for its own interval + dedup. Event-driven
    /// backends override this to block on change notifications and crop.
    fn next_updates(&mut self, first: bool) -> anyhow::Result<Vec<Frame>> {
        let _ = first;
        Ok(vec![self.capture()?])
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureDisplay {
    pub id: String,
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub primary: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureProbe {
    /// `granted`, `denied`, or `notRequired`.
    pub permission: String,
    /// macOS Accessibility permission used for keyboard and pointer injection.
    pub control_permission: String,
    pub displays: Vec<CaptureDisplay>,
    pub summary: String,
}

/// Human-readable capture capability for this OS / session (used by start logs
/// and the settings UI probe). Does not create a long-lived capturer.
pub fn capture_capability_summary() -> String {
    #[cfg(target_os = "linux")]
    {
        if wayland::is_wayland_session() {
            return "Linux Wayland: RemoteDesktop portal + persistent PipeWire capture; \
                    screen and input permission are requested together"
                .into();
        }
        if std::env::var_os("DISPLAY").is_some() {
            return "Linux X11: XShm/XDamage capture with XTest input and XRandR monitoring".into();
        }
        return "Linux: no DISPLAY and not a Wayland session — capture unavailable".into();
    }
    #[cfg(target_os = "macos")]
    {
        return "macOS: persistent native display capture (requires Screen Recording permission)"
            .into();
    }
    #[cfg(target_os = "windows")]
    {
        return "Windows: Windows Graphics Capture with GDI compatibility fallback".into();
    }
    #[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
    {
        "unsupported platform".into()
    }
}

/// Build the best available capturer for this platform, or `Err` with a clear
/// reason. MUST be called on the thread that will own/drive the capturer, since
/// backends are not `Send`.
pub fn create_capturer(log: &CaptureLogger) -> anyhow::Result<Box<dyn Capturer>> {
    create_capturer_for_display(log, None, false)
}

/// Build a capturer for an explicitly selected display. The selector is used
/// on macOS; other platforms retain their existing desktop-selection policy.
pub fn create_capturer_for_display(
    log: &CaptureLogger,
    display_id: Option<&str>,
    request_input: bool,
) -> anyhow::Result<Box<dyn Capturer>> {
    #[cfg(target_os = "linux")]
    {
        let _ = display_id;
        // XWayland's root only contains X11 surfaces. A reachable DISPLAY must
        // never override the session type, otherwise native Wayland windows are
        // silently missing from the shared desktop.
        if wayland::is_wayland_session() {
            return wayland::try_new(log, request_input);
        }
        return Ok(Box::new(x11::X11Capturer::new(log)?));
    }

    #[cfg(target_os = "windows")]
    {
        let _ = request_input;
        return Ok(Box::new(win::WindowsCapturer::new(log, display_id)?));
    }

    #[cfg(target_os = "macos")]
    {
        let _ = request_input;
        mac::try_new(log, display_id)
    }

    #[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
    {
        let _ = (log, request_input);
        anyhow::bail!("screen capture is not supported on this platform")
    }
}

/// Return the permission/display state surfaced by the RDP Server settings.
/// This probe never prompts. The explicit request action is implemented by
/// [`mac::request_permission`] and run on Tauri's main thread.
pub fn probe() -> anyhow::Result<CaptureProbe> {
    #[cfg(target_os = "macos")]
    {
        return mac::probe();
    }

    #[cfg(target_os = "windows")]
    {
        let displays = win::probe_displays()?;
        return Ok(CaptureProbe {
            permission: "notRequired".to_string(),
            control_permission: "notRequired".to_string(),
            displays,
            summary: capture_capability_summary(),
        });
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Ok(CaptureProbe {
            permission: "notRequired".to_string(),
            control_permission: "notRequired".to_string(),
            displays: Vec::new(),
            summary: capture_capability_summary(),
        })
    }
}
