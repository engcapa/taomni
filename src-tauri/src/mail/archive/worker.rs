//! Desktop ownership of background archive workers during the Mail transition.

use super::{lifetime::ArchiveJob, sync::run};
use crate::{
    mail::{
        MailAccountConfig, coordination, imap_catch_result, mail_db_task, module_host, pop3,
        resolve_config,
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
use taomni_mail_api::archive_scan::{ArchiveScanAction, ArchiveScanStatus};
#[cfg(any(test, feature = "legacy-mail-imap"))]
use taomni_mail_storage::archive::writer::LocalEncoder;
use taomni_mail_storage::{
    archive::{
        progress::{ArchiveStatus, ScanProgress},
        scan_store::ArchiveScanStore,
        writer::{ArchiveMailbox, OriginalEncoder},
    },
    storage::scan,
};
use tauri::{AppHandle, Manager};

pub(super) fn start(app: AppHandle, config: MailAccountConfig, resume: bool) -> Result<(), String> {
    let id = config.session_id.clone();
    let state = app.state::<AppState>();
    let hosted = !pop3::is_pop3(&config) && module_host::owns_archive_scan(&state.plugins);
    let runtime = tokio::runtime::Handle::current();
    let Some((job, handle)) = register(&state, &id, resume, hosted, &runtime)? else {
        return Ok(());
    };
    let registry = state.plugins.clone();
    // A pause from another process closes this worker's socket as well. The
    // poll uses blocking DB work and ends with the job; no task is tied to a tab.
    let monitor_job = Arc::clone(&job);
    let monitor_id = id.clone();
    let monitor_db = Arc::clone(&handle);
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_millis(250)).await;
            if !monitor_job.running.load(Ordering::Acquire)
                || monitor_job.progress.pause.load(Ordering::Acquire)
            {
                break;
            }
            let paused = if hosted {
                module_host::run_archive_scan::<ArchiveScanStatus>(
                    registry.clone(),
                    monitor_db.clone(),
                    monitor_id.clone(),
                    ArchiveScanAction::Status,
                )
                .await
                .map(|status| status.paused)
            } else {
                mail_db_task(Arc::clone(&monitor_db), monitor_id.clone(), scan::is_paused).await
            };
            if matches!(paused, Ok(true)) {
                let _ = monitor_job.pause();
                break;
            }
        }
    });
    // Resolution and all disk/protocol work live off Tokio's I/O workers.
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
                None => {
                    #[cfg(any(test, feature = "legacy-mail-imap"))]
                    {
                        &LocalEncoder
                    }
                    #[cfg(not(any(test, feature = "legacy-mail-imap")))]
                    return Err(crate::mail::SIGNED_MAIL_ARCHIVE_REQUIRED.to_string());
                }
            };
            let hosted_scan = module_host::HostedArchiveScan {
                registry: &state.plugins,
                cache: &handle,
                runtime: &runtime,
                progress: &job.progress,
            };
            let scan_store: &dyn ArchiveScanStore = if hosted {
                &hosted_scan
            } else {
                handle.as_ref()
            };
            let mailbox = ArchiveMailbox {
                account: &id,
                database: &handle,
                progress: &job.progress,
                encoder,
                scan_store,
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
            if job.progress.pause.load(Ordering::Acquire)
                || result
                    .as_ref()
                    .is_err_and(|error| error.contains(scan::PAUSED))
            {
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
    hosted: bool,
    runtime: &tokio::runtime::Handle,
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
    let jobs = archive.jobs.lock().map_err(|error| error.to_string())?;
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

    // The changes guard serializes new workers while the host persists the
    // start. Status and stop requests can still inspect the current job map.
    drop(jobs);
    let handle = state.mail_db(id)?;
    let paused = if hosted {
        runtime.block_on(module_host::run_archive_scan(
            state.plugins.clone(),
            handle.clone(),
            id.to_owned(),
            ArchiveScanAction::Begin { resume },
        ))?
    } else {
        let db = handle.lock()?;
        scan::begin(&db, id, resume).map_err(|error| error.to_string())?
    };
    if paused {
        return Ok(None);
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
    archive
        .jobs
        .lock()
        .map_err(|error| error.to_string())?
        .insert(id.to_owned(), job.clone());
    Ok(Some((job, handle)))
}
