//! Backend-owned connection lifecycle. CLI is an optional read-only app source.
use super::{
    cli_config, cli_secret,
    device_flow::{self, FlowClient, RegisteredApp},
};
use crate::{
    backup::{
        control,
        credentials::{self, ConnectionSecrets},
        jobs::BackupJobs,
        model::*,
        network,
    },
    state::AppState,
};
use std::{
    collections::HashMap,
    fs::{File, OpenOptions, TryLockError},
    sync::Mutex,
    time::Duration,
};
use tauri::{Emitter, Manager};
use tokio_util::sync::CancellationToken;

#[derive(Default)]
pub struct Authorizations {
    active: Mutex<Option<(String, CancellationToken)>>,
    unsaved: Mutex<HashMap<String, RegisteredApp>>,
}
struct CredentialLock(File);
impl Drop for CredentialLock {
    fn drop(&mut self) {
        let _ = self.0.unlock();
    }
}
async fn lock(
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
fn session_path(app: &tauri::AppHandle, id: &str) -> Result<std::path::PathBuf, String> {
    validate_id(id)?;
    Ok(control::root(app)?
        .join("authorization")
        .join(format!("{id}.json")))
}
fn publish(
    app: &tauri::AppHandle,
    session: &mut AuthorizationSession,
    phase: &str,
    url: Option<String>,
    code: Option<String>,
    error: Option<String>,
) -> Result<(), String> {
    session.revision += 1;
    session.phase = phase.into();
    session.verification_url = url;
    session.user_code = code;
    session.error = error;
    control::write_json(&session_path(app, &session.id)?, session)?;
    let _ = app.emit("backup-authorization", &*session);
    Ok(())
}
pub fn sessions(app: &tauri::AppHandle) -> Result<Vec<AuthorizationSession>, String> {
    let dir = control::root(app)?.join("authorization");
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut sessions = vec![];
    for entry in std::fs::read_dir(dir).map_err(|_| "Cannot read Feishu authorization state")? {
        let path = entry
            .map_err(|_| "Cannot read Feishu authorization state")?
            .path();
        if path.extension().is_some_and(|e| e == "json") {
            let session: AuthorizationSession = serde_json::from_slice(
                &std::fs::read(path).map_err(|_| "Cannot read Feishu authorization state")?,
            )
            .map_err(|_| "Feishu authorization state is damaged")?;
            if let Some(url) = &session.verification_url {
                device_flow::validate_verification_url(url)?;
            }
            sessions.push(session);
        }
    }
    Ok(sessions)
}
pub fn terminal(phase: &str) -> bool {
    matches!(
        phase,
        "connected" | "failed" | "cancelled" | "expired" | "interrupted"
    )
}
pub fn connected(secrets: &ConnectionSecrets) -> bool {
    !secrets.refresh_in_flight
        && !secrets.refresh_token.is_empty()
        && secrets.refresh_expires_at > now_ms()
        && device_flow::missing_scopes(&secrets.granted_scopes).is_empty()
}
pub fn initialize(app: &tauri::AppHandle) {
    app.manage(Authorizations::default());
    match sessions(app) {
        Ok(values) => {
            for mut session in values.into_iter().filter(|s| !terminal(&s.phase)) {
                let _ = publish(
                    app,
                    &mut session,
                    "interrupted",
                    None,
                    None,
                    Some("Application stopped; reconnect to resume authorization".into()),
                );
            }
        }
        Err(error) => {
            tracing::error!(target:"backup",%error,"Cannot load Feishu authorization state")
        }
    }
}
pub fn cancel(app: &tauri::AppHandle, id: &str) -> Result<(), String> {
    let state = app.state::<Authorizations>();
    let active = state
        .active
        .lock()
        .map_err(|_| "Cannot access Feishu authorization")?;
    if let Some((session, token)) = &*active {
        if session == id {
            token.cancel();
        }
    }
    Ok(())
}
pub fn start(
    app: &tauri::AppHandle,
    target_id: &str,
    selection: Option<String>,
) -> Result<AuthorizationSession, String> {
    let target = control::target(app, target_id)?;
    let state = app.state::<Authorizations>();
    let mut active = state
        .active
        .lock()
        .map_err(|_| "Cannot access Feishu authorization")?;
    if let Some((id, _)) = &*active {
        let session = sessions(app)?
            .into_iter()
            .find(|s| &s.id == id)
            .ok_or("Authorization session not found")?;
        if session.target_id == target_id {
            return Ok(session);
        }
        return Err(
            "Another Feishu connection is being authorized; finish or cancel it first".into(),
        );
    }
    let cancel = CancellationToken::new();
    let mut session = AuthorizationSession {
        id: uuid::Uuid::new_v4().to_string(),
        target_id: target_id.into(),
        revision: 0,
        created_at: now_ms(),
        phase: String::new(),
        verification_url: None,
        user_code: None,
        error: None,
    };
    let jobs = app.state::<BackupJobs>();
    let _gate = jobs
        .gate
        .lock()
        .map_err(|_| "Cannot access backup task state")?;
    let mut running = jobs
        .running
        .lock()
        .map_err(|_| "Cannot access backup task state")?;
    if !running.is_empty() {
        return Err("Finish or cancel active backup tasks before connecting Feishu".into());
    }
    publish(app, &mut session, "discovering", None, None, None)?;
    let key = format!("auth:{}", session.id);
    running.insert(key.clone(), cancel.clone());
    *active = Some((session.id.clone(), cancel.clone()));
    let mut task_session = session.clone();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let result = connect(
            &app,
            &target,
            selection.as_deref(),
            &mut task_session,
            &cancel,
        )
        .await;
        if let Err(error) = result {
            let phase = if cancel.is_cancelled() {
                "cancelled"
            } else if error == device_flow::EXPIRED {
                "expired"
            } else {
                "failed"
            };
            if let Err(error) = publish(&app, &mut task_session, phase, None, None, Some(error)) {
                tracing::error!(target:"backup",%error,"Cannot persist Feishu authorization result");
            }
        }
        if let Ok(mut running) = app.state::<BackupJobs>().running.lock() {
            running.remove(&key);
        }
        if let Ok(mut active) = app.state::<Authorizations>().active.lock() {
            *active = None;
        }
    });
    Ok(session)
}
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

async fn connect(
    app: &tauri::AppHandle,
    target: &BackupTarget,
    selection: Option<&str>,
    session: &mut AuthorizationSession,
    cancel: &CancellationToken,
) -> Result<(), String> {
    let client = network::client(&app.state::<AppState>(), &target.proxy)?;
    let flow = FlowClient::new(client);
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
    let mut conn = if let Some(id) = saved {
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
            let chosen = tauri::async_runtime::spawn_blocking(move || {
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
                if conn.registration_pending {
                    return Err("A previous app registration may have completed. Recover the existing application's credentials before creating another; Taomni will not automatically register a duplicate".into());
                }
                bind(app, &target.id, &conn)?;
                publish(app, session, "registering", None, None, None)?;
                let challenge = flow.begin_registration(cancel).await?;
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
                            bind(app, &target.id, &conn)?;
                        }
                        return Err(error);
                    }
                };
                persist_registered(app, &target.id, &profile, &mut conn, &mut secrets, issued)?;
            }
        }
    } else if secrets.app_secret.is_empty() {
        return Err("Saved Feishu application credentials are missing; unlock or repair the system credential store".into());
    }
    drop(initialization);
    if cancel.is_cancelled() {
        return Err(device_flow::CANCELLED.into());
    }
    if current != Some(conn.id.as_str())
        && secrets.refresh_expires_at > now_ms()
        && !secrets.refresh_in_flight
        && !secrets.refresh_token.is_empty()
        && device_flow::missing_scopes(&secrets.granted_scopes).is_empty()
    {
        bind(app, &target.id, &conn)?;
        return publish(app, session, "connected", None, None, None);
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
    if cancel.is_cancelled() {
        return Err(device_flow::CANCELLED.into());
    }
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

pub async fn access_token(
    app: &tauri::AppHandle,
    target: &BackupTarget,
    client: &reqwest::Client,
    cancel: &CancellationToken,
) -> Result<String, String> {
    let id = target
        .connection_id
        .as_deref()
        .ok_or("Connect Feishu before using this backup target")?;
    let _lock = lock(app, id, cancel).await?;
    let config = control::load(app)?;
    let conn = connection(&config, id)?;
    let mut stored = credentials::get_connection(&config.device.id, id)?;
    if stored.refresh_in_flight {
        return Err("Previous Feishu token refresh was interrupted or uncertain; authorize again before backing up".into());
    }
    if !device_flow::missing_scopes(&stored.granted_scopes).is_empty() {
        return Err("Authorize all Feishu backup permissions before using this target".into());
    }
    if !stored.access_token.is_empty() && stored.expires_at > now_ms() + 120_000 {
        return Ok(stored.access_token.clone());
    }
    if stored.refresh_token.is_empty() || stored.refresh_expires_at <= now_ms() {
        return Err("Feishu authorization expired; connect the account again".into());
    }
    if cancel.is_cancelled() {
        return Err(device_flow::CANCELLED.into());
    }
    stored.refresh_in_flight = true;
    credentials::put_connection(&config.device.id, id, &stored)?;
    match FlowClient::new(client.clone())
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
                credentials::put_connection(&config.device.id, id, &stored)?;
                return Err(error);
            }
            Err(format!(
                "{error}. Token refresh did not complete reliably; authorize Feishu again"
            ))
        }
    }
}
