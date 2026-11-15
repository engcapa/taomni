use super::browser::REMOTE_BROWSER_LABEL;
use crate::mobile::Core;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use tauri::Manager;

const MAX_INPUT_BYTES: usize = 4096;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct DesktopWindow {
    pub id: String,
    pub title: String,
    pub app_name: String,
    pub pid: u32,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub minimized: bool,
    pub focused: bool,
    pub kind: String,
}

#[derive(Clone, Debug, Deserialize, Default)]
pub struct WindowInputRequest {
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub key: Option<String>,
    #[serde(default)]
    pub submit: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct WindowInputResult {
    pub ok: bool,
    pub window_id: String,
    pub title: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WindowKey {
    Enter,
    Tab,
    Escape,
    Backspace,
    Space,
    Up,
    Down,
    Left,
    Right,
    Home,
    End,
    PageUp,
    PageDown,
    F5,
    CtrlC,
    CtrlA,
    CtrlV,
    CtrlL,
    CtrlEnter,
}

/// Validates input parameters cleanly before attempting focus or key injection.
pub fn validate_window_input(req: &WindowInputRequest) -> Result<Option<WindowKey>, String> {
    if req.text.len() > MAX_INPUT_BYTES {
        return Err("input_too_large".into());
    }
    let key = match req.key.as_deref().map(str::trim).filter(|k| !k.is_empty()) {
        Some(spec) => Some(parse_window_key(spec)?),
        None => None,
    };
    if req.text.is_empty() && key.is_none() && !req.submit {
        return Err("empty_window_input".into());
    }
    Ok(key)
}

/// Parses a normalized desktop window shortcut/key identifier.
pub fn parse_window_key(raw: &str) -> Result<WindowKey, String> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "enter" | "return" | "回车" => Ok(WindowKey::Enter),
        "tab" => Ok(WindowKey::Tab),
        "esc" | "escape" => Ok(WindowKey::Escape),
        "backspace" | "bs" | "退格" => Ok(WindowKey::Backspace),
        "space" | "空格" => Ok(WindowKey::Space),
        "up" | "上" => Ok(WindowKey::Up),
        "down" | "下" => Ok(WindowKey::Down),
        "left" | "左" => Ok(WindowKey::Left),
        "right" | "右" => Ok(WindowKey::Right),
        "home" => Ok(WindowKey::Home),
        "end" => Ok(WindowKey::End),
        "pageup" | "pgup" => Ok(WindowKey::PageUp),
        "pagedown" | "pgdn" => Ok(WindowKey::PageDown),
        "f5" | "refresh" => Ok(WindowKey::F5),
        "ctrl-c" | "ctrl+c" | "^c" => Ok(WindowKey::CtrlC),
        "ctrl-a" | "ctrl+a" | "^a" => Ok(WindowKey::CtrlA),
        "ctrl-v" | "ctrl+v" | "^v" => Ok(WindowKey::CtrlV),
        "ctrl-l" | "ctrl+l" | "^l" => Ok(WindowKey::CtrlL),
        "ctrl-enter" | "ctrl+enter" | "ctrl-return" => Ok(WindowKey::CtrlEnter),
        _ => Err("invalid_window_key".into()),
    }
}

/// Resolves an exact window ID, 1-based list index, numeric ID, or unique case-insensitive substring.
pub fn resolve_window<'a>(
    windows: &'a [DesktopWindow],
    selector: &str,
) -> Result<&'a DesktopWindow, String> {
    let trimmed = selector.trim();
    if trimmed.is_empty() {
        return Err("window_not_found".into());
    }
    if let Some(exact) = windows.iter().find(|w| w.id == trimmed) {
        return Ok(exact);
    }
    if let Ok(index) = trimmed.parse::<usize>() {
        if index >= 1 {
            if let Some(by_idx) = windows.get(index - 1) {
                return Ok(by_idx);
            }
        }
        let win_id = format!("win:{trimmed}");
        if let Some(by_win) = windows.iter().find(|w| w.id == win_id) {
            return Ok(by_win);
        }
    }
    let needle = trimmed.to_ascii_lowercase();
    let matches: Vec<&DesktopWindow> = windows
        .iter()
        .filter(|w| {
            w.title.to_ascii_lowercase().contains(&needle)
                || w.app_name.to_ascii_lowercase().contains(&needle)
                || w.id.to_ascii_lowercase().contains(&needle)
        })
        .collect();
    if matches.len() == 1 {
        Ok(matches[0])
    } else if matches.is_empty() {
        Err("window_not_found".into())
    } else {
        Err("ambiguous_window_target".into())
    }
}

pub async fn list_windows(core: &Core) -> Result<Vec<DesktopWindow>, String> {
    #[cfg(test)]
    if let Some(driver) = core.state().mobile.desktop.test_driver() {
        return driver.list_windows();
    }
    let Core::Desktop(app) = core else {
        return Err("desktop_required".into());
    };
    let app = app.clone();
    tokio::task::spawn_blocking(move || collect_windows(&app))
        .await
        .map_err(|_| "window_list_failed".to_string())
}

pub async fn send_window_input(
    core: &Core,
    window_id: &str,
    request: WindowInputRequest,
) -> Result<WindowInputResult, String> {
    let parsed_key = validate_window_input(&request)?;
    #[cfg(test)]
    if let Some(driver) = core.state().mobile.desktop.test_driver() {
        return driver.send_window_input(window_id, &request);
    }
    let Core::Desktop(app) = core else {
        return Err("desktop_required".into());
    };
    let windows = list_windows(core).await?;
    let target = resolve_window(&windows, window_id)?.clone();

    #[cfg(target_os = "macos")]
    if !crate::servers::rdp::control_permission_granted() {
        return Err("desktop_input_permission_required".into());
    }

    let app_for_focus = app.clone();
    let target_for_focus = target.clone();
    tokio::task::spawn_blocking(move || focus_target_window(&app_for_focus, &target_for_focus))
        .await
        .map_err(|_| "window_focus_failed".to_string())??;
    tokio::time::sleep(std::time::Duration::from_millis(90)).await;

    let text = request.text;
    let submit = request.submit;
    tokio::task::spawn_blocking(move || deliver_keyboard_input(&text, parsed_key, submit))
        .await
        .map_err(|_| "window_input_failed".to_string())??;

    Ok(WindowInputResult {
        ok: true,
        window_id: target.id,
        title: target.title,
    })
}

fn collect_windows(app: &tauri::AppHandle) -> Vec<DesktopWindow> {
    let mut windows = Vec::new();
    let mut own_titles = HashSet::new();
    let self_pid = std::process::id();

    let mut tauri_entries: Vec<_> = app.webview_windows().into_iter().collect();
    // Put the remote browser window and main window ahead of secondary tabs.
    tauri_entries.sort_by_key(|(label, _)| {
        if label == REMOTE_BROWSER_LABEL {
            (0usize, label.clone())
        } else if label == "main" {
            (1, label.clone())
        } else {
            (2, label.clone())
        }
    });

    for (label, win) in tauri_entries {
        if label.starts_with("screenshot-") || !win.is_visible().unwrap_or(true) {
            continue;
        }
        let title = win.title().unwrap_or_else(|_| label.clone());
        let pos = win.outer_position().ok();
        let size = win.outer_size().ok();
        own_titles.insert(title.clone());
        windows.push(DesktopWindow {
            id: format!("tauri:{label}"),
            title,
            app_name: "Taomni".into(),
            pid: self_pid,
            x: pos.map_or(0, |p| p.x),
            y: pos.map_or(0, |p| p.y),
            width: size.map_or(0, |s| s.width),
            height: size.map_or(0, |s| s.height),
            minimized: win.is_minimized().unwrap_or(false),
            focused: win.is_focused().unwrap_or(false),
            kind: if label == REMOTE_BROWSER_LABEL {
                "tauri_browser"
            } else {
                "tauri"
            }
            .into(),
        });
    }

    if let Ok(os_windows) = xcap::Window::all() {
        for win in os_windows {
            let Ok(id) = win.id() else {
                continue;
            };
            let title = win.title().unwrap_or_default();
            let app_name = win.app_name().unwrap_or_default();
            let pid = win.pid().unwrap_or(0);
            let width = win.width().unwrap_or(0);
            let height = win.height().unwrap_or(0);
            if width == 0 || height == 0 {
                continue;
            }
            if title.trim().is_empty() && app_name.trim().is_empty() {
                continue;
            }
            if pid == self_pid && !title.is_empty() && own_titles.contains(&title) {
                continue;
            }
            windows.push(DesktopWindow {
                id: format!("win:{id}"),
                title: if title.trim().is_empty() {
                    app_name.clone()
                } else {
                    title
                },
                app_name,
                pid,
                x: win.x().unwrap_or(0),
                y: win.y().unwrap_or(0),
                width,
                height,
                minimized: win.is_minimized().unwrap_or(false),
                focused: win.is_focused().unwrap_or(false),
                kind: "desktop".into(),
            });
        }
    }
    windows
}

fn focus_target_window(app: &tauri::AppHandle, target: &DesktopWindow) -> Result<(), String> {
    if let Some(label) = target.id.strip_prefix("tauri:") {
        let win = app
            .get_webview_window(label)
            .ok_or_else(|| "window_not_found".to_string())?;
        let _ = win.unminimize();
        let _ = win.show();
        focus_tauri_os_handle(&win);
        win.set_focus()
            .map_err(|_| "window_focus_failed".to_string())?;
        return Ok(());
    }
    if let Some(raw) = target.id.strip_prefix("win:") {
        let id = raw
            .parse::<u32>()
            .map_err(|_| "window_not_found".to_string())?;
        return focus_os_window(id, target.pid);
    }
    Err("window_not_found".into())
}

#[cfg(target_os = "linux")]
fn focus_tauri_os_handle(win: &tauri::WebviewWindow) {
    use gtk::glib::translate::ToGlibPtr;
    use gtk::prelude::*;

    #[link(name = "gdk-3")]
    unsafe extern "C" {
        fn gdk_x11_window_get_xid(window: *mut gtk::gdk::ffi::GdkWindow) -> u32;
    }

    let target = win.clone();
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    if win
        .run_on_main_thread(move || {
            let xid = target.gtk_window().ok().and_then(|gtk| {
                if gtk.display().type_().name() != "GdkX11Display" {
                    return None;
                }
                gtk.realize();
                let surface = gtk.window()?;
                Some(unsafe { gdk_x11_window_get_xid(surface.to_glib_none().0) })
            });
            let _ = tx.send(xid);
        })
        .is_ok()
    {
        if let Ok(Some(xid)) = rx.recv_timeout(std::time::Duration::from_secs(2)) {
            let _ = focus_x11_window(xid);
        }
    }
}

#[cfg(target_os = "windows")]
fn focus_tauri_os_handle(win: &tauri::WebviewWindow) {
    use windows::Win32::Foundation::HWND;
    if let Ok(raw) = win.hwnd() {
        focus_win32_hwnd(HWND(raw.0 as _));
    }
}

#[cfg(target_os = "macos")]
fn focus_tauri_os_handle(_win: &tauri::WebviewWindow) {}

#[cfg(target_os = "linux")]
fn focus_os_window(id: u32, _pid: u32) -> Result<(), String> {
    focus_x11_window(id)
}

#[cfg(target_os = "linux")]
fn focus_x11_window(xid: u32) -> Result<(), String> {
    use x11rb::connection::Connection;
    use x11rb::protocol::xproto::{
        CLIENT_MESSAGE_EVENT, ClientMessageData, ClientMessageEvent, ConfigureWindowAux,
        ConnectionExt as _, EventMask, InputFocus, StackMode,
    };

    let (conn, screen_num) = x11rb::connect(None).map_err(|_| "window_focus_failed".to_string())?;
    let screen = &conn.setup().roots[screen_num];
    let _ = conn.map_window(xid);
    let _ = conn.configure_window(xid, &ConfigureWindowAux::new().stack_mode(StackMode::ABOVE));
    if let Ok(reply) = conn.intern_atom(false, b"_NET_ACTIVE_WINDOW") {
        if let Ok(atom_reply) = reply.reply() {
            let event = ClientMessageEvent {
                response_type: CLIENT_MESSAGE_EVENT,
                format: 32,
                sequence: 0,
                window: xid,
                type_: atom_reply.atom,
                data: ClientMessageData::from([2u32, x11rb::CURRENT_TIME, 0, 0, 0]),
            };
            let _ = conn.send_event(
                false,
                screen.root,
                EventMask::SUBSTRUCTURE_REDIRECT | EventMask::SUBSTRUCTURE_NOTIFY,
                event,
            );
        }
    }
    conn.set_input_focus(InputFocus::PARENT, xid, x11rb::CURRENT_TIME)
        .map_err(|_| "window_focus_failed".to_string())?
        .check()
        .map_err(|_| "window_focus_failed".to_string())?;
    conn.flush()
        .map_err(|_| "window_focus_failed".to_string())?;
    Ok(())
}

#[cfg(target_os = "windows")]
fn focus_os_window(id: u32, _pid: u32) -> Result<(), String> {
    use windows::Win32::Foundation::{HWND, LPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{EnumWindows, IsWindowVisible};
    use windows::core::BOOL;

    struct Search {
        target: u32,
        found: Option<HWND>,
    }

    unsafe extern "system" fn find_window(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let search = unsafe { &mut *(lparam.0 as *mut Search) };
        if (hwnd.0 as usize as u32) == search.target && unsafe { IsWindowVisible(hwnd).as_bool() } {
            search.found = Some(hwnd);
            return BOOL(0);
        }
        BOOL(1)
    }

    let mut search = Search {
        target: id,
        found: None,
    };
    let _ = unsafe {
        EnumWindows(
            Some(find_window),
            LPARAM(&mut search as *mut Search as isize),
        )
    };
    let hwnd = search.found.ok_or_else(|| "window_not_found".to_string())?;
    if focus_win32_hwnd(hwnd) {
        Ok(())
    } else {
        Err("window_focus_failed".into())
    }
}

#[cfg(target_os = "windows")]
fn focus_win32_hwnd(hwnd: windows::Win32::Foundation::HWND) -> bool {
    use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
    use windows::Win32::UI::WindowsAndMessaging::{
        BringWindowToTop, GetForegroundWindow, GetWindowThreadProcessId, IsIconic, SW_RESTORE,
        SetForegroundWindow, ShowWindow,
    };
    unsafe {
        if IsIconic(hwnd).as_bool() {
            let _ = ShowWindow(hwnd, SW_RESTORE);
        }
        let fg = GetForegroundWindow();
        if fg == hwnd {
            return true;
        }
        let mut activated = SetForegroundWindow(hwnd).as_bool();
        if !activated && !fg.is_invalid() {
            let current = GetCurrentThreadId();
            let owner = GetWindowThreadProcessId(fg, None);
            if owner != 0 && owner != current && AttachThreadInput(current, owner, true).as_bool() {
                activated = SetForegroundWindow(hwnd).as_bool();
                let _ = AttachThreadInput(current, owner, false);
            }
        }
        let _ = BringWindowToTop(hwnd);
        activated
    }
}

#[cfg(target_os = "macos")]
fn focus_os_window(_id: u32, pid: u32) -> Result<(), String> {
    use objc2_app_kit::{NSApplicationActivationOptions, NSRunningApplication};
    if pid == 0 {
        return Err("window_focus_failed".into());
    }
    let Some(app) = NSRunningApplication::runningApplicationWithProcessIdentifier(pid as i32)
    else {
        return Err("window_not_found".into());
    };
    #[allow(deprecated)]
    let ok = app.activateWithOptions(
        NSApplicationActivationOptions::ActivateAllWindows
            | NSApplicationActivationOptions::ActivateIgnoringOtherApps,
    );
    if ok {
        Ok(())
    } else {
        Err("window_focus_failed".into())
    }
}

fn deliver_keyboard_input(text: &str, key: Option<WindowKey>, submit: bool) -> Result<(), String> {
    use enigo::{Direction, Enigo, Key, Keyboard, Settings};

    let settings = Settings {
        #[cfg(target_os = "macos")]
        open_prompt_to_get_permissions: false,
        ..Settings::default()
    };
    let mut enigo = Enigo::new(&settings).map_err(|_| "window_input_failed".to_string())?;
    if !text.is_empty() {
        enigo
            .text(text)
            .map_err(|_| "window_input_failed".to_string())?;
    }
    if submit {
        enigo
            .key(Key::Return, Direction::Click)
            .map_err(|_| "window_input_failed".to_string())?;
    }
    if let Some(key) = key {
        apply_window_key(&mut enigo, key)?;
    }
    Ok(())
}

fn apply_window_key(enigo: &mut enigo::Enigo, key: WindowKey) -> Result<(), String> {
    use enigo::{Direction, Key, Keyboard};

    let send_chord = |enigo: &mut enigo::Enigo, modifier: Key, target: Key| -> Result<(), String> {
        enigo
            .key(modifier, Direction::Press)
            .map_err(|_| "window_input_failed".to_string())?;
        let clicked = enigo
            .key(target, Direction::Click)
            .map_err(|_| "window_input_failed".to_string());
        let released = enigo
            .key(modifier, Direction::Release)
            .map_err(|_| "window_input_failed".to_string());
        clicked?;
        released
    };

    match key {
        WindowKey::Enter => enigo.key(Key::Return, Direction::Click),
        WindowKey::Tab => enigo.key(Key::Tab, Direction::Click),
        WindowKey::Escape => enigo.key(Key::Escape, Direction::Click),
        WindowKey::Backspace => enigo.key(Key::Backspace, Direction::Click),
        WindowKey::Space => enigo.key(Key::Space, Direction::Click),
        WindowKey::Up => enigo.key(Key::UpArrow, Direction::Click),
        WindowKey::Down => enigo.key(Key::DownArrow, Direction::Click),
        WindowKey::Left => enigo.key(Key::LeftArrow, Direction::Click),
        WindowKey::Right => enigo.key(Key::RightArrow, Direction::Click),
        WindowKey::Home => enigo.key(Key::Home, Direction::Click),
        WindowKey::End => enigo.key(Key::End, Direction::Click),
        WindowKey::PageUp => enigo.key(Key::PageUp, Direction::Click),
        WindowKey::PageDown => enigo.key(Key::PageDown, Direction::Click),
        WindowKey::F5 => enigo.key(Key::F5, Direction::Click),
        WindowKey::CtrlC => return send_chord(enigo, Key::Control, Key::Unicode('c')),
        WindowKey::CtrlA => return send_chord(enigo, Key::Control, Key::Unicode('a')),
        WindowKey::CtrlV => return send_chord(enigo, Key::Control, Key::Unicode('v')),
        WindowKey::CtrlL => return send_chord(enigo, Key::Control, Key::Unicode('l')),
        WindowKey::CtrlEnter => return send_chord(enigo, Key::Control, Key::Return),
    }
    .map_err(|_| "window_input_failed".to_string())
}
