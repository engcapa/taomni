//! Complete MIME objects are immutable and independent of the disposable body cache.
use flate2::{Compression, read::GzDecoder, write::GzEncoder};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum FullMessageMode {
    #[default]
    All,
    Include,
    Exclude,
}

pub fn stores_full(settings: &super::MailCacheSettings, folder: &str) -> bool {
    // Keep old exact server keys working, and accept the full readable path
    // entered before the account has ever connected or cached its folders.
    let readable_folder = super::decode_imap_modified_utf7(folder);
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

pub fn init_tables(db: &Connection) -> rusqlite::Result<()> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS mail_full_messages (
            account_id TEXT NOT NULL, folder TEXT NOT NULL, uid INTEGER NOT NULL,
            uid_validity INTEGER NOT NULL, sha256 TEXT NOT NULL,
            raw_size INTEGER NOT NULL, stored_size INTEGER NOT NULL, stored_at INTEGER NOT NULL,
            header_json TEXT NOT NULL DEFAULT '{}',
            PRIMARY KEY(account_id, folder, uid_validity, uid));
         CREATE INDEX IF NOT EXISTS mail_full_messages_hash ON mail_full_messages(sha256);
         CREATE TABLE IF NOT EXISTS mail_archive_gc (sha256 TEXT PRIMARY KEY);
         CREATE TABLE IF NOT EXISTS mail_archive_preferences (
            account_id TEXT PRIMARY KEY, paused INTEGER NOT NULL DEFAULT 0);
         CREATE TABLE IF NOT EXISTS mail_archive_skipped (
            account_id TEXT NOT NULL, folder TEXT NOT NULL, uid_validity INTEGER NOT NULL, uid INTEGER NOT NULL,
            PRIMARY KEY(account_id,folder,uid_validity,uid));
         CREATE TRIGGER IF NOT EXISTS mail_full_object_unreferenced AFTER DELETE ON mail_full_messages BEGIN
            INSERT OR IGNORE INTO mail_archive_gc(sha256) VALUES(old.sha256);
         END;",
    )
}

pub fn account_root(db: &Connection, account_id: &str) -> Result<PathBuf, String> {
    let path = db
        .path()
        .filter(|path| !path.is_empty())
        .ok_or("Mail storage has no disk path")?;
    let parent = Path::new(path)
        .parent()
        .ok_or("Invalid mail storage path")?;
    // tempfile publishes with raw Win32 APIs, unlike std::fs which handles
    // long paths itself. Canonicalize the existing parent before appending
    // object names so both temporary and final paths retain the \\?\ prefix.
    #[cfg(windows)]
    let parent = parent
        .canonicalize()
        .map_err(|e| format!("Resolve mail storage directory: {e}"))?;
    Ok(parent.join(format!(
        "{}.mail",
        crate::state::mail_db_file_stem(account_id)
    )))
}

fn object_path(root: &Path, hash: &str) -> Result<PathBuf, String> {
    if hash.len() != 64
        || !hash
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        return Err("Invalid full-message object hash".into());
    }
    Ok(root
        .join("objects")
        .join(&hash[..2])
        .join(format!("{hash}.eml.gz")))
}

#[derive(Debug, Clone)]
pub struct FullMessage {
    pub hash: String,
    pub raw_size: u64,
    pub stored_size: u64,
}

pub fn lookup(
    db: &Connection,
    account: &str,
    folder: &str,
    uid: u32,
) -> Result<Option<FullMessage>, String> {
    db.query_row(
        "SELECT sha256, raw_size, stored_size, uid_validity FROM mail_full_messages
         WHERE account_id = ?1 AND folder = ?2 AND uid = ?3
           AND uid_validity = COALESCE((SELECT uid_validity FROM mail_folders WHERE account_id=?1 AND name=?2),uid_validity)
         ORDER BY stored_at DESC LIMIT 1",
        params![account, folder, uid],
        |row| Ok(FullMessage { hash: row.get(0)?, raw_size: row.get::<_,i64>(1)? as u64, stored_size: row.get::<_,i64>(2)? as u64 }),
    ).optional().map_err(|e| e.to_string())
}

pub struct PreparedMessage {
    temp: tempfile::NamedTempFile,
    hash: String,
    raw_size: u64,
}

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
    let header = super::cached_header(&tx, account, folder, uid).map_err(|e| e.to_string())?;
    let header_json = serde_json::to_string(&header).map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM mail_full_messages WHERE account_id=?1 AND folder=?2 AND uid=?3 AND uid_validity=?4", params![account,folder,uid,uid_validity]).map_err(|e|e.to_string())?;
    tx.execute(
        "INSERT INTO mail_full_messages(account_id,folder,uid,uid_validity,sha256,raw_size,stored_size,stored_at,header_json)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",
        params![account,folder,uid,uid_validity,hash,raw_size as i64,stored_size as i64,super::now_ts(),header_json],
    ).map_err(|e|e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(FullMessage {
        hash,
        raw_size,
        stored_size,
    })
}

fn verify_object(
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

fn verify_open_object(
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

/// Open while the DB lock protects the object reference, then release that
/// lock before decompressing, parsing or exporting a potentially large MIME.
/// The open descriptor remains valid if cleanup or relocation removes its path.
pub struct OpenMessage {
    file: File,
    hash: String,
    pub raw_size: u64,
}

impl OpenMessage {
    pub fn read(self) -> Result<Vec<u8>, String> {
        if self.raw_size > 512 * 1024 * 1024 {
            return Err("This saved email exceeds the 512 MiB reader limit; save its original EML to open it externally".into());
        }
        let mut bytes = Vec::new();
        verify_open_object(self.file, &self.hash, self.raw_size, &mut bytes)?;
        Ok(bytes)
    }

    pub fn export(self, target: &Path) -> Result<u64, String> {
        let parent = target.parent().ok_or("Invalid email export path")?;
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
        verify_open_object(self.file, &self.hash, self.raw_size, temp.as_file_mut())?;
        temp.as_file().sync_all().map_err(|e| e.to_string())?;
        temp.persist(target).map_err(|e| e.error.to_string())?;
        Ok(self.raw_size)
    }
}

fn open_object(
    db: &Connection,
    account: &str,
    hash: String,
    raw_size: u64,
) -> Result<OpenMessage, String> {
    let file = File::open(object_path(&account_root(db, account)?, &hash)?)
        .map_err(|e| format!("Open saved email: {e}"))?;
    Ok(OpenMessage {
        file,
        hash,
        raw_size,
    })
}

pub fn open(
    db: &Connection,
    account: &str,
    folder: &str,
    uid: u32,
) -> Result<Option<OpenMessage>, String> {
    lookup(db, account, folder, uid)?
        .map(|entry| open_object(db, account, entry.hash, entry.raw_size))
        .transpose()
}

pub fn open_entry(
    db: &Connection,
    account: &str,
    entry: &ArchiveEntry,
) -> Result<OpenMessage, String> {
    let (hash, size): (String, u64) = db.query_row(
        "SELECT sha256,raw_size FROM mail_full_messages WHERE account_id=?1 AND folder=?2 AND uid_validity=?3 AND uid=?4",
        params![account,entry.folder,entry.uid_validity,entry.uid],
        |row| Ok((row.get(0)?, row.get::<_,i64>(1)? as u64)),
    ).map_err(|e| e.to_string())?;
    open_object(db, account, hash, size)
}

#[cfg(test)]
pub fn read(
    db: &Connection,
    account: &str,
    folder: &str,
    uid: u32,
) -> Result<Option<Vec<u8>>, String> {
    open(db, account, folder, uid)?
        .map(OpenMessage::read)
        .transpose()
}

#[cfg(test)]
pub fn export(
    db: &Connection,
    account: &str,
    folder: &str,
    uid: u32,
    target: &Path,
) -> Result<Option<u64>, String> {
    open(db, account, folder, uid)?
        .map(|file| file.export(target))
        .transpose()
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveEntry {
    pub folder: String,
    pub uid: u32,
    pub uid_validity: u32,
    pub subject: String,
    pub raw_size: u64,
    pub stored_size: u64,
    pub stored_at: i64,
}

pub fn list(db: &Connection, account: &str, offset: u32) -> Result<Vec<ArchiveEntry>, String> {
    db.prepare("SELECT folder,uid,uid_validity,header_json,raw_size,stored_size,stored_at FROM mail_full_messages WHERE account_id=?1 ORDER BY stored_at DESC,folder,uid_validity DESC,uid DESC LIMIT 200 OFFSET ?2").map_err(|e|e.to_string())?
        .query_map(params![account,offset],|row| {
            let header:String=row.get(3)?;
            let header:serde_json::Value=serde_json::from_str(&header).unwrap_or_default();
            Ok(ArchiveEntry { folder:row.get(0)?,uid:row.get(1)?,uid_validity:row.get(2)?,subject:header.get("subject").and_then(|v|v.as_str()).unwrap_or("(no subject)").into(),raw_size:row.get::<_,i64>(4)? as u64,stored_size:row.get::<_,i64>(5)? as u64,stored_at:row.get(6)? })
        }).map_err(|e|e.to_string())?.collect::<rusqlite::Result<_>>().map_err(|e|e.to_string())
}

#[cfg(test)]
pub fn read_entry(db: &Connection, account: &str, entry: &ArchiveEntry) -> Result<Vec<u8>, String> {
    open_entry(db, account, entry)?.read()
}

pub fn remove_entries(
    db: &Connection,
    account: &str,
    entries: &[ArchiveEntry],
) -> Result<usize, String> {
    let tx = db.unchecked_transaction().map_err(|e| e.to_string())?;
    for entry in entries {
        tx.execute("DELETE FROM mail_full_messages WHERE account_id=?1 AND folder=?2 AND uid_validity=?3 AND uid=?4",params![account,entry.folder,entry.uid_validity,entry.uid]).map_err(|e|e.to_string())?;
        tx.execute("INSERT OR IGNORE INTO mail_archive_skipped(account_id,folder,uid_validity,uid) VALUES(?1,?2,?3,?4)",params![account,entry.folder,entry.uid_validity,entry.uid]).map_err(|e|e.to_string())?;
        tx.execute("UPDATE mail_messages SET body_text=NULL,body_html=NULL,body_cached_at=NULL WHERE account_id=?1 AND folder=?2 AND uid=?3",params![account,entry.folder,entry.uid]).map_err(|e|e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    collect_garbage(db, account)
}

/// Only an unreferenced object is removed. A backup's hard link remains valid.
pub fn collect_garbage(db: &Connection, account: &str) -> Result<usize, String> {
    let hashes: Vec<String> = db
        .prepare("SELECT sha256 FROM mail_archive_gc")
        .map_err(|e| e.to_string())?
        .query_map([], |row| row.get(0))
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<_>>()
        .map_err(|e| e.to_string())?;
    let mut removed = 0;
    for hash in hashes {
        let used: bool = db
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM mail_full_messages WHERE sha256=?1)",
                [&hash],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        if !used {
            let path = object_path(&account_root(db, account)?, &hash)?;
            match fs::remove_file(path) {
                Ok(()) => {
                    removed += 1;
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(format!("Remove saved email: {e}")),
            }
        }
        db.execute("DELETE FROM mail_archive_gc WHERE sha256=?1", [hash])
            .map_err(|e| e.to_string())?;
    }
    Ok(removed)
}

pub fn snapshot_objects(
    db: &Connection,
    account: &str,
    target_root: &Path,
) -> Result<Vec<(PathBuf, PathBuf)>, String> {
    let hashes: Vec<String> = db
        .prepare("SELECT DISTINCT sha256 FROM mail_full_messages WHERE account_id=?1")
        .map_err(|e| e.to_string())?
        .query_map([account], |row| row.get(0))
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<_>>()
        .map_err(|e| e.to_string())?;
    let source_root = account_root(db, account)?;
    let mut files = Vec::new();
    for hash in hashes {
        let source = object_path(&source_root, &hash)?;
        let target = object_path(target_root, &hash)?;
        fs::create_dir_all(target.parent().unwrap()).map_err(|e| e.to_string())?;
        if fs::hard_link(&source, &target).is_err() {
            fs::copy(&source, &target).map_err(|e| format!("Snapshot saved email: {e}"))?;
        }
        files.push((
            target.strip_prefix(target_root).unwrap().to_path_buf(),
            target,
        ));
    }
    Ok(files)
}

pub fn as_sql_error(error: String) -> rusqlite::Error {
    rusqlite::Error::ToSqlConversionFailure(std::io::Error::other(error).into())
}

pub fn configured_directory(options: &str, default: &Path) -> Result<PathBuf, String> {
    let options: serde_json::Value = serde_json::from_str(options).map_err(|e| e.to_string())?;
    let directory = options
        .get("mailStorageDirectory")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    if directory.is_empty() {
        return Ok(default.to_path_buf());
    }
    let path = PathBuf::from(directory);
    if !path.is_absolute() {
        return Err("Mail storage directory must be an absolute path".into());
    }
    Ok(path)
}

fn copy_tree(source: &Path, target: &Path) -> Result<(), String> {
    if !source.exists() {
        return Ok(());
    }
    fs::create_dir_all(target).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(source).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let kind = entry.file_type().map_err(|e| e.to_string())?;
        if kind.is_symlink() {
            return Err("Mail storage migration cannot follow symbolic links".into());
        }
        let destination = target.join(entry.file_name());
        if kind.is_dir() {
            copy_tree(&entry.path(), &destination)?;
        } else if kind.is_file() {
            if fs::hard_link(entry.path(), &destination).is_err() {
                fs::copy(entry.path(), destination).map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(())
}

/// The shared handle stays the same: requests waiting on it use the new
/// connection after relocation, rather than writing to a detached old DB.
pub fn save_mail_session(
    state: &crate::state::AppState,
    config: &crate::session::models::SessionConfig,
) -> Result<(), String> {
    let target_root = configured_directory(&config.options_json, state.mail_cache_root())?;
    let _changes = state
        .mail_archive
        .changes
        .lock()
        .map_err(|e| e.to_string())?;
    state.mail_archive.stop_account(&config.id)?;
    let handle = state.mail_db(&config.id)?;
    let mut db = handle.lock().map_err(|e| e.to_string())?;
    let _worker = super::coordination::ProcessLock::try_at(
        Path::new(db.path().ok_or("Mail storage has no disk path")?), "archive",
    )?.ok_or("Another Taomni instance is storing this mailbox. Pause full storage and retry saving its settings")?;
    relocate(&mut db, &config.id, &target_root, || {
        let main_db = state.db.lock().map_err(|e| e.to_string())?;
        crate::session::db::save_session(&main_db, config).map_err(|e| e.to_string())
    })
}

pub(super) fn relocate(
    db: &mut Connection,
    account: &str,
    target_root: &Path,
    persist_settings: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    super::init_mail_tables(db).map_err(|e| e.to_string())?;
    let source = PathBuf::from(db.path().ok_or("Mail storage has no disk path")?);
    fs::create_dir_all(&target_root).map_err(|e| format!("Create mail storage directory: {e}"))?;
    let target_root = target_root.canonicalize().map_err(|e| e.to_string())?;
    let source_root = source
        .parent()
        .unwrap()
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if source_root == target_root {
        return persist_settings();
    }
    let stem = crate::state::mail_db_file_stem(account);
    let target_db = target_root.join(format!("{stem}.db"));
    let _target_lock = super::coordination::ProcessLock::access(&target_db)?;
    let _target_worker = super::coordination::ProcessLock::try_at(&target_db, "archive")?
        .ok_or("Another Taomni instance is using the destination mailbox")?;
    let target_objects = target_root.join(format!("{stem}.mail"));
    let target_attachments = target_root.join("attachments").join(&stem);
    if target_db.exists() || target_objects.exists() || target_attachments.exists() {
        return Err("The selected directory already contains this mailbox. Choose an empty location; existing mail will not be overwritten".into());
    }
    if target_root.starts_with(source_root.join(format!("{stem}.mail")))
        || target_root.starts_with(source_root.join("attachments").join(&stem))
    {
        return Err("Choose a storage directory outside this account's existing mail files".into());
    }
    let staging = tempfile::Builder::new()
        .prefix(".mail-move-")
        .tempdir_in(&target_root)
        .map_err(|e| e.to_string())?;
    let staged_db = staging.path().join("mail.db");
    db.execute("VACUUM INTO ?1", [staged_db.to_string_lossy().as_ref()])
        .map_err(|e| format!("Snapshot mail storage: {e}"))?;
    let source_objects = source_root.join(format!("{stem}.mail"));
    let source_attachments = source_root.join("attachments").join(&stem);
    copy_tree(&source_objects, &staging.path().join("objects"))?;
    copy_tree(&source_attachments, &staging.path().join("attachments"))?;
    // Only paths created by this migration are rolled back on failure.
    let mut created = Vec::new();
    let target_redirect = super::coordination::redirect_path(&target_db);
    let previous_redirect = if target_redirect.exists() {
        Some(fs::read(&target_redirect).map_err(|e| e.to_string())?)
    } else {
        None
    };
    let publication = (|| -> Result<Connection, String> {
        for (from, to) in [
            (staging.path().join("objects"), target_objects.clone()),
            (
                staging.path().join("attachments"),
                target_attachments.clone(),
            ),
        ] {
            if from.exists() {
                fs::create_dir_all(to.parent().unwrap()).map_err(|e| e.to_string())?;
                fs::rename(from, &to).map_err(|e| e.to_string())?;
                created.push(to);
            }
        }
        fs::rename(&staged_db, &target_db).map_err(|e| e.to_string())?;
        created.push(target_db.clone());
        let replacement = Connection::open(&target_db).map_err(|e| e.to_string())?;
        let integrity: String = replacement
            .query_row("PRAGMA quick_check", [], |row| row.get(0))
            .map_err(|e| e.to_string())?;
        if integrity != "ok" {
            return Err("Migrated mail database failed integrity verification".into());
        }
        // Both directories are locked. Publish a durable redirect before
        // changing settings so cached connections in other processes follow it.
        // Moving back to a previously used directory must not form a cycle.
        if previous_redirect.is_some() {
            fs::remove_file(&target_redirect).map_err(|e| e.to_string())?;
        }
        super::coordination::write_redirect(&source, &target_db)?;
        if let Err(error) = persist_settings() {
            let _ = fs::remove_file(super::coordination::redirect_path(&source));
            return Err(error);
        }
        Ok(replacement)
    })();
    match publication {
        Err(error) => {
            if let Some(bytes) = previous_redirect {
                let _ = fs::write(target_redirect, bytes);
            }
            for path in created.into_iter().rev() {
                if path.is_dir() {
                    let _ = fs::remove_dir_all(path);
                } else {
                    let _ = fs::remove_file(path);
                }
            }
            return Err(error);
        }
        Ok(replacement) => {
            *db = replacement;
        }
    }
    // The old SQLite connection has been closed before removing its files.
    for path in [
        source.clone(),
        PathBuf::from(format!("{}-wal", source.display())),
        PathBuf::from(format!("{}-shm", source.display())),
    ] {
        if path.exists() {
            if let Err(error) = fs::remove_file(&path) {
                tracing::warn!(%error,"Mail moved; old database cleanup pending at {}",path.display());
            }
        }
    }
    for path in [source_objects, source_attachments] {
        if path.exists() {
            if let Err(error) = fs::remove_dir_all(&path) {
                tracing::warn!(%error,"Mail moved; old files cleanup pending at {}",path.display());
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn default_storage_publishes_long_paths_and_preserves_complete_mime() {
        let directory = tempfile::tempdir().unwrap();
        let base = directory.path().to_path_buf();
        // Start with the ordinary profile path, just like a Quick Connect
        // mailbox. A pre-canonicalized test directory would mask the bug.
        #[cfg(windows)]
        let base = PathBuf::from(
            base.to_str()
                .unwrap()
                .strip_prefix(r"\\?\")
                .unwrap_or(base.to_str().unwrap()),
        );
        let padding = 145usize.saturating_sub(base.as_os_str().len() + 1);
        let profile = base.join("p".repeat(padding.max(1)));
        fs::create_dir_all(&profile).unwrap();
        let account = format!("quick-mail-{}@example.test_993", "account".repeat(12));
        let db_path = profile.join(format!("{}.db", crate::state::mail_db_file_stem(&account)));
        #[cfg(windows)]
        assert!(db_path.as_os_str().len() < 260);
        let db = Connection::open(&db_path).unwrap();
        super::super::init_mail_tables(&db).unwrap();
        let raw = b"Subject: full MIME on long paths\r\nContent-Type: multipart/mixed; boundary=qa\r\n\r\n--qa\r\nContent-Type: text/plain\r\n\r\nbody\r\n--qa\r\nContent-Type: application/octet-stream\r\nContent-Transfer-Encoding: base64\r\n\r\nYXR0YWNobWVudA==\r\n--qa--\r\n";
        let stored = store(&db, &account, "INBOX", 1, 10, raw.as_slice()).unwrap();
        let path = object_path(&account_root(&db, &account).unwrap(), &stored.hash).unwrap();
        assert!(path.as_os_str().len() > 260);
        assert!(path.exists());
        assert_eq!(read(&db, &account, "INBOX", 1).unwrap().unwrap(), raw);
        let duplicate = store(&db, &account, "INBOX", 2, 10, raw.as_slice()).unwrap();
        assert_eq!(duplicate.hash, stored.hash);
        db.execute("DELETE FROM mail_full_messages", []).unwrap();
        assert_eq!(collect_garbage(&db, &account).unwrap(), 1);
        assert!(!path.exists());
    }

    #[test]
    fn full_mime_round_trip_deduplicates_and_physically_removes_last_reference() {
        let directory = tempfile::tempdir().unwrap();
        let db = Connection::open(directory.path().join("qa.db")).unwrap();
        super::super::init_mail_tables(&db).unwrap();
        for uid in [1, 2] {
            db.execute("INSERT INTO mail_messages(account_id,folder,uid,updated_at) VALUES('qa','INBOX',?1,0)",[uid]).unwrap();
        }
        let raw = format!(
            "From: a@example.test\r\nSubject: complete\r\n\r\n{}",
            "body and attachment bytes\r\n".repeat(20000)
        )
        .into_bytes();
        let first = store(&db, "qa", "INBOX", 1, 10, raw.as_slice()).unwrap();
        let second = store(&db, "qa", "INBOX", 2, 10, raw.as_slice()).unwrap();
        assert_eq!(first.hash, second.hash);
        assert!(first.stored_size < first.raw_size / 10);
        assert_eq!(read(&db, "qa", "INBOX", 1).unwrap().unwrap(), raw);
        db.execute("DELETE FROM mail_messages WHERE uid=1", [])
            .unwrap();
        assert_eq!(read(&db, "qa", "INBOX", 1).unwrap().unwrap(), raw);
        db.execute("DELETE FROM mail_full_messages WHERE uid=1", [])
            .unwrap();
        assert_eq!(collect_garbage(&db, "qa").unwrap(), 0);
        let opened = open(&db, "qa", "INBOX", 2).unwrap().unwrap();
        let snapshot = directory.path().join("snapshot");
        let pinned = snapshot_objects(&db, "qa", &snapshot).unwrap();
        db.execute("DELETE FROM mail_messages WHERE uid=2", [])
            .unwrap();
        db.execute("DELETE FROM mail_full_messages WHERE uid=2", [])
            .unwrap();
        assert_eq!(collect_garbage(&db, "qa").unwrap(), 1);
        // In-flight readers retain their descriptor across explicit cleanup.
        assert_eq!(opened.read().unwrap(), raw);
        assert!(
            !object_path(&account_root(&db, "qa").unwrap(), &first.hash)
                .unwrap()
                .exists()
        );
        verify_object(&pinned[0].1, &first.hash, first.raw_size, std::io::sink()).unwrap();
    }

    #[test]
    fn relocation_switches_the_existing_connection_and_rolls_back_publication_failure() {
        let source = tempfile::tempdir().unwrap();
        let target = tempfile::tempdir().unwrap();
        let stem = crate::state::mail_db_file_stem("qa");
        let source_path = source.path().join(format!("{stem}.db"));
        let mut db = Connection::open(&source_path).unwrap();
        super::super::init_mail_tables(&db).unwrap();
        let raw = b"Subject: moving\r\n\r\noriginal";
        store(&db, "qa", "INBOX", 1, 10, raw.as_slice()).unwrap();
        let partial = account_root(&db, "qa").unwrap().join("partial/qa.part");
        fs::create_dir_all(partial.parent().unwrap()).unwrap();
        fs::write(&partial, b"resumable bytes").unwrap();
        let attachment =
            super::super::parts::attachment_cache_path(source.path(), &stem, "INBOX", 1, "2");
        fs::create_dir_all(attachment.parent().unwrap()).unwrap();
        fs::write(&attachment, b"cached attachment").unwrap();
        assert!(
            relocate(&mut db, "qa", target.path(), || Err(
                "settings save failed".into()
            ))
            .is_err()
        );
        assert_eq!(read(&db, "qa", "INBOX", 1).unwrap().unwrap(), raw);
        assert!(source_path.exists());
        assert!(!target.path().join(format!("{stem}.db")).exists());
        relocate(&mut db, "qa", target.path(), || Ok(())).unwrap();
        assert!(!source_path.exists());
        assert_eq!(
            fs::read(account_root(&db, "qa").unwrap().join("partial/qa.part")).unwrap(),
            b"resumable bytes"
        );
        assert_eq!(
            fs::read(super::super::parts::attachment_cache_path(
                target.path(),
                &stem,
                "INBOX",
                1,
                "2"
            ))
            .unwrap(),
            b"cached attachment"
        );
        assert_eq!(read(&db, "qa", "INBOX", 1).unwrap().unwrap(), raw);
        assert_eq!(
            Path::new(db.path().unwrap()).parent().unwrap(),
            target.path().canonicalize().unwrap()
        );
        let collision = source.path().join(format!("{stem}.db"));
        fs::write(&collision, b"existing unrelated file").unwrap();
        assert!(relocate(&mut db, "qa", source.path(), || Ok(())).is_err());
        assert_eq!(fs::read(collision).unwrap(), b"existing unrelated file");
    }

    #[test]
    fn uidvalidity_and_cleanup_keep_history_separate_from_current_mail() {
        let directory = tempfile::tempdir().unwrap();
        let db = Connection::open(directory.path().join("qa.db")).unwrap();
        super::super::init_mail_tables(&db).unwrap();
        db.execute("INSERT INTO mail_folders(account_id,name,uid_validity,updated_at) VALUES('qa','INBOX',10,0)",[]).unwrap();
        store(&db, "qa", "INBOX", 1, 10, &b"Subject: old\r\n\r\nold"[..]).unwrap();
        db.execute("UPDATE mail_folders SET uid_validity=20", [])
            .unwrap();
        assert!(read(&db, "qa", "INBOX", 1).unwrap().is_none());
        store(&db, "qa", "INBOX", 1, 20, &b"Subject: new\r\n\r\nnew"[..]).unwrap();
        let entries = list(&db, "qa", 0).unwrap();
        assert_eq!(entries.len(), 2);
        let old = entries
            .iter()
            .find(|e| e.uid_validity == 10)
            .unwrap()
            .clone();
        assert!(
            String::from_utf8(read_entry(&db, "qa", &old).unwrap())
                .unwrap()
                .contains("old")
        );
        assert_eq!(remove_entries(&db, "qa", &[old]).unwrap(), 1);
        assert_eq!(list(&db, "qa", 0).unwrap().len(), 1);
        assert!(
            String::from_utf8(read(&db, "qa", "INBOX", 1).unwrap().unwrap())
                .unwrap()
                .contains("new")
        );
        assert_eq!(
            db.query_row("SELECT count(*) FROM mail_archive_skipped", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }

    #[test]
    fn folder_selection_keeps_exact_names_and_inbox_case_rules() {
        let mut settings = super::super::MailCacheSettings::default();
        assert!(stores_full(&settings, "Archive"));
        settings.full_message_mode = FullMessageMode::Include;
        settings.full_message_folders = vec!["inbox".into(), "Projects/A".into()];
        assert!(stores_full(&settings, "INBOX"));
        assert!(stores_full(&settings, "Projects/A"));
        assert!(!stores_full(&settings, "projects/a"));
        settings.full_message_mode = FullMessageMode::Exclude;
        assert!(!stores_full(&settings, "INBOX"));
        assert!(stores_full(&settings, "Sent"));
        assert!(
            configured_directory(
                r#"{"mailStorageDirectory":"relative"}"#,
                directory_default()
            )
            .is_err()
        );
    }
    #[test]
    fn readable_folder_selection_matches_imap_keys_for_include_and_exclude() {
        for (selection, folder, selected) in [
            ("台北", "&U,BTFw-", true),
            ("&U,BTFw-", "&U,BTFw-", true),
            ("  台北  ", "&U,BTFw-", true),
            ("Projects/台北", "Projects/&U,BTFw-", true),
            ("台北", "Projects/&U,BTFw-", false),
            ("projects/台北", "Projects/&U,BTFw-", false),
            ("A & B", "A &- B", true),
            ("中文", "中文", true),
            ("inbox", "INBOX", true),
            ("archive", "Archive", false),
            ("Other", "&U,BTFw-", false),
        ] {
            let mut settings = super::super::MailCacheSettings {
                full_message_mode: FullMessageMode::Include,
                full_message_folders: vec![selection.into()],
                ..Default::default()
            };
            assert_eq!(
                stores_full(&settings, folder),
                selected,
                "include {selection} / {folder}"
            );
            settings.full_message_mode = FullMessageMode::Exclude;
            assert_eq!(
                stores_full(&settings, folder),
                !selected,
                "exclude {selection} / {folder}"
            );
        }
    }

    fn directory_default() -> &'static Path {
        Path::new("/unused-test-default")
    }

    #[test]
    fn damaged_object_never_replaces_an_exported_email() {
        let directory = tempfile::tempdir().unwrap();
        let db = Connection::open(directory.path().join("qa.db")).unwrap();
        super::super::init_mail_tables(&db).unwrap();
        let entry = store(
            &db,
            "qa",
            "INBOX",
            1,
            10,
            &b"Subject: test\r\n\r\ncomplete"[..],
        )
        .unwrap();
        fs::write(
            object_path(&account_root(&db, "qa").unwrap(), &entry.hash).unwrap(),
            b"broken",
        )
        .unwrap();
        let target = directory.path().join("saved.eml");
        fs::write(&target, b"previous working export").unwrap();
        assert!(export(&db, "qa", "INBOX", 1, &target).is_err());
        assert_eq!(fs::read(target).unwrap(), b"previous working export");
        assert!(object_path(directory.path(), "../escape").is_err());
    }
}
