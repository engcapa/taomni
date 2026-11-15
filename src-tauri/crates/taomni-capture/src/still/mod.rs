//! Explicit still policies preserve one-shot portal consent and macOS snapshots.

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
pub mod mac_snapshot;

/// Grey pixels are deliberately unencoded, so callers own their wire format.
#[derive(Debug, PartialEq, Eq)]
pub struct LumaFrame {
    pub width: u32,
    pub height: u32,
    pub luma: Vec<u8>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum StillError {
    NoDisplay(String),
    Failed(String),
}

/// Stills never implicitly substitute a persistent ScreenCast stream.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StillPolicy {
    #[cfg(target_os = "linux")]
    X11RandR,
    #[cfg(target_os = "linux")]
    PortalScreenshot,
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    Xcap,
}

#[cfg(target_os = "linux")]
pub fn native_wayland() -> bool {
    crate::engine::wayland::is_wayland_session()
}

/// Invoke on a blocking worker. PortalScreenshot owns its short-lived runtime;
/// it does not retain a sharing indicator or a PipeWire authorization session.
pub fn capture_all_luma() -> Result<Vec<LumaFrame>, StillError> {
    #[cfg(target_os = "linux")]
    let policy = if native_wayland() {
        StillPolicy::PortalScreenshot
    } else {
        StillPolicy::X11RandR
    };
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    let policy = StillPolicy::Xcap;
    capture_luma(policy)
}

pub fn capture_luma(policy: StillPolicy) -> Result<Vec<LumaFrame>, StillError> {
    match policy {
        #[cfg(target_os = "linux")]
        StillPolicy::X11RandR => linux::capture_x11(),
        #[cfg(target_os = "linux")]
        StillPolicy::PortalScreenshot => linux::capture_portal(),
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        StillPolicy::Xcap => capture_xcap(),
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn capture_xcap() -> Result<Vec<LumaFrame>, StillError> {
    let monitors = xcap::Monitor::all().map_err(|e| StillError::NoDisplay(e.to_string()))?;
    if monitors.is_empty() {
        return Err(StillError::NoDisplay("no displays found".into()));
    }
    let mut frames = Vec::with_capacity(monitors.len());
    let mut failures = Vec::new();
    for monitor in monitors {
        match monitor.capture_image() {
            Ok(image) => {
                let (width, height) = image.dimensions();
                let luma = crate::pixels::rgba_to_luma(image.as_raw(), width, height)
                    .map_err(|e| StillError::Failed(e.to_string()))?;
                frames.push(LumaFrame {
                    width,
                    height,
                    luma,
                });
            }
            Err(error) => failures.push(error.to_string()),
        }
    }
    if frames.is_empty() {
        return Err(StillError::Failed(failures.join("; ")));
    }
    Ok(frames)
}
