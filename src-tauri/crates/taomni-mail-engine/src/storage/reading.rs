use super::index::account_root;
use super::index::lookup;
use super::index::object_path;
use super::model::ArchiveEntry;
use crate::archive::{verify_message, verify_message_with};
use rusqlite::Connection;
use rusqlite::params;
use std::fs;
use std::fs::File;
use std::path::Path;

/// Open while the DB lock protects the object reference, then release that
/// lock before decompressing, parsing or exporting a potentially large MIME.
/// The open descriptor remains valid if cleanup or relocation removes its path.
pub struct OpenMessage {
    pub(super) file: File,
    pub(super) hash: String,
    pub raw_size: u64,
}

impl OpenMessage {
    pub fn read(self) -> Result<Vec<u8>, String> {
        self.read_with(|| Ok(()))
    }

    pub fn read_with(self, check: impl Fn() -> Result<(), String>) -> Result<Vec<u8>, String> {
        if self.raw_size > 512 * 1024 * 1024 {
            return Err("This saved email exceeds the 512 MiB reader limit; save its original EML to open it externally".into());
        }
        let mut bytes = Vec::new();
        verify_message_with(self.file, &self.hash, self.raw_size, &mut bytes, check)?;
        Ok(bytes)
    }

    pub fn export(self, target: &Path) -> Result<u64, String> {
        let parent = target.parent().ok_or("Invalid email export path")?;
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
        verify_message(self.file, &self.hash, self.raw_size, temp.as_file_mut())?;
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
    open_file: impl FnOnce(&Path) -> Result<File, String>,
) -> Result<OpenMessage, String> {
    let file = open_file(&object_path(&account_root(db, account)?, &hash)?)?;
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
    open_with(db, account, folder, uid, open_file)
}

/// Resolve the indexed object and let the storage owner open the verified path.
pub fn open_with(
    db: &Connection,
    account: &str,
    folder: &str,
    uid: u32,
    open_file: impl FnOnce(&Path) -> Result<File, String>,
) -> Result<Option<OpenMessage>, String> {
    lookup(db, account, folder, uid)?
        .map(|entry| open_object(db, account, entry.hash, entry.raw_size, open_file))
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
    open_object(db, account, hash, size, open_file)
}

fn open_file(path: &Path) -> Result<File, String> {
    File::open(path).map_err(|error| format!("Open saved email: {error}"))
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
