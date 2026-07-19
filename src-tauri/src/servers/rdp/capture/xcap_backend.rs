//! Shared `xcap`-based screen capturer used by:
//! - macOS RDP server (primary backend)
//! - Linux pure-Wayland fallback when X11/XWayland is unavailable
//!
//! `xcap` returns RGBA8 full frames. We convert to BGRA for the RDP encoder
//! (`PixelFormat::BgrA32`) and poll at ~20 fps with frame-hash dedup handled by
//! the display capture loop.

use super::{Capturer, Frame};
use crate::servers::engine::LogEmitter;

pub(crate) struct XcapCapturer {
    width: u16,
    height: u16,
    /// Monitor index within `xcap::Monitor::all()` (primary = 0 when present).
    monitor_index: usize,
}

impl XcapCapturer {
    pub(crate) fn new(log: &LogEmitter) -> anyhow::Result<Self> {
        let monitors = xcap::Monitor::all().map_err(|e| {
            anyhow::anyhow!(
                "xcap: cannot enumerate monitors ({e}). On macOS grant Screen Recording \
                 permission to Taomni (System Settings → Privacy & Security → Screen Recording)."
            )
        })?;
        let monitor = monitors
            .into_iter()
            .next()
            .ok_or_else(|| anyhow::anyhow!("xcap: no monitors found"))?;

        // Capture once to learn size and prove permission is granted.
        let image = monitor.capture_image().map_err(|e| {
            anyhow::anyhow!(
                "xcap: initial capture failed ({e}). On macOS enable Screen Recording for \
                 this app; on Wayland accept the portal ScreenCast prompt."
            )
        })?;
        let width = u16::try_from(image.width()).unwrap_or(1);
        let height = u16::try_from(image.height()).unwrap_or(1);
        log.line(format!(
            "xcap capturer ready ({}x{}, monitor index 0)",
            width, height
        ));
        Ok(Self {
            width,
            height,
            monitor_index: 0,
        })
    }

    fn grab_monitor(&self) -> anyhow::Result<xcap::Monitor> {
        let monitors = xcap::Monitor::all().map_err(|e| anyhow::anyhow!("xcap enum: {e}"))?;
        monitors
            .into_iter()
            .nth(self.monitor_index)
            .or_else(|| {
                // Monitor list may reorder after sleep/lid; fall back to first.
                xcap::Monitor::all().ok().and_then(|m| m.into_iter().next())
            })
            .ok_or_else(|| anyhow::anyhow!("xcap: no monitor available"))
    }
}

impl Capturer for XcapCapturer {
    fn desktop_size(&self) -> (u16, u16) {
        (self.width, self.height)
    }

    fn capture(&mut self) -> anyhow::Result<Frame> {
        let monitor = self.grab_monitor()?;
        let image = monitor
            .capture_image()
            .map_err(|e| anyhow::anyhow!("xcap capture: {e}"))?;
        let w = image.width();
        let h = image.height();
        self.width = u16::try_from(w).unwrap_or(self.width);
        self.height = u16::try_from(h).unwrap_or(self.height);

        // image crate RgbaImage: tightly packed RGBA8.
        let rgba = image.into_raw();
        let mut bgra = Vec::with_capacity(rgba.len());
        for px in rgba.chunks_exact(4) {
            bgra.push(px[2]); // B
            bgra.push(px[1]); // G
            bgra.push(px[0]); // R
            bgra.push(px[3]); // A
        }
        let stride = (w as usize).saturating_mul(4);
        Ok(Frame {
            data: bgra,
            x: 0,
            y: 0,
            width: self.width,
            height: self.height,
            stride,
        })
    }
}
