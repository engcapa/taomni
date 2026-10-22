use super::credentials::DBEAVER_CREDENTIALS_CONFIG_FILE;
use super::credentials::parse_dbeaver_credentials_config;
use super::discovery::scan_dbeaver;
use super::discovery::scan_iterm2;
use super::discovery::scan_mremote;
use super::discovery::scan_securecrt;
use super::discovery::scan_tabby;
use super::discovery::scan_terminal_app;
use super::discovery::scan_termius_exports;
use super::discovery::scan_windterm;
use super::local_shells::platform_external_bash_sessions;
#[cfg(any(windows, not(windows)))]
use super::local_shells::platform_putty_sessions;
#[cfg(any(windows, not(windows)))]
use super::local_shells::platform_wsl_sessions;
use super::model::DbeaverCredentialEntry;
use super::model::LocalSessionFile;
use super::model::MAX_LOCAL_SESSION_FILE_BYTES;
use super::xshell::scan_xshell;
use crate::session::models::SessionConfig;
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

#[tauri::command]
pub fn import_putty_sessions() -> Result<Vec<SessionConfig>, String> {
    platform_putty_sessions()
}

#[tauri::command]
pub fn import_wsl_sessions() -> Result<Vec<SessionConfig>, String> {
    platform_wsl_sessions()
}

#[tauri::command]
pub fn import_external_bash_sessions() -> Result<Vec<SessionConfig>, String> {
    Ok(platform_external_bash_sessions())
}

#[tauri::command]
pub fn scan_local_session_files(source: String) -> Result<Vec<LocalSessionFile>, String> {
    let key = source.trim().to_ascii_lowercase();
    let mut files = Vec::new();
    match key.as_str() {
        "xshell" => scan_xshell(&mut files),
        "tabby" => scan_tabby(&mut files),
        "windterm" => scan_windterm(&mut files),
        "dbeaver" => scan_dbeaver(&mut files),
        "iterm2" | "iterm" => scan_iterm2(&mut files),
        "terminal" | "terminal.app" => scan_terminal_app(&mut files),
        "termius" => scan_termius_exports(&mut files),
        "mremote" | "mremoteng" => scan_mremote(&mut files),
        "securecrt" | "scrt" => scan_securecrt(&mut files),
        _ => return Err(format!("Unsupported local session source: {}", source)),
    }
    Ok(files)
}

#[tauri::command]
pub fn read_dbeaver_credentials_for_data_sources(
    path: String,
) -> Result<HashMap<String, DbeaverCredentialEntry>, String> {
    let expanded = shellexpand::tilde(&path).to_string();
    let data_sources_path = PathBuf::from(&expanded);
    let data_sources_meta = fs::metadata(&data_sources_path)
        .map_err(|e| format!("Failed to read DBeaver data-source metadata: {}", e))?;
    if !data_sources_meta.is_file() {
        return Err("The selected DBeaver data-source path is not a file.".to_string());
    }
    let credentials_path = data_sources_path
        .parent()
        .ok_or_else(|| "The selected DBeaver data-source path has no parent folder.".to_string())?
        .join(DBEAVER_CREDENTIALS_CONFIG_FILE);
    if !credentials_path.exists() {
        return Ok(HashMap::new());
    }

    let credentials_meta = fs::metadata(&credentials_path)
        .map_err(|e| format!("Failed to read DBeaver credentials metadata: {}", e))?;
    if !credentials_meta.is_file() {
        return Err("The DBeaver credentials-config.json path is not a file.".to_string());
    }
    if credentials_meta.len() > MAX_LOCAL_SESSION_FILE_BYTES {
        return Err(
            "The DBeaver credentials-config.json file is too large to import safely.".to_string(),
        );
    }

    let encrypted = fs::read(&credentials_path)
        .map_err(|e| format!("Failed to read DBeaver credentials-config.json: {}", e))?;
    parse_dbeaver_credentials_config(&encrypted)
        .map_err(|e| format!("Failed to decrypt DBeaver credentials-config.json: {}", e))
}

#[tauri::command]
pub fn read_plist_session_file(path: String) -> Result<LocalSessionFile, String> {
    let expanded = shellexpand::tilde(&path).to_string();
    let path_buf = PathBuf::from(&expanded);
    let meta =
        fs::metadata(&path_buf).map_err(|e| format!("Failed to read plist metadata: {}", e))?;
    if !meta.is_file() {
        return Err("The selected path is not a file.".to_string());
    }
    if meta.len() > MAX_LOCAL_SESSION_FILE_BYTES {
        return Err("The selected plist file is too large to import safely.".to_string());
    }

    let value = plist::Value::from_file(&path_buf)
        .map_err(|e| format!("Failed to parse plist file: {}", e))?;
    let mut bytes = Vec::new();
    value
        .to_writer_xml(&mut bytes)
        .map_err(|e| format!("Failed to convert plist file to XML: {}", e))?;
    let text = String::from_utf8(bytes)
        .map_err(|e| format!("Converted plist XML was not UTF-8: {}", e))?;
    let relative_path = path_buf
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("session.plist")
        .to_string();

    Ok(LocalSessionFile {
        source: "plist".to_string(),
        path: path_buf.to_string_lossy().into_owned(),
        relative_path,
        text,
    })
}
