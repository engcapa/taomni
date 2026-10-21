/// Translate an RDP PC/AT Set-1 scancode + extended flag into the `u16` keycode
/// `enigo::Keyboard::raw` expects on this platform. Returns `None` for codes we
/// can't represent (caller then drops the event).
///
/// Split out as a free function so the mapping can be unit-tested without a real
/// `Enigo`/display.
pub(crate) fn rdp_scancode_to_raw(scancode: u8, extended: bool) -> Option<u16> {
    #[cfg(target_os = "windows")]
    {
        // Preserve the RDP E0 marker until the native injection layer splits
        // it into KEYEVENTF_EXTENDEDKEY and the low-byte hardware scan code.
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
        if extended {
            macos_extended_scancode_to_keycode(scancode)
        } else {
            macos_scancode_to_keycode(scancode)
        }
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
pub(super) fn macos_scancode_to_keycode(scancode: u8) -> Option<u16> {
    // PC Set-1 → CGKeyCode for common keys (see HIToolbox Events.h).
    // Letters/digits use ANSI keycodes; unmapped codes fall through so the
    // Unicode path can still deliver text when the client sends it.
    let cg = match scancode {
        // Control keys
        0x01 => 53, // Escape
        0x0E => 51, // Delete (Backspace)
        0x0F => 48, // Tab
        0x1C => 36, // Return
        0x39 => 49, // Space
        0x3A => 57, // Caps Lock
        // Modifiers
        0x1D => 59, // Left Control
        0x2A => 56, // Left Shift
        0x36 => 60, // Right Shift
        0x38 => 58, // Left Option/Alt
        0x5B => 55, // Left Command (meta) — when not extended
        // Digits top row
        0x02 => 18, // 1
        0x03 => 19, // 2
        0x04 => 20, // 3
        0x05 => 21, // 4
        0x06 => 23, // 5
        0x07 => 22, // 6
        0x08 => 26, // 7
        0x09 => 28, // 8
        0x0A => 25, // 9
        0x0B => 29, // 0
        0x0C => 27, // -
        0x0D => 24, // =
        // Letters (QWERTY)
        0x10 => 12, // Q
        0x11 => 13, // W
        0x12 => 14, // E
        0x13 => 15, // R
        0x14 => 17, // T
        0x15 => 16, // Y
        0x16 => 32, // U
        0x17 => 34, // I
        0x18 => 31, // O
        0x19 => 35, // P
        0x1E => 0,  // A
        0x1F => 1,  // S
        0x20 => 2,  // D
        0x21 => 3,  // F
        0x22 => 5,  // G
        0x23 => 4,  // H
        0x24 => 38, // J
        0x25 => 40, // K
        0x26 => 37, // L
        0x2C => 6,  // Z
        0x2D => 7,  // X
        0x2E => 8,  // C
        0x2F => 9,  // V
        0x30 => 11, // B
        0x31 => 45, // N
        0x32 => 46, // M
        // Punctuation
        0x1A => 33, // [
        0x1B => 30, // ]
        0x27 => 41, // ;
        0x28 => 39, // '
        0x29 => 50, // `
        0x2B => 42, // \
        0x33 => 43, // ,
        0x34 => 47, // .
        0x35 => 44, // /
        // Function keys F1–F12
        0x3B => 122, // F1
        0x3C => 120, // F2
        0x3D => 99,  // F3
        0x3E => 118, // F4
        0x3F => 96,  // F5
        0x40 => 97,  // F6
        0x41 => 98,  // F7
        0x42 => 100, // F8
        0x43 => 101, // F9
        0x44 => 109, // F10
        0x57 => 103, // F11
        0x58 => 111, // F12
        _ => return None,
    };
    Some(cg)
}

/// Extended (E0) scancodes → CGKeyCode for arrows and navigation.
#[cfg(target_os = "macos")]
pub(super) fn macos_extended_scancode_to_keycode(scancode: u8) -> Option<u16> {
    let cg = match scancode {
        0x48 => 126, // Up
        0x50 => 125, // Down
        0x4B => 123, // Left
        0x4D => 124, // Right
        0x47 => 115, // Home
        0x4F => 119, // End
        0x49 => 116, // Page Up
        0x51 => 121, // Page Down
        0x52 => 114, // Insert (Help on mac)
        0x53 => 117, // Forward Delete
        0x1D => 62,  // Right Control
        0x38 => 61,  // Right Option
        0x5B => 55,  // Left Command
        0x5C => 54,  // Right Command
        0x1C => 76,  // Keypad Enter
        _ => return None,
    };
    Some(cg)
}
