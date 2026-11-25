use super::{NotepadDirFilesResult, NotepadRenameResult, NotepadSaveAsResult};
use crate::atomic_replace;
use crate::viewer::{HARD_TEXT_BYTES, display_path, is_owned_temp, normalize_eol, path_io_error};
use crate::workspace::viewer_io::{atomic_viewer_write_unconditional, encode_text_bytes};
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::time::UNIX_EPOCH;

fn validate_absolute_target(raw_path: &str) -> Result<PathBuf, String> {
    let path = Path::new(raw_path);
    if !path.is_absolute() || path.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err("permission: Notepad target path must be absolute without '..'".into());
    }
    let parent = path
        .parent()
        .ok_or_else(|| "permission: Target path must include a parent directory".to_string())?;
    let name = path
        .file_name()
        .ok_or_else(|| "permission: Target path must include a file name".to_string())?;
    if !parent.exists() {
        fs::create_dir_all(parent).map_err(|e| path_io_error("create parent directory", e))?;
    }
    let canonical_parent =
        fs::canonicalize(parent).map_err(|e| path_io_error("resolve parent directory", e))?;
    Ok(canonical_parent.join(name))
}

fn validate_single_filename(name: &str) -> Result<(), String> {
    let trimmed = name.trim();
    if trimmed.is_empty()
        || matches!(trimmed, "." | "..")
        || trimmed.contains(['/', '\\', '\0'])
        || trimmed.chars().any(char::is_control)
    {
        return Err("invalid_name: Invalid file name".into());
    }
    #[cfg(windows)]
    {
        if trimmed.chars().any(|c| "<>:\"|?*".contains(c)) || trimmed.ends_with(['.', ' ']) {
            return Err("invalid_name: Invalid Windows file name".into());
        }
    }
    Ok(())
}

fn mtime_secs(meta: &fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

pub(crate) fn save_as(
    path: &str,
    content: &str,
    encoding: &str,
    bom: bool,
    eol: &str,
    overwrite: bool,
) -> Result<NotepadSaveAsResult, String> {
    if content.len() as u64 > HARD_TEXT_BYTES {
        return Err("too_large: Text exceeds the 20 MiB editing limit".into());
    }
    let target = validate_absolute_target(path)?;
    if is_owned_temp(&target) {
        return Err("permission: Cannot overwrite viewer temporary directory".into());
    }
    if let Ok(meta) = fs::symlink_metadata(&target) {
        if meta.file_type().is_symlink() {
            return Err("permission: Refusing to save over a symbolic link".into());
        }
        if meta.is_dir() {
            return Err("permission: Target path is a directory".into());
        }
        if !overwrite {
            return Err("exists: Target file already exists".into());
        }
    }
    let normalized = normalize_eol(content, eol)?;
    let bytes =
        encode_text_bytes(&normalized, encoding, bom).map_err(|e| format!("binary: {e}"))?;
    if bytes.len() as u64 > HARD_TEXT_BYTES {
        return Err("too_large: Encoded text exceeds the 20 MiB editing limit".into());
    }
    let (hash, size) = atomic_viewer_write_unconditional(&target, bytes, HARD_TEXT_BYTES)
        .map_err(|e| format!("permission: {}", e.message))?;
    let meta = fs::metadata(&target).map_err(|e| path_io_error("stat saved file", e))?;
    Ok(NotepadSaveAsResult {
        path: display_path(&target),
        hash,
        size,
        mtime: mtime_secs(&meta),
    })
}

pub(crate) fn rename_file(old_path: &str, new_name: &str) -> Result<NotepadRenameResult, String> {
    let trimmed = new_name.trim();
    validate_single_filename(trimmed)?;
    let old = Path::new(old_path);
    if !old.is_absolute() {
        return Err("permission: Source path must be absolute".into());
    }
    let canonical = fs::canonicalize(old).map_err(|e| path_io_error("resolve source file", e))?;
    if is_owned_temp(&canonical) {
        return Err("permission: Temporary read-only copies cannot be renamed".into());
    }
    let meta = fs::symlink_metadata(&canonical).map_err(|e| path_io_error("stat source", e))?;
    if !meta.is_file() {
        return Err("permission: Only regular files can be renamed".into());
    }
    let parent = canonical
        .parent()
        .ok_or_else(|| "permission: Missing parent directory".to_string())?;
    let dest = parent.join(trimmed);
    if dest == canonical {
        return Ok(NotepadRenameResult {
            old_path: display_path(&canonical),
            new_path: display_path(&dest),
            name: trimmed.to_string(),
        });
    }
    if fs::symlink_metadata(&dest).is_ok() {
        return Err("exists: A file with that name already exists".into());
    }
    atomic_replace::retry(|| fs::rename(&canonical, &dest))
        .map_err(|e| path_io_error("rename file", e))?;
    Ok(NotepadRenameResult {
        old_path: display_path(&canonical),
        new_path: display_path(&dest),
        name: trimmed.to_string(),
    })
}

pub(crate) fn trash_file(path: &str) -> Result<String, String> {
    let candidate = Path::new(path);
    if is_owned_temp(candidate) {
        return Err("permission: Temporary read-only copies cannot be moved to Trash".into());
    }
    crate::filebrowser::local_ops::trash_single_entry(path)
}

pub(crate) fn set_readonly_attr(path: &str, readonly: bool) -> Result<bool, String> {
    let target = fs::canonicalize(Path::new(path)).map_err(|e| path_io_error("resolve path", e))?;
    if is_owned_temp(&target) {
        return Err("permission: Temporary read-only copies cannot change permissions".into());
    }
    let mut perms = fs::metadata(&target)
        .map_err(|e| path_io_error("stat file", e))?
        .permissions();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = perms.mode();
        let next_mode = if readonly {
            mode & !0o222
        } else {
            mode | 0o200
        };
        perms.set_mode(next_mode);
        fs::set_permissions(&target, perms)
            .map_err(|e| path_io_error("set file permissions", e))?;
    }
    #[cfg(windows)]
    {
        perms.set_readonly(readonly);
        fs::set_permissions(&target, perms)
            .map_err(|e| path_io_error("set readonly attribute", e))?;
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = readonly;
        return Err("unsupported: Changing file attributes is unsupported on this platform".into());
    }
    Ok(readonly)
}

pub(crate) fn open_terminal_dir(path: &str, preferred_shell: Option<&str>) -> Result<(), String> {
    let resolved =
        fs::canonicalize(Path::new(path)).map_err(|e| path_io_error("resolve path", e))?;
    let dir = if resolved.is_dir() {
        resolved
    } else {
        resolved
            .parent()
            .map(Path::to_path_buf)
            .ok_or_else(|| "not_found: Missing parent directory".to_string())?
    };

    #[cfg(target_os = "windows")]
    {
        let shell = preferred_shell.unwrap_or("powershell");
        let cmd = if shell.eq_ignore_ascii_case("cmd") {
            Command::new("cmd.exe")
                .args(["/C", "start", "cmd.exe"])
                .current_dir(&dir)
                .spawn()
        } else {
            Command::new("powershell.exe")
                .args([
                    "-NoExit",
                    "-Command",
                    "Set-Location",
                    &dir.to_string_lossy(),
                ])
                .current_dir(&dir)
                .spawn()
        };
        cmd.map(|_| ())
            .map_err(|e| format!("permission: Failed to launch terminal: {e}"))
    }

    #[cfg(target_os = "macos")]
    {
        let _ = preferred_shell;
        Command::new("open")
            .arg("-a")
            .arg("Terminal")
            .arg(&dir)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("permission: Failed to launch Terminal.app: {e}"))
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let _ = preferred_shell;
        let dir_str = dir.to_string_lossy().into_owned();
        for (bin, args) in [
            ("x-terminal-emulator", vec![]),
            ("gnome-terminal", vec!["--working-directory", &dir_str]),
            ("konsole", vec!["--workdir", &dir_str]),
            ("xfce4-terminal", vec!["--working-directory", &dir_str]),
            ("xterm", vec![]),
        ] {
            if let Ok(_child) = Command::new(bin).args(&args).current_dir(&dir).spawn() {
                return Ok(());
            }
        }
        Err("unsupported: No supported Linux terminal emulator found in PATH".into())
    }
}

pub(crate) fn list_dir_text_files(
    path: &str,
    max_count: Option<usize>,
) -> Result<NotepadDirFilesResult, String> {
    let cap = max_count.unwrap_or(20).clamp(1, 100);
    let root =
        fs::canonicalize(Path::new(path)).map_err(|e| path_io_error("resolve directory", e))?;
    if !root.is_dir() {
        return Err("permission: Path is not a directory".into());
    }
    let mut entries: Vec<PathBuf> = fs::read_dir(&root)
        .map_err(|e| path_io_error("read directory", e))?
        .filter_map(|e| e.ok().map(|v| v.path()))
        .collect();
    entries.sort();

    let mut files = Vec::new();
    let mut total_candidates = 0usize;
    let mut skipped_binary = 0usize;
    let mut truncated = false;

    for entry in entries {
        let Ok(meta) = fs::symlink_metadata(&entry) else {
            continue;
        };
        if !meta.is_file() || meta.file_type().is_symlink() {
            continue;
        }
        total_candidates += 1;
        if meta.len() > HARD_TEXT_BYTES || looks_binary_prefix(&entry) {
            skipped_binary += 1;
            continue;
        }
        if files.len() >= cap {
            truncated = true;
            continue;
        }
        files.push(display_path(&entry));
    }

    Ok(NotepadDirFilesResult {
        files,
        total_candidates,
        skipped_binary,
        truncated,
    })
}

fn looks_binary_prefix(path: &Path) -> bool {
    let Ok(mut file) = fs::File::open(path) else {
        return true;
    };
    let mut buf = [0u8; 4096];
    let Ok(n) = file.read(&mut buf) else {
        return true;
    };
    if n == 0 {
        return false;
    }
    let slice = &buf[..n];
    // Allow UTF-16 BOMs
    if slice.starts_with(b"\xFF\xFE") || slice.starts_with(b"\xFE\xFF") {
        return false;
    }
    let nul_count = slice.iter().filter(|&&b| b == 0).count();
    nul_count > 0
}
