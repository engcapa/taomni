//! Platform screen-capture abstraction for the RDP server display side.
//!
//! A [`Capturer`] yields full-frame BGRA images. Backends are `#[cfg]`-gated per
//! platform (the dev plan's §2.5 blueprint, following RustDesk's native-API
//! choices): X11 uses MIT-SHM via `x11rb`; Windows/macOS/Wayland are structural
//! placeholders for now (DXGI / CGDisplayStream / PipeWire), to be filled in as
//! each platform's native backend lands.
//!
//! A captured [`Frame`] is BGRA8888 (`PixelFormat::BgrA32`), top-down, tightly
//! packed at `stride` bytes per row — exactly what `BitmapUpdate` wants, so the
//! display layer can wrap it with zero pixel conversion.

use crate::servers::engine::LogEmitter;

#[cfg(target_os = "linux")]
pub(crate) mod wayland;
#[cfg(target_os = "linux")]
pub(crate) mod x11;

/// One captured frame or sub-region: BGRA8888, `stride` bytes per row,
/// `height` rows. `x`/`y` are the top-left origin of this region within the
/// desktop (0,0 for a full-screen frame), so the display layer can place a
/// cropped damage rectangle at the right offset in the client's framebuffer.
pub(crate) struct Frame {
    pub data: Vec<u8>,
    /// Region origin within the desktop, in pixels.
    pub x: u16,
    pub y: u16,
    pub width: u16,
    pub height: u16,
    /// Bytes per row (`>= width * 4`).
    pub stride: usize,
}

/// A platform screen-capture source. Lives on its own OS thread because most
/// native backends hold thread-affine, non-`Send` handles (X11 SHM pointers,
/// DXGI device contexts, …).
pub(crate) trait Capturer {
    /// Current desktop size in pixels `(width, height)`.
    fn desktop_size(&self) -> (u16, u16);

    /// Capture the whole screen into a BGRA full-frame [`Frame`]. Blocking.
    fn capture(&mut self) -> anyhow::Result<Frame>;

    /// Whether this backend drives itself off change notifications (e.g. X11
    /// XDamage) rather than fixed-interval polling. Event-driven backends sleep
    /// until the screen actually changes and return only the changed regions,
    /// so the caller must NOT add its own poll interval or frame-dedup hashing.
    fn is_event_driven(&self) -> bool {
        false
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

/// Build the best available capturer for this platform, or `Err` with a clear
/// reason. MUST be called on the thread that will own/drive the capturer, since
/// backends are not `Send`.
pub(crate) fn create_capturer(log: &LogEmitter) -> anyhow::Result<Box<dyn Capturer>> {
    #[cfg(target_os = "linux")]
    {
        // Try X11 first whenever an X server is reachable. This is authoritative:
        // on a real Xorg session it captures the desktop directly, and on a
        // Wayland session with XWayland it still captures (XWayland exposes the
        // root window). Only when X11 is genuinely unreachable do we fall back to
        // the Wayland portal path. (Routing on `is_wayland_session()` first was
        // wrong: it skipped a perfectly working X11/`DISPLAY=:0` and dropped
        // straight to the unimplemented Wayland message → synthetic placeholder.)
        match x11::X11Capturer::new(log) {
            Ok(cap) => return Ok(Box::new(cap)),
            Err(x11_err) => {
                if wayland::is_wayland_session() {
                    // No usable X11 but we are on Wayland — report the Wayland
                    // capture status (currently: not built in).
                    match wayland::try_new(log) {
                        Ok(never) => match never {},
                        Err(e) => return Err(e),
                    }
                }
                return Err(x11_err);
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        let _ = log;
        // Phase 1 target backend: Windows Graphics Capture / DXGI Desktop
        // Duplication (see dev plan §2.5). Not yet implemented; the display
        // layer falls back to a synthetic frame source and logs this.
        anyhow::bail!(
            "Windows screen capture (DXGI/WGC) is not implemented yet — RDP server will \
             serve a placeholder frame. Implement servers/rdp/capture/win.rs to enable it."
        )
    }

    #[cfg(target_os = "macos")]
    {
        let _ = log;
        // Phase 1 target backend: CGDisplayStream / ScreenCaptureKit (dev plan §2.5).
        anyhow::bail!(
            "macOS screen capture (CGDisplayStream) is not implemented yet — RDP server will \
             serve a placeholder frame. Implement servers/rdp/capture/mac.rs to enable it."
        )
    }

    #[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
    {
        let _ = log;
        anyhow::bail!("screen capture is not supported on this platform")
    }
}
