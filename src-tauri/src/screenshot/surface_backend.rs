//! Floating capture surfaces need absolute placement and keep-above.
//! xdg-toplevel provides neither. Use the compositor's XWayland connection
//! for these auxiliary GTK windows; the main window and capture portal stay
//! on Wayland. Never change GDK's process-wide default display.

use gtk::glib::translate::ToGlibPtr;
use gtk::prelude::*;
use std::cell::RefCell;

#[link(name = "gdk-3")]
unsafe extern "C" {
    fn gdk_x11_get_server_time(window: *mut gtk::gdk::ffi::GdkWindow) -> u32;
    /// XIDs are 32-bit; this matches the sibling declaration in the QA oracle
    /// (a differing signature for the same symbol is a clashing declaration).
    fn gdk_x11_window_get_xid(window: *mut gtk::gdk::ffi::GdkWindow) -> u32;
}

thread_local! {
    static FLOATING_DISPLAY: RefCell<Option<gtk::gdk::Display>> = const { RefCell::new(None) };
}

/// Bridge a user action on an XWayland capture control to the main Wayland
/// toplevel. GTK's Wayland seat cannot supply the X11 control's input serial;
/// the compositor can resolve its startup notification using the X11 timestamp.
/// Call on the GTK thread while the focused capture window is still mapped.
pub(super) fn activation_id() -> Option<String> {
    let active_windows: Vec<_> = gtk::Window::list_toplevels()
        .into_iter()
        .filter_map(|widget| widget.downcast::<gtk::Window>().ok())
        .filter(|window| window.is_active())
        .collect();
    let source = FLOATING_DISPLAY
        .with(|slot| {
            let display = slot.borrow();
            active_windows
                .iter()
                .find(|window| display.as_ref().is_some_and(|d| window.display() == *d))
                .cloned()
        })
        .or_else(|| active_windows.into_iter().next())?;
    let display = source.display();
    let executable = std::env::current_exe().ok()?;
    let command = gtk::glib::shell_quote(executable);
    let info = gtk::gio::AppInfo::create_from_commandline(
        &command,
        Some("Taomni"),
        gtk::gio::AppInfoCreateFlags::SUPPORTS_STARTUP_NOTIFICATION,
    )
    .ok()?;
    let context = display.app_launch_context()?;
    if display.type_().name() == "GdkX11Display" {
        let surface = source.window()?;
        // WebKit's input connection need not update this GDK connection's
        // user_time (observed as zero). Read the X server's time for this
        // operation on the currently focused, owned control instead.
        let events = surface.events();
        surface.set_events(events | gtk::gdk::EventMask::PROPERTY_CHANGE_MASK);
        // SAFETY: the live surface belongs to GdkX11Display, and PropertyNotify
        // is selected as required by gdk_x11_get_server_time's blocking query.
        let timestamp = unsafe { gdk_x11_get_server_time(surface.to_glib_none().0) };
        surface.set_events(events);
        if timestamp == 0 {
            return None;
        }
        context.set_timestamp(timestamp);
    }
    let id = context.startup_notify_id(&info, &[])?;
    // Startup notification and xdg activation travel on different display
    // connections. Publish the X11 sequence before activating Wayland.
    display.sync();
    log::info!(
        "capture activation: source={}, timestamp={:?}",
        display.type_().name(),
        id.rsplit_once("_TIME").map(|(_, time)| time)
    );
    Some(id.to_string())
}

/// Present a capture window with an X11 server timestamp so the session's
/// focus policy accepts the activation.
///
/// tao forwards `set_focus` as `present_with_time(GDK_CURRENT_TIME)`, which
/// GNOME's focus-stealing prevention can refuse for a window opened from a
/// global shortcut; the overlay then stays without keyboard focus until the
/// user clicks it. Reading the time off the window's own X11 surface gives
/// mutter a timestamp it accepts. Wayland windows only need the plain present
/// tao already performs, so this is a no-op there.
pub(super) fn present_for_input(window: &tauri::WebviewWindow) -> Result<(), String> {
    let target = window.clone();
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    window
        .run_on_main_thread(move || {
            let result = target.gtk_window().map_err(|e| e.to_string()).map(|gtk| {
                if gtk.display().type_().name() != "GdkX11Display" {
                    return;
                }
                let Some(surface) = gtk.window() else {
                    return;
                };
                let events = surface.events();
                surface.set_events(events | gtk::gdk::EventMask::PROPERTY_CHANGE_MASK);
                // SAFETY: the live surface belongs to GdkX11Display and
                // PropertyNotify is selected, as gdk_x11_get_server_time needs
                // for its blocking round trip.
                let timestamp = unsafe { gdk_x11_get_server_time(surface.to_glib_none().0) };
                surface.set_events(events);
                if timestamp == 0 {
                    return;
                }
                let window: &gtk::Window = gtk.upcast_ref();
                // SAFETY: `window` is a live GtkWindow owned by this thread.
                unsafe {
                    gtk::ffi::gtk_window_present_with_time(window.to_glib_none().0, timestamp);
                }
            });
            let _ = tx.send(result);
        })
        .map_err(|e| e.to_string())?;
    rx.recv_timeout(std::time::Duration::from_secs(5))
        .map_err(|e| format!("activate capture surface: {e}"))?
}

/// Ask the compositor not to unredirect this capture surface.
///
/// Ubuntu's X11 fractional scaling temporarily disables a monitor's scale while
/// a fullscreen window is unredirected; that re-applies the whole display
/// configuration, so the screen flashes and the desktop layout jumps whenever
/// the screenshot overlay opens or closes. `_NET_WM_BYPASS_COMPOSITOR = 2`
/// ("do not bypass") keeps the window composited and this path unreachable.
/// Wayland has no such split, so this is a no-op there.
pub(super) fn keep_composited(window: &tauri::WebviewWindow) -> Result<(), String> {
    let target = window.clone();
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    window
        .run_on_main_thread(move || {
            let result = target
                .gtk_window()
                .map_err(|e| e.to_string())
                .and_then(|gtk| {
                    if gtk.display().type_().name() != "GdkX11Display" {
                        return Ok(());
                    }
                    // The property must exist before the window is mapped.
                    gtk.realize();
                    let surface = gtk.window().ok_or("capture surface has no GdkWindow")?;
                    // SAFETY: `surface` is a live GdkX11 window on this thread.
                    let xid = unsafe { gdk_x11_window_get_xid(surface.to_glib_none().0) } as u32;
                    set_bypass_compositor_off(xid)
                });
            let _ = tx.send(result);
        })
        .map_err(|e| e.to_string())?;
    rx.recv_timeout(std::time::Duration::from_secs(5))
        .map_err(|e| format!("mark capture surface composited: {e}"))?
}

/// Claim the X11 input focus for a capture surface.
///
/// Window managers with a "smart" focus policy (mutter/muffin) can refuse the
/// `_NET_ACTIVE_WINDOW` activation for a window whose application just hid its
/// own main window: the overlay is mapped and raised but never focused, so
/// Escape and every other shortcut stays dead until the user clicks it. The
/// capture surface is a user-triggered fullscreen modal, so taking the input
/// focus directly is the intended behaviour; the polite present is tried first.
pub(super) fn force_input_focus(window: &tauri::WebviewWindow) -> Result<(), String> {
    let target = window.clone();
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    window
        .run_on_main_thread(move || {
            let xid = target.gtk_window().ok().and_then(|gtk| {
                if gtk.display().type_().name() != "GdkX11Display" {
                    return None;
                }
                gtk.realize();
                let surface = gtk.window()?;
                // SAFETY: live GdkX11 surface owned by this thread.
                Some(unsafe { gdk_x11_window_get_xid(surface.to_glib_none().0) })
            });
            let _ = tx.send(xid);
        })
        .map_err(|e| e.to_string())?;
    let xid = rx
        .recv_timeout(std::time::Duration::from_secs(5))
        .map_err(|e| format!("resolve capture surface: {e}"))?
        .ok_or("capture surface has no X11 window")?;

    use x11rb::connection::Connection;
    use x11rb::protocol::xproto::{ConnectionExt as _, InputFocus};
    let (connection, _) = x11rb::connect(None).map_err(|e| e.to_string())?;
    connection
        .set_input_focus(InputFocus::PARENT, xid, x11rb::CURRENT_TIME)
        .map_err(|e| e.to_string())?
        .check()
        .map_err(|e| e.to_string())?;
    connection.flush().map_err(|e| e.to_string())?;
    log::info!("capture surface {xid:#x}: input focus claimed directly");
    Ok(())
}

/// Write `_NET_WM_BYPASS_COMPOSITOR = 2` (META_BYPASS_COMPOSITOR_HINT_OFF).
fn set_bypass_compositor_off(xid: u32) -> Result<(), String> {
    use x11rb::connection::Connection;
    use x11rb::protocol::xproto::{AtomEnum, ConnectionExt as _, PropMode};
    // `change_property32` lives on the ergonomic wrapper trait, not xproto.
    use x11rb::wrapper::ConnectionExt as _;

    let (connection, _) = x11rb::connect(None).map_err(|e| e.to_string())?;
    // `only_if_exists = false`: on a desktop whose compositor never interned
    // the atom (CI Xvfb/openbox) an existing-only lookup returns 0 and the
    // property write fails.
    let atom = connection
        .intern_atom(false, b"_NET_WM_BYPASS_COMPOSITOR")
        .map_err(|e| e.to_string())?
        .reply()
        .map_err(|e| e.to_string())?
        .atom;
    connection
        .change_property32(PropMode::REPLACE, xid, atom, AtomEnum::CARDINAL, &[2u32])
        .map_err(|e| e.to_string())?
        .check()
        .map_err(|e| e.to_string())?;
    connection.flush().map_err(|e| e.to_string())?;
    log::info!("capture surface {xid:#x}: _NET_WM_BYPASS_COMPOSITOR=2");
    Ok(())
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
