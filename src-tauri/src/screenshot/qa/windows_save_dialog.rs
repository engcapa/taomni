use std::time::{Duration, Instant};

use serde_json::{Value, json};
use winapi::shared::windef::{HWND, RECT};
use winapi::um::winuser::{
    GA_ROOT, GUITHREADINFO, GetAncestor, GetClassNameW, GetDlgCtrlID, GetDlgItem,
    GetForegroundWindow, GetGUIThreadInfo, GetWindowRect, GetWindowTextLengthW, GetWindowTextW,
    GetWindowThreadProcessId, IsWindowEnabled, IsWindowVisible,
};

use super::save_dialog_observation::{StableObservation, filename_ready};

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
            let capacity = GetWindowTextLengthW(gui.hwndFocus).max(0) as usize + 1;
            let mut buffer = vec![0u16; capacity];
            let length = GetWindowTextW(gui.hwndFocus, buffer.as_mut_ptr(), buffer.len() as i32);
            file_name = String::from_utf16_lossy(&buffer[..length.max(0) as usize]);
        }
        let dialog_ready = owned
            && queried
            && dialog_class == "#32770"
            && IsWindowVisible(window) != 0
            && IsWindowEnabled(window) != 0
            && IsWindowEnabled(gui.hwndFocus) != 0;
        let save = if dialog_ready {
            GetDlgItem(window, 1)
        } else {
            std::ptr::null_mut()
        };
        let mut bounds: RECT = std::mem::zeroed();
        let save_ready = !save.is_null()
            && GetAncestor(save, GA_ROOT) == window
            && IsWindowEnabled(save) != 0
            && IsWindowVisible(save) != 0
            && GetWindowRect(save, &mut bounds) != 0
            && bounds.right > bounds.left
            && bounds.bottom > bounds.top;
        json!({"dialogReady":dialog_ready,"processId":process_id,"ownProcess":owned,
            "window":window as usize,"dialogClass":dialog_class,
            "focusWindow":gui.hwndFocus as usize,"focusClass":focus_class,
            "focusControlId":GetDlgCtrlID(gui.hwndFocus),"fileName":file_name,
            "focusInDialog":GetAncestor(gui.hwndFocus, GA_ROOT) == window,
            "saveButton":{"ready":save_ready,"window":save as usize,
                "center":[(bounds.left+bounds.right)/2,(bounds.top+bounds.bottom)/2]}})
    }
}

/// A cold Windows shell can open the dialog after the old fixed delay.
/// Wait for the actual filename field before sending any global OS input.
pub(super) async fn wait_ready() -> anyhow::Result<Value> {
    let started = Instant::now();
    let mut stable = StableObservation::default();
    loop {
        let mut state = snapshot();
        if stable.observe(&state, filename_ready(&state, None), started.elapsed()) {
            state["ready"] = json!(true);
            state["waitedMs"] = json!(started.elapsed().as_millis());
            return Ok(state);
        }
        if started.elapsed() >= Duration::from_secs(20) {
            anyhow::bail!("QA save dialog filename did not gain focus: {state}");
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// Use actual OS input, then read the whole field back before confirming.
/// Sending a long Unicode batch followed immediately by Return can instead
/// accept a Shell autocomplete suggestion halfway through that batch.
pub(super) fn choose_destination(
    input: &mut enigo::Enigo,
    destination: &std::path::Path,
) -> anyhow::Result<Value> {
    use anyhow::Context;
    use enigo::{Button, Coordinate, Direction, Key, Keyboard, Mouse};
    let path = destination.to_str().context("UTF-8 save destination")?;
    let before = snapshot();
    anyhow::ensure!(
        filename_ready(&before, None),
        "Save field lost focus: {before}"
    );
    input.key(Key::Control, Direction::Press)?;
    std::thread::sleep(Duration::from_millis(30));
    let selected = input.key(Key::Unicode('a'), Direction::Click);
    let released = input.key(Key::Control, Direction::Release);
    selected?;
    released?;
    std::thread::sleep(Duration::from_millis(50));
    for character in path.chars() {
        input.text(&character.to_string())?;
        std::thread::sleep(Duration::from_millis(15));
    }
    let started = Instant::now();
    let mut stable = StableObservation::default();
    let entered = loop {
        let state = snapshot();
        if stable.observe(
            &state,
            filename_ready(&state, Some(path)),
            started.elapsed(),
        ) {
            break state;
        }
        anyhow::ensure!(
            started.elapsed() < Duration::from_secs(10),
            "Save destination was not entered completely: expected={path:?}, observed={state}"
        );
        std::thread::sleep(Duration::from_millis(50));
    };
    let center = &entered["saveButton"]["center"];
    let target = (
        center[0].as_i64().context("Save button x")? as i32,
        center[1].as_i64().context("Save button y")? as i32,
    );
    input.move_mouse(target.0, target.1, Coordinate::Abs)?;
    std::thread::sleep(Duration::from_millis(100));
    anyhow::ensure!(
        input.location()? == target,
        "OS pointer did not reach Save button"
    );
    let confirmed = snapshot();
    anyhow::ensure!(
        filename_ready(&confirmed, Some(path)) && confirmed == entered,
        "Save dialog changed before confirmation: {confirmed}"
    );
    input.button(Button::Left, Direction::Click)?;
    Ok(
        json!({"input":"paced OS keyboard","destinationEntered":entered,
        "confirmation":"OS mouse click on the enabled Save button"}),
    )
}
