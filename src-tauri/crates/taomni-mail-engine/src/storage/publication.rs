use super::index::account_root;
use super::index::object_path;
use super::model::FullMessage;
use super::model::PreparedMessage;
use super::query::ArchiveKey;
use crate::archive::{MessageObject, compress_message, verify_message};
use rusqlite::params;
use rusqlite::{Connection, Transaction, TransactionBehavior};
use std::fs;
use std::fs::File;
use std::io::Read;
use std::io::Write;
use std::path::Path;

pub fn store(
    db: &Connection,
    account: &str,
    folder: &str,
    uid: u32,
    uid_validity: u32,
    raw: impl Read,
) -> Result<FullMessage, String> {
    publish(
        db,
        account,
        folder,
        uid,
        uid_validity,
        prepare(&account_root(db, account)?, raw, || Ok(()))?,
    )
}

/// Compression runs outside the account DB lock. Relocation first stops this worker.
pub fn prepare(
    root: &Path,
    raw: impl Read,
    check: impl Fn() -> Result<(), String>,
) -> Result<PreparedMessage, String> {
    prepare_with(root, |file| compress_message(raw, file, check))
}

pub fn prepare_with(
    root: &Path,
    encode: impl FnOnce(&mut File) -> Result<MessageObject, String>,
) -> Result<PreparedMessage, String> {
    fs::create_dir_all(root.join("objects")).map_err(|e| e.to_string())?;
    let mut temp =
        tempfile::NamedTempFile::new_in(root.join("objects")).map_err(|e| e.to_string())?;
    let MessageObject {
        hash,
        raw_size,
        has_attachments,
    } = encode(temp.as_file_mut())?;
    temp.as_file().sync_all().map_err(|e| e.to_string())?;
    let existing = object_path(root, &hash)?;
    if existing.exists() {
        // Duplicate verification, like compression, must stay off the DB lock.
        verify_object(&existing, &hash, raw_size, std::io::sink())?;
    }
    Ok(PreparedMessage {
        temp,
        hash,
        raw_size,
        has_attachments,
    })
}

pub fn publish(
    db: &Connection,
    account: &str,
    folder: &str,
    uid: u32,
    uid_validity: u32,
    prepared: PreparedMessage,
) -> Result<FullMessage, String> {
    let target = ArchiveKey {
        folder: folder.into(),
        uid,
        uid_validity,
    };
    publish_checked(db, account, &target, prepared, |_| Ok(()))
}

pub(super) fn publish_checked(
    db: &Connection,
    account: &str,
    target: &ArchiveKey,
    prepared: PreparedMessage,
    check: impl FnOnce(&Connection) -> Result<(), String>,
) -> Result<FullMessage, String> {
    // Reserve the writer lock before reading pause and skip markers. A cleanup
    // must finish before that check or wait for this publication to commit.
    let tx = Transaction::new_unchecked(db, TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    check(&tx)?;
    let ArchiveKey {
        folder,
        uid,
        uid_validity,
    } = target;
    let PreparedMessage {
        temp,
        hash,
        raw_size,
        has_attachments,
    } = prepared;
    let root = account_root(&tx, account)?;
    let path = object_path(&root, &hash)?;
    fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    if !path.exists() {
        temp.persist_noclobber(&path)
            .map_err(|e| format!("Publish full email: {}", e.error))?;
    } // Existing immutable content was verified during preparation.
    let stored_size = fs::metadata(&path).map_err(|e| e.to_string())?.len();
    let mut header =
        crate::cache::cached_header(&tx, account, folder, *uid).map_err(|e| e.to_string())?;
    if let Some(header) = &mut header {
        header.has_attachments = has_attachments;
    }
    let header_json = serde_json::to_string(&header).map_err(|e| e.to_string())?;
    let stored_at = crate::now_ts();
    tx.execute("DELETE FROM mail_full_messages WHERE account_id=?1 AND folder=?2 AND uid=?3 AND uid_validity=?4", params![account,folder,uid,uid_validity]).map_err(|e|e.to_string())?;
    tx.execute(
        "INSERT INTO mail_full_messages(account_id,folder,uid,uid_validity,sha256,raw_size,stored_size,stored_at,header_json)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",
        params![account,folder,uid,uid_validity,hash,raw_size as i64,stored_size as i64,stored_at,header_json],
    ).map_err(|e|e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(FullMessage {
        hash,
        raw_size,
        stored_size,
        stored_at,
    })
}

pub(super) fn verify_object(
    path: &Path,
    hash: &str,
    expected: u64,
    destination: impl Write,
) -> Result<(), String> {
    verify_message(
        File::open(path).map_err(|e| format!("Open saved email: {e}"))?,
        hash,
        expected,
        destination,
    )
}
