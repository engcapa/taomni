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


/// Install / refresh the main app tray menu with Sockscap actions.
///
/// Safe to call from `.setup()`. On Linux, left-click does not toggle; the
/// menu is the primary entry (design plan §8 / §9).
pub fn install_main_tray(app: &tauri::AppHandle) -> Result<(), String> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
    use tauri::tray::TrayIconBuilder;
    #[cfg(not(target_os = "linux"))]
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconEvent};
    use tauri::Manager;

    let status = {
        if let Some(state) = app.try_state::<crate::state::AppState>() {
            state.sockscap.status()
        } else {
            crate::sockscap::types::EngineStatus::default()
        }
    };
    let pres = tray_presentation(status.state, &status.message);

    let open_i = MenuItem::with_id(app, "sockscap_open", "Open Sockscap", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let start_i = MenuItem::with_id(
        app,
        "sockscap_start",
        "Start Sockscap",
        pres.show_start_action,
        None::<&str>,
    )
    .map_err(|e| e.to_string())?;
    let stop_i = MenuItem::with_id(
        app,
        "sockscap_stop",
        "Stop Sockscap",
        pres.show_stop_action,
        None::<&str>,
    )
    .map_err(|e| e.to_string())?;
    let recover_i = MenuItem::with_id(
        app,
        "sockscap_recover",
        "Recover network",
        true,
        None::<&str>,
    )
    .map_err(|e| e.to_string())?;
    let sep = PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?;
    let quit_i = MenuItem::with_id(app, "quit", "Exit Taomni", true, None::<&str>)
        .map_err(|e| e.to_string())?;

    let menu = Menu::with_items(
        app,
        &[&open_i, &start_i, &stop_i, &recover_i, &sep, &quit_i],
    )
    .map_err(|e| e.to_string())?;

    // Prefer the config-created tray if present; otherwise build one.
    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_menu(Some(menu));
        let _ = tray.set_tooltip(Some(pres.tooltip));
        tray.on_menu_event(|app, event| {
            handle_tray_menu(app, event.id.as_ref());
        });
        #[cfg(not(target_os = "linux"))]
        {
            tray.on_tray_icon_event(|tray, event| {
                if let TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } = event
                {
                    let app = tray.app_handle();
                    let _ = tauri::async_runtime::spawn(async move {
                        let _ = crate::windowing::open_detached_window(
                            app.clone(),
                            "sockscap".into(),
                            "main".into(),
                            Some("Sockscap".into()),
                            None,
                            None,
                            Some(1100.0),
                            Some(760.0),
                        )
                        .await;
                    });
                }
            });
        }
        return Ok(());
    }

    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| "no default window icon for tray".to_string())?;

    #[allow(unused_mut)]
    let mut builder = TrayIconBuilder::with_id("main")
        .icon(icon)
        .menu(&menu)
        .tooltip(&pres.tooltip)
        .on_menu_event(|app, event| {
            handle_tray_menu(app, event.id.as_ref());
        });

    #[cfg(not(target_os = "linux"))]
    {
        builder = builder.on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                let _ = tauri::async_runtime::spawn(async move {
                    let _ = crate::windowing::open_detached_window(
                        app.clone(),
                        "sockscap".into(),
                        "main".into(),
                        Some("Sockscap".into()),
                        None,
                        None,
                        Some(1100.0),
                        Some(760.0),
                    )
                    .await;
                });
            }
        });
    }

    builder.build(app).map_err(|e| e.to_string())?;
    Ok(())
}

fn handle_tray_menu(app: &tauri::AppHandle, id: &str) {
    use tauri::Manager;
    match id {
        "sockscap_open" => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let _ = crate::windowing::open_detached_window(
                    app,
                    "sockscap".into(),
                    "main".into(),
                    Some("Sockscap".into()),
                    None,
                    None,
                    Some(1100.0),
                    Some(760.0),
                )
                .await;
            });
        }
        "sockscap_start" => {
            if let Some(state) = app.try_state::<crate::state::AppState>() {
                let profiles = state
                    .sockscap_db
                    .lock()
                    .ok()
                    .and_then(|db| crate::sockscap::db::list_profiles(&db).ok())
                    .unwrap_or_default();
                let _ = state.sockscap.start(&profiles);
            }
        }
        "sockscap_stop" => {
            if let Some(state) = app.try_state::<crate::state::AppState>() {
                let _ = state.sockscap.stop();
            }
        }
        "sockscap_recover" => {
            if let Some(state) = app.try_state::<crate::state::AppState>() {
                let _ = state.sockscap.recover();
            }
        }
        "quit" => {
            // Best-effort stop before exit.
            if let Some(state) = app.try_state::<crate::state::AppState>() {
                let _ = state.sockscap.stop();
            }
            app.exit(0);
        }
        _ => {}
    }
}
