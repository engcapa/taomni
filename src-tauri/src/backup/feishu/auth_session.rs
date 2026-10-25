//! Durable authorization journal, cancellation and conditional owner cleanup.
use super::device_flow::{self, RegisteredApp};
use crate::backup::{control, jobs::BackupJobs, model::*};
use std::{collections::HashMap, sync::Mutex};
use tauri::{Emitter, Manager};
use tokio_util::sync::CancellationToken;

#[derive(Default)]
pub struct Authorizations {
    pub(super) active: Mutex<Option<(String, CancellationToken)>>,
    pub(super) unsaved: Mutex<HashMap<String, RegisteredApp>>,
    journal: Mutex<()>,
}

pub(super) fn session_path(app: &tauri::AppHandle, id: &str) -> Result<std::path::PathBuf, String> {
    validate_id(id)?;
    Ok(control::root(app)?
        .join("authorization")
        .join(format!("{id}.json")))
}

pub fn terminal(phase: &str) -> bool {
    matches!(
        phase,
        "connected" | "failed" | "cancelled" | "expired" | "interrupted"
    )
}

pub(super) fn cleanup_complete(session: &AuthorizationSession) -> bool {
    session
        .cleanup_complete
        .unwrap_or_else(|| terminal(&session.phase))
}

fn read(app: &tauri::AppHandle, id: &str) -> Result<AuthorizationSession, String> {
    serde_json::from_slice(&std::fs::read(session_path(app, id)?).map_err(|e| e.to_string())?)
        .map_err(|_| "Feishu authorization state is damaged".into())
}

fn save(app: &tauri::AppHandle, session: &AuthorizationSession) -> Result<(), String> {
    control::write_json(&session_path(app, &session.id)?, session)?;
    let _ = app.emit("backup-authorization", session);
    Ok(())
}

/// Merge with the durable head: cancellation/tombstones can never be overwritten
/// by a late result from a request that was already in flight.
fn advance(
    current: &mut AuthorizationSession,
    old: Option<&AuthorizationSession>,
) -> Result<(), String> {
    if let Some(old) = old {
        if old.dismissed_at.is_some() {
            return Err("Authorization session was dismissed".into());
        }
        current.cancel_requested |= old.cancel_requested;
        if current.cancel_requested && !terminal(&current.phase) {
            return Err(device_flow::CANCELLED.into());
        }
        if current.cancel_requested && current.phase == "connected" {
            current.phase = "cancelled".into();
        }
        current.revision = current.revision.max(old.revision);
    }
    current.revision += 1;
    Ok(())
}

pub(super) fn publish(
    app: &tauri::AppHandle,
    session: &mut AuthorizationSession,
    phase: &str,
    url: Option<String>,
    code: Option<String>,
    error: Option<String>,
) -> Result<(), String> {
    let state = app.state::<Authorizations>();
    let _journal = state.journal.lock().map_err(|e| e.to_string())?;
    session.phase = phase.into();
    session.verification_url = url;
    session.user_code = code;
    session.error = error;
    let path = session_path(app, &session.id)?;
    let old = if path.exists() {
        Some(read(app, &session.id)?)
    } else {
        None
    };
    advance(session, old.as_ref())?;
    save(app, session)
}

pub fn sessions(app: &tauri::AppHandle) -> Result<Vec<AuthorizationSession>, String> {
    let dir = control::root(app)?.join("authorization");
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut values = vec![];
    for entry in std::fs::read_dir(dir).map_err(|_| "Cannot read Feishu authorization state")? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.extension().is_some_and(|e| e == "json") {
            let session: AuthorizationSession =
                serde_json::from_slice(&std::fs::read(path).map_err(|e| e.to_string())?)
                    .map_err(|_| "Feishu authorization state is damaged")?;
            if let Some(url) = &session.verification_url {
                device_flow::validate_verification_url(url)?;
            }
            values.push(session);
        }
    }
    Ok(values)
}

pub fn initialize(app: &tauri::AppHandle) {
    app.manage(Authorizations::default());
    let Ok(_owner) = crate::backup::jobs::claim(app) else {
        return;
    };
    match sessions(app) {
        Ok(values) => {
            for mut session in values.into_iter().filter(|s| !cleanup_complete(s)) {
                session.cleanup_complete = Some(true);
                let phase = if terminal(&session.phase) {
                    session.phase.clone()
                } else {
                    "interrupted".into()
                };
                let _ = publish(
                    app,
                    &mut session,
                    &phase,
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
    let _owner = crate::backup::jobs::claim(app)?;
    let state = app.state::<Authorizations>();
    let active = state.active.lock().map_err(|e| e.to_string())?;
    let _journal = state.journal.lock().map_err(|e| e.to_string())?;
    let mut session = read(app, id)?;
    if cleanup_complete(&session) || terminal(&session.phase) {
        return Ok(());
    }
    let Some((owner_id, token)) = &*active else {
        return Err(
            "Authorization is owned by another instance; close that instance and restart Taomni"
                .into(),
        );
    };
    if owner_id != id {
        return Err("Authorization owner changed; refresh and retry".into());
    }
    session.cancel_requested = true;
    session.verification_url = None;
    session.user_code = None;
    session.revision += 1;
    // Persist intent before notifying the worker. Completion is published by finish.
    save(app, &session)?;
    token.cancel();
    Ok(())
}

pub fn forget(app: &tauri::AppHandle, id: &str) -> Result<AuthorizationSession, String> {
    let _owner = crate::backup::jobs::claim(app)?;
    let state = app.state::<Authorizations>();
    let active = state.active.lock().map_err(|e| e.to_string())?;
    let _journal = state.journal.lock().map_err(|e| e.to_string())?;
    let mut session = read(app, id)?;
    if active.as_ref().is_some_and(|(owner, _)| owner == id)
        || !terminal(&session.phase)
        || !cleanup_complete(&session)
    {
        return Err(
            "Finish cancelling this authorization before dismissing its local status".into(),
        );
    }
    session.dismissed_at = Some(now_ms());
    session.verification_url = None;
    session.user_code = None;
    session.error = None;
    session.revision += 1;
    save(app, &session)?;
    Ok(session)
}

pub(super) fn commit_active<T>(
    app: &tauri::AppHandle,
    id: &str,
    cancel: &CancellationToken,
    commit: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let state = app.state::<Authorizations>();
    let active = state.active.lock().map_err(|e| e.to_string())?;
    if cancel.is_cancelled() || !active.as_ref().is_some_and(|(owner, _)| owner == id) {
        return Err(device_flow::CANCELLED.into());
    }
    commit()
}

fn release_owner(active: &mut Option<(String, CancellationToken)>, id: &str) {
    if active.as_ref().is_some_and(|(owner, _)| owner == id) {
        *active = None;
    }
}

pub(super) fn finish(
    app: &tauri::AppHandle,
    session: &mut AuthorizationSession,
    key: &str,
) -> Result<(), String> {
    let state = app.state::<Authorizations>();
    let mut active = state.active.lock().map_err(|e| e.to_string())?;
    let jobs = app.state::<BackupJobs>();
    let _gate = jobs.gate.lock().map_err(|e| e.to_string())?;
    jobs.running.lock().map_err(|e| e.to_string())?.remove(key);
    release_owner(&mut active, &session.id);
    session.cleanup_complete = Some(true);
    let phase = session.phase.clone();
    publish(app, session, &phase, None, None, session.error.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn session() -> AuthorizationSession {
        serde_json::from_value(serde_json::json!({"id":"s", "targetId":"a", "revision":1,
            "createdAt":1,"phase":"awaiting_authorization","verificationUrl":null,"userCode":null,"error":null,
            "cleanupComplete":false,"cancelRequested":false})).unwrap()
    }
    #[test]
    fn cancellation_is_monotonic_until_cleanup() {
        let mut old = session();
        old.revision = 8;
        old.cancel_requested = true;
        let mut late = session();
        assert!(advance(&mut late, Some(&old)).is_err());
        late.phase = "connected".into();
        advance(&mut late, Some(&old)).unwrap();
        assert_eq!(late.phase, "cancelled");
        assert_eq!(late.revision, 9);
        assert!(!cleanup_complete(&late));
        late.cleanup_complete = Some(true);
        assert!(cleanup_complete(&late));
    }
    #[test]
    fn tombstone_rejects_late_results_and_old_cleanup_cannot_clear_new_owner() {
        let mut old = session();
        old.dismissed_at = Some(4);
        assert!(advance(&mut session(), Some(&old)).is_err());
        let mut owner = Some(("new".into(), CancellationToken::new()));
        release_owner(&mut owner, "old");
        assert_eq!(owner.as_ref().unwrap().0, "new");
        release_owner(&mut owner, "new");
        assert!(owner.is_none());
    }
}
