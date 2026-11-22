use super::connection::{ArchiveConnection, HostedConnection};
use super::download::{download_one, publish_original};
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
use crate::mail::{connect_imap_with_socket, folder_is_noselect, module_host};
use crate::state::AppState;
use rusqlite::params;
use std::collections::HashSet;
use sync::MailSyncRequestMode;
use sync::StepParams;
use taomni_mail_engine::storage::{query::ArchiveKey, scan};

pub(super) fn run_local(state: &AppState, id: &str, job: &ArchiveJob) -> Result<(), String> {
    let handle = state.mail_db(id)?;
    let targets = {
        let db = handle.lock().map_err(|e| e.to_string())?;
        scan::pending_local(&db, id).map_err(|error| error.to_string())?
    };
    update(job, |status| status.total = targets.len())?;
    for target in targets {
        update(job, |status| {
            status.folder = Some(target.folder.clone());
            status.phase = "verifying".into();
        })?;
        let (root, raw) = {
            let db = handle.lock().map_err(|e| e.to_string())?;
            (
                storage::account_root(&db, id)?,
                pop3::local_raw(&db, id, &target.folder, target.uid).map_err(|e| e.to_string())?,
            )
        };
        let Some(raw) = raw else { continue };
        let prepared = storage::prepare(&root, raw.as_slice(), || update(job, |_| {}))?;
        publish_original(&handle, id, &target, prepared, job)?;
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
    let mut hosted;
    let mut legacy;
    let (imap, condstore): (&mut dyn ArchiveConnection, bool) =
        if module_host::archives_imap(&state.plugins) {
            hosted = HostedConnection::open(state.plugins.clone(), account, runtime, job)?;
            (&mut hosted, false)
        } else {
            let (session, socket) = connect_imap_with_socket(account, runtime)?;
            *job.socket.lock().map_err(|e| e.to_string())? = socket;
            legacy = session;
            let condstore = legacy.has_capability("CONDSTORE");
            (&mut legacy, condstore)
        };
    update(job, |_| {})?;
    let folders = imap.list(id)?;
    let mut failures = ContentFailures::default();
    for folder in folders
        .into_iter()
        .filter(|folder| !folder_is_noselect(folder))
    {
        run_folder(
            imap,
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
    imap: &mut dyn ArchiveConnection,
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
            let step = imap.headers(
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
            scan::pending_imap(&db, id, folder).map_err(|error| error.to_string())?
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
    imap: &mut dyn ArchiveConnection,
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
                let key = ArchiveKey {
                    folder: folder.into(),
                    uid,
                    uid_validity: validity,
                };
                scan::skip(&db, id, &key).map_err(|error| error.to_string())?;
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
