use std::time::{Duration, Instant};

use serde_json::{Value, json};
use winapi::shared::windef::HWND;
use winapi::um::winuser::{
    GA_ROOT, GUITHREADINFO, GetAncestor, GetClassNameW, GetDlgCtrlID, GetForegroundWindow,
    GetGUIThreadInfo, GetWindowTextW, GetWindowThreadProcessId, IsWindowEnabled, IsWindowVisible,
};

fn class_name(window: HWND) -> String {
    let mut buffer = [0u16; 128];
    // SAFETY: the buffer is writable and its length is supplied to Win32.
    let length = unsafe { GetClassNameW(window, buffer.as_mut_ptr(), buffer.len() as i32) };
    String::from_utf16_lossy(&buffer[..length.max(0) as usize])
}

fn snapshot() -> Value {
    // SAFETY: these queries do not retain pointers. GUITHREADINFO is initialized
    // with its required size; Win32 supplies the window handles we inspect.
    unsafe {
        let window = GetForegroundWindow();
        let mut process_id = 0;
        let thread_id = GetWindowThreadProcessId(window, &mut process_id);
        let mut gui: GUITHREADINFO = std::mem::zeroed();
        gui.cbSize = std::mem::size_of::<GUITHREADINFO>() as u32;
        let queried = thread_id != 0 && GetGUIThreadInfo(thread_id, &mut gui) != 0;
        let owned = process_id == std::process::id();
        let dialog_class = class_name(window);
        let focus_class = class_name(gui.hwndFocus);
        let mut file_name = String::new();
        if owned && queried && focus_class == "Edit" {
            let mut buffer = [0u16; 256];
            let length = GetWindowTextW(gui.hwndFocus, buffer.as_mut_ptr(), buffer.len() as i32);
            file_name = String::from_utf16_lossy(&buffer[..length.max(0) as usize]);
        }
        let ready = owned
            && queried
            && dialog_class == "#32770"
            && IsWindowVisible(window) != 0
            && IsWindowEnabled(window) != 0
            && GetAncestor(gui.hwndFocus, GA_ROOT) == window
            && focus_class == "Edit"
            && IsWindowEnabled(gui.hwndFocus) != 0
            && file_name.starts_with("Taomni-pin");
        json!({"ready":ready,"processId":process_id,"ownProcess":owned,
            "window":window as usize,"dialogClass":dialog_class,
            "focusWindow":gui.hwndFocus as usize,"focusClass":focus_class,
            "focusControlId":GetDlgCtrlID(gui.hwndFocus),"fileName":file_name})
    }
}

/// A cold Windows shell can open the dialog after the old fixed delay.
/// Wait for the actual filename field before sending any global OS input.
pub(super) async fn wait_ready() -> anyhow::Result<Value> {
    let started = Instant::now();
    loop {
        let mut state = snapshot();
        state["waitedMs"] = json!(started.elapsed().as_millis());
        if state["ready"] == true {
            return Ok(state);
        }
        if started.elapsed() >= Duration::from_secs(20) {
            anyhow::bail!("QA save dialog filename did not gain focus: {state}");
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}
