#[cfg(target_os = "macos")]
use super::macos::MacMouse;
use super::queue::InputCmd;
#[cfg(target_os = "windows")]
use super::windows::inject_windows_scancode;
use enigo::Button;
use enigo::Coordinate;
use enigo::Enigo;
use enigo::Key;
use enigo::Keyboard;
use enigo::Mouse;

/// Replay one command on the thread-owned input backend. Returning an error
/// closes the actor so revoked permissions and backend failures are visible.
pub(super) fn apply(
    enigo: &mut Enigo,
    #[cfg(target_os = "macos")] mac_mouse: &mut MacMouse,
    cmd: InputCmd,
) -> Result<(), String> {
    match cmd {
        InputCmd::Raw { code, dir } => {
            #[cfg(target_os = "windows")]
            inject_windows_scancode(code, dir)?;
            #[cfg(not(target_os = "windows"))]
            enigo.raw(code, dir).map_err(|e| e.to_string())?;
        }
        InputCmd::Key { key, dir } => {
            enigo.key(key, dir).map_err(|e| e.to_string())?;
        }
        InputCmd::Button { button, dir } => {
            #[cfg(target_os = "macos")]
            mac_mouse.button(button, dir)?;
            #[cfg(not(target_os = "macos"))]
            enigo.button(button, dir).map_err(|e| e.to_string())?;
        }
        InputCmd::MoveMouse { x, y, coord } => {
            #[cfg(target_os = "macos")]
            match coord {
                Coordinate::Abs => {
                    mac_mouse.absolute_move(
                        u16::try_from(x).unwrap_or(0),
                        u16::try_from(y).unwrap_or(0),
                    )?;
                }
                Coordinate::Rel => mac_mouse.relative_move(x, y)?,
            }
            #[cfg(not(target_os = "macos"))]
            enigo.move_mouse(x, y, coord).map_err(|e| e.to_string())?;
        }
        InputCmd::Scroll { length, axis } => {
            enigo.scroll(length, axis).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
