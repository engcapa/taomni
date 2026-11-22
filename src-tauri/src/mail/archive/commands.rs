use super::{lifetime::ArchiveStatus, worker};
use crate::{
    mail::{MailAccountConfig, coordination, storage, with_mail_db_async},
    state::AppState,
};
use std::{path::Path, sync::atomic::Ordering};
use taomni_mail_engine::storage::scan;
use tauri::{AppHandle, State};

#[tauri::command]
pub async fn mail_archive_status(
    account_id: String,
    state: State<'_, AppState>,
) -> Result<ArchiveStatus, String> {
    {
        let jobs = state
            .legacy
            .mail
            .mail_archive
            .jobs
            .lock()
            .map_err(|e| e.to_string())?;
        if let Some(job) = jobs
            .get(&account_id)
            .filter(|job| job.running.load(Ordering::Acquire))
        {
            return Ok(job
                .progress
                .status
                .lock()
                .map_err(|e| e.to_string())?
                .clone());
        }
    }
    let (paused, shared) = with_mail_db_async(&state, &account_id, |db, account| {
        let paused = scan::is_paused(db, account)?;
        let shared = coordination::ProcessLock::try_at(Path::new(db.path().unwrap()), "archive")
            .map_err(storage::as_sql_error)?
            .is_none();
        Ok((paused, shared))
    })
    .await?;
    if !shared {
        if let Some(job) = state
            .legacy
            .mail
            .mail_archive
            .jobs
            .lock()
            .map_err(|e| e.to_string())?
            .get(&account_id)
            .filter(|job| {
                job.progress
                    .status
                    .lock()
                    .is_ok_and(|status| status.phase != "shared")
            })
        {
            let mut status = job
                .progress
                .status
                .lock()
                .map_err(|e| e.to_string())?
                .clone();
            // Keep the current scan's folder and counters when a persisted
            // pause stops the worker, including after the mail tab reopens.
            if paused {
                status.phase = "paused".into();
            }
            return Ok(status);
        }
    }
    Ok(ArchiveStatus {
        phase: if paused {
            "paused"
        } else if shared {
            "shared"
        } else {
            "idle"
        }
        .into(),
        ..Default::default()
    })
}

#[tauri::command]
pub async fn mail_archive_pause(
    account_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.legacy.mail.mail_archive.pause_account(&account_id)?;
    with_mail_db_async(&state, &account_id, scan::pause).await
}

#[tauri::command]
pub async fn mail_archive_start(
    config: MailAccountConfig,
    resume: Option<bool>,
    app: AppHandle,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || worker::start(app, config, resume.unwrap_or(false)))
        .await
        .map_err(|error| error.to_string())?
}
