use super::queue::InputCmd;
#[cfg(target_os = "linux")]
use crate::servers::rdp::capture::PortalInput;
use enigo::Axis;
use enigo::Button;
use enigo::Coordinate;
use enigo::Direction::Press;
use enigo::Key;

#[cfg(target_os = "linux")]
pub(super) fn input_cmd_to_portal(cmd: InputCmd) -> Option<PortalInput> {
    match cmd {
        // Enigo's Linux raw key API takes X11 keycodes (evdev + 8), while the
        // RemoteDesktop portal takes Linux evdev keycodes directly.
        InputCmd::Raw { code, dir } => Some(PortalInput::Keycode {
            code: i32::from(code.saturating_sub(8)),
            pressed: dir == Press,
        }),
        InputCmd::Key {
            key: Key::Unicode(ch),
            dir,
        } => Some(PortalInput::Keysym {
            keysym: unicode_to_keysym(ch),
            pressed: dir == Press,
        }),
        InputCmd::Key { .. } => None,
        InputCmd::Button { button, dir } => Some(PortalInput::Button {
            button: match button {
                Button::Left => 0x110,
                Button::Right => 0x111,
                Button::Middle => 0x112,
                Button::Back => 0x116,
                Button::Forward => 0x115,
                _ => return None,
            },
            pressed: dir == Press,
        }),
        InputCmd::MoveMouse { x, y, coord } => match coord {
            Coordinate::Abs => Some(PortalInput::MotionAbsolute {
                x: f64::from(x),
                y: f64::from(y),
            }),
            Coordinate::Rel => Some(PortalInput::MotionRelative {
                dx: f64::from(x),
                dy: f64::from(y),
            }),
        },
        InputCmd::Scroll { length, axis } => Some(PortalInput::Scroll {
            horizontal: axis == Axis::Horizontal,
            steps: length,
        }),
    }
}

#[cfg(any(target_os = "linux", test))]
pub(super) fn unicode_to_keysym(ch: char) -> i32 {
    let codepoint = u32::from(ch);
    let keysym = if codepoint <= 0xff {
        codepoint
    } else {
        0x0100_0000 | codepoint
    };
    i32::try_from(keysym).expect("Unicode keysym fits in a signed 32-bit portal value")
}
