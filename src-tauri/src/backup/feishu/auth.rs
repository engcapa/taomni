//! Feishu credentials and refresh. Authorization ownership lives in auth_session.
pub use super::auth_service::start;
pub use super::auth_session::{Authorizations, cancel, forget, initialize, sessions, terminal};
use super::{
    cli_config,
    device_flow::{self, FlowClient},
};
use crate::backup::{
    control,
    credentials::{self, ConnectionSecrets},
    model::*,
};
use std::{
    fs::{File, OpenOptions, TryLockError},
    time::Duration,
};
use tauri::{Emitter, Manager};
use tokio_util::sync::CancellationToken;
pub fn required_scopes() -> &'static str {
    device_flow::SCOPES
}
pub fn connected(secrets: &ConnectionSecrets) -> bool {
    !secrets.refresh_in_flight
        && !secrets.authorization_required
        && !secrets.refresh_token.is_empty()
        && secrets.refresh_expires_at > now_ms()
        && device_flow::missing_scopes(&secrets.granted_scopes).is_empty()
}
fn connection(config: &ControlConfig, id: &str) -> Result<FeishuConnection, String> {
    config
        .connections
        .iter()
        .find(|c| c.id == id)
        .cloned()
        .ok_or_else(|| "Feishu connection not found".into())
}
pub(super) struct CredentialLock(File);
impl Drop for CredentialLock {
    fn drop(&mut self) {
        let _ = self.0.unlock();
    }
}
pub(super) async fn lock(
    app: &tauri::AppHandle,
    id: &str,
    cancel: &CancellationToken,
) -> Result<CredentialLock, String> {
    if id != "initialization" {
        validate_id(id)?;
    }
    let dir = control::root(app)?.join("auth-locks");
    std::fs::create_dir_all(&dir).map_err(|_| "Cannot create Feishu connection lock directory")?;
    let file = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .truncate(false)
        .open(dir.join(format!("{id}.lock")))
        .map_err(|_| "Cannot open Feishu connection lock")?;
    loop {
        if cancel.is_cancelled() {
            return Err(device_flow::CANCELLED.into());
        }
        match file.try_lock() {
            Ok(())=>return Ok(CredentialLock(file)),
            Err(TryLockError::WouldBlock)=>tokio::select!{_=cancel.cancelled()=>return Err(device_flow::CANCELLED.into()),_=tokio::time::sleep(Duration::from_millis(100))=>()},
            Err(_)=>return Err("Cannot lock Feishu credentials; close other Taomni instances using this profile and retry".into()),
        }
    }
}
pub async fn access_token(
    app: &tauri::AppHandle,
    target: &BackupTarget,
    client: &reqwest::Client,
    cancel: &CancellationToken,
) -> Result<String, String> {
    access_token_inner(app, target, client, cancel, None).await
}

pub async fn access_token_after_rejection(
    app: &tauri::AppHandle,
    target: &BackupTarget,
    client: &reqwest::Client,
    cancel: &CancellationToken,
    rejected: &str,
) -> Result<String, String> {
    access_token_inner(app, target, client, cancel, Some(rejected)).await
}

pub async fn require_authorization(
    app: &tauri::AppHandle,
    target: &BackupTarget,
    cancel: &CancellationToken,
) -> Result<(), String> {
    let id = target
        .connection_id
        .as_deref()
        .ok_or("Missing Feishu connection")?;
    let _lock = lock(app, id, cancel).await?;
    let profile = control::load(app)?.device.id;
    let mut stored = credentials::get_connection(&profile, id)?;
    stored.authorization_required = true;
    credentials::put_connection(&profile, id, &stored)?;
    let _ = app.emit("backup-connection-changed", id);
    Ok(())
}

async fn access_token_inner(
    app: &tauri::AppHandle,
    target: &BackupTarget,
    client: &reqwest::Client,
    cancel: &CancellationToken,
    rejected: Option<&str>,
) -> Result<String, String> {
    use crate::backup::failure::{self, FailureKind};
    let id = target
        .connection_id
        .as_deref()
        .ok_or("Connect Feishu before using this backup target")?;
    let _lock = lock(app, id, cancel).await?;
    let config = control::load(app)?;
    let conn = connection(&config, id)?;
    let mut stored = credentials::get_connection(&config.device.id, id)?;
    if stored.authorization_required {
        return Err(failure::tagged(
            FailureKind::Authorization,
            "Feishu authorization is no longer valid; authorize again",
        ));
    }
    if stored.refresh_in_flight {
        return Err(failure::tagged(
            FailureKind::Authorization,
            "Previous Feishu token refresh was interrupted or uncertain; authorize again before backing up",
        ));
    }
    if !device_flow::missing_scopes(&stored.granted_scopes).is_empty() {
        return Err(failure::tagged(
            FailureKind::Authorization,
            "Authorize all Feishu backup permissions before using this target",
        ));
    }
    if !stored.access_token.is_empty()
        && stored.expires_at > now_ms() + 120_000
        && rejected != Some(stored.access_token.as_str())
    {
        return Ok(stored.access_token.clone());
    }
    if stored.refresh_token.is_empty() || stored.refresh_expires_at <= now_ms() {
        return Err(failure::tagged(
            FailureKind::Authorization,
            "Feishu authorization expired; connect the account again",
        ));
    }
    if cancel.is_cancelled() {
        return Err(device_flow::CANCELLED.into());
    }
    stored.refresh_in_flight = true;
    credentials::put_connection(&config.device.id, id, &stored)?;
    match FlowClient::for_app(client.clone(), app)?
        .refresh(&conn.app_id, &stored, cancel)
        .await
    {
        Ok(mut refreshed) => {
            refreshed.app_id = conn.app_id;
            refreshed.app_secret = stored.app_secret.clone();
            credentials::put_connection(&config.device.id, id, &refreshed)?;
            if cancel.is_cancelled() {
                return Err(device_flow::CANCELLED.into());
            }
            Ok(refreshed.access_token.clone())
        }
        Err((error, uncertain)) => {
            if !uncertain {
                stored.refresh_in_flight = false;
                if failure::classify(&error) == FailureKind::Authorization {
                    stored.authorization_required = true;
                }
                credentials::put_connection(&config.device.id, id, &stored)?;
                let _ = app.emit("backup-connection-changed", id);
                return Err(error);
            }
            let _ = app.emit("backup-connection-changed", id);
            Err(failure::tagged(
                FailureKind::Authorization,
                &format!(
                    "{error}. Token refresh did not complete reliably; authorize Feishu again"
                ),
            ))
        }
    }
}
