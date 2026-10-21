//! Account-owned, resumable full-MIME storage. The renderer only starts or pauses it.
use super::*;
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::Seek;
use std::net::Shutdown;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Manager;

const CHUNK: usize = 256 * 1024;
const ARCHIVE_BATCH: usize = 100;
const CONTENT_ERROR: &str = "MAIL_ARCHIVE_CONTENT: ";

#[derive(Default)]
struct ContentFailures {
    count: usize,
    first: Option<String>,
}

impl ContentFailures {
    fn message(&self) -> String {
        format!(
            "{} email(s) could not be saved; other readable messages were processed. First failure: {}. Retry to retry incomplete originals",
            self.count,
            self.first.as_deref().unwrap_or("unknown")
        )
    }
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveStatus {
    pub phase: String,
    pub folder: Option<String>,
    pub saved: usize,
    pub headers_synced: usize,
    pub headers_total: Option<u32>,
    pub total: usize,
    pub bytes: u64,
    pub total_bytes: Option<u64>,
    pub error: Option<String>,
}

#[derive(Default)]
pub struct ArchiveManager {
    jobs: Mutex<HashMap<String, Arc<ArchiveJob>>>,
    pub(crate) changes: Mutex<()>,
}
struct ArchiveJob {
    pause: AtomicBool,
    running: AtomicBool,
    status: Mutex<ArchiveStatus>,
    socket: Mutex<Option<TcpStream>>,
}

impl ArchiveManager {
    /// Called only on blocking workers, never while holding an account DB lock.
    pub fn stop_account(&self, account: &str) -> Result<(), String> {
        self.pause_account(account)?;
        let job = self
            .jobs
            .lock()
            .map_err(|e| e.to_string())?
            .get(account)
            .cloned();
        let started = Instant::now();
        while job
            .as_ref()
            .is_some_and(|job| job.running.load(Ordering::Acquire))
        {
            if started.elapsed() > Duration::from_secs(30) {
                return Err("Full-message storage is still stopping; retry shortly".into());
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        Ok(())
    }

    pub fn pause_account(&self, account: &str) -> Result<(), String> {
        if let Some(job) = self.jobs.lock().map_err(|e| e.to_string())?.get(account) {
            job.pause.store(true, Ordering::Release);
            if let Some(socket) = job.socket.lock().map_err(|e| e.to_string())?.as_ref() {
                let _ = socket.shutdown(Shutdown::Both);
            }
            job.status.lock().map_err(|e| e.to_string())?.phase =
                if job.running.load(Ordering::Acquire) {
                    "pausing"
                } else {
                    "paused"
                }
                .into();
        }
        Ok(())
    }
}

#[tauri::command]
pub async fn mail_archive_status(
    account_id: String,
    state: State<'_, AppState>,
) -> Result<ArchiveStatus, String> {
    {
        let jobs = state.mail.mail_archive.jobs.lock().map_err(|e| e.to_string())?;
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
            .mail.mail_archive
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
    let job = {
        let _changes = state
            .mail.mail_archive
            .changes
            .try_lock()
            .map_err(|_| "Mail settings or backup snapshot is being saved; retry shortly")?;
        let mut jobs = state.mail.mail_archive.jobs.lock().map_err(|e| e.to_string())?;
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

fn update(job: &ArchiveJob, f: impl FnOnce(&mut ArchiveStatus)) -> Result<(), String> {
    if job.pause.load(Ordering::Acquire) {
        return Err("Full-message storage paused".into());
    }
    let mut status = job.status.lock().map_err(|e| e.to_string())?;
    f(&mut status);
    Ok(())
}

fn check_publication(
    db: &Connection,
    account: &str,
    folder: &str,
    uid: u32,
    validity: u32,
    job: &ArchiveJob,
) -> Result<(), String> {
    let paused: bool = db
        .query_row(
            "SELECT COALESCE((SELECT paused FROM mail_archive_preferences WHERE account_id=?1),0)",
            [account],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    if paused {
        job.pause.store(true, Ordering::Release);
    }
    let skipped: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM mail_archive_skipped WHERE account_id=?1 AND folder=?2 AND uid=?3 AND uid_validity=?4)", params![account,folder,uid,validity], |row| row.get(0)).map_err(|e| e.to_string())?;
    if skipped {
        return Err("This local original was cleaned up in another instance; scan again to continue with other messages".into());
    }
    update(job, |_| {})
}

fn run_local(state: &AppState, id: &str, job: &ArchiveJob) -> Result<(), String> {
    let handle = state.mail_db(id)?;
    let targets: Vec<(String, u32)> = {
        let db = handle.lock().map_err(|e| e.to_string())?;
        db.prepare("SELECT r.folder,r.uid FROM mail_local_raw r WHERE r.account_id=?1 AND NOT EXISTS(SELECT 1 FROM mail_full_messages a WHERE a.account_id=r.account_id AND a.folder=r.folder AND a.uid=r.uid AND a.uid_validity=1) AND NOT EXISTS(SELECT 1 FROM mail_archive_skipped s WHERE s.account_id=r.account_id AND s.folder=r.folder AND s.uid=r.uid AND s.uid_validity=1)").map_err(|e|e.to_string())?.query_map([id],|row|Ok((row.get(0)?,row.get(1)?))).map_err(|e|e.to_string())?.collect::<SqlResult<_>>().map_err(|e|e.to_string())?
    };
    update(job, |status| status.total = targets.len())?;
    for (folder, uid) in targets {
        update(job, |status| {
            status.folder = Some(folder.clone());
            status.phase = "verifying".into();
        })?;
        let (root, raw) = {
            let db = handle.lock().map_err(|e| e.to_string())?;
            (
                storage::account_root(&db, id)?,
                pop3::local_raw(&db, id, &folder, uid).map_err(|e| e.to_string())?,
            )
        };
        let Some(raw) = raw else { continue };
        let prepared = storage::prepare(&root, raw.as_slice(), || update(job, |_| {}))?;
        let db = handle.lock().map_err(|e| e.to_string())?;
        check_publication(&db, id, &folder, uid, 1, job)?;
        storage::publish(&db, id, &folder, uid, 1, prepared)?;
        update(job, |status| status.saved += 1)?;
    }
    Ok(())
}

fn run(
    state: &AppState,
    account: &ResolvedMailAccount,
    runtime: &tokio::runtime::Handle,
    job: &ArchiveJob,
) -> Result<(), String> {
    let id = &account.config.session_id;
    let handle = state.mail_db(id)?;
    // A cancellable connection owned by this job cannot stall interactive or
    // header/body-prefetch lanes, and is dropped when the job stops.
    let (mut imap, socket) = connect_imap_with_socket(account, runtime)?;
    *job.socket.lock().map_err(|e| e.to_string())? = socket;
    update(job, |_| {})?;
    let folders = imap.list_folders(id)?;
    let condstore = imap.has_capability("CONDSTORE");
    let mut failures = ContentFailures::default();
    for folder in folders
        .into_iter()
        .filter(|folder| !folder_is_noselect(folder))
    {
        run_folder(
            &mut imap,
            account,
            &handle,
            &folder.name,
            condstore,
            job,
            &mut failures,
        )?;
    }
    if failures.count == 0 {
        Ok(())
    } else {
        Err(failures.message())
    }
}

/// Alternate bounded header and MIME batches so a large history cannot delay
/// the first readable original. Failed content is attempted once per scan.
#[allow(clippy::too_many_arguments)]
fn run_folder(
    imap: &mut ActiveImapSession,
    account: &ResolvedMailAccount,
    handle: &crate::state::MailDbHandle,
    folder: &str,
    condstore: bool,
    job: &ArchiveJob,
    failures: &mut ContentFailures,
) -> Result<(), String> {
    let id = &account.config.session_id;
    let stores_full = storage::stores_full(&account.config.cache, folder);
    let mut request = MailSyncRequestMode::Auto;
    let mut headers_complete = false;
    let mut discovered = HashSet::new();
    let mut attempted = HashSet::new();
    update(job, |status| {
        status.folder = Some(folder.into());
        status.headers_synced = 0;
        status.headers_total = None;
        status.bytes = 0;
        status.total_bytes = None;
    })?;
    loop {
        update(job, |_| {})?;
        if !headers_complete {
            let snapshot = {
                let db = handle.lock().map_err(|e| e.to_string())?;
                sync::load_folder_sync_state(&db, id, folder).map_err(|e| e.to_string())?
            };
            update(job, |status| {
                status.phase = "headers".into();
                status.headers_synced = snapshot.cached_uids.len();
                status.bytes = 0;
                status.total_bytes = None;
            })?;
            let started = sync::now_ms();
            let step = imap.sync_folder_step(
                account,
                folder,
                &snapshot,
                &StepParams {
                    request,
                    limit: ARCHIVE_BATCH,
                    include_bodies: false,
                    condstore,
                },
            )?;
            headers_complete = !step.more && step.watermark.complete;
            if !step.more && !step.watermark.complete {
                request = MailSyncRequestMode::Backfill;
            }
            let synced = {
                let db = handle.lock().map_err(|e| e.to_string())?;
                // The archive's index is complete regardless of recent-body cache limits.
                let settings = MailCacheSettings {
                    header_limit_per_folder: 0,
                    header_retention_days: 0,
                    ..account.config.cache.clone()
                };
                sync::apply_folder_step(&db, id, &step, &settings, started)
                    .map_err(|e| e.to_string())?;
                db.query_row(
                    "SELECT COUNT(*) FROM mail_messages WHERE account_id=?1 AND folder=?2",
                    params![id, folder],
                    |row| row.get::<_, u32>(0),
                )
                .map_err(|e| e.to_string())?
            };
            update(job, |status| {
                status.headers_synced = synced as usize;
                status.headers_total = step.folder.total;
            })?;
        }
        if !stores_full {
            if headers_complete {
                break;
            }
            continue;
        }
        let (validity, targets) = {
            let db = handle.lock().map_err(|e| e.to_string())?;
            let validity:u32=db.query_row("SELECT COALESCE(uid_validity,0) FROM mail_folders WHERE account_id=?1 AND name=?2",params![id,folder],|row|row.get(0)).map_err(|e|e.to_string())?;
            let targets:Vec<u32>=db.prepare("SELECT m.uid FROM mail_messages m WHERE m.account_id=?1 AND m.folder=?2 AND NOT EXISTS
                (SELECT 1 FROM mail_full_messages a WHERE a.account_id=m.account_id AND a.folder=m.folder AND a.uid=m.uid AND a.uid_validity=?3)
                AND NOT EXISTS(SELECT 1 FROM mail_archive_skipped s WHERE s.account_id=m.account_id AND s.folder=m.folder AND s.uid=m.uid AND s.uid_validity=?3)
                ORDER BY m.uid DESC").map_err(|e|e.to_string())?.query_map(params![id,folder,validity],|row|row.get(0)).map_err(|e|e.to_string())?.collect::<SqlResult<_>>().map_err(|e|e.to_string())?;
            (validity, targets)
        };
        let newly_discovered = targets
            .iter()
            .filter(|uid| discovered.insert((validity, **uid)))
            .count();
        update(job, |status| status.total += newly_discovered)?;
        let batch: Vec<u32> = targets
            .into_iter()
            .filter(|uid| !attempted.contains(&(validity, *uid)))
            .take(ARCHIVE_BATCH)
            .collect();
        if batch.is_empty() && headers_complete {
            break;
        }
        attempted.extend(batch.iter().map(|uid| (validity, *uid)));
        download_targets(
            imap, account, handle, folder, validity, batch, job, failures,
        )?;
    }
    Ok(())
}

// Content errors belong to a specific message, not the connection. The command
// response has already been consumed, so the same session can process later UIDs.
// Network/disk/identity failures still stop immediately and preserve safe partials.
#[allow(clippy::too_many_arguments)]
fn download_targets(
    imap: &mut ActiveImapSession,
    account: &ResolvedMailAccount,
    handle: &crate::state::MailDbHandle,
    folder: &str,
    validity: u32,
    targets: Vec<u32>,
    job: &ArchiveJob,
    failures: &mut ContentFailures,
) -> Result<(), String> {
    let id = &account.config.session_id;
    for uid in targets {
        match download_one(imap, account, handle, folder, uid, validity, job) {
            Ok(()) => update(job, |status| status.saved += 1)?,
            Err(error) if error.starts_with("MAIL_ARCHIVE_GONE:") => {
                let db = handle.lock().map_err(|e| e.to_string())?;
                db.execute("INSERT OR IGNORE INTO mail_archive_skipped(account_id,folder,uid_validity,uid) VALUES(?1,?2,?3,?4)",params![id,folder,validity,uid]).map_err(|e|e.to_string())?;
                update(job, |status| status.total = status.total.saturating_sub(1))?;
            }
            Err(error) if error.starts_with(CONTENT_ERROR) => {
                failures.count += 1;
                failures.first.get_or_insert_with(|| {
                    format!(
                        "{folder}, UID {uid}: {}",
                        error.trim_start_matches(CONTENT_ERROR)
                    )
                });
                update(job, |status| status.error = Some(failures.message()))?;
            }
            Err(error) => return Err(format!("{folder}, UID {uid}: {error}")),
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn mail_archive_query(
    account_id: String,
    query: archive_query::ArchiveQuery,
    offset: Option<u32>,
    state: State<'_, AppState>,
) -> Result<archive_query::ArchivePage, String> {
    with_mail_db_async(&state, &account_id, move |db, account| {
        archive_query::query(db, account, &query, offset.unwrap_or(0))
            .map_err(storage::as_sql_error)
    })
    .await
}

#[tauri::command]
pub async fn mail_archive_preview_cleanup(
    account_id: String,
    selection: archive_query::ArchiveSelection,
    state: State<'_, AppState>,
) -> Result<archive_query::CleanupPreview, String> {
    with_mail_db_async(&state, &account_id, move |db, account| {
        archive_query::preview(db, account, &selection).map_err(storage::as_sql_error)
    })
    .await
}

#[tauri::command]
pub async fn mail_archive_cleanup(
    account_id: String,
    token: String,
    state: State<'_, AppState>,
) -> Result<u64, String> {
    // Stop publication before deleting the frozen preview; skip markers prevent
    // other instances from publishing these originals again.
    state.mail.mail_archive.pause_account(&account_id)?;
    with_mail_db_async(&state, &account_id, move |db, account| {
        archive_query::remove_preview(db, account, &token).map_err(storage::as_sql_error)
    })
    .await
}

#[tauri::command]
pub async fn mail_archive_list(
    account_id: String,
    offset: Option<u32>,
    state: State<'_, AppState>,
) -> Result<Vec<storage::ArchiveEntry>, String> {
    with_mail_db_async(&state, &account_id, move |db, account| {
        storage::list(db, account, offset.unwrap_or(0)).map_err(storage::as_sql_error)
    })
    .await
}

#[tauri::command]
pub async fn mail_archive_read(
    account_id: String,
    entry: storage::ArchiveEntry,
    state: State<'_, AppState>,
) -> Result<MailMessageBody, String> {
    let folder = entry.folder.clone();
    let uid = entry.uid;
    let original = with_mail_original(&state, &account_id, move |db, account| {
        storage::open_entry(db, account, &entry)
    })
    .await?;
    decode_mail_original(move || {
        let raw = original.read()?;
        Ok(cached_to_body(
            parse_body_message(
                &account_id,
                &folder,
                uid,
                Some(raw.len() as u32),
                &raw,
                raw.len(),
            ),
            "archive",
        ))
    })
    .await
}

#[tauri::command]
pub async fn mail_archive_export(
    account_id: String,
    entry: storage::ArchiveEntry,
    target_path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let original = with_mail_original(&state, &account_id, move |db, account| {
        storage::open_entry(db, account, &entry)
    })
    .await?;
    decode_mail_original(move || original.export(Path::new(&target_path)).map(|_| ())).await
}

#[tauri::command]
pub async fn mail_archive_attachment(
    account_id: String,
    entry: storage::ArchiveEntry,
    attachment_index: usize,
    target_path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let original = with_mail_original(&state, &account_id, move |db, account| {
        storage::open_entry(db, account, &entry)
    })
    .await?;
    decode_mail_original(move || {
        let raw = original.read()?;
        let attachment = extract_attachment(&raw, attachment_index)?;
        write_attachment_file(&target_path, &attachment.bytes)?;
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn mail_archive_remove(
    account_id: String,
    entries: Vec<storage::ArchiveEntry>,
    state: State<'_, AppState>,
) -> Result<usize, String> {
    state.mail.mail_archive.pause_account(&account_id)?;
    with_mail_db_async(&state,&account_id,move |db,account| {
        db.execute("INSERT INTO mail_archive_preferences(account_id,paused) VALUES(?1,1) ON CONFLICT(account_id) DO UPDATE SET paused=1",[account])?;
        storage::remove_entries(db,account,&entries).map_err(storage::as_sql_error)
    }).await
}

fn parse_chunk(mut response: &[u8], uid: u32, offset: u64) -> Result<(u64, Vec<u8>), String> {
    use imap_proto::types::{AttributeValue, Response};
    let invalid = |message: String| format!("{CONTENT_ERROR}{message}");
    let mut found = false;
    let mut size = None;
    let mut chunk = None;
    while !response.is_empty() {
        let (rest, value) = imap_proto::parse_response(response)
            .map_err(|e| invalid(format!("Invalid partial FETCH response: {e}")))?;
        response = rest;
        if let Response::Fetch(_, attrs) = value {
            if !attrs
                .iter()
                .any(|v| matches!(v,AttributeValue::Uid(n) if *n==uid))
            {
                continue;
            }
            found = true;
            // Unsolicited flags for the same UID may precede the requested
            // FETCH, and a server may split the requested attributes.
            for attr in attrs {
                match attr {
                    AttributeValue::Rfc822Size(n) => {
                        if size.is_some_and(|old| old != n as u64) {
                            return Err(invalid("IMAP returned conflicting email sizes".into()));
                        }
                        size = Some(n as u64);
                    }
                    AttributeValue::BodySection {
                        section: None,
                        index,
                        data,
                    } => {
                        if chunk.replace((index, data)).is_some() {
                            return Err(invalid("IMAP returned multiple full email chunks".into()));
                        }
                    }
                    _ => {}
                }
            }
        }
    }
    if !found {
        return Err(format!("MAIL_ARCHIVE_GONE: Email UID {uid} disappeared"));
    }
    let size = size.ok_or_else(|| invalid("IMAP server omitted full email size".into()))?;
    let (origin, data) =
        chunk.ok_or_else(|| invalid("IMAP server omitted full email chunk".into()))?;
    let bytes = data.unwrap_or_default();
    // Some servers omit <0> when the whole message fits, or return NIL at EOF.
    let implicit_origin = origin.is_none() && (offset == 0 || data.is_none());
    if (!implicit_origin && origin.map(u64::from) != Some(offset)) || bytes.len() > CHUNK {
        return Err(invalid(format!(
            "IMAP returned a different byte range at offset {offset}; partial email was preserved without appending"
        )));
    }
    if bytes.is_empty() && offset == 0 {
        return Err(invalid(format!(
            "IMAP returned an empty full email chunk at offset 0 (declared size {size}); no original was saved"
        )));
    }
    // RFC822.SIZE is a progress hint. Some providers calculate it before MIME
    // transformations; the literal/range and an explicit EOF determine length.
    Ok((size, bytes.to_vec()))
}

fn partial<T: Read + Write>(
    session: &mut imap::Session<T>,
    folder: &str,
    uid: u32,
    offset: u64,
) -> Result<(u32, u64, Vec<u8>), String> {
    let mailbox = session
        .examine(folder)
        .map_err(|e| format!("IMAP EXAMINE {folder}: {e}"))?;
    let validity = mailbox
        .uid_validity
        .ok_or("IMAP server omitted UIDVALIDITY")?;
    let values = session
        .run_command_and_read_response(format!(
            "UID FETCH {uid} (UID RFC822.SIZE BODY.PEEK[]<{offset}.{CHUNK}>)"
        ))
        .map_err(|e| format!("IMAP full email chunk failed: {e}"))?;
    let (size, bytes) = parse_chunk(&values, uid, offset)?;
    Ok((validity, size, bytes))
}

fn download_one(
    imap: &mut ActiveImapSession,
    account: &ResolvedMailAccount,
    handle: &crate::state::MailDbHandle,
    folder: &str,
    uid: u32,
    validity: u32,
    job: &ArchiveJob,
) -> Result<(), String> {
    let id = &account.config.session_id;
    let folder_hash = hex::encode(Sha256::digest(folder.as_bytes()));
    let root = {
        let db = handle.lock().map_err(|e| e.to_string())?;
        storage::account_root(&db, id)?
    };
    let path = root
        .join("partial")
        .join(format!("{folder_hash}-{validity}-{uid}.part"));
    let metadata = path.with_extension("json");
    fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    let mut offset = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    let mut expected: Option<u64> = fs::read(&metadata)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok());
    // A crash may leave metadata before the first byte, or after publication
    // removed the partial. Without bytes there is no identity to resume.
    if offset == 0 {
        expected = None;
    }
    // A partial without its identity metadata is not safe to append to.
    if offset > 0 && expected.is_none() {
        fs::remove_file(&path).map_err(|e| e.to_string())?;
        offset = 0;
    }
    loop {
        update(job, |status| {
            status.phase = "downloading".into();
            status.bytes = offset;
            status.total_bytes = expected.map(|size| size.max(offset));
        })?;
        let (remote_validity, size, bytes) = match imap {
            ActiveImapSession::Tls { session, .. } => partial(session, folder, uid, offset),
            ActiveImapSession::Plain { session, .. } => partial(session, folder, uid, offset),
        }?;
        update(job, |_| {})?;
        if remote_validity != validity {
            return Err("Mailbox identity changed; refresh before resuming full storage".into());
        }
        if expected.is_some_and(|old| old != size) {
            // Restart safely on the next retry. Never append a different message.
            fs::remove_file(&path).map_err(|e| e.to_string())?;
            let _ = fs::remove_file(&metadata);
            return Err("Email size changed; partial download reset. Retry full storage".into());
        }
        expected = Some(size);
        fs::write(
            &metadata,
            serde_json::to_vec(&size).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        let mut output = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .map_err(|e| e.to_string())?;
        if output
            .seek(std::io::SeekFrom::End(0))
            .map_err(|e| e.to_string())?
            != offset
        {
            return Err("Partial email changed during download; retry storage".into());
        }
        output.write_all(&bytes).map_err(|e| e.to_string())?;
        output.sync_data().map_err(|e| e.to_string())?;
        offset += bytes.len() as u64;
        drop(output);
        // A full block never proves EOF, even if it equals the size estimate.
        // A mismatched short block needs one more range request to confirm EOF.
        // Resumed complete .part files also verify EOF, accepting BODY[] NIL.
        if bytes.is_empty() || (bytes.len() < CHUNK && offset == size) {
            update(job, |status| {
                status.phase = "verifying".into();
                status.bytes = offset;
                status.total_bytes = Some(offset);
            })?;
            let prepared =
                storage::prepare(&root, File::open(&path).map_err(|e| e.to_string())?, || {
                    update(job, |_| {})
                })?;
            let db = handle.lock().map_err(|e| e.to_string())?;
            // Cleanup sets pause before acquiring this same lock. No publication
            // can resurrect a reference deleted by explicit cleanup.
            check_publication(&db, id, folder, uid, validity, job)?;
            storage::publish(&db, id, folder, uid, validity, prepared)?;
            fs::remove_file(path).map_err(|e| e.to_string())?;
            let _ = fs::remove_file(metadata);
            return Ok(());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(
        fake: &fake_imap::FakeImap,
    ) -> (
        tempfile::TempDir,
        ResolvedMailAccount,
        crate::state::MailDbHandle,
        ArchiveJob,
        ActiveImapSession,
    ) {
        let dir = tempfile::tempdir().unwrap();
        let db = Connection::open(dir.path().join("qa.db")).unwrap();
        init_mail_tables(&db).unwrap();
        let config: MailAccountConfig = serde_json::from_value(serde_json::json!({"sessionId":"qa","emailAddress":"qa@example.test","imap":{"host":"127.0.0.1","port":fake.port,"security":"none"},"smtp":{"host":"127.0.0.1","port":1,"security":"none"}})).unwrap();
        let account = ResolvedMailAccount {
            config,
            auth_mode: MailAuthMode::Password,
            imap_username: "user".into(),
            imap_password: "pass".into(),
            smtp_username: "user".into(),
            smtp_password: "pass".into(),
            network_settings: None,
        };
        let handle = Arc::new(coordination::MailDatabase::new(dir.path().join("qa.db")));
        let job = ArchiveJob {
            pause: AtomicBool::new(false),
            running: AtomicBool::new(true),
            status: Mutex::new(ArchiveStatus::default()),
            socket: Mutex::new(None),
        };
        let imap = ActiveImapSession::Plain {
            session: fake.session(),
            forward_task: None,
        };
        (dir, account, handle, job, imap)
    }

    #[test]
    fn archive_publishes_first_batch_before_backfilling_history_and_drains_cached_mail() {
        let fake = fake_imap::FakeImap::start(false);
        fake.deliver("INBOX", 201, "Batched archive");
        let (_dir, account, handle, job, mut imap) = fixture(&fake);
        let mut failures = ContentFailures::default();
        run_folder(
            &mut imap,
            &account,
            &handle,
            "INBOX",
            false,
            &job,
            &mut failures,
        )
        .unwrap();
        let commands = fake.log();
        let first_raw = commands
            .iter()
            .position(|cmd| cmd.contains("BODY.PEEK[]<"))
            .unwrap();
        let second_headers = commands
            .iter()
            .enumerate()
            .filter(|(_, cmd)| cmd.contains("BODY.PEEK[HEADER]"))
            .nth(1)
            .unwrap()
            .0;
        assert!(
            first_raw < second_headers,
            "complete originals must precede history backfill"
        );
        assert_eq!(failures.count, 0);
        let status = job.status.lock().unwrap();
        assert_eq!(
            (
                status.saved,
                status.total,
                status.headers_synced,
                status.headers_total
            ),
            (201, 201, 201, Some(201))
        );
        drop(status);
        let db = handle.lock().unwrap();
        assert_eq!(storage::list(&db, "qa", 0).unwrap().len(), 200);
        assert_eq!(storage::list(&db, "qa", 200).unwrap().len(), 1);
        assert!(
            sync::load_folder_sync_state(&db, "qa", "INBOX")
                .unwrap()
                .complete
        );
        // Simulate an existing complete header cache with no originals. A new
        // scan must drain every cached message, not just its first MIME batch.
        db.execute("DELETE FROM mail_full_messages", []).unwrap();
        drop(db);
        let retry_job = ArchiveJob {
            status: Mutex::new(ArchiveStatus::default()),
            ..job
        };
        run_folder(
            &mut imap,
            &account,
            &handle,
            "INBOX",
            false,
            &retry_job,
            &mut failures,
        )
        .unwrap();
        assert_eq!(retry_job.status.lock().unwrap().saved, 201);
    }

    #[test]
    fn batched_archive_attempts_unavailable_content_once_per_scan() {
        let fake = fake_imap::FakeImap::start(false);
        let uids = fake.deliver("INBOX", 101, "Batched failure");
        let bad = *uids.last().unwrap();
        fake.state
            .lock()
            .unwrap()
            .empty_bodies
            .insert(("INBOX".into(), bad));
        let (_dir, account, handle, job, mut imap) = fixture(&fake);
        let mut failures = ContentFailures::default();
        run_folder(
            &mut imap,
            &account,
            &handle,
            "INBOX",
            false,
            &job,
            &mut failures,
        )
        .unwrap();
        assert_eq!(failures.count, 1);
        let status = job.status.lock().unwrap();
        assert_eq!((status.saved, status.total), (100, 101));
        assert_eq!(
            fake.log()
                .iter()
                .filter(|cmd| cmd.contains(&format!("UID FETCH {bad} "))
                    && cmd.contains("BODY.PEEK[]<0."))
                .count(),
            1
        );
    }

    #[test]
    fn inaccurate_size_estimates_do_not_truncate_or_block_full_mime() {
        let fake = fake_imap::FakeImap::start(false);
        let (_dir, account, handle, job, mut imap) = fixture(&fake);
        for (length, advertised) in [
            (537, 0),
            (537, 532),
            (537, 999),
            (CHUNK + 17, CHUNK),
            (CHUNK * 2, CHUNK * 2 + 50),
        ] {
            let mut raw =
                fake_imap::raw_message("Inaccurate size", "Tue, 14 Nov 2023 22:13:20 +0000");
            raw.resize(length, b'x');
            let uid = fake.deliver_raw("INBOX", raw.clone());
            fake.state
                .lock()
                .unwrap()
                .reported_sizes
                .insert(("INBOX".into(), uid), advertised);
            download_one(&mut imap, &account, &handle, "INBOX", uid, 1000, &job).unwrap();
            assert_eq!(
                storage::read(&handle.lock().unwrap(), "qa", "INBOX", uid)
                    .unwrap()
                    .unwrap(),
                raw
            );
            assert!(!fake.flags("INBOX", uid).contains(&"\\Seen".into()));
        }
    }

    #[test]
    fn unavailable_body_does_not_block_others_or_become_a_permanent_skip() {
        let fake = fake_imap::FakeImap::start(false);
        let uids = fake.deliver("INBOX", 3, "Content failure");
        let bad = uids[2];
        fake.state
            .lock()
            .unwrap()
            .empty_bodies
            .insert(("INBOX".into(), bad));
        let (_dir, account, handle, job, mut imap) = fixture(&fake);
        let mut failures = ContentFailures::default();
        download_targets(
            &mut imap,
            &account,
            &handle,
            "INBOX",
            1000,
            uids.iter().rev().copied().collect(),
            &job,
            &mut failures,
        )
        .unwrap();
        assert_eq!(failures.count, 1);
        assert!(failures.message().contains(&format!("INBOX, UID {bad}")));
        assert_eq!(job.status.lock().unwrap().saved, 2);
        {
            let db = handle.lock().unwrap();
            assert!(storage::read(&db, "qa", "INBOX", bad).unwrap().is_none());
            assert_eq!(
                db.query_row("SELECT COUNT(*) FROM mail_archive_skipped", [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                0
            );
            for uid in &uids[..2] {
                assert!(storage::read(&db, "qa", "INBOX", *uid).unwrap().is_some());
            }
        }
        let mut retry = ContentFailures::default();
        download_targets(
            &mut imap,
            &account,
            &handle,
            "INBOX",
            1000,
            vec![bad],
            &job,
            &mut retry,
        )
        .unwrap();
        assert_eq!(retry.count, 1);
        fake.state.lock().unwrap().empty_bodies.clear();
        let mut recovered = ContentFailures::default();
        download_targets(
            &mut imap,
            &account,
            &handle,
            "INBOX",
            1000,
            vec![bad],
            &job,
            &mut recovered,
        )
        .unwrap();
        assert_eq!(recovered.count, 0);
        assert!(
            storage::read(&handle.lock().unwrap(), "qa", "INBOX", bad)
                .unwrap()
                .is_some()
        );
    }

    #[test]
    fn resumed_parts_validate_actual_eof_and_size_hint_changes_reset_safely() {
        let fake = fake_imap::FakeImap::start(false);
        let mut raw =
            fake_imap::raw_message("Resume inaccurate size", "Tue, 14 Nov 2023 22:13:20 +0000");
        raw.resize(CHUNK + 57, b'x');
        let uid = fake.deliver_raw("INBOX", raw.clone());
        let (_dir, account, handle, job, mut imap) = fixture(&fake);
        let root = storage::account_root(&handle.lock().unwrap(), "qa").unwrap();
        let path = root.join("partial").join(format!(
            "{}-1000-{uid}.part",
            hex::encode(Sha256::digest(b"INBOX"))
        ));
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, &raw[..CHUNK]).unwrap();
        // Legacy numeric metadata remains readable. A claimed complete prefix
        // must not be published if the provider has more bytes at that offset.
        fs::write(path.with_extension("json"), CHUNK.to_string()).unwrap();
        fake.state
            .lock()
            .unwrap()
            .reported_sizes
            .insert(("INBOX".into(), uid), CHUNK);
        download_one(&mut imap, &account, &handle, "INBOX", uid, 1000, &job).unwrap();
        assert_eq!(
            storage::read(&handle.lock().unwrap(), "qa", "INBOX", uid)
                .unwrap()
                .unwrap(),
            raw
        );
        let next = fake.deliver_raw("INBOX", raw.clone());
        let changed = path.with_file_name(format!(
            "{}-1000-{next}.part",
            hex::encode(Sha256::digest(b"INBOX"))
        ));
        fs::write(&changed, &raw[..CHUNK]).unwrap();
        fs::write(changed.with_extension("json"), "10").unwrap();
        assert!(
            download_one(&mut imap, &account, &handle, "INBOX", next, 1000, &job)
                .unwrap_err()
                .contains("size changed")
        );
        assert!(!changed.exists());
        assert!(
            storage::read(&handle.lock().unwrap(), "qa", "INBOX", next)
                .unwrap()
                .is_none()
        );
        download_one(&mut imap, &account, &handle, "INBOX", next, 1000, &job).unwrap();
        assert_eq!(
            storage::read(&handle.lock().unwrap(), "qa", "INBOX", next)
                .unwrap()
                .unwrap(),
            raw
        );
    }

    #[test]
    fn orphaned_resume_metadata_does_not_trap_retry_after_size_changes() {
        let fake = fake_imap::FakeImap::start(false);
        let raw = fake_imap::raw_message("Orphaned metadata", "Tue, 14 Nov 2023 22:13:20 +0000");
        let (_dir, account, handle, job, mut imap) = fixture(&fake);
        let root = storage::account_root(&handle.lock().unwrap(), "qa").unwrap();
        for empty_partial in [false, true] {
            let uid = fake.deliver_raw("INBOX", raw.clone());
            let path = root.join("partial").join(format!(
                "{}-1000-{uid}.part",
                hex::encode(Sha256::digest(b"INBOX"))
            ));
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path.with_extension("json"), "1").unwrap();
            if empty_partial {
                fs::write(&path, []).unwrap();
            }
            download_one(&mut imap, &account, &handle, "INBOX", uid, 1000, &job).unwrap();
            assert_eq!(
                storage::read(&handle.lock().unwrap(), "qa", "INBOX", uid)
                    .unwrap()
                    .unwrap(),
                raw
            );
            assert!(!path.exists());
            assert!(!path.with_extension("json").exists());
        }
    }

    #[test]
    fn loopback_resume_saves_complete_mime_and_leaves_it_unread() {
        let fake = fake_imap::FakeImap::start(false);
        let raw=format!("Subject: Complete original\r\nContent-Type: multipart/mixed; boundary=b\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\nOffline body\r\n--b\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename=large.bin\r\nContent-Transfer-Encoding: base64\r\n\r\n{}\r\n--b--\r\n",BASE64_STANDARD.encode(vec![17u8;600_000])).into_bytes();
        let uid = fake.deliver_raw("INBOX", raw.clone());
        let dir = tempfile::tempdir().unwrap();
        let db = Connection::open(dir.path().join("qa.db")).unwrap();
        init_mail_tables(&db).unwrap();
        let config:MailAccountConfig=serde_json::from_value(serde_json::json!({"sessionId":"qa","emailAddress":"qa@example.test","imap":{"host":"127.0.0.1","port":fake.port,"security":"none"},"smtp":{"host":"127.0.0.1","port":1,"security":"none"}})).unwrap();
        let account = ResolvedMailAccount {
            config,
            auth_mode: MailAuthMode::Password,
            imap_username: "user".into(),
            imap_password: "pass".into(),
            smtp_username: "user".into(),
            smtp_password: "pass".into(),
            network_settings: None,
        };
        let root = storage::account_root(&db, "qa").unwrap();
        let partial_dir = root.join("partial");
        fs::create_dir_all(&partial_dir).unwrap();
        let path = partial_dir.join(format!(
            "{}-1000-{uid}.part",
            hex::encode(Sha256::digest(b"INBOX"))
        ));
        fs::write(&path, &raw[..CHUNK]).unwrap();
        fs::write(
            path.with_extension("json"),
            serde_json::to_vec(&raw.len()).unwrap(),
        )
        .unwrap();
        let job = ArchiveJob {
            pause: AtomicBool::new(false),
            running: AtomicBool::new(true),
            status: Mutex::new(ArchiveStatus::default()),
            socket: Mutex::new(None),
        };
        drop(db);
        let handle = Arc::new(coordination::MailDatabase::new(dir.path().join("qa.db")));
        let mut imap = ActiveImapSession::Plain {
            session: fake.session(),
            forward_task: None,
        };
        download_one(&mut imap, &account, &handle, "INBOX", uid, 1000, &job).unwrap();
        let db = handle.lock().unwrap();
        assert_eq!(
            storage::read(&db, "qa", "INBOX", uid).unwrap().unwrap(),
            raw
        );
        assert_eq!(
            extract_attachment(&raw, 0).unwrap().bytes,
            vec![17u8; 600_000]
        );
        assert!(!path.exists());
        assert!(
            fake.log()
                .iter()
                .any(|line| line.contains("BODY.PEEK[]<262144.262144>"))
        );
        assert!(!fake.flags("INBOX", uid).contains(&"\\Seen".into()));
        drop(db);
        // Simulate a process ending after the last chunk was fsynced but before
        // compression. Resume must validate the actual EOF, not only SIZE.
        let next_uid = fake.deliver_raw("INBOX", raw.clone());
        let complete_path = partial_dir.join(format!(
            "{}-1000-{next_uid}.part",
            hex::encode(Sha256::digest(b"INBOX"))
        ));
        fs::write(&complete_path, &raw).unwrap();
        fs::write(
            complete_path.with_extension("json"),
            serde_json::to_vec(&raw.len()).unwrap(),
        )
        .unwrap();
        download_one(&mut imap, &account, &handle, "INBOX", next_uid, 1000, &job).unwrap();
        assert_eq!(
            storage::read(&handle.lock().unwrap(), "qa", "INBOX", next_uid)
                .unwrap()
                .unwrap(),
            raw
        );
        assert!(!complete_path.exists());
        let requests = fake.log();
        assert!(requests.iter().any(|line| line.contains(&format!(
            "UID FETCH {next_uid} (UID RFC822.SIZE BODY.PEEK[]<{}.{}>)",
            raw.len(),
            CHUNK
        ))));
        job.pause.store(true, Ordering::Release);
        assert!(download_one(&mut imap, &account, &handle, "INBOX", uid, 1000, &job).is_err());
    }

    #[test]
    fn resumed_fetch_checks_origin_uid_size_and_literal() {
        let ok = b"* 1 FETCH (UID 7 RFC822.SIZE 6 BODY[]<3> {3}\r\ndef)\r\n";
        assert_eq!(parse_chunk(ok, 7, 3).unwrap(), (6, b"def".to_vec()));
        assert!(parse_chunk(ok, 7, 0).is_err());
        assert!(parse_chunk(ok, 8, 3).is_err());
        assert!(
            parse_chunk(
                b"* 1 FETCH (UID 7 RFC822.SIZE 6 BODY[] {3}\r\nabc)\r\n",
                7,
                3
            )
            .is_err()
        );
        assert_eq!(
            parse_chunk(
                b"* 1 FETCH (UID 7 RFC822.SIZE 6 BODY[]<5> {3}\r\nabc)\r\n",
                7,
                5
            )
            .unwrap(),
            (6, b"abc".to_vec())
        );
        assert_eq!(
            parse_chunk(
                b"* 1 FETCH (UID 7 RFC822.SIZE 6 BODY[]<6> {0}\r\n)\r\n",
                7,
                6
            )
            .unwrap(),
            (6, vec![])
        );
        assert_eq!(parse_chunk(b"* 1 FETCH (UID 7 FLAGS (\\Seen))\r\n* 1 FETCH (UID 7 RFC822.SIZE 9)\r\n* 1 FETCH (UID 7 BODY[]<3> {3}\r\ndef)\r\n", 7, 3).unwrap(), (9, b"def".to_vec()));
        assert_eq!(
            parse_chunk(b"* 1 FETCH (UID 7 RFC822.SIZE 8 BODY[] NIL)\r\n", 7, 6).unwrap(),
            (8, vec![])
        );
        assert!(
            parse_chunk(
                b"* 1 FETCH (UID 7 RFC822.SIZE 8 BODY[]<0> {0}\r\n)\r\n",
                7,
                0
            )
            .unwrap_err()
            .contains("offset 0")
        );
        assert!(parse_chunk(b"* 1 FETCH (UID 7 RFC822.SIZE 0 BODY[] NIL)\r\n", 7, 0).is_err());
    }
}
