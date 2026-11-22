//! Mailbox scans interleave gap-free header backfill with verified MIME publication.

use super::{
    CONTENT_ERROR,
    writer::{ArchiveMailbox, publish_original},
};
use crate::{
    MailFolder,
    cache::{self, MailCacheSettings},
    imap_sync::{FolderStepOutcome, FolderSyncState, MailSyncRequestMode, StepParams},
    pop3::local_store::local_raw,
    storage::{self, FullMessageMode, query::ArchiveKey, scan},
};
use rusqlite::params;
use std::collections::HashSet;

const ARCHIVE_BATCH: usize = 100;

#[derive(Default)]
pub struct ContentFailures {
    pub count: usize,
    pub first: Option<String>,
}

impl ContentFailures {
    pub fn message(&self) -> String {
        format!(
            "{} email(s) could not be saved; other readable messages were processed. First failure: {}. Retry to retry incomplete originals",
            self.count,
            self.first.as_deref().unwrap_or("unknown")
        )
    }
}

pub trait ArchiveConnection {
    fn list(&mut self, account_id: &str) -> Result<Vec<MailFolder>, String>;
    fn headers(
        &mut self,
        account: &str,
        folder: &str,
        state: &FolderSyncState,
        step: &StepParams,
    ) -> Result<FolderStepOutcome, String>;
    fn chunk(&mut self, folder: &str, uid: u32, offset: u64)
    -> Result<(u32, u64, Vec<u8>), String>;
}

pub fn stores_full(settings: &MailCacheSettings, folder: &str) -> bool {
    // Keep old exact server keys working, and accept the full readable path
    // entered before the account has ever connected or cached its folders.
    let readable_folder = crate::imap_folders::decode_imap_modified_utf7(folder);
    let selected = settings.full_message_folders.iter().any(|name| {
        let name = name.trim();
        name == folder
            || name == readable_folder
            || (name.eq_ignore_ascii_case("INBOX") && folder.eq_ignore_ascii_case("INBOX"))
    });
    match settings.full_message_mode {
        FullMessageMode::All => true,
        FullMessageMode::Include => selected,
        FullMessageMode::Exclude => !selected,
    }
}

impl ArchiveMailbox<'_> {
    pub fn run_local(&self) -> Result<(), String> {
        let (handle, id, job) = (self.database, self.account, self.progress);
        let targets = {
            let db = handle.lock().map_err(|e| e.to_string())?;
            scan::pending_local(&db, id).map_err(|error| error.to_string())?
        };
        job.update(|status| status.total = targets.len())?;
        for target in targets {
            job.update(|status| {
                status.folder = Some(target.folder.clone());
                status.phase = "verifying".into();
            })?;
            let (root, raw) = {
                let db = handle.lock().map_err(|e| e.to_string())?;
                (
                    storage::account_root(&db, id)?,
                    local_raw(&db, id, &target.folder, target.uid).map_err(|e| e.to_string())?,
                )
            };
            let Some(raw) = raw else { continue };
            let prepared = self.prepare(&root, &mut raw.as_slice(), raw.len() as u64)?;
            publish_original(handle, id, &target, prepared, job)?;
            job.update(|status| status.saved += 1)?;
        }
        Ok(())
    }

    pub fn run_imap(
        &self,
        imap: &mut dyn ArchiveConnection,
        settings: &MailCacheSettings,
        condstore: bool,
    ) -> Result<(), String> {
        let (id, job) = (self.account, self.progress);
        job.update(|_| {})?;
        let folders = imap.list(id)?;
        let mut failures = ContentFailures::default();
        for folder in folders.into_iter().filter(|folder| {
            !folder
                .flags
                .iter()
                .any(|flag| flag.to_ascii_lowercase().contains("noselect"))
        }) {
            self.run_folder(imap, settings, &folder.name, condstore, &mut failures)?;
        }
        if failures.count == 0 {
            Ok(())
        } else {
            Err(failures.message())
        }
    }

    /// Alternate bounded header and MIME batches so a large history cannot delay
    /// the first readable original. Failed content is attempted once per scan.
    pub fn run_folder(
        &self,
        imap: &mut dyn ArchiveConnection,
        settings: &MailCacheSettings,
        folder: &str,
        condstore: bool,
        failures: &mut ContentFailures,
    ) -> Result<(), String> {
        let (id, handle, job) = (self.account, self.database, self.progress);
        let stores_full = stores_full(settings, folder);
        let mut request = MailSyncRequestMode::Auto;
        let mut headers_complete = false;
        let mut discovered = HashSet::new();
        let mut attempted = HashSet::new();
        job.update(|status| {
            status.folder = Some(folder.into());
            status.headers_synced = 0;
            status.headers_total = None;
            status.bytes = 0;
            status.total_bytes = None;
        })?;
        loop {
            job.update(|_| {})?;
            if !headers_complete {
                let snapshot = {
                    let db = handle.lock().map_err(|e| e.to_string())?;
                    cache::load_folder_sync_state(&db, id, folder).map_err(|e| e.to_string())?
                };
                job.update(|status| {
                    status.phase = "headers".into();
                    status.headers_synced = snapshot.cached_uids.len();
                    status.bytes = 0;
                    status.total_bytes = None;
                })?;
                let started = cache::now_ms();
                let step = imap.headers(
                    id,
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
                        ..settings.clone()
                    };
                    cache::apply_folder_step(&db, id, &step, &settings, started)
                        .map_err(|e| e.to_string())?;
                    db.query_row(
                        "SELECT COUNT(*) FROM mail_messages WHERE account_id=?1 AND folder=?2",
                        params![id, folder],
                        |row| row.get::<_, u32>(0),
                    )
                    .map_err(|e| e.to_string())?
                };
                job.update(|status| {
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
            job.update(|status| status.total += newly_discovered)?;
            let batch: Vec<u32> = targets
                .into_iter()
                .filter(|uid| !attempted.contains(&(validity, *uid)))
                .take(ARCHIVE_BATCH)
                .collect();
            if batch.is_empty() && headers_complete {
                break;
            }
            attempted.extend(batch.iter().map(|uid| (validity, *uid)));
            self.download_targets(imap, folder, validity, batch, failures)?;
        }
        Ok(())
    }

    // Content errors belong to a specific message, not the connection. The command
    // response has already been consumed, so the same session can process later UIDs.
    // Network/disk/identity failures still stop immediately and preserve safe partials.
    pub fn download_targets(
        &self,
        imap: &mut dyn ArchiveConnection,
        folder: &str,
        validity: u32,
        targets: Vec<u32>,
        failures: &mut ContentFailures,
    ) -> Result<(), String> {
        let (id, handle, job) = (self.account, self.database, self.progress);
        for uid in targets {
            match self.download_one(imap, folder, uid, validity) {
                Ok(()) => job.update(|status| status.saved += 1)?,
                Err(error) if error.starts_with("MAIL_ARCHIVE_GONE:") => {
                    let db = handle.lock().map_err(|e| e.to_string())?;
                    let key = ArchiveKey {
                        folder: folder.into(),
                        uid,
                        uid_validity: validity,
                    };
                    scan::skip(&db, id, &key).map_err(|error| error.to_string())?;
                    job.update(|status| status.total = status.total.saturating_sub(1))?;
                }
                Err(error) if error.starts_with(CONTENT_ERROR) => {
                    failures.count += 1;
                    failures.first.get_or_insert_with(|| {
                        format!(
                            "{folder}, UID {uid}: {}",
                            error.trim_start_matches(CONTENT_ERROR)
                        )
                    });
                    job.update(|status| status.error = Some(failures.message()))?;
                }
                Err(error) => return Err(format!("{folder}, UID {uid}: {error}")),
            }
        }
        Ok(())
    }
}
