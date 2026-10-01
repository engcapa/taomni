//! "Pass special keys directly to the remote device" (VNC-INPUT-003,
//! DEC-VNC-16; RealVNC `SendSpecialKeys=True`).
//!
//! Windows handles Win, Alt+Tab, Alt+Esc, Ctrl+Esc and PrtScn before a
//! WebView ever sees them. While a VNC canvas has focus in our foreground
//! window, a low-level keyboard hook swallows those keys locally and the app
//! emits `vnc-special-key` events that the focused session sends as keysyms.
//!
//! The hook runs in a helper process (this executable started with
//! [`HOOK_PROCESS_ARG`]). Windows does not call a low-level hook owned by the
//! Taomni process while one of its WebView2 windows is in front: measured
//! 2026-10-01, a hook on a worker thread and one on the main UI thread both
//! received zero calls for every key until another process owned the
//! foreground, so every key reached the shell. A hook in another process is
//! called normally. The helper reads `on` / `off` lines on stdin, writes one
//! line per swallowed key on stdout, only acts while the foreground window
//! belongs to its parent, and exits when its stdin closes (parent gone).
//! macOS and Linux have no equivalent without extra system permissions; the
//! command reports `false` there.

/// Tauri event carrying one intercepted key.
pub const SPECIAL_KEY_EVENT: &str = "vnc-special-key";

/// First argument that turns this executable into the hook helper process.
#[cfg(windows)]
pub const HOOK_PROCESS_ARG: &str = "--vnc-special-key-hook";

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct SpecialKey {
    /// DOM `KeyboardEvent.code` of the key: MetaLeft, MetaRight, Tab,
    /// Escape or PrintScreen.
    pub code: &'static str,
    pub down: bool,
}

#[cfg(any(windows, test))]
const SPECIAL_KEY_CODES: [&str; 5] = ["MetaLeft", "MetaRight", "PrintScreen", "Tab", "Escape"];

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

/// One line of the helper's stdout protocol.
#[cfg(any(windows, test))]
#[derive(Debug, PartialEq, Eq)]
enum HelperLine {
    /// `k <0|1> <code>`: a swallowed key.
    Key(SpecialKey),
    /// `n <calls>`: hook procedure calls so far (diagnostics).
    Calls(u64),
}

#[cfg(any(windows, test))]
fn format_key(key: &SpecialKey) -> String {
    format!("k {} {}\n", u8::from(key.down), key.code)
}

#[cfg(any(windows, test))]
fn parse_helper_line(line: &str) -> Option<HelperLine> {
    let mut parts = line.split_whitespace();
    match (parts.next()?, parts.next()?, parts.next()) {
        ("k", down, Some(code)) => {
            let code = SPECIAL_KEY_CODES
                .iter()
                .copied()
                .find(|known| *known == code)?;
            let down = match down {
                "1" => true,
                "0" => false,
                _ => return None,
            };
            Some(HelperLine::Key(SpecialKey { code, down }))
        }
        ("n", calls, None) => calls.parse().ok().map(HelperLine::Calls),
        _ => None,
    }
}

/// State of the hook for QA and diagnostics (`vnc_special_key_capture_status`).
#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct SpecialKeyCaptureStatus {
    pub supported: bool,
    /// The helper process is running with its hook installed.
    pub installed: bool,
    pub capturing: bool,
    /// Hook procedure calls (as last reported by the helper) and keys
    /// swallowed since the app started.
    pub hook_calls: u64,
    pub intercepted: u64,
}

#[cfg(windows)]
mod imp {
    use std::io::{BufRead, BufReader, Write};
    use std::os::windows::process::CommandExt;
    use std::process::{Child, ChildStdin, Command, Stdio};
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

    use tauri::{AppHandle, Emitter};

    use super::{
        HOOK_PROCESS_ARG, HelperLine, SPECIAL_KEY_EVENT, SpecialKeyCaptureStatus, parse_helper_line,
    };

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    struct Helper {
        child: Child,
        stdin: ChildStdin,
    }

    static HELPER: Mutex<Option<Helper>> = Mutex::new(None);
    static CAPTURING: AtomicBool = AtomicBool::new(false);
    static HOOK_CALLS: AtomicU64 = AtomicU64::new(0);
    static INTERCEPTED: AtomicU64 = AtomicU64::new(0);

    fn spawn(app: AppHandle) -> std::io::Result<Helper> {
        let mut child = Command::new(std::env::current_exe()?)
            .arg(HOOK_PROCESS_ARG)
            .arg(std::process::id().to_string())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| std::io::Error::other("helper stdin"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| std::io::Error::other("helper stdout"))?;
        std::thread::Builder::new()
            .name("vnc-special-keys".into())
            .spawn(move || {
                for line in BufReader::new(stdout).lines() {
                    let Ok(line) = line else { break };
                    match parse_helper_line(&line) {
                        Some(HelperLine::Key(key)) => {
                            INTERCEPTED.fetch_add(1, Ordering::Relaxed);
                            let _ = app.emit(SPECIAL_KEY_EVENT, key);
                        }
                        Some(HelperLine::Calls(calls)) => {
                            HOOK_CALLS.store(calls, Ordering::Relaxed)
                        }
                        None => {}
                    }
                }
            })?;
        Ok(Helper { child, stdin })
    }

    fn running(helper: &mut Option<Helper>) -> bool {
        match helper.as_mut().map(|h| h.child.try_wait()) {
            Some(Ok(None)) => true,
            Some(_) => {
                *helper = None;
                false
            }
            None => false,
        }
    }

    pub fn set_capture(app: AppHandle, enabled: bool) -> bool {
        CAPTURING.store(enabled, Ordering::Release);
        let mut helper = HELPER
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if enabled && !running(&mut helper) {
            match spawn(app) {
                Ok(started) => *helper = Some(started),
                Err(error) => {
                    tracing::warn!(%error, "VNC special-key hook helper did not start");
                    return false;
                }
            }
        }
        let Some(active) = helper.as_mut() else {
            return !enabled;
        };
        let command: &[u8] = if enabled { b"on\n" } else { b"off\n" };
        if active
            .stdin
            .write_all(command)
            .and_then(|_| active.stdin.flush())
            .is_err()
        {
            *helper = None;
            return !enabled;
        }
        true
    }

    pub fn status() -> SpecialKeyCaptureStatus {
        let mut helper = HELPER
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        SpecialKeyCaptureStatus {
            supported: true,
            installed: running(&mut helper),
            capturing: CAPTURING.load(Ordering::Acquire),
            hook_calls: HOOK_CALLS.load(Ordering::Relaxed),
            intercepted: INTERCEPTED.load(Ordering::Relaxed),
        }
    }
}

/// The helper process: owns the low-level hook (see the module comment).
#[cfg(windows)]
mod helper {
    use std::cell::RefCell;
    use std::collections::HashSet;
    use std::io::{BufRead, Write};
    use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
    use std::sync::mpsc;
    use std::time::Duration;

    use winapi::shared::minwindef::{LPARAM, LRESULT, WPARAM};
    use winapi::um::libloaderapi::GetModuleHandleW;
    use winapi::um::processthreadsapi::GetCurrentThreadId;
    use winapi::um::winuser::{
        CallNextHookEx, GetAsyncKeyState, GetForegroundWindow, GetMessageW,
        GetWindowThreadProcessId, KBDLLHOOKSTRUCT, LLKHF_ALTDOWN, MSG, PostThreadMessageW,
        SetWindowsHookExW, UnhookWindowsHookEx, VK_CONTROL, WH_KEYBOARD_LL, WM_KEYDOWN, WM_QUIT,
        WM_SYSKEYDOWN,
    };

    use super::{SpecialKey, classify, format_key};

    static CAPTURING: AtomicBool = AtomicBool::new(false);
    static PARENT: AtomicU32 = AtomicU32::new(0);
    static CALLS: AtomicU64 = AtomicU64::new(0);

    // The hook procedure must return quickly (Windows skips, and since
    // Windows 7 silently removes, a hook that exceeds LowLevelHooksTimeout):
    // it only touches thread-local state and hands keys to the writer thread.
    thread_local! {
        /// Keys whose press was swallowed; their release is swallowed too.
        static HELD: RefCell<HashSet<u32>> = RefCell::new(HashSet::new());
        static OUT: RefCell<Option<mpsc::Sender<SpecialKey>>> = const { RefCell::new(None) };
    }

    fn foreground_is_parent() -> bool {
        // SAFETY: plain Win32 calls; pid is a valid out pointer.
        unsafe {
            let window = GetForegroundWindow();
            if window.is_null() {
                return false;
            }
            let mut pid = 0u32;
            GetWindowThreadProcessId(window, &mut pid);
            pid != 0 && pid == PARENT.load(Ordering::Relaxed)
        }
    }

    unsafe extern "system" fn hook_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code >= 0 {
            CALLS.fetch_add(1, Ordering::Relaxed);
            // SAFETY: for WH_KEYBOARD_LL, lparam points at a KBDLLHOOKSTRUCT.
            let info = unsafe { &*(lparam as *const KBDLLHOOKSTRUCT) };
            let message = wparam as u32;
            let down = message == WM_KEYDOWN || message == WM_SYSKEYDOWN;
            let vk = info.vkCode;
            let key = HELD.with(|held| {
                let mut held = held.borrow_mut();
                if down {
                    if !CAPTURING.load(Ordering::Acquire) || !foreground_is_parent() {
                        return None;
                    }
                    let alt = info.flags & LLKHF_ALTDOWN != 0;
                    // SAFETY: plain Win32 call without pointers.
                    let ctrl = unsafe { GetAsyncKeyState(VK_CONTROL) } < 0;
                    let key = classify(vk, alt, ctrl);
                    if key.is_some() {
                        held.insert(vk);
                    }
                    key
                } else if held.remove(&vk) {
                    // Releases follow their swallowed press even after capture stops.
                    classify(vk, true, true)
                } else {
                    None
                }
            });
            if let Some(key) = key {
                OUT.with(|out| {
                    if let Some(tx) = out.borrow().as_ref() {
                        let _ = tx.send(SpecialKey { code: key, down });
                    }
                });
                return 1;
            }
        }
        // SAFETY: forwarding the unmodified hook arguments.
        unsafe { CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam) }
    }

    pub fn run(parent: u32) -> i32 {
        PARENT.store(parent, Ordering::Relaxed);
        // SAFETY: Win32 call without arguments.
        let main_thread = unsafe { GetCurrentThreadId() };

        let (key_tx, key_rx) = mpsc::channel::<SpecialKey>();
        OUT.with(|out| *out.borrow_mut() = Some(key_tx));
        let writer = std::thread::spawn(move || {
            let mut stdout = std::io::stdout();
            let mut reported = u64::MAX;
            loop {
                let line = match key_rx.recv_timeout(Duration::from_millis(250)) {
                    Ok(key) => format_key(&key),
                    Err(mpsc::RecvTimeoutError::Timeout) => {
                        let calls = CALLS.load(Ordering::Relaxed);
                        if calls == reported {
                            continue;
                        }
                        reported = calls;
                        format!("n {calls}\n")
                    }
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                };
                if stdout
                    .write_all(line.as_bytes())
                    .and_then(|_| stdout.flush())
                    .is_err()
                {
                    break;
                }
            }
        });
        std::thread::spawn(move || {
            for line in std::io::stdin().lock().lines() {
                match line.as_deref() {
                    Ok("on") => CAPTURING.store(true, Ordering::Release),
                    Ok("off") => CAPTURING.store(false, Ordering::Release),
                    Ok(_) => {}
                    Err(_) => break,
                }
            }
            // The parent closed our stdin (or exited): end the message loop.
            // SAFETY: posting WM_QUIT to this process's main thread.
            unsafe {
                PostThreadMessageW(main_thread, WM_QUIT, 0, 0);
            }
        });

        // SAFETY: installs this module's hook procedure for the desktop; it is
        // removed below on this same thread.
        let hook = unsafe {
            SetWindowsHookExW(
                WH_KEYBOARD_LL,
                Some(hook_proc),
                GetModuleHandleW(std::ptr::null()),
                0,
            )
        };
        if hook.is_null() {
            return 1;
        }
        // Low-level hooks are called on this thread's message loop.
        // SAFETY: MSG is plain data; GetMessageW fills it.
        unsafe {
            let mut msg: MSG = std::mem::zeroed();
            while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {}
            UnhookWindowsHookEx(hook);
        }
        OUT.with(|out| out.borrow_mut().take());
        let _ = writer.join();
        0
    }
}

/// Entry point of `taomni --vnc-special-key-hook <parent-pid>`.
#[cfg(windows)]
pub fn run_hook_process() -> i32 {
    match std::env::args()
        .nth(2)
        .and_then(|pid| pid.parse::<u32>().ok())
    {
        Some(parent) => helper::run(parent),
        None => 2,
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

/// Whether the hook is installed and how many keys it has swallowed (native QA).
#[tauri::command]
pub fn vnc_special_key_capture_status() -> SpecialKeyCaptureStatus {
    #[cfg(windows)]
    {
        imp::status()
    }
    #[cfg(not(windows))]
    {
        SpecialKeyCaptureStatus::default()
    }
}

#[cfg(test)]
mod tests {
    use super::{HelperLine, SpecialKey, classify, format_key, parse_helper_line};

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

    #[test]
    fn helper_lines_round_trip_and_reject_unknown_keys() {
        let key = SpecialKey {
            code: "PrintScreen",
            down: true,
        };
        assert_eq!(
            parse_helper_line(format_key(&key).trim_end()),
            Some(HelperLine::Key(key))
        );
        assert_eq!(
            parse_helper_line("k 0 Escape"),
            Some(HelperLine::Key(SpecialKey {
                code: "Escape",
                down: false
            }))
        );
        assert_eq!(parse_helper_line("n 42"), Some(HelperLine::Calls(42)));
        assert_eq!(parse_helper_line("k 1 KeyA"), None);
        assert_eq!(parse_helper_line("k 2 Tab"), None);
        assert_eq!(parse_helper_line("n"), None);
        assert_eq!(parse_helper_line("garbage"), None);
    }
}
