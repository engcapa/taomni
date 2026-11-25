//! Scrolling screenshot authorization and input for shared frame sources.
use crate::capture::displays::DisplayInfo;
#[cfg(target_os = "linux")]
use crate::capture::snapshot::wayland_monitor_capture;
use crate::capture::source::{Backend, FrameSource};
use tauri::AppHandle;

impl FrameSource {
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
        if taomni_capture::engine::wayland::is_wayland_session() {
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
        if taomni_capture::engine::wayland::is_wayland_session() {
            use taomni_capture::engine::PortalInput;
            if !matches!(&self.backend, Backend::Persistent(c) if c.supports_portal_input()) {
                // A manual session deliberately starts without pointer access.
                // Request it only when the user switches to Auto, retaining the
                // working capture source until the replacement is approved.
                let log = crate::capture::log::capture_log();
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
}
