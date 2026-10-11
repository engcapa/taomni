use super::crypto::{ERR_BACKUP_PASSWORD_REQUIRED, decrypt_payload, is_encrypted_bytes};
use super::manifest::{BackupManifest, MANIFEST_FILE_NAME, file_sha256};
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};
use tauri::AppHandle;
use zip::ZipArchive;

pub const RESTORE_INTENT_FILE: &str = "restore_intent.json";
pub const PENDING_RESTORE_DIR: &str = ".pending_restore";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StageRestoreResult {
    pub manifest: BackupManifest,
    pub restart_required: bool,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RestoreIntent {
    staged_at: i64,
    manifest: BackupManifest,
}

/// Extract and read bytes from archive, decrypting if necessary.
fn read_archive_zip_bytes(archive_path: &Path, password: Option<&str>) -> Result<Vec<u8>, String> {
    let mut file = File::open(archive_path)
        .map_err(|e| format!("open archive file {}: {e}", archive_path.display()))?;
    let mut data = Vec::new();
    file.read_to_end(&mut data)
        .map_err(|e| format!("read archive file: {e}"))?;

    if is_encrypted_bytes(&data) {
        let pw = password.unwrap_or_default().trim();
        if pw.is_empty() {
            return Err(ERR_BACKUP_PASSWORD_REQUIRED.into());
        }
        decrypt_payload(&data, pw)
    } else {
        Ok(data)
    }
}

const MAX_ARCHIVE_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_EXTRACTED_BYTES: u64 = 8 * 1024 * 1024 * 1024;
const JOURNAL_FILE: &str = "restore_journal.json";

fn checked_path(name: &str) -> Result<(), String> {
    if name.is_empty()
        || name.contains('\\')
        || name.contains(':')
        || name.starts_with('/')
        || name.split('/').any(|p| {
            p.is_empty()
                || p == "."
                || p == ".."
                || p.ends_with('.')
                || p.ends_with(' ')
                || p.chars().any(|c| c.is_control())
        })
    {
        return Err(format!("Unsafe backup path: {name}"));
    }
    for part in name.split('/') {
        let base = part.split('.').next().unwrap_or("").to_ascii_uppercase();
        if ["CON", "PRN", "AUX", "NUL"].contains(&base.as_str())
            || (base.len() == 4
                && (base.starts_with("COM") || base.starts_with("LPT"))
                && base.as_bytes()[3].is_ascii_digit())
        {
            return Err("Reserved backup path".into());
        }
    }
    Ok(())
}

fn destination(app_data: &Path, name: &str) -> Result<PathBuf, String> {
    checked_path(name)?;
    let target = match name {
        "databases/taomni.db" => app_data.join("taomni.db"),
        "databases/notes.db" => app_data.join("notes.db"),
        "databases/vault.db" => app_data.join("vault.db"),
        "databases/mfa.db" => app_data.join("mfa.db"),
        "databases/lanchat.sqlite" => app_data.join("lanchat.sqlite"),
        "configs/tunnels.json" => app_data.join("tunnels.json"),
        "configs/ai.json" | "configs/proxy.json" | "configs/mirror.json" | "configs/sdk.json" => {
            crate::resolved_config_dir()
                .ok_or("Configuration directory unavailable")?
                .join("taomni")
                .join(name.strip_prefix("configs/").unwrap())
        }
        "servers/ssh_host_ed25519" => app_data.join("ssh-server/host_ed25519"),
        "servers/rdp_cert.pem" => app_data.join("rdp-server/cert.pem"),
        "servers/rdp_key.pem" => app_data.join("rdp-server/key.pem"),
        "local-history/history.db" => app_data.join(name),
        _ if name.starts_with("mail-cache/")
            && name.ends_with(".db")
            && name.split('/').count() == 2 =>
        {
            app_data.join(name)
        }
        _ => return Err(format!("Unsupported Taomni backup entry: {name}")),
    };
    Ok(target)
}

fn verified_archive(
    path: &Path,
    password: Option<&str>,
) -> Result<(BackupManifest, ZipArchive<Cursor<Vec<u8>>>), String> {
    if std::fs::metadata(path).map_err(|e| e.to_string())?.len() > MAX_ARCHIVE_BYTES {
        return Err("Archive exceeds the supported 1 GiB limit".into());
    }
    let encrypted =
        super::crypto::is_encrypted_stream(File::open(path).map_err(|e| e.to_string())?);
    let mut archive = ZipArchive::new(Cursor::new(read_archive_zip_bytes(path, password)?))
        .map_err(|e| format!("Invalid archive: {e}"))?;
    if archive.len() > 100_000 {
        return Err("Too many archive entries".into());
    }
    let manifest: BackupManifest = {
        let f = archive
            .by_name(MANIFEST_FILE_NAME)
            .map_err(|_| "Missing manifest.json")?;
        if f.size() > 16 * 1024 * 1024 {
            return Err("Manifest is too large".into());
        }
        serde_json::from_reader(f).map_err(|_| "Invalid backup manifest")?
    };
    if manifest.format_version != 1
        || manifest.app_name != "Taomni"
        || manifest.encrypted != encrypted
    {
        return Err("Unsupported or inconsistent backup format".into());
    }
    if manifest
        .provenance
        .as_ref()
        .is_some_and(|p| p.source_kind != "taomni" || p.source_schema_version != 1)
    {
        return Err("Unsupported backup source; save the archive without restoring it".into());
    }
    let mut entries = std::collections::HashMap::new();
    let mut names = std::collections::HashSet::new();
    let mut total = 0u64;
    for entry in &manifest.files {
        destination(Path::new("."), &entry.path)?;
        if !names.insert(entry.path.to_lowercase()) {
            return Err("Duplicate backup entry".into());
        }
        total = total
            .checked_add(entry.size_bytes)
            .ok_or("Backup size overflow")?;
        if total > MAX_EXTRACTED_BYTES {
            return Err("Unpacked archive exceeds 8 GiB limit".into());
        }
        entries.insert(entry.path.as_str(), entry);
    }
    if entries.is_empty() {
        return Err("Backup contains no data".into());
    }
    let mut seen = std::collections::HashSet::new();
    for i in 0..archive.len() {
        let mut file = archive.by_index(i).map_err(|e| e.to_string())?;
        let name = file.name().to_owned();
        if !seen.insert(name.to_lowercase()) {
            return Err("Duplicate ZIP entry".into());
        }
        if name == MANIFEST_FILE_NAME {
            continue;
        }
        checked_path(&name)?;
        if file.is_dir() || file.unix_mode().is_some_and(|m| m & 0o170000 == 0o120000) {
            return Err("Directories and symlinks are not backup payload entries".into());
        }
        let expected = entries
            .get(name.as_str())
            .ok_or("Archive contains an entry absent from its manifest")?;
        if file.size() != expected.size_bytes {
            return Err(format!("Size mismatch for {name}"));
        }
        use sha2::{Digest, Sha256};
        let mut hash = Sha256::new();
        let mut buffer = [0u8; 65536];
        let mut length = 0u64;
        loop {
            let n = file.read(&mut buffer).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            length += n as u64;
            if length > expected.size_bytes {
                return Err("Decompressed entry exceeded manifest size".into());
            }
            hash.update(&buffer[..n]);
        }
        if length != expected.size_bytes || hex::encode(hash.finalize()) != expected.sha256 {
            return Err(format!("Checksum mismatch for {name}"));
        }
    }
    if seen.len() != manifest.files.len() + 1 {
        return Err("Archive is missing a manifest entry".into());
    }
    Ok((manifest, archive))
}

pub fn inspect_archive(path: &Path, password: Option<&str>) -> Result<BackupManifest, String> {
    verified_archive(path, password).map(|(m, _)| m)
}
pub fn stage_restore(
    app: &AppHandle,
    path: &Path,
    password: Option<&str>,
) -> Result<StageRestoreResult, String> {
    stage_restore_to_dir(&crate::resolved_app_data_dir(app)?, path, password)
}

pub fn stage_restore_to_dir(
    app_data: &Path,
    path: &Path,
    password: Option<&str>,
) -> Result<StageRestoreResult, String> {
    let (manifest, mut archive) = verified_archive(path, password)?;
    if app_data.join(RESTORE_INTENT_FILE).exists() || app_data.join(JOURNAL_FILE).exists() {
        return Err("A restore is already staged; restart before preparing another restore".into());
    }
    std::fs::create_dir_all(app_data).map_err(|e| e.to_string())?;
    let temp = tempfile::Builder::new()
        .prefix(".restore-verify-")
        .tempdir_in(app_data)
        .map_err(|e| e.to_string())?;
    for entry in &manifest.files {
        let output = temp.path().join(&entry.path);
        std::fs::create_dir_all(output.parent().unwrap()).map_err(|e| e.to_string())?;
        let mut out = File::create(&output).map_err(|e| e.to_string())?;
        std::io::copy(
            &mut archive.by_name(&entry.path).map_err(|e| e.to_string())?,
            &mut out,
        )
        .map_err(|e| e.to_string())?;
        out.sync_all().map_err(|e| e.to_string())?;
        if entry.path.ends_with(".db") || entry.path.ends_with(".sqlite") {
            let db = rusqlite::Connection::open_with_flags(
                &output,
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
            )
            .map_err(|e| format!("Invalid SQLite backup: {e}"))?;
            let check: String = db
                .query_row("PRAGMA quick_check", [], |r| r.get(0))
                .map_err(|e| e.to_string())?;
            if check != "ok" {
                return Err(format!("SQLite backup check failed: {check}"));
            }
        }
    }
    let temp_path = temp.keep();
    let pending = app_data.join(PENDING_RESTORE_DIR);
    if pending.exists() {
        std::fs::remove_dir_all(&pending).map_err(|e| e.to_string())?;
    }
    std::fs::rename(&temp_path, &pending).map_err(|e| {
        let _ = std::fs::remove_dir_all(&temp_path);
        e.to_string()
    })?;
    let intent = RestoreIntent {
        staged_at: super::model::now_ms(),
        manifest: manifest.clone(),
    };
    super::control::write_json(&app_data.join(RESTORE_INTENT_FILE), &intent)?;
    Ok(StageRestoreResult {
        manifest,
        restart_required: true,
        message: "Backup verified and staged. Restart to restore.".into(),
    })
}

#[derive(Serialize, Deserialize)]
struct RollbackEntry {
    path: PathBuf,
    saved: PathBuf,
    existed: bool,
}
#[derive(Serialize, Deserialize)]
struct RestoreJournal {
    entries: Vec<RollbackEntry>,
    committed: bool,
}

fn no_symlink_ancestors(path: &Path) -> Result<(), String> {
    for ancestor in path.ancestors() {
        if std::fs::symlink_metadata(ancestor).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err("Restore destination contains a symlink".into());
        }
    }
    Ok(())
}
fn replace_file(src: &Path, dst: &Path) -> Result<(), String> {
    no_symlink_ancestors(dst)?;
    let parent = dst.parent().ok_or("Invalid restore destination")?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let tmp = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    std::fs::copy(src, tmp.path()).map_err(|e| e.to_string())?;
    tmp.as_file().sync_all().map_err(|e| e.to_string())?;
    tmp.persist(dst).map_err(|e| e.error.to_string())?;
    Ok(())
}
fn rollback(journal: &RestoreJournal) -> Result<(), String> {
    for entry in &journal.entries {
        if entry.existed {
            replace_file(&entry.saved, &entry.path)?;
        } else if entry.path.exists() {
            std::fs::remove_file(&entry.path).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Fail startup rather than opening a partially restored set of databases.
pub fn apply_pending_restore(app_data: &Path) -> Result<(), String> {
    let intent_path = app_data.join(RESTORE_INTENT_FILE);
    let journal_path = app_data.join(JOURNAL_FILE);
    let pending = app_data.join(PENDING_RESTORE_DIR);
    if journal_path.exists() {
        let journal: RestoreJournal =
            serde_json::from_slice(&std::fs::read(&journal_path).map_err(|e| e.to_string())?)
                .map_err(|_| "Invalid restore journal")?;
        if !journal.committed {
            rollback(&journal)?;
        }
        if intent_path.exists() {
            std::fs::remove_file(&intent_path).map_err(|e| e.to_string())?;
        }
        std::fs::remove_file(&journal_path).map_err(|e| e.to_string())?;
        if pending.exists() {
            std::fs::remove_dir_all(&pending).map_err(|e| e.to_string())?;
        }
        return Ok(());
    }
    if !intent_path.exists() {
        return Ok(());
    }
    let intent: RestoreIntent =
        serde_json::from_slice(&std::fs::read(&intent_path).map_err(|e| e.to_string())?)
            .map_err(|_| "Invalid restore intent")?;
    if intent.manifest.format_version != 1 || intent.manifest.app_name != "Taomni" {
        return Err("Unsupported restore intent".into());
    }
    let safety = app_data
        .join("backups")
        .join(format!("restore-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&safety).map_err(|e| e.to_string())?;
    let mut journal = RestoreJournal {
        entries: vec![],
        committed: false,
    };
    let mut mappings = vec![];
    for entry in &intent.manifest.files {
        let src = pending.join(&entry.path);
        let dst = destination(app_data, &entry.path)?;
        no_symlink_ancestors(&src)?;
        no_symlink_ancestors(&dst)?;
        if file_sha256(&src).map_err(|e| e.to_string())? != entry.sha256
            || std::fs::metadata(&src).map_err(|e| e.to_string())?.len() != entry.size_bytes
        {
            return Err("Staged restore data changed".into());
        }
        let mut paths = vec![dst.clone()];
        if entry.path.ends_with(".db") || entry.path.ends_with(".sqlite") {
            paths.push(PathBuf::from(format!("{}-wal", dst.display())));
            paths.push(PathBuf::from(format!("{}-shm", dst.display())));
        }
        for path in paths {
            no_symlink_ancestors(&path)?;
            let saved = safety.join(journal.entries.len().to_string());
            let existed = path.try_exists().map_err(|e| e.to_string())?;
            if existed {
                std::fs::copy(&path, &saved)
                    .map_err(|e| format!("Cannot save restore rollback copy: {e}"))?;
                std::fs::OpenOptions::new()
                    .write(true)
                    .open(&saved)
                    .and_then(|f| f.sync_all())
                    .map_err(|e| e.to_string())?;
            }
            journal.entries.push(RollbackEntry {
                path,
                saved,
                existed,
            });
        }
        mappings.push((src, dst));
    }
    super::control::write_json(&journal_path, &journal)?;
    let apply = (|| -> Result<(), String> {
        for (src, dst) in &mappings {
            replace_file(src, dst)?;
            for suffix in ["-wal", "-shm"] {
                let aux = PathBuf::from(format!("{}{suffix}", dst.display()));
                if aux.exists() {
                    std::fs::remove_file(aux).map_err(|e| e.to_string())?;
                }
            }
        }
        Ok(())
    })();
    if let Err(error) = apply {
        rollback(&journal).map_err(|e| {
            format!("Restore failed ({error}); rollback also failed ({e}); recovery files retained")
        })?;
        return Err(format!("Restore failed and was rolled back: {error}"));
    }
    journal.committed = true;
    super::control::write_json(&journal_path, &journal)?;
    // Retain the historical safety-copy location for existing users and tooling.
    let legacy = app_data.join("backups/pre_restore_safety_copy");
    std::fs::create_dir_all(&legacy).map_err(|e| e.to_string())?;
    for entry in &journal.entries {
        if entry.existed && entry.path.parent() == Some(app_data) {
            if let Some(name) = entry.path.file_name() {
                std::fs::copy(&entry.saved, legacy.join(name)).map_err(|e| e.to_string())?;
            }
        }
    }
    std::fs::remove_file(&intent_path).map_err(|e| e.to_string())?;
    std::fs::remove_dir_all(&pending).map_err(|e| e.to_string())?;
    std::fs::remove_file(&journal_path).map_err(|e| e.to_string())?;
    Ok(())
}
