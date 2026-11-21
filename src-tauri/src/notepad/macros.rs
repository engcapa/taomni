use super::{NotepadMacroLoadResult, notepad_root};
use crate::viewer::path_io_error;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};

fn macros_json_path(app_data_dir: &Path) -> PathBuf {
    notepad_root(app_data_dir).join("macros.json")
}

fn macros_hash_path(app_data_dir: &Path) -> PathBuf {
    notepad_root(app_data_dir).join("macros.sha256")
}

fn hash_str(content: &str) -> String {
    hex::encode(Sha256::digest(content.as_bytes()))
}

pub(crate) fn macros_load(app_data_dir: &Path) -> Result<NotepadMacroLoadResult, String> {
    let json_path = macros_json_path(app_data_dir);
    let hash_path = macros_hash_path(app_data_dir);
    if !json_path.exists() {
        let empty = "[]".to_string();
        let h = hash_str(&empty);
        return Ok(NotepadMacroLoadResult {
            json: empty,
            expected_hash: h.clone(),
            actual_hash: h,
            tampered: false,
        });
    }
    let json = fs::read_to_string(&json_path).map_err(|e| path_io_error("read macros.json", e))?;
    let actual_hash = hash_str(&json);
    let expected_hash = fs::read_to_string(&hash_path)
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    let tampered = expected_hash.is_empty() || !expected_hash.eq_ignore_ascii_case(&actual_hash);
    Ok(NotepadMacroLoadResult {
        json,
        expected_hash,
        actual_hash,
        tampered,
    })
}

pub(crate) fn macros_save(
    app_data_dir: &Path,
    json: &str,
) -> Result<NotepadMacroLoadResult, String> {
    let parsed: serde_json::Value =
        serde_json::from_str(json).map_err(|e| format!("invalid_json: Invalid macro JSON: {e}"))?;
    if !parsed.is_array() {
        return Err("invalid_json: macros.json must be a JSON array".into());
    }
    let dir = notepad_root(app_data_dir);
    fs::create_dir_all(&dir).map_err(|e| path_io_error("create notepad dir", e))?;
    let json_path = macros_json_path(app_data_dir);
    let hash_path = macros_hash_path(app_data_dir);
    let tmp_json = dir.join(format!(".macros-{}.tmp", uuid::Uuid::new_v4().simple()));
    fs::write(&tmp_json, json.as_bytes()).map_err(|e| path_io_error("write macros temp", e))?;
    crate::atomic_replace::retry(|| fs::rename(&tmp_json, &json_path)).map_err(|e| {
        let _ = fs::remove_file(&tmp_json);
        path_io_error("commit macros.json", e)
    })?;
    let actual_hash = hash_str(json);
    fs::write(&hash_path, actual_hash.as_bytes())
        .map_err(|e| path_io_error("write macros.sha256", e))?;
    Ok(NotepadMacroLoadResult {
        json: json.to_string(),
        expected_hash: actual_hash.clone(),
        actual_hash,
        tampered: false,
    })
}

pub(crate) fn macros_validate(app_data_dir: &Path) -> Result<NotepadMacroLoadResult, String> {
    macros_load(app_data_dir)
}

pub(crate) fn macros_accept(app_data_dir: &Path) -> Result<NotepadMacroLoadResult, String> {
    let loaded = macros_load(app_data_dir)?;
    let parsed: serde_json::Value = serde_json::from_str(&loaded.json)
        .map_err(|e| format!("invalid_json: Cannot accept corrupt macros.json: {e}"))?;
    if !parsed.is_array() {
        return Err("invalid_json: macros.json must be a JSON array".into());
    }
    let dir = notepad_root(app_data_dir);
    fs::create_dir_all(&dir).map_err(|e| path_io_error("create notepad dir", e))?;
    fs::write(
        macros_hash_path(app_data_dir),
        loaded.actual_hash.as_bytes(),
    )
    .map_err(|e| path_io_error("update macros.sha256", e))?;
    Ok(NotepadMacroLoadResult {
        json: loaded.json,
        expected_hash: loaded.actual_hash.clone(),
        actual_hash: loaded.actual_hash,
        tampered: false,
    })
}
