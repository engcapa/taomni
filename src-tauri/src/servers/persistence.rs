use super::credentials::rdp_plaintext_password;
use super::credentials::redact_legacy_rdp_password;
use super::credentials::redact_rdp_password;
use super::credentials::secure_rdp_config;
use super::model::ServerType;
use crate::servers::db;
use crate::state::AppState;
use std::collections::HashMap;
use tauri::State;

#[tauri::command]
pub async fn save_server_config(
    state: State<'_, AppState>,
    server_type: String,
    mut config: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let st = ServerType::from_str(&server_type)
        .ok_or_else(|| format!("unknown server type: {}", server_type))?;
    if st == ServerType::Rdp {
        let legacy_password = {
            let db = state.db.lock().map_err(|e| e.to_string())?;
            db::load_server_config(&db, st.as_str())
                .map_err(|e| e.to_string())?
                .and_then(|value| rdp_plaintext_password(&value).map(str::to_owned))
        };
        secure_rdp_config(
            state.vault.as_ref(),
            &mut config,
            legacy_password.as_deref(),
        )?;
    }
    let json = serde_json::to_string(&config).map_err(|e| e.to_string())?;
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db::save_server_config(&db, st.as_str(), &json).map_err(|e| e.to_string())?;
    Ok(config)
}

#[tauri::command]
pub async fn load_server_configs(
    state: State<'_, AppState>,
) -> Result<HashMap<String, serde_json::Value>, String> {
    let mut configs = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        db::load_server_configs(&db).map_err(|e| e.to_string())?
    };

    if let Some(config) = configs.get_mut(ServerType::Rdp.as_str()) {
        let legacy_password = rdp_plaintext_password(config).map(str::to_owned);
        if legacy_password.is_some() {
            match secure_rdp_config(state.vault.as_ref(), config, legacy_password.as_deref()) {
                Ok(()) => {
                    let json = serde_json::to_string(config).map_err(|e| e.to_string())?;
                    let db = state.db.lock().map_err(|e| e.to_string())?;
                    db::save_server_config(&db, ServerType::Rdp.as_str(), &json)
                        .map_err(|e| e.to_string())?;
                }
                Err(e) if e == crate::vault::ERR_VAULT_LOCKED => {
                    redact_legacy_rdp_password(config);
                }
                Err(e) => return Err(e),
            }
        } else {
            redact_rdp_password(config);
        }
    }

    Ok(configs)
}
