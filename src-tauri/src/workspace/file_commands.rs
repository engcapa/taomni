use super::*;

#[tauri::command]
pub fn workspace_read_file(
    repo_root: String,
    path: String,
    max_bytes: Option<u64>,
) -> Result<WorkspaceFile, String> {
    let root = canonical_repo_root(&repo_root)?;
    let target = resolve_existing_path(&root, &path)?;
    let meta = fs::metadata(&target).map_err(|e| format!("stat {}: {e}", target.display()))?;
    if !meta.is_file() {
        return Err(format!("Not a file: {}", target.display()));
    }
    let limit = max_bytes.unwrap_or(DEFAULT_MAX_TEXT_BYTES);
    if meta.len() > limit {
        return Err(format!(
            "File is {} bytes, exceeds text editor limit of {} bytes",
            meta.len(),
            limit
        ));
    }
    let bytes = fs::read(&target).map_err(|e| format!("read {}: {e}", target.display()))?;
    file_from_bytes(&root, &target, bytes, meta)
}

#[tauri::command]
pub fn workspace_read_loose_file(
    path: String,
    max_bytes: Option<u64>,
) -> Result<WorkspaceFile, String> {
    let target = resolve_existing_loose_file_path(&path)?;
    let meta = fs::metadata(&target).map_err(|e| format!("stat {}: {e}", target.display()))?;
    if !meta.is_file() {
        return Err(format!("Not a file: {}", target.display()));
    }
    let limit = max_bytes.unwrap_or(DEFAULT_MAX_TEXT_BYTES);
    if meta.len() > limit {
        return Err(format!(
            "File is {} bytes, exceeds text editor limit of {} bytes",
            meta.len(),
            limit
        ));
    }
    let bytes = fs::read(&target).map_err(|e| format!("read {}: {e}", target.display()))?;
    loose_file_from_bytes(&target, bytes, meta)
}

/// Re-decode an existing file using an explicit user-selected encoding. The
/// default read commands remain auto-detecting for backwards compatibility.
#[tauri::command]
pub fn workspace_read_file_with_encoding(
    repo_root: String,
    path: String,
    max_bytes: Option<u64>,
    encoding: String,
) -> Result<WorkspaceFile, String> {
    let root = canonical_repo_root(&repo_root)?;
    let target = resolve_existing_path(&root, &path)?;
    let meta = fs::metadata(&target).map_err(|e| format!("stat {}: {e}", target.display()))?;
    if !meta.is_file() {
        return Err(format!("Not a file: {}", target.display()));
    }
    let limit = max_bytes.unwrap_or(DEFAULT_MAX_TEXT_BYTES);
    if meta.len() > limit {
        return Err(format!(
            "File is {} bytes, exceeds text editor limit of {} bytes",
            meta.len(),
            limit
        ));
    }
    let bytes = fs::read(&target).map_err(|e| format!("read {}: {e}", target.display()))?;
    file_from_bytes_with_encoding(&root, &target, bytes, meta, Some(&encoding))
}

#[tauri::command]
pub fn workspace_read_loose_file_with_encoding(
    path: String,
    max_bytes: Option<u64>,
    encoding: String,
) -> Result<WorkspaceFile, String> {
    let target = resolve_existing_loose_file_path(&path)?;
    let meta = fs::metadata(&target).map_err(|e| format!("stat {}: {e}", target.display()))?;
    if !meta.is_file() {
        return Err(format!("Not a file: {}", target.display()));
    }
    let limit = max_bytes.unwrap_or(DEFAULT_MAX_TEXT_BYTES);
    if meta.len() > limit {
        return Err(format!(
            "File is {} bytes, exceeds text editor limit of {} bytes",
            meta.len(),
            limit
        ));
    }
    let bytes = fs::read(&target).map_err(|e| format!("read {}: {e}", target.display()))?;
    loose_file_from_bytes_with_encoding(&target, bytes, meta, Some(&encoding))
}

pub fn workspace_write_file(
    repo_root: String,
    path: String,
    contents: String,
    expected_hash: Option<String>,
) -> Result<WorkspaceFile, String> {
    let root = canonical_repo_root(&repo_root)?;
    let target = resolve_writable_path(&root, &path)?;
    reject_protected_write(&root, &target)?;

    if let Some(expected) = expected_hash
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let current = fs::read(&target).map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                format!(
                    "Cannot compare expected hash; file does not exist: {}",
                    target.display()
                )
            } else {
                format!("read {}: {e}", target.display())
            }
        })?;
        let current_hash = sha256_hex(&current);
        if !current_hash.eq_ignore_ascii_case(expected) {
            return Err(hash_mismatch_error(expected, &current_hash));
        }
    }

    let parent = target
        .parent()
        .ok_or_else(|| format!("Cannot resolve parent for {}", target.display()))?;
    fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    let tmp = parent.join(format!(".taomni-write-{}", uuid::Uuid::new_v4().simple()));
    {
        use std::io::Write;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)
            .map_err(|e| format!("open {}: {e}", tmp.display()))?;
        file.write_all(contents.as_bytes())
            .map_err(|e| format!("write {}: {e}", tmp.display()))?;
        file.sync_all()
            .map_err(|e| format!("sync {}: {e}", tmp.display()))?;
    }
    if let Err(e) = replace_file(&tmp, &target) {
        let _ = fs::remove_file(&tmp);
        return Err(format!(
            "rename {} -> {}: {e}",
            tmp.display(),
            target.display()
        ));
    }

    workspace_read_file(repo_root, path, None)
}

pub fn workspace_write_loose_file(
    path: String,
    contents: String,
    expected_hash: Option<String>,
) -> Result<WorkspaceFile, String> {
    let target = resolve_writable_loose_file_path(&path)?;
    reject_protected_loose_write(&target)?;

    if let Some(expected) = expected_hash
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let current = fs::read(&target).map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                format!(
                    "Cannot compare expected hash; file does not exist: {}",
                    target.display()
                )
            } else {
                format!("read {}: {e}", target.display())
            }
        })?;
        let current_hash = sha256_hex(&current);
        if !current_hash.eq_ignore_ascii_case(expected) {
            return Err(hash_mismatch_error(expected, &current_hash));
        }
    }

    let parent = target
        .parent()
        .ok_or_else(|| format!("Cannot resolve parent for {}", target.display()))?;
    fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    let tmp = parent.join(format!(".taomni-write-{}", uuid::Uuid::new_v4().simple()));
    {
        use std::io::Write;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)
            .map_err(|e| format!("open {}: {e}", tmp.display()))?;
        file.write_all(contents.as_bytes())
            .map_err(|e| format!("write {}: {e}", tmp.display()))?;
        file.sync_all()
            .map_err(|e| format!("sync {}: {e}", tmp.display()))?;
    }
    if let Err(e) = replace_file(&tmp, &target) {
        let _ = fs::remove_file(&tmp);
        return Err(format!(
            "rename {} -> {}: {e}",
            tmp.display(),
            target.display()
        ));
    }

    workspace_read_loose_file(path, None)
}

/// Write text using the selected editor encoding while retaining the existing
/// hash-precondition and atomic replacement guarantees. Returns a typed ack
/// carrying the exact written byte identity (§8.18.1 native contract).
pub fn workspace_write_file_encoded(
    repo_root: String,
    path: String,
    contents: String,
    expected_hash: Option<String>,
    encoding: String,
    bom: Option<bool>,
) -> Result<WorkspaceWriteAck, WorkspaceWriteError> {
    let root = canonical_repo_root(&repo_root)
        .map_err(|e| WorkspaceWriteError::new(WorkspaceWriteErrorKind::Io, e))?;
    let target = resolve_writable_path(&root, &path)
        .map_err(|e| WorkspaceWriteError::new(WorkspaceWriteErrorKind::Io, e))?;
    reject_protected_write(&root, &target)
        .map_err(|e| WorkspaceWriteError::new(WorkspaceWriteErrorKind::Io, e))?;
    let bytes = encode_workspace_text(&contents, &encoding, bom.unwrap_or(false)).map_err(|e| {
        // Encoding happens before any filesystem mutation.
        WorkspaceWriteError::new(WorkspaceWriteErrorKind::Encoding, e)
            .with_effect(WorkspaceWriteEffect::None, None)
    })?;
    let ack = write_workspace_bytes(&target, bytes, expected_hash.as_deref())?;
    let file = workspace_read_file_with_encoding(repo_root, path, None, encoding).map_err(|e| {
        // Bytes provably landed; only the decoded read-back failed. The
        // frontend classifies committed from `writtenHash` without
        // rewriting.
        WorkspaceWriteError::new(WorkspaceWriteErrorKind::Io, e)
            .with_effect(
                WorkspaceWriteEffect::Unknown,
                Some((ack.written_hash.clone(), ack.written_byte_length)),
            )
            .with_intent(ack.written_hash.clone(), ack.written_byte_length)
            .with_old_hash(ack.old_hash.clone())
    })?;
    Ok(WorkspaceWriteAck {
        file,
        written_hash: ack.written_hash.clone(),
        written_byte_length: ack.written_byte_length,
        intent_hash: ack.written_hash,
        old_hash: ack.old_hash,
        atomic_replace_used: true,
    })
}

pub fn workspace_write_loose_file_encoded(
    path: String,
    contents: String,
    expected_hash: Option<String>,
    encoding: String,
    bom: Option<bool>,
) -> Result<WorkspaceWriteAck, WorkspaceWriteError> {
    let target = resolve_writable_loose_file_path(&path)
        .map_err(|e| WorkspaceWriteError::new(WorkspaceWriteErrorKind::Io, e))?;
    reject_protected_loose_write(&target)
        .map_err(|e| WorkspaceWriteError::new(WorkspaceWriteErrorKind::Io, e))?;
    let bytes = encode_workspace_text(&contents, &encoding, bom.unwrap_or(false)).map_err(|e| {
        // Encoding happens before any filesystem mutation.
        WorkspaceWriteError::new(WorkspaceWriteErrorKind::Encoding, e)
            .with_effect(WorkspaceWriteEffect::None, None)
    })?;
    let ack = write_workspace_bytes(&target, bytes, expected_hash.as_deref())?;
    let read_result = (|| -> Result<WorkspaceFile, WorkspaceWriteError> {
        let raw = fs::read(&target).map_err(|e| classify_io_error("read target", &e))?;
        let meta = fs::metadata(&target).map_err(|e| classify_io_error("stat target", &e))?;
        loose_file_from_bytes_with_encoding(&target, raw, meta, Some(&encoding))
            .map_err(|e| WorkspaceWriteError::new(WorkspaceWriteErrorKind::Io, e))
    })();
    let file = read_result.map_err(|e| {
        WorkspaceWriteError::new(e.kind, e.message)
            .with_effect(
                WorkspaceWriteEffect::Unknown,
                Some((ack.written_hash.clone(), ack.written_byte_length)),
            )
            .with_intent(ack.written_hash.clone(), ack.written_byte_length)
            .with_old_hash(ack.old_hash.clone())
    })?;
    Ok(WorkspaceWriteAck {
        file,
        written_hash: ack.written_hash.clone(),
        written_byte_length: ack.written_byte_length,
        intent_hash: ack.written_hash,
        old_hash: ack.old_hash,
        atomic_replace_used: true,
    })
}

#[tauri::command]
pub fn workspace_create_file(
    repo_root: String,
    path: String,
    contents: Option<String>,
) -> Result<WorkspaceFile, String> {
    let root = canonical_repo_root(&repo_root)?;
    let target = resolve_writable_path(&root, &path)?;
    reject_protected_write(&root, &target)?;
    if target.exists() {
        return Err(format!("Path already exists: {}", target.display()));
    }

    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&target)
        .map_err(|e| format!("create {}: {e}", target.display()))?;
    {
        use std::io::Write;
        file.write_all(contents.unwrap_or_default().as_bytes())
            .map_err(|e| format!("write {}: {e}", target.display()))?;
        file.sync_all()
            .map_err(|e| format!("sync {}: {e}", target.display()))?;
    }
    workspace_read_file(repo_root, path, None)
}

#[tauri::command]
pub fn workspace_create_dir(repo_root: String, path: String) -> Result<WorkspaceEntry, String> {
    let root = canonical_repo_root(&repo_root)?;
    let target = resolve_writable_path(&root, &path)?;
    reject_protected_write(&root, &target)?;
    if target.exists() {
        return Err(format!("Path already exists: {}", target.display()));
    }
    fs::create_dir(&target).map_err(|e| format!("mkdir {}: {e}", target.display()))?;
    workspace_entry(&root, &target)
}

#[tauri::command]
pub fn workspace_delete_path(
    repo_root: String,
    path: String,
    recursive: Option<bool>,
) -> Result<(), String> {
    let root = canonical_repo_root(&repo_root)?;
    let target = resolve_existing_path(&root, &path)?;
    reject_workspace_root_target(&root, &target, "delete")?;
    reject_protected_write(&root, &target)?;
    let meta =
        fs::symlink_metadata(&target).map_err(|e| format!("stat {}: {e}", target.display()))?;
    if meta.is_dir() && !meta.file_type().is_symlink() {
        if recursive.unwrap_or(false) {
            fs::remove_dir_all(&target).map_err(|e| format!("rmdir {}: {e}", target.display()))?;
        } else {
            fs::remove_dir(&target).map_err(|e| format!("rmdir {}: {e}", target.display()))?;
        }
    } else {
        fs::remove_file(&target).map_err(|e| format!("remove {}: {e}", target.display()))?;
    }
    Ok(())
}

#[tauri::command]
pub fn workspace_rename_path(
    repo_root: String,
    from_path: String,
    to_path: String,
) -> Result<WorkspaceEntry, String> {
    let root = canonical_repo_root(&repo_root)?;
    let from = resolve_existing_path(&root, &from_path)?;
    reject_workspace_root_target(&root, &from, "rename")?;
    reject_protected_write(&root, &from)?;
    let to = resolve_writable_path(&root, &to_path)?;
    reject_protected_write(&root, &to)?;
    if to.exists() {
        return Err(format!("Path already exists: {}", to.display()));
    }
    fs::rename(&from, &to)
        .map_err(|e| format!("rename {} -> {}: {e}", from.display(), to.display()))?;
    workspace_entry(&root, &to)
}
