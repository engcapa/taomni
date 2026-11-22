//! Desktop ownership of background archive workers during the Mail transition.

use super::{lifetime::ArchiveJob, sync::run};
use crate::{
    mail::{
        MailAccountConfig, coordination, imap_catch_result, mail_db_task, pop3, resolve_config,
    },
    plugin::LifecycleState,
    state::{AppState, MailDbHandle},
};
use std::{
    path::Path,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use taomni_mail_engine::{
    archive::{
        progress::{ArchiveStatus, ScanProgress},
        writer::{ArchiveMailbox, LocalEncoder, OriginalEncoder},
    },
    storage::scan,
};
use tauri::{AppHandle, Manager};

pub(super) fn start(app: AppHandle, config: MailAccountConfig, resume: bool) -> Result<(), String> {
    let id = config.session_id.clone();
    let Some((job, handle)) = register(&app.state::<AppState>(), &id, resume)? else {
        return Ok(());
    };
    // A pause from another process closes this worker's socket as well. The
    // poll uses blocking DB work and ends with the job; no task is tied to a tab.
    let monitor_job = Arc::clone(&job);
    let monitor_id = id.clone();
    let monitor_db = Arc::clone(&handle);
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_millis(250)).await;
            if !monitor_job.running.load(Ordering::Acquire) {
                break;
            }
            let paused =
                mail_db_task(Arc::clone(&monitor_db), monitor_id.clone(), scan::is_paused).await;
            if matches!(paused, Ok(true)) {
                let _ = monitor_job.pause();
                break;
            }
        }
    });
    // Resolution and all disk/protocol work live off Tokio's I/O workers.
    let runtime = tokio::runtime::Handle::current();
    tokio::task::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let result = imap_catch_result(|| {
            job.progress.update(|_| {})?;
            let lease = {
                let db = handle.lock()?;
                let path = db.path().ok_or("Mail storage has no disk path")?;
                coordination::ProcessLock::try_at(Path::new(path), "archive")?
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
        let mut status = job.progress.status.lock();
        if let Ok(status) = &mut status {
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

fn register(
    state: &AppState,
    id: &str,
    resume: bool,
) -> Result<Option<(Arc<ArchiveJob>, MailDbHandle)>, String> {
    let archive = &state.legacy.mail.mail_archive;
    let _changes = archive
        .changes
        .try_lock()
        .map_err(|_| "Mail settings or backup snapshot is being saved; retry shortly")?;
    state
        .plugins
        .check_resource_admission()
        .map_err(|error| error.to_string())?;
    if state
        .plugins
        .get(taomni_mail_api::SLUG)
        .is_some_and(|record| record.state != LifecycleState::Enabled)
    {
        return Err("Enable Mail before starting full-message storage".into());
    }
    let mut jobs = archive.jobs.lock().map_err(|error| error.to_string())?;
    if let Some(job) = jobs.get(id) {
        if job.running.load(Ordering::Acquire) {
            return if resume && job.progress.pause.load(Ordering::Acquire) {
                Err("Storage is pausing; resume when it has stopped".into())
            } else {
                Ok(None)
            };
        }
        if !resume
            && job
                .progress
                .status
                .lock()
                .is_ok_and(|status| status.phase == "failed")
        {
            return Ok(None);
        }
    }

    let handle = state.mail_db(id)?;
    {
        let db = handle.lock()?;
        if scan::begin(&db, id, resume).map_err(|error| error.to_string())? {
            return Ok(None);
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
    jobs.insert(id.to_owned(), job.clone());
    Ok(Some((job, handle)))
}
