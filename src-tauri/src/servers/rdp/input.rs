//! RDP server input handler: injects client keyboard/mouse events into the
//! local desktop via `enigo`, the RemoteDesktop portal on Wayland, and native
//! CoreGraphics pointer events on macOS.
//!
//! ## Coordinates
//! [`MouseEvent::Move { x, y }`] carries coordinates in the advertised RDP
//! surface. On macOS that surface uses ScreenCaptureKit physical pixels while
//! CoreGraphics pointer events use global logical points, so [`MacInputMapping`]
//! scales and offsets absolute movement for Retina and secondary displays.
//!
//! ## Keyboard scancodes — the platform-specific part
//! RDP delivers PC/AT **Set 1** scancodes (`KeyboardEvent::Pressed { code, extended }`).
//! How those reach the OS differs by platform, so [`rdp_scancode_to_raw`] adapts:
//!   - **Windows**: native `SendInput` receives the Set-1 code directly; extended
//!     keys split the `0xE0` marker into `KEYEVENTF_EXTENDEDKEY` and the low-byte
//!     hardware scan code.
//!   - **X11/Linux**: `enigo.raw()` takes an *X11 keycode* = Linux evdev code + 8.
//!     RDP Set-1 codes equal evdev codes across the main block, so
//!     `x11_keycode = scancode + 8` is correct for ordinary keys; extended keys
//!     (arrows, Ctrl-right, etc.) need an explicit evdev remap.
//!   - **macOS**: `enigo.raw()` takes a CGKeyCode; we map the common keys and
//!     fall back to `enigo.key()` for the rest.
//!
//! `view_only` short-circuits all injection.

mod queue;

mod permissions;

mod macos;

mod actor;

mod handler;

mod portal;

mod injection;

mod windows;

mod scancodes;

#[cfg(test)]
mod tests;

#[cfg(target_os = "macos")]
pub(crate) use permissions::control_permission_granted;

#[cfg(target_os = "macos")]
pub(crate) use permissions::request_control_permission;

#[cfg(target_os = "macos")]
pub(crate) use macos::MacInputMapping;

pub(crate) use actor::RdpInput;

pub(crate) use scancodes::rdp_scancode_to_raw;

#[cfg(any(target_os = "linux", test))]
pub(crate) use scancodes::linux_scancode_to_keycode;
