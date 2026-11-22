use super::lifetime::ArchiveJob;
use super::lifetime::ArchiveStatus;
use super::sync::run;
use crate::mail::MailAccountConfig;
use crate::mail::coordination;
use crate::mail::pop3;
use crate::mail::storage;
use crate::mail::{imap_catch_result, mail_db_task, resolve_config, with_mail_db_async};
use crate::state::AppState;
use std::net::Shutdown;
use std::path::Path;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::time::Duration;
use taomni_mail_engine::archive::{
    progress::ScanProgress,
    writer::{ArchiveMailbox, LocalEncoder, OriginalEncoder},
};
use taomni_mail_engine::storage::scan;
use tauri::AppHandle;
use tauri::Manager;
use tauri::State;

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
    state: State<'_, AppState>,
) -> Result<(), String> {
    let id = config.session_id.clone();
    let resume = resume.unwrap_or(false);
    let paused = with_mail_db_async(&state, &id, move |db, account| {
        scan::begin(db, account, resume)
    })
    .await?;
    if paused {
        return Ok(());
    }
    let monitor_db = state.mail_db(&id)?;
    let job =
        {
            let _changes =
                state.legacy.mail.mail_archive.changes.try_lock().map_err(
                    |_| "Mail settings or backup snapshot is being saved; retry shortly",
                )?;
            let mut jobs = state
                .legacy
                .mail
                .mail_archive
                .jobs
                .lock()
                .map_err(|e| e.to_string())?;
            if let Some(job) = jobs
                .get(&id)
                .filter(|job| job.running.load(Ordering::Acquire))
            {
                return if resume && job.progress.pause.load(Ordering::Acquire) {
                    Err("Storage is pausing; resume when it has stopped".into())
                } else {
                    Ok(())
                };
            }
            if !resume
                && jobs.get(&id).is_some_and(|job| {
                    job.progress
                        .status
                        .lock()
                        .is_ok_and(|status| status.phase == "failed")
                })
            {
                return Ok(());
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
            jobs.insert(id.clone(), Arc::clone(&job));
            job
        };
    // A pause from another process closes this worker's socket as well. The
    // poll uses blocking DB work and ends with the job; no task is tied to a tab.
    let monitor_job = Arc::clone(&job);
    let monitor_id = id.clone();
    tokio::spawn(async move {
        while monitor_job.running.load(Ordering::Acquire) {
            tokio::time::sleep(Duration::from_millis(250)).await;
            let paused =
                mail_db_task(Arc::clone(&monitor_db), monitor_id.clone(), scan::is_paused).await;
            if matches!(paused, Ok(true)) {
                monitor_job.progress.pause.store(true, Ordering::Release);
                if let Ok(socket) = monitor_job.socket.lock() {
                    if let Some(socket) = socket.as_ref() {
                        let _ = socket.shutdown(Shutdown::Both);
                    }
                }
                break;
            }
        }
    });
    // Resolution and all disk/protocol work live off Tokio's I/O workers.
    let runtime = tokio::runtime::Handle::current();
    tokio::task::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let result = imap_catch_result(|| {
            let handle = state.mail_db(&id)?;
            let lease = {
                let db = handle.lock()?;
                coordination::ProcessLock::try_at(Path::new(db.path().unwrap()), "archive")?
            };
            let Some(_lease) = lease else {
                job.progress.status.lock().map_err(|e| e.to_string())?.phase = "shared".into();
                return Ok(());
            };
            let mut config = config;
            // Open tabs may still hold pre-edit settings. Persisted storage policy
            // is authoritative on every scan, including after relocation.
            let session = {
                let db = state.core.db.lock().map_err(|e| e.to_string())?;
                crate::session::db::get_session(&db, &id).ok()
            };
            if let Some(session) = session {
                let options: serde_json::Value =
                    serde_json::from_str(&session.options_json).map_err(|e| e.to_string())?;
                config.cache.full_message_mode = serde_json::from_value(
                    options
                        .get("mailFullMessageMode")
                        .cloned()
                        .unwrap_or(serde_json::json!("all")),
                )
                .map_err(|e| e.to_string())?;
                config.cache.full_message_folders = serde_json::from_value(
                    options
                        .get("mailFullMessageFolders")
                        .cloned()
                        .unwrap_or(serde_json::json!([])),
                )
                .map_err(|e| e.to_string())?;
            }
            let encoder =
                crate::mail::module_host::ArchiveEncoder::for_registry(&runtime, &state.plugins);
            let encoder: &dyn OriginalEncoder = match &encoder {
                Some(host) => host,
                None => &LocalEncoder,
            };
            let mailbox = ArchiveMailbox {
                account: &id,
                database: &handle,
                progress: &job.progress,
                encoder,
            };
            if pop3::is_pop3(&config) {
                mailbox.run_local()
            } else {
                resolve_config(&state, config)
                    .and_then(|account| run(&state, &account, &runtime, &job, &mailbox))
            }
        });
        if let Ok(mut socket) = job.socket.lock() {
            *socket = None;
        }
        if let Ok(mut status) = job.progress.status.lock() {
            if job.progress.pause.load(Ordering::Acquire) {
                status.phase = "paused".into();
            } else if let Err(error) = result {
                status.phase = "failed".into();
                status.error = Some(error);
            } else if status.phase != "shared" {
                status.phase = "completed".into();
            }
        }
        job.running.store(false, Ordering::Release);
    });
    Ok(())
}
