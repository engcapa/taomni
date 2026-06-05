//! Wayland screen capture for the RDP server (dev plan §2.5 / phase 5).
//!
//! ## Status on this build
//! Native Wayland capture goes through the `org.freedesktop.portal.ScreenCast`
//! portal → a PipeWire stream (RustDesk's model, minus GStreamer). That requires
//! the `ashpd` + `pipewire` crates, which in turn need the system `libpipewire`
//! development libraries present at build time. Those are NOT a hard dependency
//! of this build, so this module ships the **detection + the documented portal
//! flow**, and returns a clear, actionable error when a pure-Wayland session is
//! detected without the X11 fallback being usable.
//!
//! Input injection on Wayland *is* live: `enigo` is built with its `wayland`
//! feature, so the input handler works on a Wayland session (subject to the
//! compositor honoring the virtual-keyboard / remote-desktop protocols).
//!
//! ## Wiring the PipeWire backend (future work)
//! 1. Add `ashpd` + `pipewire` to `[target.'cfg(target_os="linux")'.dependencies]`
//!    (build host needs `libpipewire-0.3` dev headers).
//! 2. `ashpd::desktop::screencast::Screencast`: `create_session` → `select_sources`
//!    (Monitor) → `start` → obtain the PipeWire fd + node id (this raises the
//!    compositor's permission dialog — handle the user-denied case).
//! 3. Open the PipeWire remote on that fd, connect a stream to the node, and in
//!    the `process` callback copy each buffer's BGRx/RGBx plane into a [`Frame`]
//!    (convert to BGRA, force alpha opaque), mirroring [`super::x11`].
//! 4. Track modifier state manually for input (the portal cannot report key
//!    state), per the dev plan's note.

use crate::servers::engine::LogEmitter;

/// True when the current session is Wayland (so the X11/XShm backend will only
/// see XWayland surfaces, not the real desktop).
pub(crate) fn is_wayland_session() -> bool {
    if std::env::var_os("WAYLAND_DISPLAY").is_some() {
        return true;
    }
    matches!(std::env::var("XDG_SESSION_TYPE").as_deref(), Ok("wayland"))
}

/// Attempt to build a Wayland capturer. Currently always returns `Err` with the
/// concrete steps needed to enable it; kept as a function so `create_capturer`
/// has a single, documented Wayland entry point to flesh out later.
pub(crate) fn try_new(log: &LogEmitter) -> anyhow::Result<std::convert::Infallible> {
    log.line(
        "Wayland session detected. Native Wayland screen capture (PipeWire via the \
         ScreenCast portal) is not built into this binary. Input injection still works \
         via enigo's Wayland backend. To capture the screen, either run an X11/XWayland \
         session or build with the PipeWire portal backend enabled.",
    );
    anyhow::bail!(
        "Wayland screen capture not available in this build (needs the PipeWire portal \
         backend). Use an X11 session, or enable the ashpd/pipewire backend."
    )
}
