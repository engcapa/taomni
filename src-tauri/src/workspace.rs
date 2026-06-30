use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

const DEFAULT_MAX_TEXT_BYTES: u64 = 5 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceEntry {
    pub name: String,
    pub path: String,
    pub file_type: String,
    pub size: u64,
    pub mtime: u64,
    pub is_hidden: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFile {
    pub path: String,
    pub text: String,
    pub size: u64,
    pub mtime: u64,
    pub hash: String,
}

#[tauri::command]
pub fn workspace_list_dir(
    repo_root: String,
    path: Option<String>,
) -> Result<Vec<WorkspaceEntry>, String> {
    let root = canonical_repo_root(&repo_root)?;
    let target = resolve_existing_path(&root, path.as_deref().unwrap_or(""))?;
    let meta = fs::metadata(&target).map_err(|e| format!("stat {}: {e}", target.display()))?;
    if !meta.is_dir() {
        return Err(format!("Not a directory: {}", target.display()));
    }

    let mut entries = Vec::new();
    let read = fs::read_dir(&target).map_err(|e| format!("read {}: {e}", target.display()))?;
    for item in read {
        let Ok(item) = item else {
            continue;
        };
        let path = item.path();
        if let Ok(entry) = workspace_entry(&root, &path) {
            entries.push(entry);
        }
    }
    entries.sort_by(
        |a, b| match (a.file_type.as_str() == "dir", b.file_type.as_str() == "dir") {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        },
    );
    Ok(entries)
}

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

#[tauri::command]
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
            return Err(format!(
                "File changed on disk; expected hash {expected}, found {current_hash}"
            ));
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

#[tauri::command]
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
            return Err(format!(
                "File changed on disk; expected hash {expected}, found {current_hash}"
            ));
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

fn canonical_repo_root(repo_root: &str) -> Result<PathBuf, String> {
    let root = PathBuf::from(repo_root);
    let canonical = root
        .canonicalize()
        .map_err(|e| format!("resolve repo root {}: {e}", root.display()))?;
    if !canonical.is_dir() {
        return Err(format!(
            "Repo root is not a directory: {}",
            canonical.display()
        ));
    }
    Ok(canonical)
}

fn resolve_existing_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let requested = sanitize_relative_path(relative)?;
    let target = root.join(requested);
    let canonical = target
        .canonicalize()
        .map_err(|e| format!("resolve {}: {e}", target.display()))?;
    ensure_inside(root, &canonical)?;
    Ok(canonical)
}

fn resolve_writable_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let requested = sanitize_relative_path(relative)?;
    if requested.as_os_str().is_empty() {
        return Err("Cannot write the workspace root".to_string());
    }
    let target = root.join(&requested);
    let parent = target
        .parent()
        .ok_or_else(|| format!("Cannot resolve parent for {}", target.display()))?;
    let parent_canonical = parent
        .canonicalize()
        .map_err(|e| format!("resolve {}: {e}", parent.display()))?;
    ensure_inside(root, &parent_canonical)?;
    Ok(target)
}

fn resolve_existing_loose_file_path(path: &str) -> Result<PathBuf, String> {
    let target = loose_file_path(path)?;
    target
        .canonicalize()
        .map_err(|e| format!("resolve {}: {e}", target.display()))
}

fn resolve_writable_loose_file_path(path: &str) -> Result<PathBuf, String> {
    let target = loose_file_path(path)?;
    let parent = target
        .parent()
        .ok_or_else(|| format!("Cannot resolve parent for {}", target.display()))?;
    parent
        .canonicalize()
        .map_err(|e| format!("resolve {}: {e}", parent.display()))?;
    Ok(target)
}

fn loose_file_path(path: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("Loose file path cannot be empty".into());
    }
    let target = PathBuf::from(trimmed);
    if !target.is_absolute() {
        return Err("Loose file path must be absolute".into());
    }
    Ok(target)
}

fn sanitize_relative_path(value: &str) -> Result<PathBuf, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok(PathBuf::new());
    }
    let path = Path::new(trimmed);
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => out.push(part),
            Component::CurDir => {}
            Component::ParentDir => return Err("Workspace paths cannot contain '..'".into()),
            Component::RootDir | Component::Prefix(_) => {
                return Err("Workspace paths must be relative".into())
            }
        }
    }
    Ok(out)
}

fn ensure_inside(root: &Path, target: &Path) -> Result<(), String> {
    if target.starts_with(root) {
        Ok(())
    } else {
        Err(format!(
            "Path escapes workspace root: {} is outside {}",
            target.display(),
            root.display()
        ))
    }
}

fn replace_file(tmp: &Path, target: &Path) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        if target.exists() {
            fs::remove_file(target)?;
        }
    }
    fs::rename(tmp, target)
}

fn reject_workspace_root_target(root: &Path, target: &Path, operation: &str) -> Result<(), String> {
    if target == root {
        Err(format!("Cannot {operation} the workspace root"))
    } else {
        Ok(())
    }
}

fn reject_protected_write(root: &Path, target: &Path) -> Result<(), String> {
    let relative = target
        .strip_prefix(root)
        .map_err(|_| "Path escapes workspace root".to_string())?;
    if relative
        .components()
        .any(|component| matches!(component, Component::Normal(part) if part == ".git"))
    {
        return Err("Writing inside .git is not allowed".into());
    }
    Ok(())
}

fn reject_protected_loose_write(target: &Path) -> Result<(), String> {
    if target
        .components()
        .any(|component| matches!(component, Component::Normal(part) if part == ".git"))
    {
        return Err("Writing inside .git is not allowed".into());
    }
    Ok(())
}

fn workspace_entry(root: &Path, path: &Path) -> Result<WorkspaceEntry, String> {
    let symlink_meta =
        fs::symlink_metadata(path).map_err(|e| format!("stat {}: {e}", path.display()))?;
    let file_type = if symlink_meta.file_type().is_symlink() {
        "symlink"
    } else if symlink_meta.is_dir() {
        "dir"
    } else if symlink_meta.is_file() {
        "file"
    } else {
        "other"
    };
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_default();
    Ok(WorkspaceEntry {
        name: name.clone(),
        path: relative_path(root, path)?,
        file_type: file_type.to_string(),
        size: symlink_meta.len(),
        mtime: mtime_secs(&symlink_meta),
        is_hidden: name.starts_with('.'),
    })
}

fn file_from_bytes(
    root: &Path,
    target: &Path,
    bytes: Vec<u8>,
    meta: fs::Metadata,
) -> Result<WorkspaceFile, String> {
    let text =
        String::from_utf8(bytes.clone()).map_err(|e| format!("File is not valid UTF-8: {e}"))?;
    Ok(WorkspaceFile {
        path: relative_path(root, target)?,
        text,
        size: meta.len(),
        mtime: mtime_secs(&meta),
        hash: sha256_hex(&bytes),
    })
}

fn loose_file_from_bytes(
    target: &Path,
    bytes: Vec<u8>,
    meta: fs::Metadata,
) -> Result<WorkspaceFile, String> {
    let text =
        String::from_utf8(bytes.clone()).map_err(|e| format!("File is not valid UTF-8: {e}"))?;
    Ok(WorkspaceFile {
        path: path_for_display(target),
        text,
        size: meta.len(),
        mtime: mtime_secs(&meta),
        hash: sha256_hex(&bytes),
    })
}

fn path_for_display(path: &Path) -> String {
    let value = path.to_string_lossy().to_string();
    #[cfg(windows)]
    {
        if let Some(rest) = value.strip_prefix(r"\\?\UNC\") {
            return format!(r"\\{rest}");
        }
        if let Some(rest) = value.strip_prefix(r"\\?\") {
            return rest.to_string();
        }
    }
    value
}

fn relative_path(root: &Path, target: &Path) -> Result<String, String> {
    let rel = target
        .strip_prefix(root)
        .map_err(|_| "Path escapes workspace root".to_string())?;
    Ok(rel.to_string_lossy().replace('\\', "/"))
}

fn mtime_secs(meta: &fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_parent_dir_escape() {
        let dir = tempfile::tempdir().unwrap();
        let err = workspace_list_dir(dir.path().to_string_lossy().to_string(), Some("../".into()))
            .unwrap_err();
        assert!(err.contains(".."));
    }

    #[test]
    fn rejects_dot_git_writes() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join(".git")).unwrap();
        let err = workspace_write_file(
            dir.path().to_string_lossy().to_string(),
            ".git/config".into(),
            "x".into(),
            None,
        )
        .unwrap_err();
        assert!(err.contains(".git"));
    }

    #[test]
    fn detects_expected_hash_conflict() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("a.txt"), "one").unwrap();
        let file = workspace_read_file(
            dir.path().to_string_lossy().to_string(),
            "a.txt".into(),
            None,
        )
        .unwrap();
        fs::write(dir.path().join("a.txt"), "two").unwrap();
        let err = workspace_write_file(
            dir.path().to_string_lossy().to_string(),
            "a.txt".into(),
            "three".into(),
            Some(file.hash),
        )
        .unwrap_err();
        assert!(err.contains("changed on disk"));
    }

    #[test]
    fn reads_and_writes_loose_file_with_hash_check() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("note.md");
        fs::write(&path, "one").unwrap();
        let path_string = path.to_string_lossy().to_string();

        let file = workspace_read_loose_file(path_string.clone(), None).unwrap();
        assert_eq!(file.path, path_string);
        assert_eq!(file.text, "one");

        let saved =
            workspace_write_loose_file(path_string.clone(), "two".into(), Some(file.hash)).unwrap();
        assert_eq!(saved.text, "two");

        let err = workspace_write_loose_file(path_string, "three".into(), Some("bad".into()))
            .unwrap_err();
        assert!(err.contains("changed on disk"));
    }

    #[test]
    fn rejects_dot_git_loose_writes() {
        let dir = tempfile::tempdir().unwrap();
        let git_dir = dir.path().join(".git");
        fs::create_dir(&git_dir).unwrap();
        let path = git_dir.join("config");
        fs::write(&path, "x").unwrap();

        let err = workspace_write_loose_file(path.to_string_lossy().to_string(), "y".into(), None)
            .unwrap_err();
        assert!(err.contains(".git"));
    }

    #[test]
    fn creates_renames_and_deletes_file() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().to_string();

        workspace_create_dir(root.clone(), "src".into()).unwrap();
        let file =
            workspace_create_file(root.clone(), "src/main.ts".into(), Some("one".into())).unwrap();
        assert_eq!(file.path, "src/main.ts");
        assert_eq!(file.text, "one");

        let renamed =
            workspace_rename_path(root.clone(), "src/main.ts".into(), "src/app.ts".into()).unwrap();
        assert_eq!(renamed.path, "src/app.ts");
        assert!(!dir.path().join("src/main.ts").exists());
        assert!(dir.path().join("src/app.ts").exists());

        workspace_delete_path(root, "src/app.ts".into(), None).unwrap();
        assert!(!dir.path().join("src/app.ts").exists());
    }

    #[test]
    fn creates_and_deletes_directory_tree() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().to_string();

        let entry = workspace_create_dir(root.clone(), "src".into()).unwrap();
        assert_eq!(entry.file_type, "dir");
        workspace_create_file(root.clone(), "src/main.ts".into(), None).unwrap();

        let err = workspace_delete_path(root.clone(), "src".into(), Some(false)).unwrap_err();
        assert!(err.contains("rmdir"));

        workspace_delete_path(root, "src".into(), Some(true)).unwrap();
        assert!(!dir.path().join("src").exists());
    }

    #[test]
    fn rejects_dot_git_deletes() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join(".git")).unwrap();
        fs::write(dir.path().join(".git/config"), "x").unwrap();

        let err = workspace_delete_path(
            dir.path().to_string_lossy().to_string(),
            ".git/config".into(),
            None,
        )
        .unwrap_err();
        assert!(err.contains(".git"));
    }
}
