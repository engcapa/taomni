//! Windows special key input process, owned by the VNC client.

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
    CallNextHookEx, GetAsyncKeyState, GetForegroundWindow, GetMessageW, GetWindowThreadProcessId,
    KBDLLHOOKSTRUCT, LLKHF_ALTDOWN, MSG, PM_NOREMOVE, PeekMessageW, PostThreadMessageW,
    SetWindowsHookExW, UnhookWindowsHookEx, VK_CONTROL, WH_KEYBOARD_LL, WM_KEYDOWN, WM_QUIT,
    WM_SYSKEYDOWN,
};

use taomni_vnc_key_protocol::{SpecialKey, classify, format_key};

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
    // Create the queue before the stdin reader can post WM_QUIT on early EOF.
    // SAFETY: MSG is plain data and PeekMessageW fills any returned message.
    let mut msg: MSG = unsafe { std::mem::zeroed() };
    unsafe { PeekMessageW(&mut msg, std::ptr::null_mut(), 0, 0, PM_NOREMOVE) };

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
        while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {}
        UnhookWindowsHookEx(hook);
    }
    OUT.with(|out| out.borrow_mut().take());
    let _ = writer.join();
    0
}
