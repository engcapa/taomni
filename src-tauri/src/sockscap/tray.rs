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
