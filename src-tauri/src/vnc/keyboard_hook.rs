//! "Pass special keys directly to the remote device" (VNC-INPUT-003,
//! DEC-VNC-16; RealVNC `SendSpecialKeys=True`).
//!
//! Windows handles Win, Alt+Tab, Alt+Esc, Ctrl+Esc and PrtScn before a
//! WebView ever sees them. While a VNC canvas has focus in our foreground
//! window, a low-level keyboard hook swallows those keys locally and the app
//! emits `vnc-special-key` events that the focused session sends as keysyms.
//!
//! The hook runs in the Windows VNC key helper. Windows does not call a low-level hook owned by the
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

#[cfg(all(windows, feature = "legacy-vnc-client"))]
mod imp {
    use std::io::{BufRead, BufReader, Write};
    use std::os::windows::process::CommandExt;
    use std::process::{Child, ChildStdin, Command, Stdio};
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

    use taomni_vnc_key_protocol::{HelperLine, parse_helper_line};
    use tauri::{AppHandle, Emitter};

    use super::{SPECIAL_KEY_EVENT, SpecialKeyCaptureStatus};

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    struct Helper {
        child: Child,
        stdin: ChildStdin,
    }

    static HELPER: Mutex<Option<Helper>> = Mutex::new(None);
    static CAPTURING: AtomicBool = AtomicBool::new(false);
    static HOOK_CALLS: AtomicU64 = AtomicU64::new(0);
    static INTERCEPTED: AtomicU64 = AtomicU64::new(0);

    fn helper_path() -> std::io::Result<std::path::PathBuf> {
        const NAME: &str = "taomni-vnc-key-helper.exe";
        let alongside = std::env::current_exe()?.with_file_name(NAME);
        if alongside.is_file() {
            return Ok(alongside);
        }
        Err(std::io::Error::new(std::io::ErrorKind::NotFound, NAME))
    }

    fn spawn(app: AppHandle) -> std::io::Result<Helper> {
        let mut child = Command::new(helper_path()?)
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

/// Install (or remove) the special-key hook. Returns whether special keys are
/// being passed through on this platform.
#[tauri::command]
pub fn vnc_set_special_key_capture(app: tauri::AppHandle, enabled: bool) -> bool {
    #[cfg(all(windows, feature = "legacy-vnc-client"))]
    {
        imp::set_capture(app, enabled)
    }
    #[cfg(not(all(windows, feature = "legacy-vnc-client")))]
    {
        let _ = (app, enabled);
        false
    }
}

/// Whether the hook is installed and how many keys it has swallowed (native QA).
#[tauri::command]
pub fn vnc_special_key_capture_status() -> SpecialKeyCaptureStatus {
    #[cfg(all(windows, feature = "legacy-vnc-client"))]
    {
        imp::status()
    }
    #[cfg(not(all(windows, feature = "legacy-vnc-client")))]
    {
        SpecialKeyCaptureStatus::default()
    }
}
