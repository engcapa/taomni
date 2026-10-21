use super::PIN_LABEL_PREFIX;
use super::capture;
use super::model::PinInit;
use super::pins;
use super::runtime::PIN_COUNTER;
use super::runtime::tool_state;
#[cfg(target_os = "linux")]
use super::surface_backend;
use super::window_lifecycle::window_builder;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use tauri::AppHandle;
use tauri::Manager;
use tauri::WebviewUrl;
pub(super) fn open_pin(
    app: &AppHandle,
    pinned: PathBuf,
    width: u32,
    height: u32,
    favorite_id: Option<String>,
) -> Result<String, String> {
    open_pin_with_note(app, pinned, width, height, favorite_id, String::new())
}

pub(super) fn open_pin_with_note(
    app: &AppHandle,
    pinned: PathBuf,
    width: u32,
    height: u32,
    favorite_id: Option<String>,
    note: String,
) -> Result<String, String> {
    let overlay_display = tool_state().overlay.as_ref().map(|o| o.display_id.clone());
    // Release the session lock before waiting for GTK monitor enumeration.
    // Pins open on the captured display (or the one under the pointer).
    let display = match overlay_display {
        Some(id) => capture::resolve_display(app, Some(&id)).ok(),
        None => capture::display_at_cursor(app).ok(),
    };
    let scale = display
        .as_ref()
        .map(|d| d.scale_factor)
        .unwrap_or(1.0)
        .max(0.5);
    let origin = display
        .as_ref()
        .map(|d| (d.x as f64 / scale, d.y as f64 / scale))
        .unwrap_or((0.0, 0.0));
    // Logical size at 1:1 physical pixels, capped so huge shots stay usable.
    const MAX_DIM: f64 = 720.0;
    let (lw, lh) = (width as f64 / scale, height as f64 / scale);
    let fit = (MAX_DIM / lw.max(lh)).min(1.0);
    let label = format!(
        "{PIN_LABEL_PREFIX}{}",
        PIN_COUNTER.fetch_add(1, Ordering::Relaxed)
    );
    tool_state().pins.insert(
        label.clone(),
        PinInit {
            path: pinned.to_string_lossy().into_owned(),
            width,
            height,
            favorite_id,
            note,
        },
    );

    // New pins cascade from the previous one instead of stacking exactly on
    // top of it; the user can tile them later from any pin's menu.
    let open_pins = app
        .webview_windows()
        .keys()
        .filter(|label| label.starts_with(PIN_LABEL_PREFIX))
        .count() as f64;
    let offset = 32.0 * (open_pins % 10.0);
    let url = WebviewUrl::App("index.html#screenshot-pin".into());
    let window = window_builder(app, &label, url)
        .title("Pinned Screenshot")
        .inner_size((lw * fit).round().max(240.0), (lh * fit).round().max(160.0))
        .position(origin.0 + 96.0 + offset, origin.1 + 96.0 + offset)
        .transparent(true)
        .decorations(false)
        // A native shadow darkens the desktop through translucent pin pixels on macOS.
        .shadow(false)
        .resizable(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false)
        .build();
    let window = match window {
        Ok(window) => window,
        Err(e) => {
            tool_state().pins.remove(&label);
            std::fs::remove_file(&pinned).ok();
            return Err(format!("open pin window: {e}"));
        }
    };
    #[cfg(target_os = "linux")]
    if let Err(error) = surface_backend::webview(&window) {
        let _ = window.close();
        tool_state().pins.remove(&label);
        std::fs::remove_file(&pinned).ok();
        return Err(error);
    }
    window
        .set_position(tauri::LogicalPosition::new(
            origin.0 + 96.0 + offset,
            origin.1 + 96.0 + offset,
        ))
        .map_err(|e| e.to_string())?;
    window.show().map_err(|e| e.to_string())?;
    let pin_label = label.clone();
    let pin_app = app.clone();
    window.on_window_event(move |event| {
        use tauri::Emitter;
        if let tauri::WindowEvent::Destroyed = event {
            if let Some(pin) = tool_state().pins.remove(&pin_label) {
                std::fs::remove_file(pin.path).ok();
            }
            let _ = pin_app.emit(pins::PINS_CHANGED_EVENT, ());
            pins::close_pin_tools(&pin_app, &pin_label);
        }
    });
    {
        use tauri::Emitter;
        let _ = app.emit(pins::PINS_CHANGED_EVENT, ());
    }
    Ok(label)
}
