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

/// One captured frame: BGRA8888, `stride` bytes per row, `height` rows.
pub(crate) struct Frame {
    pub data: Vec<u8>,
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

    /// Capture the current screen contents into a BGRA [`Frame`]. Blocking.
    fn capture(&mut self) -> anyhow::Result<Frame>;
}

/// Build the best available capturer for this platform, or `Err` with a clear
/// reason. MUST be called on the thread that will own/drive the capturer, since
/// backends are not `Send`.
pub(crate) fn create_capturer(log: &LogEmitter) -> anyhow::Result<Box<dyn Capturer>> {
    #[cfg(target_os = "linux")]
    {
        // On a pure-Wayland session the X11/XShm backend can only see XWayland
        // surfaces, not the real desktop, so route Wayland sessions to the
        // (portal/PipeWire) Wayland path and let it report what's available.
        if wayland::is_wayland_session() {
            match wayland::try_new(log) {
                Ok(never) => match never {},
                Err(e) => return Err(e),
            }
        }
        // X11 (MIT-SHM).
        let cap = x11::X11Capturer::new(log)?;
        Ok(Box::new(cap))
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
