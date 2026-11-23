use super::{lifetime::ArchiveStatus, owned, worker};
use crate::{
    mail::{MailAccountConfig, coordination, module_host, pop3_store, storage, with_mail_db_async},
    state::AppState,
};
use std::{path::Path, sync::atomic::Ordering};
use taomni_mail_api::{
    archive_scan::{ArchiveScanAction, ArchiveScanStatus},
    pop3_store::LocalArchiveAction,
};
use taomni_mail_engine::storage::scan;
use tauri::{AppHandle, Manager, State};

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
    let (paused, shared) = if pop3_store::is_hosted(&state, &account_id).await? {
        (
            owned::run(&state, &account_id, LocalArchiveAction::Paused).await?,
            false,
        )
    } else if module_host::owns_archive_scan(&state.plugins) {
        let status: ArchiveScanStatus = module_host::run_archive_scan(
            state.plugins.clone(),
            state.mail_db(&account_id)?,
            account_id.clone(),
            ArchiveScanAction::Status,
        )
        .await?;
        (status.paused, status.shared)
    } else {
        with_mail_db_async(&state, &account_id, |db, account| {
            let paused = scan::is_paused(db, account)?;
            let shared =
                coordination::ProcessLock::try_at(Path::new(db.path().unwrap()), "archive")
                    .map_err(storage::as_sql_error)?
                    .is_none();
            Ok((paused, shared))
        })
        .await?
    };
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
    if pop3_store::is_hosted(&state, &account_id).await? {
        return owned::run(&state, &account_id, LocalArchiveAction::Pause).await;
    }
    if module_host::owns_archive_scan(&state.plugins) {
        return module_host::run_archive_scan(
            state.plugins.clone(),
            state.mail_db(&account_id)?,
            account_id,
            ArchiveScanAction::Pause,
        )
        .await;
    }
    with_mail_db_async(&state, &account_id, scan::pause).await
}

#[tauri::command]
pub async fn mail_archive_start(
    config: MailAccountConfig,
    resume: Option<bool>,
    app: AppHandle,
) -> Result<(), String> {
    let state = app.state::<AppState>();
    if (crate::mail::pop3::is_pop3(&config)
        && pop3_store::prepare_fresh(&state, &config.session_id).await?)
        || pop3_store::is_hosted(&state, &config.session_id).await?
    {
        return owned::start(app, config.session_id, resume.unwrap_or(false));
    }
    tokio::task::spawn_blocking(move || worker::start(app, config, resume.unwrap_or(false)))
        .await
        .map_err(|error| error.to_string())?
}
