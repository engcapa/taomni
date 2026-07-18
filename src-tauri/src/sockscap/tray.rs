//! Tray view model (plan §9 tray behavior, §8 platform matrix).
//!
//! The pure mapping from engine state → tray icon color, tooltip and menu
//! items. The Tauri `TrayIcon` glue (icon assets, menu event dispatch, window
//! show/hide) is platform-integration that needs a running desktop app to
//! validate and is wired in Phase 8; keeping the decision logic here makes it
//! testable now and gives the glue a single source of truth.
//!
//! Note: Tauri 2's tray left-click event is not delivered on Linux, so the menu
//! always carries explicit Show/Hide entries (plan §8) — `menu()` includes them
//! regardless of platform, and `left_click_toggles` reports whether a bare
//! left-click should also toggle.

use super::engine::EngineState;

/// Tray icon color per state (plan §9).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrayColor {
    Gray,
    Blue,
    Green,
    Yellow,
    Red,
}

/// A tray menu entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrayMenuItem {
    pub id: &'static str,
    pub label: String,
    pub enabled: bool,
}

/// The full tray presentation for a given engine state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrayView {
    pub color: TrayColor,
    pub tooltip: String,
    pub items: Vec<TrayMenuItem>,
}

/// Menu item ids (stable — the Tauri menu-event handler dispatches on these).
pub const MENU_OPEN: &str = "sockscap.open";
pub const MENU_START: &str = "sockscap.start";
pub const MENU_STOP: &str = "sockscap.stop";
pub const MENU_RECOVER: &str = "sockscap.recover";
pub const MENU_TOGGLE: &str = "sockscap.toggle_window";
pub const MENU_QUIT: &str = "sockscap.quit";

fn color_for(state: &EngineState) -> TrayColor {
    match state {
        EngineState::Disabled => TrayColor::Gray,
        EngineState::Preparing | EngineState::Stopping => TrayColor::Blue,
        EngineState::Active => TrayColor::Green,
        EngineState::Degraded(_) => TrayColor::Yellow,
        EngineState::RecoveryRequired(_) => TrayColor::Red,
    }
}

fn tooltip_for(state: &EngineState) -> String {
    match state {
        EngineState::Disabled => "Sockscap: disabled".into(),
        EngineState::Preparing => "Sockscap: preparing…".into(),
        EngineState::Active => "Sockscap: active".into(),
        EngineState::Degraded(r) => format!("Sockscap: degraded — {r}"),
        EngineState::Stopping => "Sockscap: stopping…".into(),
        EngineState::RecoveryRequired(r) => format!("Sockscap: recovery required — {r}"),
    }
}

/// Build the tray view for `state`. Start is enabled only when not active;
/// Stop only when active; Restore-network is always available (fail-open,
/// plan §9). Show/Hide and Quit are always present.
pub fn tray_view(state: &EngineState) -> TrayView {
    let active = state.is_active();
    let items = vec![
        TrayMenuItem {
            id: MENU_OPEN,
            label: "Open Sockscap".into(),
            enabled: true,
        },
        TrayMenuItem {
            id: MENU_START,
            label: "Start".into(),
            enabled: !active,
        },
        TrayMenuItem {
            id: MENU_STOP,
            label: "Stop".into(),
            enabled: active,
        },
        TrayMenuItem {
            id: MENU_RECOVER,
            label: "Restore network".into(),
            enabled: true,
        },
        TrayMenuItem {
            id: MENU_TOGGLE,
            label: "Show / Hide".into(),
            enabled: true,
        },
        TrayMenuItem {
            id: MENU_QUIT,
            label: "Quit Taomni".into(),
            enabled: true,
        },
    ];
    TrayView {
        color: color_for(state),
        tooltip: tooltip_for(state),
        items,
    }
}

/// Whether a bare tray left-click should toggle the window on this platform
/// (plan §8: unsupported on Linux → menu fallback only).
pub fn left_click_toggles() -> bool {
    !cfg!(target_os = "linux")
}

/* --------------------------- Tauri tray integration ------------------------ */

use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};

use crate::sockscap::runtime::SockscapState;

/// Create the Sockscap system-tray icon and menu (plan §8, §9). The menu always
/// carries Show/Hide and Quit (Linux has no reliable left-click), and the
/// engine controls dispatch to the shared start/stop/recover helpers. Icon
/// color/tooltip updates per state are a follow-up (needs stored item handles);
/// clicking Start when already active is a safe no-op.
pub fn install<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let items = [
        (MENU_OPEN, "Open Sockscap"),
        (MENU_START, "Start"),
        (MENU_STOP, "Stop"),
        (MENU_RECOVER, "Restore network"),
        (MENU_TOGGLE, "Show / Hide"),
        (MENU_QUIT, "Quit Taomni"),
    ];
    let built: Vec<MenuItem<R>> = items
        .iter()
        .map(|(id, label)| MenuItem::with_id(app, *id, *label, true, None::<&str>))
        .collect::<tauri::Result<_>>()?;
    let refs: Vec<&dyn tauri::menu::IsMenuItem<R>> =
        built.iter().map(|i| i as &dyn tauri::menu::IsMenuItem<R>).collect();
    let menu = Menu::with_items(app, &refs)?;

    let mut builder = TrayIconBuilder::with_id("sockscap-tray")
        .tooltip("Sockscap")
        .menu(&menu)
        // Show the menu on any click (Windows/macOS); Linux uses the menu only.
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| handle_menu_event(app, event.id.0.as_str()));
    match app.default_window_icon().cloned() {
        Some(icon) => builder = builder.icon(icon),
        None => log::warn!("sockscap: no default window icon; tray icon may be invisible"),
    }
    let tray = builder.build(app)?;
    // The TrayIcon must be kept alive — a dropped handle removes the OS icon.
    app.manage(tray);
    Ok(())
}

fn handle_menu_event<R: Runtime>(app: &AppHandle<R>, id: &str) {
    match id {
        MENU_OPEN => open_window(app),
        MENU_TOGGLE => toggle_window(app),
        MENU_START => spawn_engine(app, EngineAction::Start),
        MENU_STOP => spawn_engine(app, EngineAction::Stop),
        MENU_RECOVER => spawn_engine(app, EngineAction::Recover),
        MENU_QUIT => quit(app),
        _ => {}
    }
}

enum EngineAction {
    Start,
    Stop,
    Recover,
}

fn spawn_engine<R: Runtime>(app: &AppHandle<R>, action: EngineAction) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Some(state) = app.try_state::<SockscapState>() {
            let result = match action {
                EngineAction::Start => state.start_engine().await,
                EngineAction::Stop => state.stop_engine().await,
                EngineAction::Recover => state.recover_engine().await,
            };
            if let Err(e) = result {
                log::warn!("sockscap tray engine action failed: {e}");
            }
        }
    });
}

/// Create (or show + focus) the standalone Sockscap window. Shared by the tray
/// menu and the `sockscap_open_window` command so the menu path matches the
/// codebase precedent of opening detached windows from Rust (the webview lacks
/// the ACL permission to create windows itself).
///
/// Uses `WebviewUrl::App(PathBuf)` with a `#sockscap` fragment (same SFTP
/// pattern) so Tauri resolves the correct base URL in dev and production
/// without percent-encoding the fragment. Close only hides the window so the
/// engine keeps running (plan §9, §16.6-21).
pub fn open_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(win) = app.get_webview_window("sockscap") {
        let _ = win.show();
        let _ = win.set_focus();
        return;
    }
    // Match filebrowser/SFTP: PathBuf + hash fragment (not query string).
    // Close-to-hide is enforced in the Sockscap webview (onCloseRequested →
    // hide) so the engine keeps running when the user clicks X (plan §9).
    let url = WebviewUrl::App(std::path::PathBuf::from("index.html#sockscap"));
    let builder = WebviewWindowBuilder::new(app, "sockscap", url)
        .title("Sockscap")
        .inner_size(1100.0, 760.0)
        .min_inner_size(720.0, 480.0)
        .resizable(true)
        .enable_clipboard_access();
    #[cfg(windows)]
    let builder = builder.disable_drag_drop_handler();
    if let Err(e) = builder.build() {
        log::error!("sockscap: failed to open window: {e}");
    }
}

fn toggle_window<R: Runtime>(app: &AppHandle<R>) {
    match app.get_webview_window("sockscap") {
        Some(win) => {
            if win.is_visible().unwrap_or(false) {
                let _ = win.hide();
            } else {
                let _ = win.show();
                let _ = win.set_focus();
            }
        }
        None => open_window(app),
    }
}

/// Quit Taomni: stop the engine (restore direct networking) before exiting so
/// the user never loses network on exit (plan §9, §16.6-21).
fn quit<R: Runtime>(app: &AppHandle<R>) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Some(state) = app.try_state::<SockscapState>() {
            let _ = state.stop_engine().await;
        }
        app.exit(0);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item<'a>(v: &'a TrayView, id: &str) -> &'a TrayMenuItem {
        v.items.iter().find(|i| i.id == id).unwrap()
    }

    #[test]
    fn disabled_shows_start_not_stop_gray_icon() {
        let v = tray_view(&EngineState::Disabled);
        assert_eq!(v.color, TrayColor::Gray);
        assert!(item(&v, MENU_START).enabled);
        assert!(!item(&v, MENU_STOP).enabled);
    }

    #[test]
    fn active_shows_stop_green_icon() {
        let v = tray_view(&EngineState::Active);
        assert_eq!(v.color, TrayColor::Green);
        assert!(!item(&v, MENU_START).enabled);
        assert!(item(&v, MENU_STOP).enabled);
    }

    #[test]
    fn degraded_yellow_still_active() {
        let v = tray_view(&EngineState::Degraded("ssh dropped".into()));
        assert_eq!(v.color, TrayColor::Yellow);
        assert!(item(&v, MENU_STOP).enabled);
        assert!(v.tooltip.contains("ssh dropped"));
    }

    #[test]
    fn recovery_required_red_and_restore_always_enabled() {
        let v = tray_view(&EngineState::RecoveryRequired("crash".into()));
        assert_eq!(v.color, TrayColor::Red);
        assert!(item(&v, MENU_RECOVER).enabled);
    }

    #[test]
    fn restore_and_quit_always_present() {
        for s in [EngineState::Disabled, EngineState::Active] {
            let v = tray_view(&s);
            assert!(item(&v, MENU_RECOVER).enabled);
            assert!(item(&v, MENU_QUIT).enabled);
            assert!(item(&v, MENU_OPEN).enabled);
        }
    }
}
