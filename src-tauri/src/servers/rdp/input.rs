//! RDP server input handler: injects client keyboard/mouse events into the
//! local desktop via `enigo`.
//!
//! ## Coordinates
//! `ironrdp-server` already converts the client's normalized RDP coordinate
//! space into screen pixels, so [`MouseEvent::Move { x, y }`] carries pixel
//! coordinates we pass straight to `enigo.move_mouse(.., Coordinate::Abs)`.
//! (The dev plan's `x = X*W/65535` formula applies inside IronRDP, not here.)
//!
//! ## Keyboard scancodes — the platform-specific part
//! RDP delivers PC/AT **Set 1** scancodes (`KeyboardEvent::Pressed { code, extended }`).
//! How those reach the OS differs by platform, so [`rdp_scancode_to_raw`] adapts:
//!   - **Windows**: `enigo.raw()` takes a scancode directly (`KEYEVENTF_SCANCODE`),
//!     so we pass the Set-1 code through (extended keys keep the `0xE0` prefix bit).
//!   - **X11/Linux**: `enigo.raw()` takes an *X11 keycode* = Linux evdev code + 8.
//!     RDP Set-1 codes equal evdev codes across the main block, so
//!     `x11_keycode = scancode + 8` is correct for ordinary keys; extended keys
//!     (arrows, Ctrl-right, etc.) need an explicit evdev remap.
//!   - **macOS**: `enigo.raw()` takes a CGKeyCode; we map the common keys and
//!     fall back to `enigo.key()` for the rest.
//!
//! `view_only` short-circuits all injection.

use enigo::{
    Axis, Button, Coordinate,
    Direction::{Press, Release},
    Enigo, Keyboard, Mouse, Settings,
};
use ironrdp::server::{KeyboardEvent, MouseEvent, RdpServerInputHandler};

use crate::servers::engine::LogEmitter;

pub(crate) struct RdpInput {
    log: LogEmitter,
    view_only: bool,
    /// `None` if enigo failed to initialize (no display / no permission); we log
    /// once and then silently drop input rather than spamming.
    enigo: Option<Enigo>,
    warned: bool,
}

impl RdpInput {
    pub(crate) fn new(log: LogEmitter, view_only: bool) -> Self {
        let enigo = if view_only {
            None
        } else {
            match Enigo::new(&Settings::default()) {
                Ok(e) => Some(e),
                Err(e) => {
                    log.line(format!(
                        "input injection unavailable ({}); connection will be view-only",
                        e
                    ));
                    None
                }
            }
        };
        Self {
            log,
            view_only,
            enigo,
            warned: false,
        }
    }

    fn enigo(&mut self) -> Option<&mut Enigo> {
        if self.view_only {
            return None;
        }
        if self.enigo.is_none() && !self.warned {
            self.warned = true;
            self.log.line("input dropped: no injection backend");
        }
        self.enigo.as_mut()
    }
}

impl RdpServerInputHandler for RdpInput {
    fn keyboard(&mut self, event: KeyboardEvent) {
        let Some(enigo) = self.enigo() else { return };
        match event {
            KeyboardEvent::Pressed { code, extended } => {
                if let Some(raw) = rdp_scancode_to_raw(code, extended) {
                    let _ = enigo.raw(raw, Press);
                }
            }
            KeyboardEvent::Released { code, extended } => {
                if let Some(raw) = rdp_scancode_to_raw(code, extended) {
                    let _ = enigo.raw(raw, Release);
                }
            }
            KeyboardEvent::UnicodePressed(c) => {
                if let Some(ch) = char::from_u32(u32::from(c)) {
                    let _ = enigo.key(enigo::Key::Unicode(ch), Press);
                }
            }
            KeyboardEvent::UnicodeReleased(c) => {
                if let Some(ch) = char::from_u32(u32::from(c)) {
                    let _ = enigo.key(enigo::Key::Unicode(ch), Release);
                }
            }
            KeyboardEvent::Synchronize(_flags) => {
                // Lock-key state sync (Caps/Num/Scroll). Tracking host lock state
                // and reconciling is a refinement; ignored for now.
            }
        }
    }

    fn mouse(&mut self, event: MouseEvent) {
        let Some(enigo) = self.enigo() else { return };
        match event {
            MouseEvent::Move { x, y } => {
                let _ = enigo.move_mouse(i32::from(x), i32::from(y), Coordinate::Abs);
            }
            MouseEvent::LeftPressed => {
                let _ = enigo.button(Button::Left, Press);
            }
            MouseEvent::LeftReleased => {
                let _ = enigo.button(Button::Left, Release);
            }
            MouseEvent::RightPressed => {
                let _ = enigo.button(Button::Right, Press);
            }
            MouseEvent::RightReleased => {
                let _ = enigo.button(Button::Right, Release);
            }
            MouseEvent::MiddlePressed => {
                let _ = enigo.button(Button::Middle, Press);
            }
            MouseEvent::MiddleReleased => {
                let _ = enigo.button(Button::Middle, Release);
            }
            MouseEvent::Button4Pressed => {
                // `Button::Back`/`Forward` don't exist on macOS in enigo 0.3.
                #[cfg(any(target_os = "windows", all(unix, not(target_os = "macos"))))]
                {
                    let _ = enigo.button(Button::Back, Press);
                }
            }
            MouseEvent::Button4Released => {
                #[cfg(any(target_os = "windows", all(unix, not(target_os = "macos"))))]
                {
                    let _ = enigo.button(Button::Back, Release);
                }
            }
            MouseEvent::Button5Pressed => {
                #[cfg(any(target_os = "windows", all(unix, not(target_os = "macos"))))]
                {
                    let _ = enigo.button(Button::Forward, Press);
                }
            }
            MouseEvent::Button5Released => {
                #[cfg(any(target_os = "windows", all(unix, not(target_os = "macos"))))]
                {
                    let _ = enigo.button(Button::Forward, Release);
                }
            }
            MouseEvent::VerticalScroll { value } => {
                // RDP wheel units are 120 per notch; positive = up. enigo's
                // `scroll` uses positive = down, so invert and normalize.
                let notches = -(i32::from(value) / 120);
                let notches = if notches == 0 {
                    if value > 0 {
                        -1
                    } else if value < 0 {
                        1
                    } else {
                        0
                    }
                } else {
                    notches
                };
                if notches != 0 {
                    let _ = enigo.scroll(notches, Axis::Vertical);
                }
            }
            MouseEvent::Scroll { x, y } => {
                if x != 0 {
                    let _ = enigo.scroll(x, Axis::Horizontal);
                }
                if y != 0 {
                    let _ = enigo.scroll(y, Axis::Vertical);
                }
            }
            MouseEvent::RelMove { x, y } => {
                let _ = enigo.move_mouse(x, y, Coordinate::Rel);
            }
        }
    }
}

/// Translate an RDP PC/AT Set-1 scancode + extended flag into the `u16` keycode
/// `enigo::Keyboard::raw` expects on this platform. Returns `None` for codes we
/// can't represent (caller then drops the event).
///
/// Split out as a free function so the mapping can be unit-tested without a real
/// `Enigo`/display.
pub(crate) fn rdp_scancode_to_raw(scancode: u8, extended: bool) -> Option<u16> {
    #[cfg(target_os = "windows")]
    {
        // Windows `raw()` takes the scancode directly. Mark extended keys with
        // the 0xE0 prefix bit so `MAPVK_VSC_TO_VK_EX` resolves the right VK.
        let mut sc = u16::from(scancode);
        if extended {
            sc |= 0xE000;
        }
        Some(sc)
    }

    #[cfg(target_os = "linux")]
    {
        Some(linux_scancode_to_keycode(scancode, extended))
    }

    #[cfg(target_os = "macos")]
    {
        // CGKeyCode space differs entirely from PC scancodes; only a partial map
        // is practical. Unmapped keys are dropped here and could be handled via
        // `enigo.key()` at the call site in a refinement.
        let _ = extended;
        macos_scancode_to_keycode(scancode)
    }

    #[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
    {
        let _ = (scancode, extended);
        None
    }
}

/// X11 keycode for an RDP Set-1 scancode. X11 keycode = Linux evdev code + 8.
/// For the main keyboard block, RDP Set-1 codes equal evdev codes, so the base
/// case is `scancode + 8`. Extended (0xE0-prefixed) keys map to distinct evdev
/// codes and are handled explicitly.
#[cfg(any(target_os = "linux", test))]
pub(crate) fn linux_scancode_to_keycode(scancode: u8, extended: bool) -> u16 {
    // Selected extended-key evdev codes (Linux input-event-codes.h). These do
    // NOT equal `scancode + 8`, so they need an explicit table.
    if extended {
        let evdev = match scancode {
            0x1C => 96,  // KEY_KPENTER
            0x1D => 97,  // KEY_RIGHTCTRL
            0x35 => 98,  // KEY_KPSLASH
            0x38 => 100, // KEY_RIGHTALT
            0x47 => 102, // KEY_HOME
            0x48 => 103, // KEY_UP
            0x49 => 104, // KEY_PAGEUP
            0x4B => 105, // KEY_LEFT
            0x4D => 106, // KEY_RIGHT
            0x4F => 107, // KEY_END
            0x50 => 108, // KEY_DOWN
            0x51 => 109, // KEY_PAGEDOWN
            0x52 => 110, // KEY_INSERT
            0x53 => 111, // KEY_DELETE
            0x5B => 125, // KEY_LEFTMETA
            0x5C => 126, // KEY_RIGHTMETA
            0x5D => 127, // KEY_COMPOSE (menu)
            // Unknown extended key: best-effort base mapping.
            other => return u16::from(other) + 8,
        };
        return evdev + 8;
    }
    // Main block: evdev code == Set-1 scancode; X11 keycode = evdev + 8.
    u16::from(scancode) + 8
}

#[cfg(target_os = "macos")]
fn macos_scancode_to_keycode(scancode: u8) -> Option<u16> {
    // Minimal PC Set-1 → CGKeyCode map for common keys. Extend as needed.
    let cg = match scancode {
        0x1C => 36, // Return
        0x0E => 51, // Delete (Backspace)
        0x0F => 48, // Tab
        0x39 => 49, // Space
        0x01 => 53, // Escape
        0x1D => 59, // Control
        0x2A => 56, // Left Shift
        0x38 => 58, // Option/Alt
        _ => return None,
    };
    Some(cg)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn main_block_is_scancode_plus_eight() {
        // 'A' is RDP Set-1 0x1E; evdev KEY_A is 30; X11 keycode 38.
        assert_eq!(linux_scancode_to_keycode(0x1E, false), 0x1E + 8);
        // Enter (main) 0x1C -> evdev 28 -> X11 36.
        assert_eq!(linux_scancode_to_keycode(0x1C, false), 28 + 8);
    }

    #[test]
    fn extended_keys_use_explicit_evdev_codes() {
        // Right Ctrl: extended 0x1D -> evdev 97 -> X11 105.
        assert_eq!(linux_scancode_to_keycode(0x1D, true), 97 + 8);
        // Up arrow: extended 0x48 -> evdev 103 -> X11 111.
        assert_eq!(linux_scancode_to_keycode(0x48, true), 103 + 8);
        // KP Enter: extended 0x1C -> evdev 96 (distinct from main Enter).
        assert_eq!(linux_scancode_to_keycode(0x1C, true), 96 + 8);
        assert_ne!(
            linux_scancode_to_keycode(0x1C, true),
            linux_scancode_to_keycode(0x1C, false)
        );
    }

    #[test]
    fn unknown_extended_falls_back_to_base() {
        // An unmapped extended code degrades to scancode+8 rather than panicking.
        assert_eq!(linux_scancode_to_keycode(0x7A, true), 0x7A + 8);
    }
}
