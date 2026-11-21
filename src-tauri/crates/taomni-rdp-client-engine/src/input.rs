//! Keyboard / mouse input event types used between the WS relay and the
//! RDP session. RDP uses scancodes (set 1) on the wire; conversion from
//! browser `KeyboardEvent.code` happens in the frontend (`src/lib/rdp.ts`).

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KeyEvent {
    pub down: bool,
    /// Set-1 scancode. The high bit of a fast-path keyboard PDU
    /// `keyboardFlags` indicates "extended key"; we keep the raw scancode
    /// here and let `session.rs` apply the flag.
    pub scancode: u16,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PointerEvent {
    pub x: u16,
    pub y: u16,
    /// Bitmask: 0x01=left, 0x02=right, 0x04=middle (matches our WS protocol;
    /// translated to PTRFLAGS_BUTTON1/2/3 in `session.rs`).
    pub buttons: u8,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PointerWheelEvent {
    pub x: u16,
    pub y: u16,
    pub is_vertical: bool,
    pub rotation_units: i16,
}

impl PointerEvent {
    pub fn left(&self) -> bool {
        self.buttons & 0x01 != 0
    }
    pub fn right(&self) -> bool {
        self.buttons & 0x02 != 0
    }
    pub fn middle(&self) -> bool {
        self.buttons & 0x04 != 0
    }
}

/// Translate a browser `KeyboardEvent.code` value into a set-1 scancode.
/// Returns `(scancode, is_extended)`. The extended flag lights bit 0x100
/// in the resulting RDP `keyboardFlags`. The map is intentionally minimal
/// — frontend already has the full table; this module is here so unit
/// tests can pin a few well-known mappings.
pub fn code_to_scancode(code: &str) -> Option<(u16, bool)> {
    Some(match code {
        "Escape" => (0x01, false),
        "Backspace" => (0x0E, false),
        "Tab" => (0x0F, false),
        "Enter" => (0x1C, false),
        "ControlLeft" => (0x1D, false),
        "ControlRight" => (0x1D, true),
        "ShiftLeft" => (0x2A, false),
        "ShiftRight" => (0x36, false),
        "AltLeft" => (0x38, false),
        "AltRight" => (0x38, true),
        "MetaLeft" => (0x5B, true),
        "MetaRight" => (0x5C, true),
        "Space" => (0x39, false),
        "CapsLock" => (0x3A, false),
        "ArrowUp" => (0x48, true),
        "ArrowDown" => (0x50, true),
        "ArrowLeft" => (0x4B, true),
        "ArrowRight" => (0x4D, true),
        "Home" => (0x47, true),
        "End" => (0x4F, true),
        "PageUp" => (0x49, true),
        "PageDown" => (0x51, true),
        "Insert" => (0x52, true),
        "Delete" => (0x53, true),
        "F1" => (0x3B, false),
        "F2" => (0x3C, false),
        "F3" => (0x3D, false),
        "F4" => (0x3E, false),
        "F5" => (0x3F, false),
        "F6" => (0x40, false),
        "F7" => (0x41, false),
        "F8" => (0x42, false),
        "F9" => (0x43, false),
        "F10" => (0x44, false),
        "F11" => (0x57, false),
        "F12" => (0x58, false),
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pointer_buttons_decode() {
        let e = PointerEvent {
            x: 0,
            y: 0,
            buttons: 0b101,
        };
        assert!(e.left());
        assert!(!e.right());
        assert!(e.middle());
    }

    #[test]
    fn known_scancodes() {
        assert_eq!(code_to_scancode("Enter"), Some((0x1C, false)));
        assert_eq!(code_to_scancode("ControlRight"), Some((0x1D, true)));
        assert_eq!(code_to_scancode("ArrowUp"), Some((0x48, true)));
        assert_eq!(code_to_scancode("F12"), Some((0x58, false)));
    }

    #[test]
    fn unknown_codes_return_none() {
        assert_eq!(code_to_scancode("KeyA"), None); // letters resolved via key.charCodeAt
        assert_eq!(code_to_scancode(""), None);
    }
}
