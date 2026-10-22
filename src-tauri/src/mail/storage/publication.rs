use super::index::account_root;
use super::index::object_path;
use super::model::FullMessage;
use super::model::PreparedMessage;
use super::reading::open;
use flate2::Compression;
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use rusqlite::Connection;
use rusqlite::params;
use sha2::Digest;
use sha2::Sha256;
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
    mut raw: impl Read,
    check: impl Fn() -> Result<(), String>,
) -> Result<PreparedMessage, String> {
    fs::create_dir_all(root.join("objects")).map_err(|e| e.to_string())?;
    let mut temp =
        tempfile::NamedTempFile::new_in(root.join("objects")).map_err(|e| e.to_string())?;
    let mut hash = Sha256::new();
    let mut raw_size = 0u64;
    let mut attachments = super::super::archive_metadata::AttachmentScan::default();
    {
        let mut encoder = GzEncoder::new(temp.as_file_mut(), Compression::new(3));
        let mut buffer = [0u8; 128 * 1024];
        loop {
            check()?;
            let n = raw
                .read(&mut buffer)
                .map_err(|e| format!("Read full email: {e}"))?;
            if n == 0 {
                break;
            }
            attachments.feed(&buffer[..n]);
            hash.update(&buffer[..n]);
            raw_size += n as u64;
            encoder
                .write_all(&buffer[..n])
                .map_err(|e| format!("Compress full email: {e}"))?;
        }
        encoder
            .finish()
            .map_err(|e| format!("Finish full email: {e}"))?;
    }
    temp.as_file().sync_all().map_err(|e| e.to_string())?;
    let hash = hex::encode(hash.finalize());
    let existing = object_path(root, &hash)?;
    if existing.exists() {
        // Duplicate verification, like compression, must stay off the DB lock.
        verify_object(&existing, &hash, raw_size, std::io::sink())?;
    }
    Ok(PreparedMessage {
        temp,
        hash,
        raw_size,
        has_attachments: attachments.found,
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
    let PreparedMessage {
        temp,
        hash,
        raw_size,
        has_attachments,
    } = prepared;
    let root = account_root(db, account)?;
    let path = object_path(&root, &hash)?;
    fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    if !path.exists() {
        temp.persist_noclobber(&path)
            .map_err(|e| format!("Publish full email: {}", e.error))?;
    } // Existing immutable content was verified during preparation.
    let stored_size = fs::metadata(&path).map_err(|e| e.to_string())?.len();
    let tx = db.unchecked_transaction().map_err(|e| e.to_string())?;
    let mut header =
        super::super::cached_header(&tx, account, folder, uid).map_err(|e| e.to_string())?;
    if let Some(header) = &mut header {
        header.has_attachments = has_attachments;
    }
    let header_json = serde_json::to_string(&header).map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM mail_full_messages WHERE account_id=?1 AND folder=?2 AND uid=?3 AND uid_validity=?4", params![account,folder,uid,uid_validity]).map_err(|e|e.to_string())?;
    tx.execute(
        "INSERT INTO mail_full_messages(account_id,folder,uid,uid_validity,sha256,raw_size,stored_size,stored_at,header_json)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",
        params![account,folder,uid,uid_validity,hash,raw_size as i64,stored_size as i64,super::super::now_ts(),header_json],
    ).map_err(|e|e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(FullMessage {
        hash,
        raw_size,
        stored_size,
    })
}

pub(super) fn verify_object(
    path: &Path,
    hash: &str,
    expected: u64,
    destination: impl Write,
) -> Result<(), String> {
    verify_open_object(
        File::open(path).map_err(|e| format!("Open saved email: {e}"))?,
        hash,
        expected,
        destination,
    )
}

pub(super) fn verify_open_object(
    file: File,
    hash: &str,
    expected: u64,
    mut destination: impl Write,
) -> Result<(), String> {
    let mut decoder = GzDecoder::new(file);
    let mut digest = Sha256::new();
    let mut size = 0u64;
    let mut buffer = [0u8; 128 * 1024];
    loop {
        let n = decoder
            .read(&mut buffer)
            .map_err(|e| format!("Saved email is damaged: {e}"))?;
        if n == 0 {
            break;
        }
        size += n as u64;
        if size > expected {
            return Err("Saved email size verification failed".into());
        }
        digest.update(&buffer[..n]);
        destination
            .write_all(&buffer[..n])
            .map_err(|e| e.to_string())?;
    }
    if size != expected || hex::encode(digest.finalize()) != hash {
        return Err("Saved email checksum verification failed".into());
    }
    Ok(())
}
