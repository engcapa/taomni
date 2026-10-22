use super::model::FullMessage;
use super::model::FullMessageMode;
use super::reading::open;
use flate2::read::GzDecoder;
use rusqlite::Connection;
use rusqlite::OptionalExtension;
use rusqlite::params;
use std::fs::File;
use std::io::Read;
use std::path::Path;
use std::path::PathBuf;

pub fn stores_full(settings: &super::super::MailCacheSettings, folder: &str) -> bool {
    // Keep old exact server keys working, and accept the full readable path
    // entered before the account has ever connected or cached its folders.
    let readable_folder = super::super::decode_imap_modified_utf7(folder);
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
    )?;
    super::super::archive_query::init_index(db)
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

pub(in crate::mail) fn legacy_attachment_flag(
    db: &Connection,
    account: &str,
    hash: &str,
) -> Result<bool, String> {
    let path = object_path(&account_root(db, account)?, hash)?;
    let mut reader = GzDecoder::new(File::open(path).map_err(|e| e.to_string())?);
    let mut scan = super::super::archive_metadata::AttachmentScan::default();
    let mut buffer = [0u8; 65536];
    loop {
        let n = reader.read(&mut buffer).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        scan.feed(&buffer[..n]);
        if scan.found {
            break;
        }
    }
    Ok(scan.found)
}

pub(super) fn object_path(root: &Path, hash: &str) -> Result<PathBuf, String> {
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
