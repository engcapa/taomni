//! Native Sockscap tray and guarded application exit.
//!
//! The tray is process-global and reflects the same engine snapshot exposed to
//! the dedicated window. Explicit application exit always runs the engine stop
//! transaction and verifies the persistent recovery journal before allowing
//! Tauri to terminate.

use std::collections::HashMap;
use std::time::Duration;

use tauri::image::Image;
use tauri::menu::{MenuBuilder, MenuEvent, MenuItem, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{App, AppHandle, Manager};

use super::commands;
use super::storage::{RecoveryJournal, RecoveryPhase};
use super::types::{EngineState, EngineStatus};
use crate::state::AppState;

const TRAY_ID: &str = "taomni-sockscap";
const STATUS_ITEM_ID: &str = "sockscap.tray.status";
const START_ITEM_ID: &str = "sockscap.tray.start";
const STOP_ITEM_ID: &str = "sockscap.tray.stop";
const PROFILES_ITEM_ID: &str = "sockscap.tray.profiles";
const DASHBOARD_ITEM_ID: &str = "sockscap.tray.dashboard";
const OPEN_ITEM_ID: &str = "sockscap.tray.open";
const HIDE_ITEM_ID: &str = "sockscap.tray.hide";
const RECOVER_ITEM_ID: &str = "sockscap.tray.recover";
const EXIT_ITEM_ID: &str = "sockscap.tray.exit";
const EXIT_CLEANUP_TIMEOUT: Duration = Duration::from_secs(15);
const ICON_SIZE: u32 = 18;

pub struct SockscapTrayState {
    tray: TrayIcon,
    status: MenuItem<tauri::Wry>,
    start: MenuItem<tauri::Wry>,
    stop: MenuItem<tauri::Wry>,
    profiles: MenuItem<tauri::Wry>,
    hide: MenuItem<tauri::Wry>,
    recover: MenuItem<tauri::Wry>,
}

#[derive(Debug, Clone, Copy)]
enum TrayEngineAction {
    Start,
    Stop,
    Recover,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TrayTone {
    Disabled,
    Active,
    Degraded,
    RecoveryRequired,
}

/// Create the native tray once AppState is available. Linux always retains a
/// concrete menu because Tauri does not expose tray click events there.
pub fn initialize_sockscap_tray(app: &App) -> tauri::Result<()> {
    let status = MenuItemBuilder::with_id(STATUS_ITEM_ID, "Status: Disabled")
        .enabled(false)
        .build(app)?;
    let start = MenuItemBuilder::with_id(START_ITEM_ID, "Start Sockscap").build(app)?;
    let stop = MenuItemBuilder::with_id(STOP_ITEM_ID, "Stop Sockscap")
        .enabled(false)
        .build(app)?;
    let profiles = MenuItemBuilder::with_id(PROFILES_ITEM_ID, "Active profiles: None")
        .enabled(false)
        .build(app)?;
    let dashboard = MenuItemBuilder::with_id(DASHBOARD_ITEM_ID, "Open Dashboard").build(app)?;
    let open = MenuItemBuilder::with_id(OPEN_ITEM_ID, "Open Sockscap").build(app)?;
    let hide = MenuItemBuilder::with_id(HIDE_ITEM_ID, "Hide Sockscap")
        .enabled(false)
        .build(app)?;
    let recover = MenuItemBuilder::with_id(RECOVER_ITEM_ID, "Recover network")
        .enabled(false)
        .build(app)?;
    let exit = MenuItemBuilder::with_id(EXIT_ITEM_ID, "Exit Taomni").build(app)?;

    let menu = MenuBuilder::new(app)
        .item(&status)
        .item(&profiles)
        .separator()
        .item(&start)
        .item(&stop)
        .item(&recover)
        .separator()
        .item(&dashboard)
        .item(&open)
        .item(&hide)
        .separator()
        .item(&exit)
        .build()?;

    let tray = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .icon(tray_icon(TrayTone::Disabled))
        .tooltip("Taomni Sockscap — Disabled")
        .show_menu_on_left_click(false)
        .on_menu_event(handle_menu_event)
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                if let Err(error) = commands::toggle_sockscap_window(tray.app_handle()) {
                    commands::publish_external_error(tray.app_handle(), error);
                }
            }
        })
        .build(app)?;

    app.manage(SockscapTrayState {
        tray,
        status,
        start,
        stop,
        profiles,
        hide,
        recover,
    });
    refresh_sockscap_tray(app.handle());
    Ok(())
}

/// Best-effort refresh used after every lifecycle result and window action.
/// Tray rendering failures never change the engine outcome.
pub fn refresh_sockscap_tray(app: &AppHandle) {
    let Some(tray) = app.try_state::<SockscapTrayState>() else {
        return;
    };
    let state = app.state::<AppState>();
    let status = state.sockscap.status();
    let tone = tone_for_status(&status);
    let state_label = state_label(status.state);
    let active_profiles = active_profile_names(&state, &status);
    let window_visible = commands::sockscap_window_is_visible(app);
    let can_start = !status.capture_active
        && !status.recovery_required
        && matches!(
            status.state,
            EngineState::Disabled | EngineState::Degraded | EngineState::UserActionRequired
        );
    let can_stop = status.capture_active
        || matches!(
            status.state,
            EngineState::Active | EngineState::Degraded | EngineState::UserActionRequired
        );

    update_tray_item(
        "status text",
        tray.status.set_text(format!("Status: {state_label}")),
    );
    update_tray_item(
        "active profiles text",
        tray.profiles
            .set_text(format!("Active profiles: {active_profiles}")),
    );
    update_tray_item("start enabled", tray.start.set_enabled(can_start));
    update_tray_item("stop enabled", tray.stop.set_enabled(can_stop));
    update_tray_item("hide enabled", tray.hide.set_enabled(window_visible));
    update_tray_item(
        "recover enabled",
        tray.recover.set_enabled(status.recovery_required),
    );
    update_tray_item("icon", tray.tray.set_icon(Some(tray_icon(tone))));
    update_tray_item(
        "tooltip",
        tray.tray
            .set_tooltip(Some(format!("Taomni Sockscap — {state_label}"))),
    );
}

/// Existing frontend command name retained so every explicit exit path shares
/// one cleanup gate.
#[tauri::command]
pub async fn exit_app(app_handle: AppHandle) -> Result<(), String> {
    request_safe_exit(app_handle).await
}

async fn request_safe_exit(app: AppHandle) -> Result<(), String> {
    let worker_app = app.clone();
    let cleanup = tokio::task::spawn_blocking(move || {
        let state = worker_app.state::<AppState>();
        let status = state.sockscap.stop()?;
        let journal = state.sockscap_store.recovery_journal()?;
        verify_exit_ready(&status, &journal)?;
        Ok(status)
    });
    let result = match tokio::time::timeout(EXIT_CLEANUP_TIMEOUT, cleanup).await {
        Ok(Ok(result)) => result,
        Ok(Err(error)) => Err(format!("SOCKSCAP_EXIT_CLEANUP_TASK_FAILED: {error}")),
        Err(_) => Err(format!(
            "SOCKSCAP_EXIT_CLEANUP_TIMEOUT: network cleanup was not confirmed within {} seconds",
            EXIT_CLEANUP_TIMEOUT.as_secs()
        )),
    };

    let state = app.state::<AppState>();
    commands::publish_engine_result(&app, &state, &result);
    if let Err(error) = result {
        let _ = commands::open_sockscap_window_at(&app, Some("lifecycle"));
        return Err(error);
    }

    app.exit(0);
    Ok(())
}

fn verify_exit_ready(status: &EngineStatus, journal: &RecoveryJournal) -> Result<(), String> {
    if status.capture_active {
        return Err("SOCKSCAP_EXIT_CAPTURE_STILL_ACTIVE: capture cleanup was not confirmed".into());
    }
    if status.recovery_required || journal.cleanup_required || journal.phase != RecoveryPhase::Clean
    {
        return Err(format!(
            "SOCKSCAP_EXIT_RECOVERY_REQUIRED: recovery generation {} remains {:?}",
            journal.generation, journal.phase
        ));
    }
    if status.state != EngineState::Disabled {
        return Err(format!(
            "SOCKSCAP_EXIT_ENGINE_NOT_DISABLED: engine remains {:?}",
            status.state
        ));
    }
    Ok(())
}

fn handle_menu_event(app: &AppHandle, event: MenuEvent) {
    match event.id().as_ref() {
        START_ITEM_ID => run_engine_action(app.clone(), TrayEngineAction::Start),
        STOP_ITEM_ID => run_engine_action(app.clone(), TrayEngineAction::Stop),
        RECOVER_ITEM_ID => run_engine_action(app.clone(), TrayEngineAction::Recover),
        DASHBOARD_ITEM_ID => {
            if let Err(error) = commands::open_sockscap_window_at(app, Some("dashboard")) {
                commands::publish_external_error(app, error);
            }
        }
        OPEN_ITEM_ID => {
            if let Err(error) = commands::open_sockscap_window_at(app, None) {
                commands::publish_external_error(app, error);
            }
        }
        HIDE_ITEM_ID => {
            if let Err(error) = commands::hide_sockscap_window(app) {
                commands::publish_external_error(app, error);
            }
        }
        EXIT_ITEM_ID => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let _ = request_safe_exit(app).await;
            });
        }
        _ => {}
    }
}

fn run_engine_action(app: AppHandle, action: TrayEngineAction) {
    tauri::async_runtime::spawn(async move {
        let worker_app = app.clone();
        let result = tokio::task::spawn_blocking(move || {
            let state = worker_app.state::<AppState>();
            match action {
                TrayEngineAction::Start => state.sockscap.start(),
                TrayEngineAction::Stop => state.sockscap.stop(),
                TrayEngineAction::Recover => state.sockscap.recover(),
            }
        })
        .await
        .unwrap_or_else(|error| Err(format!("SOCKSCAP_TRAY_ACTION_FAILED: {error}")));
        let state = app.state::<AppState>();
        commands::publish_engine_result(&app, &state, &result);
    });
}

fn active_profile_names(state: &AppState, status: &EngineStatus) -> String {
    if status.active_profile_ids.is_empty() {
        return "None".into();
    }
    let names = state
        .sockscap_store
        .list_profiles()
        .map(|profiles| {
            profiles
                .into_iter()
                .map(|record| (record.profile.id, record.profile.name))
                .collect::<HashMap<_, _>>()
        })
        .unwrap_or_default();
    let display = status
        .active_profile_ids
        .iter()
        .map(|id| names.get(id).cloned().unwrap_or_else(|| id.clone()))
        .collect::<Vec<_>>()
        .join(", ");
    bounded_text(&display, 160)
}

fn bounded_text(value: &str, max_chars: usize) -> String {
    let mut chars = value.chars();
    let prefix = chars.by_ref().take(max_chars).collect::<String>();
    if chars.next().is_some() {
        format!("{prefix}…")
    } else {
        prefix
    }
}

fn state_label(state: EngineState) -> &'static str {
    match state {
        EngineState::Disabled => "Disabled",
        EngineState::Preparing => "Preparing",
        EngineState::Active => "Active",
        EngineState::Degraded => "Degraded",
        EngineState::Stopping => "Stopping",
        EngineState::RecoveryRequired => "Recovery required",
        EngineState::UserActionRequired => "User action required",
    }
}

fn tone_for_status(status: &EngineStatus) -> TrayTone {
    if status.recovery_required || status.state == EngineState::RecoveryRequired {
        return TrayTone::RecoveryRequired;
    }
    match status.state {
        EngineState::Disabled => TrayTone::Disabled,
        EngineState::Active => TrayTone::Active,
        EngineState::Preparing
        | EngineState::Degraded
        | EngineState::Stopping
        | EngineState::UserActionRequired => TrayTone::Degraded,
        EngineState::RecoveryRequired => TrayTone::RecoveryRequired,
    }
}

fn tray_icon(tone: TrayTone) -> Image<'static> {
    Image::new_owned(tray_icon_rgba(tone), ICON_SIZE, ICON_SIZE)
}

fn tray_icon_rgba(tone: TrayTone) -> Vec<u8> {
    let color = match tone {
        TrayTone::Disabled => [128, 128, 128, 255],
        TrayTone::Active => [34, 197, 94, 255],
        TrayTone::Degraded => [245, 158, 11, 255],
        TrayTone::RecoveryRequired => [239, 68, 68, 255],
    };
    let mut rgba = vec![0; (ICON_SIZE * ICON_SIZE * 4) as usize];
    let diameter = ICON_SIZE as i32;
    for y in 0..diameter {
        for x in 0..diameter {
            let dx = 2 * x + 1 - diameter;
            let dy = 2 * y + 1 - diameter;
            let distance = dx * dx + dy * dy;
            if distance > 225 {
                continue;
            }
            let pixel = ((y * diameter + x) * 4) as usize;
            let fill = if distance > 169 {
                [color[0] / 2, color[1] / 2, color[2] / 2, 255]
            } else {
                color
            };
            rgba[pixel..pixel + 4].copy_from_slice(&fill);
        }
    }
    rgba
}

fn update_tray_item(context: &str, result: tauri::Result<()>) {
    if let Err(error) = result {
        tracing::warn!(context, %error, "could not refresh Sockscap tray");
    }
}

#[cfg(test)]
mod tests {
    use super::super::types::CapturePlatform;
    use super::*;

    fn journal(phase: RecoveryPhase, cleanup_required: bool) -> RecoveryJournal {
        RecoveryJournal {
            generation: 7,
            phase,
            cleanup_required,
            restore_after_recovery: false,
            config_revision: 4,
            platform: CapturePlatform::Linux,
            active_profile_ids: Vec::new(),
            artifact_state: serde_json::json!({}),
            helper_pid: None,
            last_heartbeat_at: None,
            last_error_code: None,
            created_at: 1,
            updated_at: 1,
        }
    }

    #[test]
    fn tray_tones_follow_the_public_lifecycle_states() {
        let mut status = EngineStatus::default();
        assert_eq!(tone_for_status(&status), TrayTone::Disabled);
        status.state = EngineState::Active;
        status.capture_active = true;
        assert_eq!(tone_for_status(&status), TrayTone::Active);
        status.state = EngineState::UserActionRequired;
        assert_eq!(tone_for_status(&status), TrayTone::Degraded);
        status.recovery_required = true;
        assert_eq!(tone_for_status(&status), TrayTone::RecoveryRequired);
    }

    #[test]
    fn generated_status_icon_has_a_transparent_corner_and_colored_center() {
        let rgba = tray_icon_rgba(TrayTone::Active);
        assert_eq!(rgba.len(), (ICON_SIZE * ICON_SIZE * 4) as usize);
        assert_eq!(&rgba[0..4], &[0, 0, 0, 0]);
        let center = (((ICON_SIZE / 2) * ICON_SIZE + ICON_SIZE / 2) * 4) as usize;
        assert_eq!(&rgba[center..center + 4], &[34, 197, 94, 255]);
    }

    #[test]
    fn guarded_exit_requires_disabled_memory_and_a_clean_persistent_journal() {
        let clean = journal(RecoveryPhase::Clean, false);
        assert!(verify_exit_ready(&EngineStatus::default(), &clean).is_ok());

        let dirty = journal(RecoveryPhase::Stopping, true);
        let error = verify_exit_ready(&EngineStatus::default(), &dirty).unwrap_err();
        assert!(error.starts_with("SOCKSCAP_EXIT_RECOVERY_REQUIRED"));

        let mut active = EngineStatus::default();
        active.state = EngineState::Active;
        active.capture_active = true;
        let error = verify_exit_ready(&active, &clean).unwrap_err();
        assert!(error.starts_with("SOCKSCAP_EXIT_CAPTURE_STILL_ACTIVE"));
    }

    #[test]
    fn active_profile_text_is_unicode_safe_and_bounded() {
        let text = "配置组".repeat(100);
        let bounded = bounded_text(&text, 12);
        assert_eq!(bounded.chars().count(), 13);
        assert!(bounded.ends_with('…'));
    }
}
