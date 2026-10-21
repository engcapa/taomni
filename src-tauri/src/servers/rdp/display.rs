//! RDP server display handler: produces [`DisplayUpdate`] frames for connected
//! clients.
//!
//! Real screen capture runs on a dedicated OS thread (native capture backends
//! hold non-`Send`, thread-affine handles — see [`super::capture`]). That thread
//! publishes BGRA frames through a latest-frame mailbox;
//! [`DisplayUpdatesImpl::next_update`] awaits that mailbox without allowing a
//! slow encoder or network to make the native capture callback retain stale
//! frames. A production RDP listener does not start when capture is unavailable;
//! serving a synthetic frame would falsely report healthy remote desktop service.
//!
//! Backends that can identify damage regions use the same mailbox. If their
//! partial updates would overlap a queued batch, the capture thread publishes a
//! replacement full refresh instead of risking a corrupt client framebuffer.

mod display;

mod updates;

mod mailbox;

mod warmup_macos;

mod warmup_linux;

mod warmup_windows;

mod capture_loop;

#[cfg(test)]
mod tests;

pub(crate) use display::RdpDisplay;

pub(crate) use updates::DisplayUpdatesImpl;
