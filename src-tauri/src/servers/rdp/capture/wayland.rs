//! Wayland screen capture and input through one xdg-desktop-portal session.
//!
//! A Wayland compositor does not expose the desktop through XWayland. The RDP
//! server therefore asks the RemoteDesktop portal for a monitor ScreenCast and,
//! for interactive sessions, keyboard/pointer devices in the same consent
//! dialog. Frames arrive through a persistent PipeWire stream instead of one
//! portal screenshot request per frame.

mod limits;

mod startup;

mod mailbox;

mod portal;

mod lifetime;

mod frames;

mod pipewire;

#[cfg(test)]
mod tests;

pub(crate) use startup::{MonitorTarget, is_wayland_session, try_new, try_new_for_monitor};

pub(crate) use lifetime::WaylandCapturer;
