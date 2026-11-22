use super::lifetime::ArchiveJob;
use super::lifetime::update;
use super::limits::CHUNK;
use super::sync::check_publication;
use crate::mail::ActiveImapSession;
use crate::mail::ResolvedMailAccount;
use crate::mail::storage;
use lettre::transport::smtp::client::Tls;
use sha2::Digest;
use sha2::Sha256;
use std::fs;
use std::fs::File;
use std::fs::OpenOptions;
use std::io::Seek;
use std::io::Write;
use taomni_mail_engine::archive::fetch_imap_chunk;

pub(super) fn download_one(
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
            ActiveImapSession::Tls { session, .. } => {
                fetch_imap_chunk(session, folder, uid, offset)
            }
            ActiveImapSession::Plain { session, .. } => {
                fetch_imap_chunk(session, folder, uid, offset)
            }
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
