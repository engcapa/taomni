use std::path::Path;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::module_lock::ModuleLock;
use crate::state::AppState;

const SERVERS_TAB_LOCK_SCOPE: &str = "servers";
const SERVERS_TAB_LOCK_RESOURCE: &str = "manager-tab";
const SERVERS_TAB_LOCK_LABEL: &str = "Local servers tab";

/// Result of trying to claim exclusive ownership of the Local servers tab
/// across windows and running Taomni processes.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ServersTabClaim {
    pub acquired: bool,
    pub holder: Option<String>,
}

/// Active OS lock entry kept in [`AppState`] while a window owns the
/// Local servers tab.
pub struct HeldServersTabLock {
    pub(crate) window_label: String,
    #[allow(dead_code)]
    pub(crate) lock: ModuleLock,
}

/// Claim exclusive ownership of the Local servers tab inside `slot`, scoped
/// to `app_data_dir` so another Taomni instance cannot open a second tab.
pub(crate) fn claim_servers_tab_in(
    slot: &Mutex<Option<HeldServersTabLock>>,
    app_data_dir: &Path,
    window_label: &str,
) -> Result<ServersTabClaim, String> {
    let mut guard = slot
        .lock()
        .map_err(|_| "servers tab lock state poisoned".to_string())?;
    if let Some(existing) = guard.as_ref() {
        if existing.window_label == window_label {
            return Ok(ServersTabClaim {
                acquired: true,
                holder: None,
            });
        }
        return Ok(ServersTabClaim {
            acquired: false,
            holder: Some(format!("Taomni window {}", existing.window_label)),
        });
    }

    match ModuleLock::try_acquire(
        app_data_dir,
        SERVERS_TAB_LOCK_SCOPE,
        SERVERS_TAB_LOCK_RESOURCE,
        SERVERS_TAB_LOCK_LABEL,
    ) {
        Ok(lock) => {
            *guard = Some(HeldServersTabLock {
                window_label: window_label.to_owned(),
                lock,
            });
            Ok(ServersTabClaim {
                acquired: true,
                holder: None,
            })
        }
        Err(error) => {
            if let Some((_, owner)) = error.split_once("is already active in ") {
                return Ok(ServersTabClaim {
                    acquired: false,
                    holder: Some(owner.trim().to_owned()),
                });
            }
            Err(error)
        }
    }
}

/// Release `slot` when `window_label` is the current owner.
pub(crate) fn release_servers_tab_in(slot: &Mutex<Option<HeldServersTabLock>>, window_label: &str) {
    if let Ok(mut guard) = slot.lock() {
        if guard
            .as_ref()
            .is_some_and(|entry| entry.window_label == window_label)
        {
            *guard = None;
        }
    }
}

/// Release any Local servers tab lock owned by `window_label` on `state`.
pub(crate) fn release_tab_lock_for_window(state: &AppState, window_label: &str) {
    release_servers_tab_in(&state.servers_tab_lock, window_label);
}

#[tauri::command]
pub async fn claim_servers_tab(
    app: AppHandle,
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
) -> Result<ServersTabClaim, String> {
    let app_data_dir = crate::resolved_app_data_dir(&app)
        .map_err(|error| format!("resolve app data directory for Local servers tab: {error}"))?;
    claim_servers_tab_in(&state.servers_tab_lock, &app_data_dir, window.label())
}

#[tauri::command]
pub async fn release_servers_tab(
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
) -> Result<(), String> {
    release_tab_lock_for_window(&state, window.label());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_window_reclaim_is_idempotent_and_other_window_is_blocked() {
        let dir = tempfile::tempdir().unwrap();
        let slot = Mutex::new(None);

        let first = claim_servers_tab_in(&slot, dir.path(), "main").expect("initial claim");
        assert_eq!(
            first,
            ServersTabClaim {
                acquired: true,
                holder: None,
            }
        );

        let reclaim = claim_servers_tab_in(&slot, dir.path(), "main").expect("same window");
        assert_eq!(
            reclaim,
            ServersTabClaim {
                acquired: true,
                holder: None,
            }
        );

        let other_window =
            claim_servers_tab_in(&slot, dir.path(), "detached-rdp").expect("other window");
        assert!(!other_window.acquired);
        assert!(
            other_window
                .holder
                .as_deref()
                .is_some_and(|holder| holder.contains("main"))
        );

        release_servers_tab_in(&slot, "detached-rdp");
        let still_held = claim_servers_tab_in(&slot, dir.path(), "detached-rdp")
            .expect("non-owner cannot release");
        assert!(!still_held.acquired);

        release_servers_tab_in(&slot, "main");
        let after_release =
            claim_servers_tab_in(&slot, dir.path(), "detached-rdp").expect("released");
        assert!(after_release.acquired);
    }

    #[test]
    fn second_instance_slot_is_rejected_until_first_instance_releases() {
        let dir = tempfile::tempdir().unwrap();
        let instance_a = Mutex::new(None);
        let instance_b = Mutex::new(None);

        let claim_a = claim_servers_tab_in(&instance_a, dir.path(), "main").expect("instance A");
        assert!(claim_a.acquired);

        let claim_b = claim_servers_tab_in(&instance_b, dir.path(), "main").expect("instance B");
        assert!(!claim_b.acquired);
        assert!(
            claim_b
                .holder
                .as_deref()
                .is_some_and(|holder| holder.contains("Taomni"))
        );

        release_servers_tab_in(&instance_a, "main");

        let claim_b_after = claim_servers_tab_in(&instance_b, dir.path(), "main")
            .expect("instance B after release");
        assert!(claim_b_after.acquired);
    }
}
