use super::connection::ArchiveConnection;
use super::lifetime::{ArchiveJob, update};
use crate::mail::{ResolvedMailAccount, storage};
use crate::state::MailDbHandle;
use std::sync::atomic::Ordering;
use taomni_mail_engine::{
    archive::download_imap_original,
    storage::{query::ArchiveKey, scan},
};

pub(super) fn publish_original(
    handle: &MailDbHandle,
    account: &str,
    key: &ArchiveKey,
    prepared: storage::PreparedMessage,
    job: &ArchiveJob,
) -> Result<(), String> {
    let db = handle.lock().map_err(|error| error.to_string())?;
    let published = scan::publish_original(&db, account, key, prepared, || update(job, |_| {}));
    if published.as_ref().is_err_and(|error| error == scan::PAUSED) {
        job.pause.store(true, Ordering::Release);
    }
    published.map(drop)
}

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
            publish_original(handle, id, &message, prepared, job)
        },
    )
}
