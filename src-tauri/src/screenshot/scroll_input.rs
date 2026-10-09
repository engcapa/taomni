//! Temporary, session-owned stop input. Starting a screenshot is deliberately
//! a different operation from finishing one, including across app instances.

use super::scroll::ScrollControl;
use std::sync::Arc;

#[cfg(not(target_os = "windows"))]
pub(super) struct StopInput(tauri::AppHandle);

#[cfg(not(target_os = "windows"))]
impl StopInput {
    pub fn start(app: &tauri::AppHandle, control: Arc<ScrollControl>) -> Result<Self, String> {
        use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
        app.global_shortcut()
            .on_shortcut("Escape", move |_, _, event| {
                if event.state == ShortcutState::Pressed {
                    control.request_stop(false);
                }
            })
            .map_err(|e| format!("register scroll capture Escape key: {e}"))?;
        Ok(Self(app.clone()))
    }
}

#[cfg(not(target_os = "windows"))]
impl Drop for StopInput {
    fn drop(&mut self) {
        use tauri_plugin_global_shortcut::GlobalShortcutExt;
        let _ = self.0.global_shortcut().unregister("Escape");
    }
}

#[cfg(target_os = "windows")]
pub(super) use windows_input::StopInput;
#[cfg(target_os = "windows")]
pub use windows_input::run_helper;

#[cfg(target_os = "windows")]
mod windows_input {
    use super::*;
    use std::cell::RefCell;
    use std::io::{BufRead, BufReader, Write};
    use std::os::windows::process::CommandExt;
    use std::process::{Child, ChildStdin, Command, Stdio};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::{Duration, Instant};
    use winapi::shared::minwindef::{LPARAM, LRESULT, WPARAM};
    use winapi::um::libloaderapi::GetModuleHandleW;
    use winapi::um::winuser::*;

    struct Input {
        control: Arc<ScrollControl>,
        escape: bool,
        right: bool,
    }
    thread_local! { static INPUT: RefCell<Option<Input>> = const { RefCell::new(None) }; }

    unsafe extern "system" fn keyboard(code: i32, w: WPARAM, l: LPARAM) -> LRESULT {
        if code == HC_ACTION {
            let info = unsafe { &*(l as *const KBDLLHOOKSTRUCT) };
            if info.vkCode == VK_ESCAPE as u32 {
                let handled = INPUT.with(|state| {
                    let mut state = state.borrow_mut();
                    let Some(input) = state.as_mut() else {
                        return false;
                    };
                    let down = w as u32 == WM_KEYDOWN || w as u32 == WM_SYSKEYDOWN;
                    if down && !input.control.stop.load(Ordering::SeqCst) {
                        input.escape = true;
                        input.control.request_stop(false);
                    }
                    let handled = input.escape;
                    if !down {
                        input.escape = false;
                    }
                    handled
                });
                if handled {
                    return 1;
                }
            }
        }
        unsafe { CallNextHookEx(std::ptr::null_mut(), code, w, l) }
    }

    unsafe extern "system" fn mouse(code: i32, w: WPARAM, l: LPARAM) -> LRESULT {
        if code == HC_ACTION && (w as u32 == WM_RBUTTONDOWN || w as u32 == WM_RBUTTONUP) {
            let handled = INPUT.with(|state| {
                let mut state = state.borrow_mut();
                let Some(input) = state.as_mut() else {
                    return false;
                };
                let down = w as u32 == WM_RBUTTONDOWN;
                if down && !input.control.stop.load(Ordering::SeqCst) {
                    input.right = true;
                    input.control.request_stop(false);
                }
                let handled = input.right;
                if !down {
                    input.right = false;
                }
                handled
            });
            if handled {
                return 1;
            }
        }
        unsafe { CallNextHookEx(std::ptr::null_mut(), code, w, l) }
    }

    // WebView2 can suppress hooks installed by its own hosting process while
    // that process owns the foreground (also see vnc/keyboard_hook.rs). Keep
    // the hooks in a session-owned helper, with stdin EOF as the crash lease.
    pub(crate) struct StopInput {
        child: Child,
        stdin: Option<ChildStdin>,
        reader: Option<std::thread::JoinHandle<()>>,
    }

    impl StopInput {
        pub fn start(_: &tauri::AppHandle, control: Arc<ScrollControl>) -> Result<Self, String> {
            let mut child = Command::new(std::env::current_exe().map_err(|e| e.to_string())?)
                .arg("--screenshot-scroll-input")
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .creation_flags(0x0800_0000)
                .spawn()
                .map_err(|e| format!("start scroll input helper: {e}"))?;
            let stdin = child.stdin.take();
            let stdout = child.stdout.take().expect("piped helper stdout");
            let (tx, rx) = std::sync::mpsc::sync_channel(1);
            let reader = std::thread::spawn(move || {
                let mut ready = false;
                for line in BufReader::new(stdout).lines() {
                    match line.as_deref() {
                        Ok("ready") if !ready => {
                            ready = true;
                            let _ = tx.send(());
                        }
                        Ok("stop") => control.request_stop(false),
                        _ => {}
                    }
                }
                // A dead helper must never leave a hidden-controls capture
                // running without its independent exit.
                control.request_stop(false);
            });
            let input = Self {
                child,
                stdin,
                reader: Some(reader),
            };
            rx.recv_timeout(Duration::from_secs(5))
                .map_err(|e| format!("scroll stop input unavailable: {e}"))?;
            Ok(input)
        }
    }

    impl Drop for StopInput {
        fn drop(&mut self) {
            self.stdin.take();
            let until = Instant::now() + Duration::from_secs(3);
            while matches!(self.child.try_wait(), Ok(None)) && Instant::now() < until {
                std::thread::sleep(Duration::from_millis(10));
            }
            let _ = self.child.kill();
            let _ = self.child.wait();
            if let Some(reader) = self.reader.take() {
                let _ = reader.join();
            }
        }
    }

    pub fn run_helper() -> i32 {
        let control = Arc::new(ScrollControl::default());
        let hooks = match HookInput::start(control.clone()) {
            Ok(hooks) => hooks,
            Err(_) => return 1,
        };
        let parent = control.clone();
        std::thread::spawn(move || {
            for line in std::io::stdin().lock().lines() {
                if line.is_err() {
                    break;
                }
            }
            parent.request_stop(true);
        });
        let mut output = std::io::stdout();
        if writeln!(output, "ready")
            .and_then(|_| output.flush())
            .is_err()
        {
            return 1;
        }
        while !control.stop.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(8));
        }
        if !control.cancel.load(Ordering::SeqCst) {
            let _ = writeln!(output, "stop").and_then(|_| output.flush());
        }
        drop(hooks);
        0
    }

    struct HookInput {
        shutdown: Arc<AtomicBool>,
        thread: Option<std::thread::JoinHandle<()>>,
    }

    impl HookInput {
        fn start(control: Arc<ScrollControl>) -> Result<Self, String> {
            let shutdown = Arc::new(AtomicBool::new(false));
            let exiting = shutdown.clone();
            let (tx, rx) = std::sync::mpsc::sync_channel(1);
            let thread = std::thread::spawn(move || unsafe {
                INPUT.with(|state| {
                    *state.borrow_mut() = Some(Input {
                        control,
                        escape: false,
                        right: false,
                    })
                });
                let module = GetModuleHandleW(std::ptr::null());
                let key_hook = SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard), module, 0);
                let mouse_hook = SetWindowsHookExW(WH_MOUSE_LL, Some(mouse), module, 0);
                if key_hook.is_null() || mouse_hook.is_null() {
                    let error = std::io::Error::last_os_error();
                    if !key_hook.is_null() {
                        UnhookWindowsHookEx(key_hook);
                    }
                    if !mouse_hook.is_null() {
                        UnhookWindowsHookEx(mouse_hook);
                    }
                    let _ = tx.send(Err(format!("install scroll stop input: {error}")));
                    return;
                }
                let _ = tx.send(Ok(()));
                let mut ending = None;
                loop {
                    let mut message: MSG = std::mem::zeroed();
                    while PeekMessageW(&mut message, std::ptr::null_mut(), 0, 0, PM_REMOVE) != 0 {
                        TranslateMessage(&message);
                        DispatchMessageW(&message);
                    }
                    if exiting.load(Ordering::SeqCst) {
                        let since = ending.get_or_insert_with(Instant::now);
                        let held = INPUT.with(|state| {
                            state.borrow().as_ref().is_some_and(|s| s.escape || s.right)
                        });
                        // Consume the release as well, so it cannot dismiss the
                        // result or open the target application's context menu.
                        if !held || since.elapsed() >= Duration::from_secs(2) {
                            break;
                        }
                    }
                    std::thread::sleep(Duration::from_millis(8));
                }
                UnhookWindowsHookEx(key_hook);
                UnhookWindowsHookEx(mouse_hook);
                INPUT.with(|state| state.borrow_mut().take());
            });
            let input = Self {
                shutdown,
                thread: Some(thread),
            };
            rx.recv_timeout(Duration::from_secs(5))
                .map_err(|e| format!("start scroll stop input: {e}"))??;
            Ok(input)
        }
    }

    impl Drop for HookInput {
        fn drop(&mut self) {
            self.shutdown.store(true, Ordering::SeqCst);
            if let Some(thread) = self.thread.take() {
                let _ = thread.join();
            }
        }
    }
}
