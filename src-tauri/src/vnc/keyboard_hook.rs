//! "Pass special keys directly to the remote device" (VNC-INPUT-003,
//! DEC-VNC-16; RealVNC `SendSpecialKeys=True`).
//!
//! Windows handles Win, Alt+Tab, Alt+Esc, Ctrl+Esc and PrtScn before a
//! WebView ever sees them. While a VNC canvas has focus in our foreground
//! window, a low-level keyboard hook swallows those keys locally and emits
//! `vnc-special-key` events that the focused session sends as keysyms. The
//! hook is installed only while capture is requested and removed as soon as
//! the canvas loses focus, so no other application pays for it. macOS and
//! Linux have no equivalent without extra system permissions; the command
//! reports `false` there.

/// Tauri event carrying one intercepted key.
pub const SPECIAL_KEY_EVENT: &str = "vnc-special-key";

#[derive(Debug, Clone, serde::Serialize)]
pub struct SpecialKey {
    /// DOM `KeyboardEvent.code` of the key: MetaLeft, MetaRight, Tab,
    /// Escape or PrintScreen.
    pub code: &'static str,
    pub down: bool,
}

/// Which intercepted key a virtual-key press is, given the modifier state.
/// Win and PrtScn always pass through; Tab only with Alt (Alt+Tab), Esc with
/// Alt or Ctrl (Alt+Esc, Ctrl+Esc).
pub fn classify(vk: u32, alt_down: bool, ctrl_down: bool) -> Option<&'static str> {
    const VK_TAB: u32 = 0x09;
    const VK_ESCAPE: u32 = 0x1B;
    const VK_SNAPSHOT: u32 = 0x2C;
    const VK_LWIN: u32 = 0x5B;
    const VK_RWIN: u32 = 0x5C;
    match vk {
        VK_LWIN => Some("MetaLeft"),
        VK_RWIN => Some("MetaRight"),
        VK_SNAPSHOT => Some("PrintScreen"),
        VK_TAB if alt_down => Some("Tab"),
        VK_ESCAPE if alt_down || ctrl_down => Some("Escape"),
        _ => None,
    }
}

#[cfg(windows)]
mod imp {
    use std::collections::HashSet;
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};

    use tauri::{AppHandle, Emitter};
    use winapi::shared::minwindef::{LPARAM, LRESULT, WPARAM};
    use winapi::um::libloaderapi::GetModuleHandleW;
    use winapi::um::processthreadsapi::GetCurrentThreadId;
    use winapi::um::winuser::{
        CallNextHookEx, GetAsyncKeyState, GetForegroundWindow, GetMessageW,
        GetWindowThreadProcessId, KBDLLHOOKSTRUCT, LLKHF_ALTDOWN, MSG, PostThreadMessageW,
        SetWindowsHookExW, UnhookWindowsHookEx, VK_CONTROL, WH_KEYBOARD_LL, WM_KEYDOWN,
        WM_QUIT, WM_SYSKEYDOWN,
    };

    use super::{SPECIAL_KEY_EVENT, SpecialKey, classify};

    static APP: Mutex<Option<AppHandle>> = Mutex::new(None);
    static CAPTURING: AtomicBool = AtomicBool::new(false);
    /// Thread id of the running hook thread, 0 when none.
    static HOOK_THREAD: AtomicU32 = AtomicU32::new(0);
    /// Keys whose press was swallowed; their release is swallowed too.
    static HELD: Mutex<Option<HashSet<u32>>> = Mutex::new(None);

    fn foreground_is_ours() -> bool {
        unsafe {
            let window = GetForegroundWindow();
            if window.is_null() {
                return false;
            }
            let mut pid = 0u32;
            GetWindowThreadProcessId(window, &mut pid);
            pid == std::process::id()
        }
    }

    fn emit(code: &'static str, down: bool) {
        if let Ok(app) = APP.lock()
            && let Some(app) = app.as_ref()
        {
            let _ = app.emit(SPECIAL_KEY_EVENT, SpecialKey { code, down });
        }
    }

    unsafe extern "system" fn hook_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code >= 0 && CAPTURING.load(Ordering::Acquire) {
            // SAFETY: for WH_KEYBOARD_LL, lparam points at a KBDLLHOOKSTRUCT.
            let info = unsafe { &*(lparam as *const KBDLLHOOKSTRUCT) };
            let message = wparam as u32;
            let down = message == WM_KEYDOWN || message == WM_SYSKEYDOWN;
            let mut held = HELD.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            let held = held.get_or_insert_with(HashSet::new);
            let alt = info.flags & LLKHF_ALTDOWN != 0;
            // SAFETY: plain Win32 call without pointers.
            let ctrl = unsafe { GetAsyncKeyState(VK_CONTROL) } < 0;
            let key = if down {
                if foreground_is_ours() {
                    classify(info.vkCode, alt, ctrl)
                } else {
                    None
                }
            } else if held.contains(&info.vkCode) {
                classify(info.vkCode, true, true)
            } else {
                None
            };
            if let Some(key) = key {
                if down {
                    held.insert(info.vkCode);
                } else {
                    held.remove(&info.vkCode);
                }
                emit(key, down);
                return 1;
            }
        }
        // SAFETY: forwarding the unmodified hook arguments.
        unsafe { CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam) }
    }

    fn start_hook_thread() {
        if HOOK_THREAD.load(Ordering::Acquire) != 0 {
            return;
        }
        let (ready_tx, ready_rx) = std::sync::mpsc::channel::<u32>();
        std::thread::Builder::new()
            .name("vnc-special-keys".into())
            .spawn(move || unsafe {
                let thread_id = GetCurrentThreadId();
                let hook = SetWindowsHookExW(
                    WH_KEYBOARD_LL,
                    Some(hook_proc),
                    GetModuleHandleW(std::ptr::null()),
                    0,
                );
                if hook.is_null() {
                    let _ = ready_tx.send(0);
                    return;
                }
                HOOK_THREAD.store(thread_id, Ordering::Release);
                let _ = ready_tx.send(thread_id);
                // Low-level hooks run on this thread's message loop.
                let mut msg: MSG = std::mem::zeroed();
                while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {}
                UnhookWindowsHookEx(hook);
                if let Ok(mut held) = HELD.lock() {
                    *held = None;
                }
                let _ = HOOK_THREAD.compare_exchange(thread_id, 0, Ordering::AcqRel, Ordering::Acquire);
            })
            .ok();
        let _ = ready_rx.recv_timeout(std::time::Duration::from_secs(2));
    }

    fn stop_hook_thread() {
        let thread_id = HOOK_THREAD.swap(0, Ordering::AcqRel);
        if thread_id != 0 {
            // SAFETY: posting WM_QUIT to our own hook thread.
            unsafe {
                PostThreadMessageW(thread_id, WM_QUIT, 0, 0);
            }
        }
    }

    pub fn set_capture(app: AppHandle, enabled: bool) -> bool {
        if let Ok(mut slot) = APP.lock() {
            *slot = Some(app);
        }
        CAPTURING.store(enabled, Ordering::Release);
        if enabled {
            start_hook_thread();
            HOOK_THREAD.load(Ordering::Acquire) != 0
        } else {
            stop_hook_thread();
            true
        }
    }
}

/// Install (or remove) the special-key hook. Returns whether special keys are
/// being passed through on this platform.
#[tauri::command]
pub fn vnc_set_special_key_capture(app: tauri::AppHandle, enabled: bool) -> bool {
    #[cfg(windows)]
    {
        imp::set_capture(app, enabled)
    }
    #[cfg(not(windows))]
    {
        let _ = (app, enabled);
        false
    }
}

#[cfg(test)]
mod tests {
    use super::classify;

    #[test]
    fn only_system_shortcuts_are_intercepted() {
        assert_eq!(classify(0x5B, false, false), Some("MetaLeft"));
        assert_eq!(classify(0x5C, false, false), Some("MetaRight"));
        assert_eq!(classify(0x2C, false, false), Some("PrintScreen"));
        assert_eq!(classify(0x09, true, false), Some("Tab"));
        assert_eq!(classify(0x09, false, false), None);
        assert_eq!(classify(0x1B, true, false), Some("Escape"));
        assert_eq!(classify(0x1B, false, true), Some("Escape"));
        assert_eq!(classify(0x1B, false, false), None);
        assert_eq!(classify(0x41, true, true), None);
    }
}
