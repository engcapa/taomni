//! Wayland screen capture for the RDP server.
//!
//! When no usable X11 connection exists but the session is Wayland, we fall
//! back to [`super::xcap_backend::XcapCapturer`], which uses the xdg-desktop-portal
//! ScreenCast path (user must accept the compositor permission dialog).
//!
//! Input injection remains via enigo's Wayland backend (virtual-keyboard /
//! remote-desktop protocols as supported by the compositor).

use super::Capturer;
use super::xcap_backend::XcapCapturer;
use crate::servers::engine::LogEmitter;

/// True when the current session is Wayland (so the X11/XShm backend will only
/// see XWayland surfaces, not the real desktop — unless XWayland root is enough).
pub(crate) fn is_wayland_session() -> bool {
    if std::env::var_os("WAYLAND_DISPLAY").is_some() {
        return true;
    }
    matches!(std::env::var("XDG_SESSION_TYPE").as_deref(), Ok("wayland"))
}

/// Build a Wayland capturer via xcap/portal.
pub(crate) fn try_new(log: &LogEmitter) -> anyhow::Result<Box<dyn Capturer>> {
    log.line(
        "Wayland session: starting xcap ScreenCast capture. Accept the portal \
         permission dialog if prompted; denial will keep the RDP client on a placeholder.",
    );
    Ok(Box::new(XcapCapturer::new(log)?))
}
