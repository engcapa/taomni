use super::notepad_root;
use crate::viewer::path_io_error;
use std::fs;
use std::path::{Component, Path, PathBuf};

fn default_session_path(app_data_dir: &Path) -> PathBuf {
    notepad_root(app_data_dir).join("last-session.taomni-session.json")
}

fn resolve_session_target(app_data_dir: &Path, path: Option<&str>) -> Result<PathBuf, String> {
    match path.map(str::trim).filter(|s| !s.is_empty()) {
        Some(raw) => {
            let p = Path::new(raw);
            if !p.is_absolute() || p.components().any(|c| matches!(c, Component::ParentDir)) {
                return Err("permission: Session file path must be absolute without '..'".into());
            }
            Ok(p.to_path_buf())
        }
        None => Ok(default_session_path(app_data_dir)),
    }
}

pub(crate) fn session_save(
    app_data_dir: &Path,
    file_path: Option<&str>,
    json: &str,
) -> Result<String, String> {
    let parsed: serde_json::Value = serde_json::from_str(json)
        .map_err(|e| format!("invalid_json: Invalid session JSON: {e}"))?;
    if parsed.get("version").and_then(|v| v.as_u64()).is_none() {
        return Err("invalid_json: Session JSON must include numeric version".into());
    }
    let target = resolve_session_target(app_data_dir, file_path)?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| path_io_error("create session directory", e))?;
    }
    let tmp = target.with_extension(format!("tmp-{}", uuid::Uuid::new_v4().simple()));
    fs::write(&tmp, json.as_bytes()).map_err(|e| path_io_error("write session temp", e))?;
    crate::atomic_replace::retry(|| fs::rename(&tmp, &target)).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        path_io_error("commit session file", e)
    })?;
    Ok(target.to_string_lossy().into_owned())
}

pub(crate) fn session_load(
    app_data_dir: &Path,
    file_path: Option<&str>,
) -> Result<Option<String>, String> {
    let target = resolve_session_target(app_data_dir, file_path)?;
    if !target.exists() {
        if file_path.is_some() {
            return Err("not_found: Session file does not exist".into());
        }
        return Ok(None);
    }
    let content = fs::read_to_string(&target).map_err(|e| path_io_error("read session file", e))?;
    let parsed: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| format!("corrupt: Session file is corrupt JSON: {e}"))?;
    if parsed.get("version").and_then(|v| v.as_u64()).is_none() {
        return Err("corrupt: Session file is missing version field".into());
    }
    Ok(Some(content))
}
