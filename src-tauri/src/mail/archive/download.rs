use super::connection::ArchiveConnection;
use super::lifetime::{ArchiveJob, update};
use super::sync::check_publication;
use crate::mail::{ResolvedMailAccount, storage};
use taomni_mail_engine::{archive::download_imap_original, storage::query::ArchiveKey};

pub(super) fn download_one(
    imap: &mut dyn ArchiveConnection,
    account: &ResolvedMailAccount,
    handle: &crate::state::MailDbHandle,
    folder: &str,
    uid: u32,
    validity: u32,
    job: &ArchiveJob,
) -> Result<(), String> {
    let id = &account.config.session_id;
    let root = {
        let db = handle.lock().map_err(|e| e.to_string())?;
        storage::account_root(&db, id)?
    };
    let message = ArchiveKey {
        folder: folder.into(),
        uid,
        uid_validity: validity,
    };
    download_imap_original(
        &root,
        &message,
        |offset| imap.chunk(folder, uid, offset),
        |bytes, total| {
            update(job, |status| {
                status.phase = "downloading".into();
                status.bytes = bytes;
                status.total_bytes = total;
            })
        },
        || update(job, |_| {}),
        |raw, size| {
            update(job, |status| {
                status.phase = "verifying".into();
                status.bytes = size;
                status.total_bytes = Some(size);
            })?;
            let prepared = storage::prepare(&root, raw, || update(job, |_| {}))?;
            let db = handle.lock().map_err(|e| e.to_string())?;
            // Cleanup sets pause before acquiring this same lock. No publication
            // can resurrect a reference deleted by explicit cleanup.
            check_publication(&db, id, folder, uid, validity, job)?;
            storage::publish(&db, id, folder, uid, validity, prepared)?;
            Ok(())
        },
    )
}
