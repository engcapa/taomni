use super::{NotepadBackupContent, NotepadBackupEntry, notepad_root};
use crate::viewer::{HARD_TEXT_BYTES, path_io_error};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_BACKUPS_PER_DOC: usize = 10;

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredBackupFile {
    entry: NotepadBackupEntry,
    content: String,
}

fn backups_dir(app_data_dir: &Path) -> PathBuf {
    notepad_root(app_data_dir).join("backups")
}

fn doc_bucket_name(doc_id: &str) -> String {
    hex::encode(Sha256::digest(doc_id.as_bytes()))
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn safe_id(raw: &str) -> Result<(), String> {
    if raw.is_empty()
        || raw.contains(['/', '\\', '\0'])
        || raw.contains("..")
        || !raw
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("permission: Invalid backup identifier".into());
    }
    Ok(())
}

pub(crate) fn backup_write(
    app_data_dir: &Path,
    doc_id: &str,
    path: Option<&str>,
    name: &str,
    content: &str,
    encoding: &str,
    bom: bool,
    eol: &str,
    saved_hash: &str,
) -> Result<NotepadBackupEntry, String> {
    if content.len() as u64 > HARD_TEXT_BYTES {
        return Err("too_large: Backup content exceeds 20 MiB".into());
    }
    let bucket = doc_bucket_name(doc_id);
    let dir = backups_dir(app_data_dir).join(&bucket);
    fs::create_dir_all(&dir).map_err(|e| path_io_error("create backup directory", e))?;
    let ts = now_millis();
    let id = format!("{bucket}__{ts}");
    let entry = NotepadBackupEntry {
        id: id.clone(),
        doc_id: doc_id.to_string(),
        path: path.map(ToString::to_string),
        name: name.to_string(),
        encoding: encoding.to_string(),
        bom,
        eol: eol.to_string(),
        saved_hash: saved_hash.to_string(),
        updated_at: now_secs(),
        size: content.len(),
    };
    let payload = serde_json::to_vec(&StoredBackupFile {
        entry: entry.clone(),
        content: content.to_string(),
    })
    .map_err(|e| format!("io: Serialize backup failed: {e}"))?;
    let file_path = dir.join(format!("{ts}.json"));
    let tmp = dir.join(format!(".{ts}-{}.tmp", uuid::Uuid::new_v4().simple()));
    fs::write(&tmp, payload).map_err(|e| path_io_error("write backup temp", e))?;
    crate::atomic_replace::retry(|| fs::rename(&tmp, &file_path)).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        path_io_error("commit backup file", e)
    })?;

    // Prune older snapshots beyond MAX_BACKUPS_PER_DOC
    if let Ok(entries) = fs::read_dir(&dir) {
        let mut files: Vec<PathBuf> = entries
            .filter_map(|e| e.ok().map(|v| v.path()))
            .filter(|p| p.extension().and_then(|s| s.to_str()) == Some("json"))
            .collect();
        files.sort();
        if files.len() > MAX_BACKUPS_PER_DOC {
            for old in &files[..files.len() - MAX_BACKUPS_PER_DOC] {
                let _ = fs::remove_file(old);
            }
        }
    }
    Ok(entry)
}

pub(crate) fn backup_list(app_data_dir: &Path) -> Result<Vec<NotepadBackupEntry>, String> {
    let root = backups_dir(app_data_dir);
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut latest_per_doc: std::collections::HashMap<String, NotepadBackupEntry> =
        std::collections::HashMap::new();
    let dirs = fs::read_dir(&root).map_err(|e| path_io_error("read backup root", e))?;
    for bucket in dirs.flatten() {
        let path = bucket.path();
        if !path.is_dir() {
            continue;
        }
        let Ok(files) = fs::read_dir(&path) else {
            continue;
        };
        for file in files.flatten() {
            let fpath = file.path();
            if fpath.extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            let Ok(bytes) = fs::read(&fpath) else {
                continue;
            };
            let Ok(parsed) = serde_json::from_slice::<StoredBackupFile>(&bytes) else {
                continue;
            };
            latest_per_doc
                .entry(parsed.entry.doc_id.clone())
                .and_modify(|existing| {
                    if parsed.entry.updated_at >= existing.updated_at
                        && parsed.entry.id > existing.id
                    {
                        *existing = parsed.entry.clone();
                    }
                })
                .or_insert(parsed.entry);
        }
    }
    let mut list: Vec<NotepadBackupEntry> = latest_per_doc.into_values().collect();
    list.sort_by(|a, b| {
        b.updated_at
            .cmp(&a.updated_at)
            .then_with(|| b.id.cmp(&a.id))
    });
    Ok(list)
}

pub(crate) fn backup_read(app_data_dir: &Path, id: &str) -> Result<NotepadBackupContent, String> {
    let (bucket, ts) = id
        .split_once("__")
        .ok_or_else(|| "not_found: Invalid backup id format".to_string())?;
    safe_id(bucket)?;
    safe_id(ts)?;
    let target = backups_dir(app_data_dir)
        .join(bucket)
        .join(format!("{ts}.json"));
    let bytes = fs::read(&target).map_err(|e| path_io_error("read backup file", e))?;
    let parsed: StoredBackupFile =
        serde_json::from_slice(&bytes).map_err(|e| format!("corrupt: Backup file corrupt: {e}"))?;
    Ok(NotepadBackupContent {
        entry: parsed.entry,
        content: parsed.content,
    })
}

pub(crate) fn backup_prune(app_data_dir: &Path, doc_id: &str) -> Result<(), String> {
    let dir = backups_dir(app_data_dir).join(doc_bucket_name(doc_id));
    if !dir.exists() {
        return Ok(());
    }
    fs::remove_dir_all(&dir).map_err(|e| path_io_error("prune document backups", e))
}

pub(crate) fn save_backup_copy(
    app_data_dir: &Path,
    source_path: &str,
    mode: &str,
    custom_dir: Option<&str>,
) -> Result<Option<String>, String> {
    if mode == "none" {
        return Ok(None);
    }
    let src = Path::new(source_path);
    if !src.is_absolute() || !src.is_file() {
        return Err("not_found: Source file missing for backup".into());
    }
    let bytes = fs::read(src).map_err(|e| path_io_error("read source for backup", e))?;
    let name = src
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("file.txt");
    let dest_dir = match custom_dir.map(str::trim).filter(|s| !s.is_empty()) {
        Some(dir) => PathBuf::from(dir),
        None => notepad_root(app_data_dir).join("save-backups"),
    };
    fs::create_dir_all(&dest_dir).map_err(|e| path_io_error("create save backup dir", e))?;
    let backup_name = if mode == "verbose" {
        format!("{name}.{}.bak", now_millis())
    } else {
        format!("{name}.bak")
    };
    let dest = dest_dir.join(backup_name);
    fs::write(&dest, bytes).map_err(|e| path_io_error("write save backup copy", e))?;
    Ok(Some(dest.to_string_lossy().into_owned()))
}
