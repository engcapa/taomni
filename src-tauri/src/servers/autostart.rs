use super::lifetime::start_local_server;
use super::model::ServerType;
use super::persistence::load_server_configs;
use crate::servers::db;
use crate::servers::rdp;
use crate::state::AppState;
use tauri::AppHandle;
use tauri::Manager;
use tauri::State;

/// On Windows, Taomni's RDP server only autostarts after the user explicitly
/// chose it over an available system Remote Desktop (design AC-04).
pub(super) fn rdp_autostart_allowed(config: &serde_json::Value) -> bool {
    use rdp::system_rdp::Recommendation;
    if config.get("systemRdpChoice").and_then(|v| v.as_str()) == Some("taomni") {
        return true;
    }
    !matches!(
        rdp::system_rdp::probe().recommendation,
        Some(Recommendation::UseSystem | Recommendation::EnableSystem | Recommendation::NeedsAdmin)
    )
}

/// Called once at startup to start any servers whose persisted config has
/// `startOnLaunch=true`. Errors are logged but never abort startup; each
/// failure still surfaces via the normal `server://status/<type>` event.
pub async fn autostart_servers(app: AppHandle) {
    let configs = {
        let state: State<AppState> = app.state();
        let db = match state.db.lock() {
            Ok(db) => db,
            Err(e) => {
                tracing::warn!("autostart servers: db lock: {}", e);
                return;
            }
        };
        match db::load_server_configs(&db) {
            Ok(c) => c,
            Err(e) => {
                tracing::warn!("autostart servers: load: {}", e);
                return;
            }
        }
    };

    for (type_str, value) in configs {
        // Only autostart entries explicitly flagged for it.
        let should = value
            .get("startOnLaunch")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        if !should {
            continue;
        }
        if type_str == ServerType::Rdp.as_str() && !rdp_autostart_allowed(&value) {
            tracing::warn!(
                "autostart server rdp skipped: Windows Remote Desktop is available and the \
                 user has not confirmed using Taomni's RDP server"
            );
            continue;
        }
        let state: State<AppState> = app.state();
        if let Err(e) = start_local_server(app.clone(), state, type_str.clone(), value).await {
            tracing::warn!("autostart server {}: {}", type_str, e);
        }
    }
}
