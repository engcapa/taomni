//! Floating capture surfaces need absolute placement and keep-above.
//! xdg-toplevel provides neither. Use the compositor's XWayland connection
//! for these auxiliary GTK windows; the main window and capture portal stay
//! on Wayland. Never change GDK's process-wide default display.

use gtk::prelude::*;
use std::cell::RefCell;
use tauri::Manager;

thread_local! {
    static FLOATING_DISPLAY: RefCell<Option<gtk::gdk::Display>> = const { RefCell::new(None) };
}

fn configure(window: &gtk::ApplicationWindow) -> Result<(), String> {
    if !super::pins::native_wayland() {
        return Ok(());
    }
    FLOATING_DISPLAY.with(|slot| {
        if slot.borrow().is_none() {
            let name = std::env::var("DISPLAY")
                .map_err(|_| "Floating screenshot windows require XWayland (DISPLAY missing)")?;
            let display = gtk::gdk::Display::open(&name)
                .filter(|display| display.type_().name() == "GdkX11Display")
                .ok_or("Cannot open XWayland for floating screenshot windows; allow both wayland and x11 in GDK_BACKEND")?;
            *slot.borrow_mut() = Some(display);
        }
        let display = slot.borrow();
        let screen = display.as_ref().unwrap().default_screen();
        window.set_screen(&screen);
        window.set_keep_above(true);
        Ok(())
    })
}

pub(super) fn webview(window: &tauri::WebviewWindow) -> Result<(), String> {
    let target = window.clone();
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    window
        .run_on_main_thread(move || {
            let result = target
                .gtk_window()
                .map_err(|e| e.to_string())
                .and_then(|w| configure(&w));
            let _ = tx.send(result);
        })
        .map_err(|e| e.to_string())?;
    rx.recv_timeout(std::time::Duration::from_secs(5))
        .map_err(|e| format!("configure floating capture window: {e}"))?
}

/// Portal/display pixels are per-monitor physical coordinates. XWayland
/// floating windows use a global buffer scale; use compositor logical geometry
/// so that scale cannot shrink or move controls into the captured region.
pub(super) fn place_webview(
    window: &tauri::WebviewWindow,
    rect: super::surfaces::Rect,
) -> Result<(), String> {
    if super::pins::native_wayland() {
        let displays =
            super::capture::list_displays(window.app_handle()).map_err(|e| e.to_string())?;
        let owners: Vec<_> = displays
            .iter()
            .filter(|d| {
                rect.x >= d.x
                    && rect.y >= d.y
                    && rect.x + rect.w <= d.x + d.width as i32
                    && rect.y + rect.h <= d.y + d.height as i32
            })
            .collect();
        let owner = match owners.as_slice() {
            [owner] => owner,
            _ => return Err("Cannot resolve the floating capture control's monitor".into()),
        };
        let scale = owner.scale_factor.max(1.0);
        window
            .set_size(tauri::LogicalSize::new(
                rect.w as f64 / scale,
                rect.h as f64 / scale,
            ))
            .map_err(|e| e.to_string())?;
        window
            .set_position(tauri::LogicalPosition::new(
                rect.x as f64 / scale,
                rect.y as f64 / scale,
            ))
            .map_err(|e| e.to_string())?;
    } else {
        window
            .set_size(tauri::PhysicalSize::new(rect.w as u32, rect.h as u32))
            .map_err(|e| e.to_string())?;
        window
            .set_position(tauri::PhysicalPosition::new(rect.x, rect.y))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub(super) fn border(window: &tauri::Window) -> Result<(), String> {
    let target = window.clone();
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    window
        .run_on_main_thread(move || {
            let result = target
                .gtk_window()
                .map_err(|e| e.to_string())
                .and_then(|w| configure(&w));
            let _ = tx.send(result);
        })
        .map_err(|e| e.to_string())?;
    rx.recv_timeout(std::time::Duration::from_secs(5))
        .map_err(|e| format!("configure capture outline: {e}"))?
}
