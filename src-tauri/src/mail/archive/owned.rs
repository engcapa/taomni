//! Keep the scan lifecycle in the application and each archive write in the Mail host.

use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};

use serde::de::DeserializeOwned;
use taomni_mail_api::{
    archive_index::ArchiveKey,
    pop3_store::{LocalArchiveAction, LocalMailboxAction},
};
use taomni_mail_storage::archive::progress::ScanProgress;
use tauri::{AppHandle, Manager};

use crate::{mail::pop3_store, state::AppState};

use super::lifetime::{ArchiveJob, ArchiveStatus};

pub(super) async fn run<T: DeserializeOwned + Send + 'static>(
    state: &AppState,
    account: &str,
    action: LocalArchiveAction,
) -> Result<T, String> {
    pop3_store::hosted(state, account, LocalMailboxAction::Archive(action)).await
}

pub(super) fn start(app: AppHandle, account: String, resume: bool) -> Result<(), String> {
    let job = {
        let state = app.state::<AppState>();
        let archive = &state.legacy.mail.mail_archive;
        let _changes = archive
            .changes
            .try_lock()
            .map_err(|_| "Mail settings or backup snapshot is being saved; retry shortly")?;
        state
            .plugins
            .check_resource_admission()
            .map_err(|error| error.to_string())?;
        let mut jobs = archive.jobs.lock().map_err(|error| error.to_string())?;
        if let Some(job) = jobs.get(&account) {
            if job.running.load(Ordering::Acquire) {
                return if resume && job.progress.pause.load(Ordering::Acquire) {
                    Err("Storage is pausing; resume when it has stopped".into())
                } else {
                    Ok(())
                };
            }
            if !resume
                && job
                    .progress
                    .status
                    .lock()
                    .is_ok_and(|status| status.phase == "failed")
            {
                return Ok(());
            }
        }
        let job = Arc::new(ArchiveJob {
            running: AtomicBool::new(true),
            socket: Mutex::new(None),
            progress: ScanProgress {
                status: Mutex::new(ArchiveStatus {
                    phase: "connecting".into(),
                    ..Default::default()
                }),
                ..Default::default()
            },
        });
        jobs.insert(account.clone(), job.clone());
        job
    };
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        let result = scan(&state, &account, &job, resume).await;
        if let Ok(mut status) = job.progress.status.lock() {
            if job.progress.pause.load(Ordering::Acquire) {
                status.phase = "paused".into();
            } else if let Err(error) = result {
                status.phase = "failed".into();
                status.error = Some(error);
            } else {
                status.phase = "completed".into();
            }
        }
        job.running.store(false, Ordering::Release);
    });
    Ok(())
}

async fn scan(
    state: &AppState,
    account: &str,
    job: &ArchiveJob,
    resume: bool,
) -> Result<(), String> {
    job.progress.update(|_| {})?;
    if run::<bool>(state, account, LocalArchiveAction::Begin { resume }).await? {
        job.progress.pause.store(true, Ordering::Release);
        return Ok(());
    }
    let targets: Vec<ArchiveKey> = run(state, account, LocalArchiveAction::Pending).await?;
    job.progress.update(|status| status.total = targets.len())?;
    for key in targets {
        job.progress.update(|status| {
            status.folder = Some(key.folder.clone());
            status.phase = "verifying".into();
        })?;
        if run::<bool>(state, account, LocalArchiveAction::Store { key }).await? {
            job.progress.update(|status| status.saved += 1)?;
        }
    }
    Ok(())
}
