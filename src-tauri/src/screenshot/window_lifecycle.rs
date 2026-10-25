use super::OVERLAY_LABEL;
use super::PIN_LABEL_PREFIX;
use super::RECORDER_LABEL;
use super::pins;
use super::qa;
#[cfg(all(debug_assertions, target_os = "macos"))]
use super::runtime::QA_WINDOW_HIDE_CALLS;
use super::runtime::tool_state;
#[cfg(target_os = "linux")]
use super::surface_backend;
use super::surfaces;
use crate::screenshot::capture::DisplayInfo;
use std::sync::atomic::Ordering;
use std::time::Duration;
use tauri::AppHandle;
use tauri::Manager;
use tauri::PhysicalPosition;
use tauri::PhysicalSize;
use tauri::WebviewUrl;
use tauri::WebviewWindow;
use tauri::WebviewWindowBuilder;
/// Time for the compositor to remove hidden windows from the screen before
/// the desktop is captured (Windows DWM and macOS fade animations).
pub(super) const HIDE_SETTLE: Duration = Duration::from_millis(250);

/// Focus retry budget for capture surfaces. `show()` is asynchronous on Linux
/// and Windows, and tao forwards a focus request only once its cached
/// visibility flag is set, so a single `set_focus()` right after `show()` is a
/// no-op there.
pub(super) const FOCUS_ATTEMPTS: usize = 20;
pub(super) const FOCUS_RETRY: Duration = Duration::from_millis(50);
/// Attempts to keep re-asserting focus even after the window reports active.
/// GTK refuses `grab_focus` on a widget that is not mapped yet, and the first
/// attempts land while `show()` is still mapping the surface.
pub(super) const FOCUS_SETTLE_ATTEMPTS: usize = 4;

/// Bring a capture surface to the foreground and hand keyboard focus to its
/// webview, waiting until the platform window is actually mapped.
///
/// Without this the overlay opens without keyboard focus: every shortcut is
/// dead (Escape cannot close it, Ctrl+C/Ctrl+S do nothing, annotation text
/// cannot be typed) until the user clicks the surface once, which is what
/// gives it focus by accident.
pub(crate) async fn focus_capture_window(window: &WebviewWindow) {
    #[cfg(target_os = "linux")]
    let mut presented = false;
    #[cfg(target_os = "linux")]
    let mut claimed = false;
    for attempt in 0..FOCUS_ATTEMPTS {
        if window.is_visible().unwrap_or(false) {
            // X11 focus-stealing prevention can refuse the timestamp-less
            // activation tao sends for a window opened by a global shortcut;
            // re-present once with a server timestamp as soon as it is mapped.
            #[cfg(target_os = "linux")]
            if !presented {
                presented = true;
                if let Err(error) = surface_backend::present_for_input(window) {
                    log::debug!("capture activation skipped: {error}");
                }
            }
            let _ = window.set_focus();
            // Webview-level focus so WebKit/WebView2 route key events to the
            // DOM (Ctrl+C, typing) and not only to the native window. Re-assert
            // on every attempt: the first ones can land before the surface is
            // mapped, where GTK drops the focus request.
            let webview: &tauri::Webview<_> = window.as_ref();
            let _ = webview.set_focus();
            // Focus policies that refuse the polite activation (mutter/muffin
            // "smart" mode after the app hid its own window) still leave the
            // overlay unfocused; claim the input focus once the present had a
            // chance to land. Claim once only: repeatedly stealing focus back
            // would fight the user or another window.
            #[cfg(target_os = "linux")]
            if !claimed
                && attempt + 1 >= FOCUS_SETTLE_ATTEMPTS
                && !window.is_focused().unwrap_or(false)
            {
                claimed = true;
                if let Err(error) = surface_backend::force_input_focus(window) {
                    log::debug!("capture input focus fallback skipped: {error}");
                }
            }
            if attempt + 1 >= FOCUS_SETTLE_ATTEMPTS && window.is_focused().unwrap_or(false) {
                return;
            }
        }
        if attempt + 1 < FOCUS_ATTEMPTS {
            tokio::time::sleep(FOCUS_RETRY).await;
        }
    }
}

pub(crate) fn window_builder<'a>(
    app: &'a AppHandle,
    label: &str,
    url: WebviewUrl,
) -> WebviewWindowBuilder<'a, tauri::Wry, AppHandle> {
    crate::webview_environment::configure(app, WebviewWindowBuilder::new(app, label, url))
}

// ---------------------------------------------------------------------------
// Overlay window
// ---------------------------------------------------------------------------

/// Hide every visible app window except the screenshot tool's own and remember
/// them (merged with windows already hidden for this session).
pub(super) fn hide_app_windows(app: &AppHandle) -> bool {
    let mut hid_any = false;
    let mut state = tool_state();
    for (label, window) in app.webview_windows() {
        if label == OVERLAY_LABEL
            || label == RECORDER_LABEL
            || label == surfaces::SCROLL_LABEL
            || label.starts_with(surfaces::BORDER_PREFIX)
            || label.starts_with(PIN_LABEL_PREFIX)
            || label == qa::QA_WINDOW_LABEL
        {
            continue;
        }
        if !window.is_visible().unwrap_or(false) {
            continue;
        }
        #[cfg(target_os = "linux")]
        if window.is_minimized().unwrap_or(false) {
            continue;
        }
        #[cfg(all(debug_assertions, target_os = "macos"))]
        QA_WINDOW_HIDE_CALLS.fetch_add(1, Ordering::SeqCst);
        // GTK hide/show unmaps the toplevel: X11 resets its position and
        // Wayland may place the new mapping on a different output. Iconifying
        // removes it from capture while retaining the compositor's placement.
        #[cfg(target_os = "linux")]
        let hidden = window.minimize();
        #[cfg(not(target_os = "linux"))]
        let hidden = window.hide();
        if hidden.is_ok() {
            hid_any = true;
            if !state.hidden.contains(&label) {
                state.hidden.push(label);
            }
        }
    }
    hid_any
}

/// Wait for UI-thread hiding/minimization and compositor fade-out to complete.
/// A queued request returning Ok is not proof of native visibility on GTK.
pub(super) async fn await_hidden_windows(app: &AppHandle) -> Result<(), String> {
    let labels = tool_state().hidden.clone();
    let until = std::time::Instant::now() + Duration::from_secs(3);
    loop {
        let mut visible = false;
        for label in &labels {
            if let Some(window) = app.get_webview_window(label) {
                let mapped = window.is_visible().map_err(|e| e.to_string())?;
                #[cfg(target_os = "linux")]
                if pins::native_wayland() {
                    // xdg-toplevel has no minimized state acknowledgement.
                    // GTK/Tao's ICONIFIED cache therefore cannot establish
                    // visibility here. Drain GTK below and allow compositor
                    // suspension/fade; native QA observes Mutter and pixels.
                    continue;
                }
                #[cfg(target_os = "linux")]
                let mapped = mapped && !window.is_minimized().map_err(|e| e.to_string())?;
                visible |= mapped;
            }
        }
        if !visible {
            break;
        }
        if std::time::Instant::now() >= until {
            return Err("Screenshot cancelled: an application window did not hide".into());
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    #[cfg(target_os = "linux")]
    {
        let (tx, rx) = tokio::sync::oneshot::channel();
        app.run_on_main_thread(move || {
            use gtk::prelude::*;
            if let Some(display) = gtk::gdk::Display::default() {
                display.sync();
            }
            let _ = tx.send(());
        })
        .map_err(|e| e.to_string())?;
        tokio::time::timeout(Duration::from_secs(3), rx)
            .await
            .map_err(|_| "GTK hide barrier timed out")?
            .map_err(|e| e.to_string())?;
        // GNOME/KWin fade animations can exceed the old fixed 250ms delay.
        tokio::time::sleep(Duration::from_millis(650)).await;
    }
    #[cfg(not(target_os = "linux"))]
    tokio::time::sleep(HIDE_SETTLE).await;
    Ok(())
}

pub(super) fn restore_app_windows(app: &AppHandle) {
    let hidden = std::mem::take(&mut tool_state().hidden);
    restore_hidden_windows(app, hidden);
}

pub(super) fn restore_app_windows_for_preview(app: &AppHandle) {
    #[cfg(target_os = "linux")]
    if pins::native_wayland() {
        // Wayland does not acknowledge whether activation deiconified the
        // window. Keep ownership through preview so its final user action
        // can still restore the original windows before closing the source.
        let hidden = tool_state().hidden.clone();
        restore_hidden_windows(app, hidden);
        return;
    }
    restore_app_windows(app);
}

pub(super) fn restore_hidden_windows(app: &AppHandle, hidden: Vec<String>) {
    #[cfg(target_os = "linux")]
    if pins::native_wayland() {
        log::info!(
            "capture restoration: hidden={hidden:?}, GTK_thread={}",
            gtk::is_initialized_main_thread()
        );
    }
    for label in hidden {
        if let Some(window) = app.get_webview_window(&label) {
            #[cfg(target_os = "linux")]
            if pins::native_wayland() {
                let target = window.clone();
                let restore = move || {
                    use gtk::prelude::*;
                    if let Ok(gtk) = target.gtk_window() {
                        let id = surface_backend::activation_id();
                        log::info!(
                            "capture restoration: target={}, backend={}, mapped={}, startup_id={}",
                            target.label(),
                            gtk.display().type_().name(),
                            gtk.is_mapped(),
                            id.is_some()
                        );
                        // Restore the retained GTK surface while the source
                        // of the activation context still exists.
                        gtk.deiconify();
                        gtk.show();
                        if let Some((id, surface)) = id.zip(gtk.window()) {
                            // The X11 startup sequence was published on another
                            // connection. Let the compositor dispatch it before
                            // sending Wayland's activation request.
                            gtk.display().sync();
                            // Activate the existing surface directly. GTK's
                            // startup property only forwards while mapped and
                            // present() also creates a second activation token.
                            surface.set_startup_id(&id);
                        } else {
                            gtk.present();
                        }
                        // Keep the source alive until the compositor has
                        // processed activation of the target surface.
                        gtk.display().sync();
                    }
                };
                if gtk::is_initialized_main_thread() {
                    restore();
                } else {
                    let _ = window.run_on_main_thread(restore);
                }
                continue;
            }
            #[cfg(target_os = "linux")]
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
}

/// Place a borderless window exactly over `display` (physical pixels).
pub(super) async fn cover_display(
    window: &WebviewWindow,
    display: &DisplayInfo,
) -> Result<(), String> {
    let _ = window.set_position(PhysicalPosition::new(display.x, display.y));
    #[cfg(target_os = "linux")]
    if pins::native_wayland() {
        // The hidden window still has the previous output's scale. A physical
        // size request converted with that cache doubles GTK/WebKit's logical
        // allocation when switching from 100% to 200% before output-enter.
        let scale = display.scale_factor.max(1.0);
        window
            .set_size(tauri::LogicalSize::new(
                display.width as f64 / scale,
                display.height as f64 / scale,
            ))
            .map_err(|e| e.to_string())?;
    } else {
        window
            .set_size(PhysicalSize::new(display.width, display.height))
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "linux"))]
    window
        .set_size(PhysicalSize::new(display.width, display.height))
        .map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    {
        // Simple fullscreen hides the menu bar and Dock without the Space
        // switch animation of native fullscreen.
        let _ = window.set_simple_fullscreen(true);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window.set_fullscreen(true);
    }
    #[cfg(target_os = "linux")]
    {
        let target = window.clone();
        let rect = display.logical_rect();
        let (tx, rx) = tokio::sync::oneshot::channel();
        window
            .run_on_main_thread(move || {
                use gtk::prelude::*;
                let result = (|| -> Result<(), String> {
                    let window = target.gtk_window().map_err(|e| e.to_string())?;
                    let display = window.display();
                    let index = (0..display.n_monitors())
                        .find(|&index| {
                            display.monitor(index).is_some_and(|monitor| {
                                let g = monitor.geometry();
                                (g.x(), g.y(), g.width(), g.height()) == rect
                            })
                        })
                        .ok_or("selected monitor is no longer available to GTK")?;
                    // Wayland ignores global set_position. Fullscreen must name
                    // the actual GDK output, using its logical geometry.
                    window.fullscreen_on_monitor(&display.default_screen(), index);
                    Ok(())
                })();
                let _ = tx.send(result);
            })
            .map_err(|e| e.to_string())?;
        tokio::time::timeout(Duration::from_secs(5), rx)
            .await
            .map_err(|_| "GTK monitor placement timed out")?
            .map_err(|e| e.to_string())??;
    }
    // Ubuntu's X11 fractional scaling turns a monitor's scale off while a
    // fullscreen window is unredirected, which re-applies the whole display
    // configuration (visible as a display-settings change and layout jump).
    // Ask the compositor to keep composing this surface; the property is read
    // when the window is managed, so it must be set before it is shown.
    #[cfg(target_os = "linux")]
    if let Err(error) = surface_backend::keep_composited(window) {
        // Visible in release logs: without this property Ubuntu's X11
        // fractional scaling re-applies the whole display configuration
        // whenever the overlay opens or closes.
        log::warn!("capture surface compositor hint skipped: {error}");
    }
    Ok(())
}
