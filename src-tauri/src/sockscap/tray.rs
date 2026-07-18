//! Tray / reliability helpers for Sockscap (Phase 8 scaffold).
//!
//! Design plan §9 / §13 Phase 8:
//! - Tray icon colors: grey Disabled, blue/green Active, yellow Degraded, red RecoveryRequired
//! - Windows/macOS left-click toggle; Linux menu fallback (Tauri 2 has no click event)
//! - Exit must wait for helper confirmation of network restore
//!
//! This module maps engine state → tray presentation metadata. Actual Tauri
//! tray menu wiring will attach when the main app tray is unified.

use crate::sockscap::types::EngineState;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TrayColor {
    Grey,
    BlueGreen,
    Yellow,
    Red,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrayPresentation {
    pub color: TrayColor,
    pub tooltip: String,
    pub show_recover_action: bool,
    pub show_start_action: bool,
    pub show_stop_action: bool,
}

pub fn tray_presentation(state: EngineState, message: &str) -> TrayPresentation {
    match state {
        EngineState::Disabled => TrayPresentation {
            color: TrayColor::Grey,
            tooltip: format!("Sockscap: disabled — {message}"),
            show_recover_action: false,
            show_start_action: true,
            show_stop_action: false,
        },
        EngineState::Preparing | EngineState::Stopping => TrayPresentation {
            color: TrayColor::Yellow,
            tooltip: format!("Sockscap: {:?} — {message}", state),
            show_recover_action: false,
            show_start_action: false,
            show_stop_action: true,
        },
        EngineState::Active => TrayPresentation {
            color: TrayColor::BlueGreen,
            tooltip: format!("Sockscap: active — {message}"),
            show_recover_action: false,
            show_start_action: false,
            show_stop_action: true,
        },
        EngineState::Degraded | EngineState::UserActionRequired => TrayPresentation {
            color: TrayColor::Yellow,
            tooltip: format!("Sockscap: {:?} — {message}", state),
            show_recover_action: true,
            show_start_action: false,
            show_stop_action: true,
        },
        EngineState::RecoveryRequired => TrayPresentation {
            color: TrayColor::Red,
            tooltip: format!("Sockscap: recovery required — {message}"),
            show_recover_action: true,
            show_start_action: false,
            show_stop_action: false,
        },
    }
}

/// Menu labels for platforms without left-click toggle (Linux).
pub fn tray_menu_labels() -> &'static [&'static str] {
    &[
        "Sockscap status",
        "Open Sockscap",
        "Start",
        "Stop",
        "Recover network",
        "Hide Sockscap",
        "Exit Taomni",
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn active_is_blue_green() {
        let p = tray_presentation(EngineState::Active, "ok");
        assert_eq!(p.color, TrayColor::BlueGreen);
        assert!(p.show_stop_action);
    }

    #[test]
    fn recovery_is_red_with_recover_action() {
        let p = tray_presentation(EngineState::RecoveryRequired, "leftover rules");
        assert_eq!(p.color, TrayColor::Red);
        assert!(p.show_recover_action);
        assert!(!p.show_start_action);
    }

    #[test]
    fn linux_menu_has_open_and_hide() {
        let labels = tray_menu_labels();
        assert!(labels.iter().any(|l| l.contains("Open")));
        assert!(labels.iter().any(|l| l.contains("Hide")));
        assert!(labels.iter().any(|l| l.contains("Recover")));
    }
}
