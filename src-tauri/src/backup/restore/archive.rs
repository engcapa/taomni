//! Decode and verify every byte before staging a restore.
use super::super::crypto::{ERR_BACKUP_PASSWORD_REQUIRED, decrypt_payload, is_encrypted_bytes};
use super::super::manifest::{BackupManifest, MANIFEST_FILE_NAME};
use super::super::plugins::contracts::PluginDataFileKind;
use super::paths::{checked_path, destination};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use zip::ZipArchive;

/// New archives and V2 encryption are streamed through files, independent of
/// mailbox size. V1 remains readable with its original 1 GiB format limit.
fn archive_file(
    path: &Path,
    password: Option<&str>,
    context: &super::super::snapshot_context::SnapshotContext,
) -> Result<File, String> {
    context.check()?;
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    let mut magic = [0u8; 13];
    let n = file.read(&mut magic).map_err(|e| e.to_string())?;
    file.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
    if !is_encrypted_bytes(&magic[..n]) {
        return Ok(file);
    }
    let password = password.unwrap_or_default().trim();
    if password.is_empty() {
        return Err(ERR_BACKUP_PASSWORD_REQUIRED.into());
    }
    let mut decoded = tempfile::tempfile().map_err(|e| e.to_string())?;
    if &magic == super::super::crypto::BACKUP_ENC_STREAM_MAGIC {
        super::super::crypto::decrypt_stream(context.reader(file), password, &mut decoded)?;
    } else {
        if file.metadata().map_err(|e| e.to_string())?.len() > 1024 * 1024 * 1024 {
            return Err("Legacy encrypted backup exceeds 1 GiB".into());
        }
        let mut data = Vec::new();
        file.read_to_end(&mut data).map_err(|e| e.to_string())?;
        std::io::Write::write_all(&mut decoded, &decrypt_payload(&data, password)?)
            .map_err(|e| e.to_string())?;
    }
    decoded
        .seek(SeekFrom::Start(0))
        .map_err(|e| e.to_string())?;
    Ok(decoded)
}

const MAX_ARCHIVE_BYTES: u64 = 1024 * 1024 * 1024 * 1024;
const MAX_EXTRACTED_BYTES: u64 = 2 * MAX_ARCHIVE_BYTES;

pub(super) fn verified_archive_with_context(
    path: &Path,
    password: Option<&str>,
    context: &super::super::snapshot_context::SnapshotContext,
) -> Result<(BackupManifest, ZipArchive<File>), String> {
    if std::fs::metadata(path).map_err(|e| e.to_string())?.len() > MAX_ARCHIVE_BYTES {
        return Err("Archive exceeds the supported 1 TiB limit".into());
    }
    let encrypted =
        super::super::crypto::is_encrypted_stream(File::open(path).map_err(|e| e.to_string())?);
    let mut archive = ZipArchive::new(archive_file(path, password, context)?)
        .map_err(|e| format!("Invalid archive: {e}"))?;
    if archive.len() > 1_000_000 {
        return Err("Too many archive entries".into());
    }
    let manifest: BackupManifest = {
        let f = archive
            .by_name(MANIFEST_FILE_NAME)
            .map_err(|_| "Missing manifest.json")?;
        if f.size() > 256 * 1024 * 1024 {
            return Err("Manifest is too large".into());
        }
        serde_json::from_reader(f).map_err(|_| "Invalid backup manifest")?
    };
    let plugin_entries = super::super::plugins::contracts::validate_manifest(&manifest)?;
    if manifest.app_name != "Taomni" || manifest.encrypted != encrypted {
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
        destination(Path::new("."), &manifest, &entry.path)?;
        if !names.insert(entry.path.to_lowercase()) {
            return Err("Duplicate backup entry".into());
        }
        total = total
            .checked_add(entry.size_bytes)
            .ok_or("Backup size overflow")?;
        if total > MAX_EXTRACTED_BYTES {
            return Err("Unpacked archive exceeds 2 TiB limit".into());
        }
        entries.insert(entry.path.as_str(), entry);
    }
    if entries.is_empty() {
        return Err("Backup contains no data".into());
    }
    let mut seen = std::collections::HashSet::new();
    for i in 0..archive.len() {
        context.check()?;
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
        let mut header = Vec::with_capacity(16);
        let mut length = 0u64;
        loop {
            context.check()?;
            let n = file.read(&mut buffer).map_err(|e| e.to_string())?;
            context.advance(n as u64).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            length += n as u64;
            if length > expected.size_bytes {
                return Err("Decompressed entry exceeded manifest size".into());
            }
            if header.len() < 16 {
                header.extend_from_slice(&buffer[..n.min(16 - header.len())]);
            }
            hash.update(&buffer[..n]);
        }
        if length != expected.size_bytes || hex::encode(hash.finalize()) != expected.sha256 {
            return Err(format!("Checksum mismatch for {name}"));
        }
        if let Some(kind) = plugin_entries.get(&name) {
            let declared_db = *kind == PluginDataFileKind::Sqlite;
            let opaque = name
                .strip_prefix("plugins/")
                .and_then(|path| path.split_once("/data/"))
                .is_some_and(|(owner, relative)| {
                    crate::plugin::retained_data::opaque_file(owner, relative)
                });
            if declared_db != (header == b"SQLite format 3\0") && !(opaque && !declared_db) {
                return Err(format!(
                    "Plugin payload type disagrees with SQLite header: {name}"
                ));
            }
        }
    }
    if seen.len() != manifest.files.len() + 1 {
        return Err("Archive is missing a manifest entry".into());
    }
    Ok((manifest, archive))
}

pub(super) fn verified_archive(
    path: &Path,
    password: Option<&str>,
) -> Result<(BackupManifest, ZipArchive<File>), String> {
    verified_archive_with_context(
        path,
        password,
        &super::super::snapshot_context::SnapshotContext::default(),
    )
}
