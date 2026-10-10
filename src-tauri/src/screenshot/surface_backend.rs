//! Floating capture surfaces need absolute placement and keep-above.
//! xdg-toplevel provides neither. Use the compositor's XWayland connection
//! for these auxiliary GTK windows; the main window and capture portal stay
//! on Wayland. Never change GDK's process-wide default display.

use gtk::prelude::*;
use std::cell::RefCell;

thread_local! {
    static FLOATING_DISPLAY: RefCell<Option<gtk::gdk::Display>> = const { RefCell::new(None) };
}

/// Bridge a user action on an XWayland capture control to the main Wayland
/// toplevel. GTK's Wayland seat cannot supply the X11 control's input serial;
/// the compositor can resolve its startup notification using the X11 timestamp.
/// Call on the GTK thread while the focused floating window is still mapped.
pub(super) fn activation_id() -> Option<String> {
    FLOATING_DISPLAY.with(|slot| {
        let display = slot.borrow();
        let display = display.as_ref()?;
        let active = gtk::Window::list_toplevels()
            .into_iter()
            .filter_map(|widget| widget.downcast::<gtk::Window>().ok())
            .any(|window| window.is_active() && window.display() == *display);
        log::info!("capture activation: floating_display={}, active={active}", display.type_().name());
        if !active {
            return None;
        }
        let executable = std::env::current_exe().ok()?;
        let command = gtk::glib::shell_quote(executable);
        let info = gtk::gio::AppInfo::create_from_commandline(
            &command,
            Some("Taomni"),
            gtk::gio::AppInfoCreateFlags::SUPPORTS_STARTUP_NOTIFICATION,
        )
        .ok()?;
        let id = display
            .app_launch_context()?
            .startup_notify_id(&info, &[])?;
        // Startup notification and xdg activation travel on different display
        // connections. Publish the X11 sequence before activating Wayland.
        display.sync();
        Some(id.to_string())
    })
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

fn desktop_bounds(display: &gtk::gdk::Display) -> Result<super::surfaces::Rect, String> {
    let monitors: Vec<_> = (0..display.n_monitors())
        .filter_map(|index| display.monitor(index).map(|monitor| monitor.geometry()))
        .collect();
    let x = monitors
        .iter()
        .map(|g| g.x())
        .min()
        .ok_or("display has no monitors")?;
    let y = monitors
        .iter()
        .map(|g| g.y())
        .min()
        .ok_or("display has no monitors")?;
    let right = monitors.iter().map(|g| g.x() + g.width()).max().unwrap();
    let bottom = monitors.iter().map(|g| g.y() + g.height()).max().unwrap();
    Ok(super::surfaces::Rect {
        x,
        y,
        w: right - x,
        h: bottom - y,
    })
}

fn place_gtk(
    window: &gtk::ApplicationWindow,
    position: super::surfaces::ControlPosition,
    border: bool,
) -> Result<(), String> {
    let source_display = gtk::gdk::Display::default().ok_or("default display missing")?;
    let source = desktop_bounds(&source_display)?;
    let target = desktop_bounds(&window.display())?;
    let scale = position.scale.max(1.0);
    let rect = position.rect;
    let logical = super::surfaces::Rect {
        x: (rect.x as f64 / scale).round() as i32,
        y: (rect.y as f64 / scale).round() as i32,
        w: (rect.w as f64 / scale).round() as i32,
        h: (rect.h as f64 / scale).round() as i32,
    };
    let rect = super::surfaces::bridge_rect(logical, source, target).ok_or_else(|| {
        format!("XWayland geometry does not match the compositor: {source:?} -> {target:?}")
    })?;
    log::debug!(
        "floating screenshot geometry: {logical:?}; native={source:?}; auxiliary={target:?}; gtk={rect:?}; widget_scale={}",
        window.scale_factor()
    );
    if border {
        let geometry = gtk::gdk::Geometry::new(
            rect.w,
            rect.h,
            rect.w,
            rect.h,
            0,
            0,
            1,
            1,
            0.0,
            0.0,
            gtk::gdk::Gravity::NorthWest,
        );
        window.set_geometry_hints(
            None::<&gtk::Widget>,
            Some(&geometry),
            gtk::gdk::WindowHints::MIN_SIZE | gtk::gdk::WindowHints::MAX_SIZE,
        );
        window.set_size_request(rect.w, rect.h);
    }
    // Use the actual auxiliary GTK display instead of Tao's scale cache from
    // the Wayland display on which this window was originally constructed.
    window.set_default_size(rect.w, rect.h);
    window.resize(rect.w, rect.h);
    window.move_(rect.x, rect.y);
    Ok(())
}

/// Convert through both GDK desktops, including XWayland's global scale.
pub(super) fn place_webview(
    window: &tauri::WebviewWindow,
    position: super::surfaces::ControlPosition,
) -> Result<(), String> {
    let rect = position.rect;
    if super::pins::native_wayland() {
        let target = window.clone();
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        window
            .run_on_main_thread(move || {
                let result = target
                    .gtk_window()
                    .map_err(|e| e.to_string())
                    .and_then(|gtk| place_gtk(&gtk, position, false));
                let _ = tx.send(result);
            })
            .map_err(|e| e.to_string())?;
        rx.recv_timeout(std::time::Duration::from_secs(5))
            .map_err(|e| format!("place floating screenshot controls: {e}"))??;
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

pub(super) fn place_border(
    window: &tauri::Window,
    position: super::surfaces::ControlPosition,
) -> Result<(), String> {
    let target = window.clone();
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    window
        .run_on_main_thread(move || {
            let result = target
                .gtk_window()
                .map_err(|e| e.to_string())
                .and_then(|gtk| place_gtk(&gtk, position, true));
            let _ = tx.send(result);
        })
        .map_err(|e| e.to_string())?;
    rx.recv_timeout(std::time::Duration::from_secs(5))
        .map_err(|e| format!("place floating screenshot border: {e}"))?
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
