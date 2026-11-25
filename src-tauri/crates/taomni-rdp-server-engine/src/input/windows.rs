use enigo::Direction;
use enigo::Direction::Press;
use enigo::Direction::Release;

#[cfg(target_os = "windows")]
pub(super) fn inject_windows_scancode(code: u16, direction: Direction) -> Result<(), String> {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP,
        KEYEVENTF_SCANCODE, SendInput,
    };

    let (scan, extended) = windows_scancode_parts(code);
    let input = |released: bool| {
        let mut flags = KEYEVENTF_SCANCODE;
        if extended {
            flags |= KEYEVENTF_EXTENDEDKEY;
        }
        if released {
            flags |= KEYEVENTF_KEYUP;
        }
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: Default::default(),
                    wScan: scan,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        }
    };
    let inputs = [input(false), input(true)];
    let inputs = match direction {
        Direction::Press => &inputs[..1],
        Direction::Release => &inputs[1..],
        Direction::Click => &inputs[..],
    };
    let sent = unsafe { SendInput(inputs, std::mem::size_of::<INPUT>() as i32) };
    if sent != inputs.len() as u32 {
        return Err(format!(
            "Windows SendInput injected {sent}/{} keyboard events: {}",
            inputs.len(),
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}

#[cfg(any(target_os = "windows", test))]
pub(super) fn windows_scancode_parts(code: u16) -> (u16, bool) {
    const EXTENDED_PREFIX: u16 = 0xE000;
    (code & 0x00FF, code & EXTENDED_PREFIX == EXTENDED_PREFIX)
}
