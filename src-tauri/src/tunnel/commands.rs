use super::credentials::compute_auth_status;
use super::credentials::resolve_tunnel_creds;
use super::credentials::ssh_auth_from;
use super::model::TunnelAuthMethod;
use super::model::TunnelConfig;
use super::model::TunnelStatus;
use super::model::TunnelStatusInfo;
use super::persistence::load_all;
use super::persistence::save_all;
use crate::state::AppState;
use crate::terminal::ssh::connect_ssh_authenticated;
use std::collections::HashMap;
use tauri::AppHandle;
use tauri::State;

/* ---------------------------- Tauri commands ------------------------ */

#[tauri::command]
pub async fn list_tunnels(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<TunnelConfig>, String> {
    let mut list = {
        let _guard = state.tunnels.store_lock.lock().await;
        load_all(&app)?
    };
    // Annotate each entry with `auth_status` so the UI can show a masked
    // indicator (and enable the eye-toggle) without exposing plaintext.
    let cache = state.tunnels.session_passwords.lock().await;
    for t in list.iter_mut() {
        t.ssh.auth_status = Some(compute_auth_status(&t.ssh, cache.contains_key(&t.id)));
    }
    Ok(list)
}

#[tauri::command]
pub async fn upsert_tunnel(
    config: TunnelConfig,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<TunnelConfig, String> {
    // Capture (or evict) the in-memory password BEFORE save_all strips it.
    //
    // Cases (auth_method == Password, save_auth == false):
    // * Plaintext authData supplied  → insert/replace the cache so
    //   "Save then Start" works without re-prompting.
    // * Empty/None authData          → KEEP whatever we already have. The
    //   user is editing the row (e.g. renaming, toggling autostart) and
    //   the editor leaves authData blank when the original was a stripped
    //   secret; evicting here would silently break a working tunnel.
    //
    // Anything else (PrivateKey/Agent, save_auth=true, vault ref) → drop
    // any prior cache entry to avoid stale secrets surviving an auth
    // method or storage change.
    {
        let cache = &state.tunnels.session_passwords;
        let mut map = cache.lock().await;
        let is_password = matches!(config.ssh.auth_method, TunnelAuthMethod::Password);
        let wants_session = is_password && !config.ssh.save_auth.unwrap_or(false);
        match (wants_session, config.ssh.auth_data.as_deref()) {
            (true, Some(raw))
                if !raw.is_empty() && !raw.starts_with(crate::vault::VAULT_REF_PREFIX) =>
            {
                // Fresh plaintext typed by the user: refresh the cache.
                map.insert(config.id.clone(), raw.to_string());
            }
            (true, _) => {
                // No new plaintext provided. Preserve any existing cached
                // password so unrelated edits don't break the tunnel.
            }
            _ => {
                // Switched away from cached-password mode (vault, agent,
                // private key, etc.) — clear the stale cache entry.
                map.remove(&config.id);
            }
        }
    }

    let _guard = state.tunnels.store_lock.lock().await;
    let mut all = load_all(&app)?;
    if let Some(idx) = all.iter().position(|t| t.id == config.id) {
        all[idx] = config.clone();
    } else {
        all.push(config.clone());
    }
    save_all(&app, &all)?;
    Ok(config)
}

#[tauri::command]
pub async fn delete_tunnel(
    id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    {
        let _guard = state.tunnels.store_lock.lock().await;
        let mut all = load_all(&app)?;
        all.retain(|t| t.id != id);
        save_all(&app, &all)?;
    }
    state.tunnels.session_passwords.lock().await.remove(&id);
    let mut running = state.tunnels.running.lock().await;
    if let Some(active) = running.remove(&id) {
        active.task.abort();
        let bridges = active.bridges.lock().await;
        for b in bridges.iter() {
            b.abort();
        }
    }
    state.tunnels.statuses.lock().await.remove(&id);
    Ok(())
}

#[tauri::command]
pub async fn get_tunnel_status(
    id: String,
    state: State<'_, AppState>,
) -> Result<TunnelStatusInfo, String> {
    let s = state.tunnels.statuses.lock().await;
    Ok(s.get(&id).cloned().unwrap_or(TunnelStatusInfo {
        id,
        status: TunnelStatus::Stopped,
        error: None,
        active_connections: None,
    }))
}

#[tauri::command]
pub async fn list_tunnel_statuses(
    state: State<'_, AppState>,
) -> Result<Vec<TunnelStatusInfo>, String> {
    let s = state.tunnels.statuses.lock().await;
    Ok(s.values().cloned().collect())
}

#[tauri::command]
pub async fn reorder_tunnels(
    ids: Vec<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let _guard = state.tunnels.store_lock.lock().await;
    let mut all = load_all(&app)?;
    let mut by_id: HashMap<String, TunnelConfig> =
        all.drain(..).map(|t| (t.id.clone(), t)).collect();
    let mut reordered: Vec<TunnelConfig> = Vec::with_capacity(by_id.len());
    for (idx, id) in ids.iter().enumerate() {
        if let Some(mut t) = by_id.remove(id) {
            t.sort_order = Some(idx as i32);
            reordered.push(t);
        }
    }
    // Append any tunnels not present in `ids` (defensive).
    for (_id, t) in by_id.into_iter() {
        reordered.push(t);
    }
    save_all(&app, &reordered)?;
    Ok(())
}

#[tauri::command]
pub async fn test_tunnel(
    id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let configs = {
        let _guard = state.tunnels.store_lock.lock().await;
        load_all(&app)?
    };
    let mut config = configs
        .into_iter()
        .find(|t| t.id == id)
        .ok_or_else(|| format!("tunnel {} not found", id))?;
    let session_pwd = state
        .tunnels
        .session_passwords
        .lock()
        .await
        .get(&id)
        .cloned();
    resolve_tunnel_creds(&mut config, &state.vault, session_pwd)?;
    let auth = ssh_auth_from(&config.ssh)?;
    let handle = connect_ssh_authenticated(
        &config.ssh.host,
        config.ssh.port,
        &config.ssh.username,
        auth,
    )
    .await?;
    drop(handle);
    Ok(format!(
        "SSH connection to {}@{}:{} succeeded",
        config.ssh.username, config.ssh.host, config.ssh.port
    ))
}
