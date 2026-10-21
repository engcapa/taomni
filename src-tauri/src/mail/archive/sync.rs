use super::download::download_one;
use super::lifetime::ArchiveJob;
use super::lifetime::update;
use super::limits::ARCHIVE_BATCH;
use super::limits::CONTENT_ERROR;
use super::limits::ContentFailures;
use crate::mail::MailCacheSettings;
use crate::mail::ResolvedMailAccount;
use crate::mail::folders;
use crate::mail::pop3;
use crate::mail::storage;
use crate::mail::sync;
use crate::mail::{ActiveImapSession, connect_imap_with_socket, folder_is_noselect};
use crate::state::AppState;
use rusqlite::Connection;
use rusqlite::Result as SqlResult;
use rusqlite::params;
use std::collections::HashSet;
use std::sync::atomic::Ordering;
use sync::MailSyncRequestMode;
use sync::StepParams;

pub(super) fn check_publication(
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

pub(super) fn run_local(state: &AppState, id: &str, job: &ArchiveJob) -> Result<(), String> {
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

pub(super) fn run(
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
pub(super) fn run_folder(
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
pub(super) fn download_targets(
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
