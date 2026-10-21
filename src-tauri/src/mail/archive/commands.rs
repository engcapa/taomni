use super::lifetime::ArchiveJob;
use super::lifetime::ArchiveStatus;
use super::sync::run;
use super::sync::run_local;
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
            .mail
            .mail_archive
            .jobs
            .lock()
            .map_err(|e| e.to_string())?;
        if let Some(job) = jobs
            .get(&account_id)
            .filter(|job| job.running.load(Ordering::Acquire))
        {
            return Ok(job.status.lock().map_err(|e| e.to_string())?.clone());
        }
    }
    let (paused, shared) = with_mail_db_async(&state, &account_id, |db, account| {
        let paused = db.query_row(
            "SELECT COALESCE((SELECT paused FROM mail_archive_preferences WHERE account_id=?1),0)",
            [account],
            |row| row.get::<_, bool>(0),
        )?;
        let shared = coordination::ProcessLock::try_at(Path::new(db.path().unwrap()), "archive")
            .map_err(storage::as_sql_error)?
            .is_none();
        Ok((paused, shared))
    })
    .await?;
    if !shared {
        if let Some(job) = state
            .mail
            .mail_archive
            .jobs
            .lock()
            .map_err(|e| e.to_string())?
            .get(&account_id)
            .filter(|job| {
                job.status
                    .lock()
                    .is_ok_and(|status| status.phase != "shared")
            })
        {
            let mut status = job.status.lock().map_err(|e| e.to_string())?.clone();
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
    state.mail.mail_archive.pause_account(&account_id)?;
    with_mail_db_async(&state, &account_id, |db, account| {
        db.execute(
            "INSERT INTO mail_archive_preferences(account_id,paused) VALUES(?1,1)
            ON CONFLICT(account_id) DO UPDATE SET paused=1",
            [account],
        )?;
        Ok(())
    })
    .await
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
        db.execute(
            "INSERT OR IGNORE INTO mail_archive_preferences(account_id,paused) VALUES(?1,0)",
            [account],
        )?;
        if resume {
            db.execute(
                "UPDATE mail_archive_preferences SET paused=0 WHERE account_id=?1",
                [account],
            )?;
        }
        db.query_row(
            "SELECT COALESCE((SELECT paused FROM mail_archive_preferences WHERE account_id=?1),0)",
            [account],
            |row| row.get::<_, bool>(0),
        )
    })
    .await?;
    if paused {
        return Ok(());
    }
    let job =
        {
            let _changes =
                state.mail.mail_archive.changes.try_lock().map_err(
                    |_| "Mail settings or backup snapshot is being saved; retry shortly",
                )?;
            let mut jobs = state
                .mail
                .mail_archive
                .jobs
                .lock()
                .map_err(|e| e.to_string())?;
            if let Some(job) = jobs
                .get(&id)
                .filter(|job| job.running.load(Ordering::Acquire))
            {
                return if resume && job.pause.load(Ordering::Acquire) {
                    Err("Storage is pausing; resume when it has stopped".into())
                } else {
                    Ok(())
                };
            }
            if !resume
                && jobs.get(&id).is_some_and(|job| {
                    job.status
                        .lock()
                        .is_ok_and(|status| status.phase == "failed")
                })
            {
                return Ok(());
            }
            let job = Arc::new(ArchiveJob {
                pause: AtomicBool::new(false),
                running: AtomicBool::new(true),
                socket: Mutex::new(None),
                status: Mutex::new(ArchiveStatus {
                    phase: "connecting".into(),
                    ..Default::default()
                }),
            });
            jobs.insert(id.clone(), Arc::clone(&job));
            job
        };
    // A pause from another process closes this worker's socket as well. The
    // poll uses blocking DB work and ends with the job; no task is tied to a tab.
    let monitor_job = Arc::clone(&job);
    let monitor_db = state.mail_db(&id)?;
    let monitor_id = id.clone();
    tokio::spawn(async move {
        while monitor_job.running.load(Ordering::Acquire) {
            tokio::time::sleep(Duration::from_millis(250)).await;
            let paused = mail_db_task(Arc::clone(&monitor_db), monitor_id.clone(), |db, account| {
                db.query_row("SELECT COALESCE((SELECT paused FROM mail_archive_preferences WHERE account_id=?1),0)", [account], |row| row.get::<_, bool>(0))
            }).await;
            if matches!(paused, Ok(true)) {
                monitor_job.pause.store(true, Ordering::Release);
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
                job.status.lock().map_err(|e| e.to_string())?.phase = "shared".into();
                return Ok(());
            };
            let mut config = config;
            // Open tabs may still hold pre-edit settings. Persisted storage policy
            // is authoritative on every scan, including after relocation.
            let session = {
                let db = state.db.lock().map_err(|e| e.to_string())?;
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
            if pop3::is_pop3(&config) {
                run_local(&state, &id, &job)
            } else {
                resolve_config(&state, config)
                    .and_then(|account| run(&state, &account, &runtime, &job))
            }
        });
        if let Ok(mut socket) = job.socket.lock() {
            *socket = None;
        }
        if let Ok(mut status) = job.status.lock() {
            if job.pause.load(Ordering::Acquire) {
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
