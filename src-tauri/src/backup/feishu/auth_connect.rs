//! Registration recovery and authorization flow; journal state is owned separately.
use super::{
    auth::lock,
    auth_session::{Authorizations, commit_active, publish},
    cli_config, cli_secret,
    device_flow::{self, FlowClient, RegisteredApp},
};
use crate::{
    backup::{
        control,
        credentials::{self, ConnectionSecrets},
        model::*,
        network,
    },
    state::AppState,
};
use std::time::Duration;
use tauri::Manager;
use tokio_util::sync::CancellationToken;
fn connection(config: &ControlConfig, id: &str) -> Result<FeishuConnection, String> {
    config
        .connections
        .iter()
        .find(|c| c.id == id)
        .cloned()
        .ok_or_else(|| "Feishu connection not found".into())
}
fn new_connection() -> FeishuConnection {
    FeishuConnection {
        id: uuid::Uuid::new_v4().to_string(),
        app_id: String::new(),
        label: "Feishu".into(),
        origin: "native_registered".into(),
        account_id: String::new(),
        account_name: String::new(),
        tenant_key: String::new(),
        auth_protocol_version: 1,
        scope_manifest_version: 1,
        registration_pending: false,
    }
}
fn bind(app: &tauri::AppHandle, target_id: &str, conn: &FeishuConnection) -> Result<(), String> {
    control::update(app, |config| {
        let target = config
            .targets
            .iter_mut()
            .find(|t| t.id == target_id)
            .ok_or("Backup target was removed")?;
        if target
            .connection_id
            .as_ref()
            .is_some_and(|id| id != &conn.id)
        {
            target.root_token.clear();
            target.writes_paused = true;
        }
        target.connection_id = Some(conn.id.clone());
        if let Some(current) = config.connections.iter_mut().find(|c| c.id == conn.id) {
            *current = conn.clone();
        } else {
            config.connections.push(conn.clone());
        }
        Ok(())
    })
}

pub(super) async fn connect(
    app: &tauri::AppHandle,
    target: &BackupTarget,
    selection: Option<&str>,
    restart_application: bool,
    session: &mut AuthorizationSession,
    cancel: &CancellationToken,
) -> Result<(), String> {
    let client = network::client(&app.state::<AppState>(), &target.proxy)?;
    let flow = FlowClient::for_app(client, app)?;
    let initialization = lock(app, "initialization", cancel).await?;
    let config = control::load(app)?;
    let profile = config.device.id.clone();
    let current = target.connection_id.as_deref();
    let saved = selection
        .and_then(|id| {
            config
                .connections
                .iter()
                .find(|c| c.id == id || c.app_id == id)
                .map(|c| c.id.as_str())
        })
        .or_else(|| {
            if selection.is_none() {
                current.or_else(|| config.connections.first().map(|c| c.id.as_str()))
            } else {
                None
            }
        });
    let mut conn = if let Some(id) = saved.filter(|_| !restart_application) {
        connection(&config, id)?
    } else {
        new_connection()
    };
    let _credential_lock = lock(app, &conn.id, cancel).await?;
    let mut secrets = credentials::get_connection(&profile, &conn.id)?;
    credentials::put_connection(&profile, &conn.id, &secrets)?;
    if conn.app_id.is_empty() && !secrets.app_id.is_empty() && !secrets.app_secret.is_empty() {
        conn.app_id = secrets.app_id.clone();
        conn.label = conn.app_id.clone();
        conn.registration_pending = false;
        bind(app, &target.id, &conn)?;
    }
    if conn.app_id.is_empty() {
        let issued = app
            .state::<Authorizations>()
            .unsaved
            .lock()
            .map_err(|_| "Cannot access pending Feishu application")?
            .remove(&conn.id);
        if let Some(issued) = issued {
            persist_registered(app, &target.id, &profile, &mut conn, &mut secrets, issued)?;
        } else {
            publish(app, session, "resolving_app", None, None, None)?;
            let choice = selection.map(str::to_owned);
            let skip_cli = restart_application
                || conn.registration_pending
                || !secrets.registration_device_code.is_empty();
            let chosen = tauri::async_runtime::spawn_blocking(move || {
                if skip_cli {
                    return Ok(None);
                }
                let selected = cli_config::selected(choice.as_deref())?;
                selected
                    .map(|app| {
                        let secret = cli_secret::resolve(&app)?;
                        Ok::<_, String>((
                            app.app_id.clone(),
                            if app.name.is_empty() {
                                app.app_id.clone()
                            } else {
                                app.name.clone()
                            },
                            secret,
                        ))
                    })
                    .transpose()
            });
            let existing = tokio::select! {_=cancel.cancelled()=>return Err(device_flow::CANCELLED.into()),result=tokio::time::timeout(Duration::from_secs(15),chosen)=>result.map_err(|_|"Timed out reading existing CLI credentials; allow OS credential access and retry")?.map_err(|_|"Cannot read existing CLI application")??};
            if let Some((id, label, secret)) = existing {
                conn.app_id = id.clone();
                conn.label = label;
                conn.origin = "cli_existing".into();
                secrets.app_id = id;
                secrets.app_secret = secret.to_string();
                credentials::put_connection(&profile, &conn.id, &secrets)?;
                bind(app, &target.id, &conn)?;
            } else {
                bind(app, &target.id, &conn)?;
                publish(app, session, "registering", None, None, None)?;
                let challenge =
                    if conn.registration_pending || !secrets.registration_device_code.is_empty() {
                        device_flow::Challenge::resume_registration(&secrets)?
                    } else {
                        let challenge = flow.begin_registration(cancel).await?;
                        // Save recovery material before opening the browser or polling.
                        challenge.save_registration(&mut secrets);
                        credentials::put_connection(&profile, &conn.id, &secrets)?;
                        challenge
                    };
                conn.registration_pending = true;
                bind(app, &target.id, &conn)?;
                publish(
                    app,
                    session,
                    "awaiting_registration",
                    Some(challenge.verification_url.clone()),
                    Some(challenge.user_code.clone()),
                    None,
                )?;
                let issued = match flow.registered(&challenge, cancel).await {
                    Ok(issued) => issued,
                    Err(error) => {
                        if error == "Feishu authorization was declined" {
                            conn.registration_pending = false;
                            clear_registration(&mut secrets);
                            credentials::put_connection(&profile, &conn.id, &secrets)?;
                            bind(app, &target.id, &conn)?;
                        }
                        return Err(error);
                    }
                };
                persist_registered(app, &target.id, &profile, &mut conn, &mut secrets, issued)?;
            }
        }
    }
    if conn.origin == "cli_existing" && !conn.app_id.is_empty() {
        // The app ID is stable across secret rotation; reread only that source.
        let id = conn.app_id.clone();
        let loaded = tauri::async_runtime::spawn_blocking(move || {
            if !cli_config::applications()?.iter().any(|a| a.app_id == id) {
                return Ok(None);
            }
            cli_config::selected(Some(&id))?
                .map(|a| cli_secret::resolve(&a))
                .transpose()
        });
        let latest = tokio::select! {
            _ = cancel.cancelled() => return Err(device_flow::CANCELLED.into()),
            result = tokio::time::timeout(Duration::from_secs(15), loaded) => result.map_err(|_| "Timed out reading existing CLI credentials")?.map_err(|_| "Cannot read existing CLI credentials")??,
        };
        if let Some(secret) = latest {
            if secrets.app_secret != secret.as_str() {
                secrets.app_secret = secret.to_string();
                secrets.authorization_required = true;
                credentials::put_connection(&profile, &conn.id, &secrets)?;
            }
        }
    }
    if secrets.app_secret.is_empty() {
        return Err("Saved Feishu application credentials are missing; unlock or repair the system credential store".into());
    }
    drop(initialization);
    if cancel.is_cancelled() {
        return Err(device_flow::CANCELLED.into());
    }
    if current != Some(conn.id.as_str())
        && !secrets.authorization_required
        && secrets.refresh_expires_at > now_ms()
        && !secrets.refresh_in_flight
        && !secrets.refresh_token.is_empty()
        && device_flow::missing_scopes(&secrets.granted_scopes).is_empty()
    {
        return commit_active(app, &session.id.clone(), cancel, || {
            bind(app, &target.id, &conn)?;
            publish(app, session, "connected", None, None, None)
        });
    }
    publish(app, session, "authorizing", None, None, None)?;
    let challenge = flow
        .begin_authorization(&conn.app_id, &secrets.app_secret, cancel)
        .await?;
    publish(
        app,
        session,
        "awaiting_authorization",
        Some(challenge.verification_url.clone()),
        Some(challenge.user_code.clone()),
        None,
    )?;
    let mut granted = flow
        .authorized(&conn.app_id, &secrets.app_secret, &challenge, cancel)
        .await?;
    publish(app, session, "verifying", None, None, None)?;
    let user = flow.identity(&granted.access_token, cancel).await?;
    commit_active(app, &session.id.clone(), cancel, || {
        let changed = !conn.account_id.is_empty()
            && (conn.account_id != user.open_id || conn.tenant_key != user.tenant_key);
        granted.app_id = conn.app_id.clone();
        granted.app_secret = secrets.app_secret.clone();
        granted.generation = secrets.generation + 1;
        if changed {
            control::update(app, |config| {
                for target in config
                    .targets
                    .iter_mut()
                    .filter(|t| t.connection_id.as_deref() == Some(&conn.id))
                {
                    target.root_token.clear();
                    target.writes_paused = true;
                }
                Ok(())
            })?;
        }
        credentials::put_connection(&profile, &conn.id, &granted)?;
        conn.account_id = user.open_id;
        conn.account_name = user.name;
        conn.tenant_key = user.tenant_key;
        bind(app, &target.id, &conn)?;
        publish(app, session, "connected", None, None, None)
    })
}
fn persist_registered(
    app: &tauri::AppHandle,
    target_id: &str,
    profile: &str,
    conn: &mut FeishuConnection,
    secrets: &mut ConnectionSecrets,
    issued: RegisteredApp,
) -> Result<(), String> {
    secrets.app_id = issued.id.clone();
    secrets.app_secret = issued.secret.to_string();
    clear_registration(secrets);
    conn.app_id = issued.id.clone();
    conn.label = issued.id.clone();
    conn.registration_pending = false;
    let result = credentials::put_connection(profile, &conn.id, secrets)
        .and_then(|_| bind(app, target_id, conn));
    if result.is_err() {
        app.state::<Authorizations>()
            .unsaved
            .lock()
            .map_err(|_| "Cannot retain pending Feishu application")?
            .insert(conn.id.clone(), issued);
        return Err("App registration completed, but local credential persistence failed. Unlock the system credential store and reconnect to save the issued app; do not create another".into());
    }
    Ok(())
}

fn clear_registration(secrets: &mut ConnectionSecrets) {
    secrets.registration_device_code.clear();
    secrets.registration_url.clear();
    secrets.registration_user_code.clear();
    secrets.registration_expires_at = 0;
    secrets.registration_interval = 0;
}
