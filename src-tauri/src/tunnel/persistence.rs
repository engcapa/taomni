use super::model::TunnelAuthMethod;
use super::model::TunnelConfig;
use std::path::PathBuf;
use tauri::AppHandle;

/* ---------------------------- persistence --------------------------- */

pub(super) fn store_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = crate::resolved_app_data_dir(app)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("create app dir: {}", e))?;
    Ok(dir.join("tunnels.json"))
}

pub(super) fn load_all(app: &AppHandle) -> Result<Vec<TunnelConfig>, String> {
    let path = store_path(app)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let bytes = std::fs::read(&path).map_err(|e| format!("read tunnels.json: {}", e))?;
    let mut list: Vec<TunnelConfig> =
        serde_json::from_slice(&bytes).map_err(|e| format!("parse tunnels.json: {}", e))?;
    list.sort_by_key(|t| t.sort_order.unwrap_or(0));
    Ok(list)
}

pub(super) fn save_all(app: &AppHandle, list: &[TunnelConfig]) -> Result<(), String> {
    // Strip secrets unless save_auth is true.
    let sanitized: Vec<TunnelConfig> = list
        .iter()
        .cloned()
        .map(|mut t| {
            let keep = t.ssh.save_auth.unwrap_or(false)
                || matches!(t.ssh.auth_method, TunnelAuthMethod::PrivateKey);
            if !keep {
                t.ssh.auth_data = None;
            }
            // `auth_status` is purely UI-side metadata; never persist it.
            t.ssh.auth_status = None;
            t
        })
        .collect();
    let bytes = serde_json::to_vec_pretty(&sanitized).map_err(|e| format!("encode: {}", e))?;
    let path = store_path(app)?;
    std::fs::write(&path, bytes).map_err(|e| format!("write tunnels.json: {}", e))?;
    Ok(())
}
