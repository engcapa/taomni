//! Owns the authorization task until polling and local cleanup have finished.
use super::{auth_connect::connect, auth_session::*, device_flow};
use crate::backup::{control, jobs::BackupJobs, model::*};
use tauri::Manager;
use tokio_util::sync::CancellationToken;
pub fn start(
    app: &tauri::AppHandle,
    target_id: &str,
    selection: Option<String>,
    restart_application: bool,
) -> Result<AuthorizationSession, String> {
    let owner = crate::backup::jobs::claim(app)?;
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
        cleanup_complete: Some(false),
        cancel_requested: false,
        dismissed_at: None,
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
    // Old terminal authorization snapshots carry no resumable secret material.
    // Keep recent feedback without allowing the session directory to grow forever.
    let mut history = sessions(app)?;
    history.sort_by_key(|s| std::cmp::Reverse(s.created_at));
    for old in history.into_iter().skip(50).filter(|s| terminal(&s.phase)) {
        let _ = std::fs::remove_file(session_path(app, &old.id)?);
    }
    let key = format!("auth:{}", session.id);
    running.insert(key.clone(), cancel.clone());
    *active = Some((session.id.clone(), cancel.clone()));
    let mut task_session = session.clone();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let _owner = owner;
        let result = connect(
            &app,
            &target,
            selection.as_deref(),
            restart_application,
            &mut task_session,
            &cancel,
        )
        .await;
        if let Err(error) = result {
            let phase = if cancel.is_cancelled() {
                "cancelled"
            } else if error.contains(device_flow::EXPIRED) {
                "expired"
            } else {
                "failed"
            };
            if let Err(error) = publish(
                &app,
                &mut task_session,
                phase,
                None,
                None,
                if cancel.is_cancelled() {
                    None
                } else {
                    Some(error)
                },
            ) {
                tracing::error!(target:"backup",%error,"Cannot persist Feishu authorization result");
            }
        }
        if let Err(error) = finish(&app, &mut task_session, &key) {
            tracing::error!(target:"backup",%error,"Cannot finish Feishu authorization cleanup");
        }
    });
    Ok(session)
}
