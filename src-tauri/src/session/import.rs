use super::models::{AuthMethod, SessionConfig, SessionType};
use serde::Serialize;
use serde_json::json;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

const MAX_LOCAL_SESSION_FILE_BYTES: u64 = 2_000_000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalSessionFile {
    pub source: String,
    pub path: String,
    pub relative_path: String,
    pub text: String,
}

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

#[cfg(windows)]
fn platform_putty_sessions() -> Result<Vec<SessionConfig>, String> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let sessions_key = hkcu
        .open_subkey("Software\\SimonTatham\\PuTTY\\Sessions")
        .map_err(|e| format!("PuTTY sessions registry key was not found: {}", e))?;

    let mut out = Vec::new();
    let now = now_seconds();
    for key_name in sessions_key.enum_keys().flatten() {
        let Ok(session_key) = sessions_key.open_subkey(&key_name) else {
            continue;
        };
        let host_name = reg_string(&session_key, "HostName");
        if host_name.trim().is_empty() {
            continue;
        }
        let protocol = reg_string(&session_key, "Protocol").to_ascii_lowercase();
        let session_type = match protocol.as_str() {
            "telnet" => SessionType::Telnet,
            "serial" => SessionType::Serial,
            _ => SessionType::SSH,
        };
        let port =
            reg_u16(&session_key, "PortNumber").unwrap_or_else(|| session_type.default_port());
        let (username, host) = split_user_host(&host_name, reg_string(&session_key, "UserName"));
        if host.trim().is_empty() && session_type != SessionType::Serial {
            continue;
        }
        let key_path = reg_string(&session_key, "PublicKeyFile");
        let auth_method = if !key_path.trim().is_empty() {
            AuthMethod::PrivateKey { key_path }
        } else if session_type == SessionType::SSH {
            AuthMethod::Password
        } else {
            AuthMethod::None
        };

        out.push(SessionConfig {
            id: Uuid::new_v4().to_string(),
            name: percent_decode(&key_name),
            session_type,
            group_path: Some("User sessions / Imported / PuTTY".to_string()),
            host,
            port,
            username,
            auth_method,
            options_json: json!({ "description": "Imported from PuTTY registry" }).to_string(),
            created_at: now,
            updated_at: now,
            last_connected_at: None,
            sort_order: 0,
        });
    }

    Ok(out)
}

#[cfg(not(windows))]
fn platform_putty_sessions() -> Result<Vec<SessionConfig>, String> {
    Ok(Vec::new())
}

#[cfg(windows)]
fn reg_string(key: &winreg::RegKey, name: &str) -> String {
    key.get_value::<String, _>(name).unwrap_or_default()
}

#[cfg(windows)]
fn reg_u16(key: &winreg::RegKey, name: &str) -> Option<u16> {
    key.get_value::<u32, _>(name)
        .ok()
        .and_then(|value| u16::try_from(value).ok())
}

#[cfg(windows)]
fn platform_wsl_sessions() -> Result<Vec<SessionConfig>, String> {
    let distros = crate::wsl::list_distros()?;
    let now = now_seconds();
    let mut sessions = Vec::with_capacity(distros.len());
    for distro in distros {
        sessions.push(local_shell_session(
            format!("WSL: {}", distro.name),
            "User sessions / Imported / WSL",
            "wsl.exe".to_string(),
            vec!["-d".to_string(), distro.name],
            "Imported from WSL",
            now,
        ));
    }
    Ok(sessions)
}

#[cfg(not(windows))]
fn platform_wsl_sessions() -> Result<Vec<SessionConfig>, String> {
    Ok(Vec::new())
}

fn platform_external_bash_sessions() -> Vec<SessionConfig> {
    let now = now_seconds();
    let mut candidates: Vec<(String, PathBuf, Vec<String>)> = Vec::new();

    #[cfg(windows)]
    {
        candidates.extend(
            [
                (
                    "Git Bash".to_string(),
                    env_join("ProgramFiles", "Git\\bin\\bash.exe"),
                    vec!["--login".to_string(), "-i".to_string()],
                ),
                (
                    "Git Bash".to_string(),
                    env_join("ProgramW6432", "Git\\bin\\bash.exe"),
                    vec!["--login".to_string(), "-i".to_string()],
                ),
                (
                    "Git Bash".to_string(),
                    env_join("ProgramFiles(x86)", "Git\\bin\\bash.exe"),
                    vec!["--login".to_string(), "-i".to_string()],
                ),
                (
                    "Git Bash".to_string(),
                    env_join("LOCALAPPDATA", "Programs\\Git\\bin\\bash.exe"),
                    vec!["--login".to_string(), "-i".to_string()],
                ),
                (
                    "Cygwin Bash".to_string(),
                    Some(PathBuf::from("C:\\cygwin64\\bin\\bash.exe")),
                    vec!["--login".to_string(), "-i".to_string()],
                ),
                (
                    "MSYS2 Bash".to_string(),
                    Some(PathBuf::from("C:\\msys64\\usr\\bin\\bash.exe")),
                    vec!["--login".to_string(), "-i".to_string()],
                ),
            ]
            .into_iter()
            .filter_map(|(name, path, args)| path.map(|p| (name, p, args))),
        );
    }

    #[cfg(unix)]
    {
        candidates.extend([
            (
                "Bash".to_string(),
                PathBuf::from("/bin/bash"),
                vec!["--login".to_string()],
            ),
            ("Zsh".to_string(), PathBuf::from("/bin/zsh"), Vec::new()),
            (
                "Fish".to_string(),
                PathBuf::from("/usr/bin/fish"),
                Vec::new(),
            ),
        ]);
    }

    let mut seen = HashSet::new();
    candidates
        .into_iter()
        .filter(|(_, path, _)| path.is_file())
        .filter(|(_, path, _)| seen.insert(path.to_string_lossy().to_ascii_lowercase()))
        .map(|(name, path, args)| {
            local_shell_session(
                name,
                "User sessions / Imported / External Bash",
                path.to_string_lossy().into_owned(),
                args,
                "Imported from local shell scan",
                now,
            )
        })
        .collect()
}

fn local_shell_session(
    name: String,
    group_path: &str,
    shell_path: String,
    shell_args: Vec<String>,
    description: &str,
    now: i64,
) -> SessionConfig {
    SessionConfig {
        id: Uuid::new_v4().to_string(),
        name,
        session_type: SessionType::LocalShell,
        group_path: Some(group_path.to_string()),
        host: String::new(),
        port: 0,
        username: None,
        auth_method: AuthMethod::None,
        options_json: json!({
            "localShellPath": shell_path,
            "localShellArgs": shell_args,
            "description": description,
        })
        .to_string(),
        created_at: now,
        updated_at: now,
        last_connected_at: None,
        sort_order: 0,
    }
}

fn scan_xshell(files: &mut Vec<LocalSessionFile>) {
    #[cfg(windows)]
    if let Some(appdata) = std::env::var_os("APPDATA").map(PathBuf::from) {
        scan_dir_for_ext(
            "xshell",
            &appdata.join("NetSarang").join("Xshell").join("Sessions"),
            "xsh",
            files,
        );
    }
}

fn scan_tabby(files: &mut Vec<LocalSessionFile>) {
    for path in tabby_config_candidates() {
        push_file(
            "tabby",
            &path,
            path.file_name()
                .and_then(|v| v.to_str())
                .unwrap_or("config.yaml"),
            files,
        );
    }
}

fn scan_windterm(files: &mut Vec<LocalSessionFile>) {
    let mut roots = Vec::new();
    if let Some(path) = std::env::var_os("WINDTERM_PROFILE_DIR").map(PathBuf::from) {
        roots.push(path);
    }
    if let Some(home) = home_dir() {
        roots.push(home.join(".wind"));
        roots.push(home.join("WindTerm"));
    }
    #[cfg(windows)]
    {
        if let Some(local) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) {
            roots.push(local.join("WindTerm"));
        }
        if let Some(appdata) = std::env::var_os("APPDATA").map(PathBuf::from) {
            roots.push(appdata.join("WindTerm"));
        }
    }

    for root in roots {
        scan_dir_for_names(
            "windterm",
            &root,
            &["user.sessions", "user.sessions.json"],
            files,
        );
    }
}

fn scan_iterm2(_files: &mut Vec<LocalSessionFile>) {
    #[cfg(target_os = "macos")]
    if let Some(home) = home_dir() {
        let root = home
            .join("Library")
            .join("Application Support")
            .join("iTerm2")
            .join("DynamicProfiles");
        scan_dir_for_ext("iterm2", &root, "json", _files);
        scan_dir_for_ext("iterm2", &root, "plist", _files);
    }
}

fn scan_terminal_app(_files: &mut Vec<LocalSessionFile>) {
    #[cfg(target_os = "macos")]
    if let Some(home) = home_dir() {
        let pref = home
            .join("Library")
            .join("Preferences")
            .join("com.apple.Terminal.plist");
        if pref.is_file() {
            if let Ok(output) = Command::new("plutil")
                .args(["-convert", "xml1", "-o", "-", &pref.to_string_lossy()])
                .output()
            {
                if output.status.success() {
                    let text = decode_command_output(&output.stdout);
                    _files.push(LocalSessionFile {
                        source: "terminal".to_string(),
                        path: pref.to_string_lossy().into_owned(),
                        relative_path: "com.apple.Terminal.plist".to_string(),
                        text,
                    });
                }
            }
        }
    }
}

fn scan_termius_exports(files: &mut Vec<LocalSessionFile>) {
    if let Some(home) = home_dir() {
        for rel in [
            ".termius/ssh_config",
            ".termius/exported_ssh_config",
            "termius-ssh-config",
            "Downloads/termius-ssh-config",
        ] {
            push_file("termius", &home.join(rel), rel, files);
        }
    }
}

fn scan_mremote(files: &mut Vec<LocalSessionFile>) {
    #[cfg(windows)]
    if let Some(appdata) = std::env::var_os("APPDATA").map(PathBuf::from) {
        push_file(
            "mremote",
            &appdata.join("mRemoteNG").join("confCons.xml"),
            "confCons.xml",
            files,
        );
    }
}

fn scan_securecrt(files: &mut Vec<LocalSessionFile>) {
    #[cfg(windows)]
    if let Some(appdata) = std::env::var_os("APPDATA").map(PathBuf::from) {
        scan_dir_for_ext(
            "securecrt",
            &appdata.join("VanDyke").join("Config").join("Sessions"),
            "ini",
            files,
        );
    }
    #[cfg(target_os = "macos")]
    if let Some(home) = home_dir() {
        scan_dir_for_ext(
            "securecrt",
            &home
                .join("Library")
                .join("Application Support")
                .join("VanDyke")
                .join("Config")
                .join("Sessions"),
            "ini",
            files,
        );
    }
}

fn tabby_config_candidates() -> Vec<PathBuf> {
    let mut out = Vec::new();
    #[cfg(windows)]
    if let Some(appdata) = std::env::var_os("APPDATA").map(PathBuf::from) {
        out.push(appdata.join("tabby").join("config.yaml"));
    }
    #[cfg(target_os = "macos")]
    if let Some(home) = home_dir() {
        out.push(
            home.join("Library")
                .join("Application Support")
                .join("tabby")
                .join("config.yaml"),
        );
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    if let Some(home) = home_dir() {
        out.push(home.join(".config").join("tabby").join("config.yaml"));
    }
    if let Some(home) = home_dir() {
        out.push(home.join(".tabby").join("config.yaml"));
    }
    out
}

fn scan_dir_for_ext(source: &str, root: &Path, ext: &str, files: &mut Vec<LocalSessionFile>) {
    scan_dir(source, root, files, &|path| {
        path.extension()
            .and_then(|value| value.to_str())
            .map(|value| value.eq_ignore_ascii_case(ext))
            .unwrap_or(false)
    });
}

fn scan_dir_for_names(
    source: &str,
    root: &Path,
    names: &[&str],
    files: &mut Vec<LocalSessionFile>,
) {
    scan_dir(source, root, files, &|path| {
        path.file_name()
            .and_then(|value| value.to_str())
            .map(|value| names.iter().any(|name| value.eq_ignore_ascii_case(name)))
            .unwrap_or(false)
    });
}

fn scan_dir<F>(source: &str, root: &Path, files: &mut Vec<LocalSessionFile>, matches: &F)
where
    F: Fn(&Path) -> bool,
{
    if !root.is_dir() {
        return;
    }
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            scan_dir(source, &path, files, matches);
        } else if matches(&path) {
            let relative = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            push_file(source, &path, &relative, files);
        }
    }
}

fn push_file(source: &str, path: &Path, relative_path: &str, files: &mut Vec<LocalSessionFile>) {
    if !path.is_file() {
        return;
    }
    let Ok(meta) = fs::metadata(path) else {
        return;
    };
    if meta.len() > MAX_LOCAL_SESSION_FILE_BYTES {
        return;
    }
    if let Ok(bytes) = fs::read(path) {
        files.push(LocalSessionFile {
            source: source.to_string(),
            path: path.to_string_lossy().into_owned(),
            relative_path: relative_path.to_string(),
            text: decode_command_output(&bytes),
        });
    }
}

fn split_user_host(host_name: &str, explicit_user: String) -> (Option<String>, String) {
    if let Some((user, host)) = host_name.split_once('@') {
        if !user.trim().is_empty() && !host.trim().is_empty() {
            return (Some(user.trim().to_string()), host.trim().to_string());
        }
    }
    let user = if explicit_user.trim().is_empty() {
        None
    } else {
        Some(explicit_user.trim().to_string())
    };
    (user, host_name.trim().to_string())
}

pub(crate) fn decode_command_output(bytes: &[u8]) -> String {
    if bytes.len() >= 2 && bytes[0] == 0xff && bytes[1] == 0xfe {
        let units = bytes[2..]
            .chunks_exact(2)
            .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
            .collect::<Vec<_>>();
        return String::from_utf16_lossy(&units).replace('\u{0}', "");
    }
    if bytes.len() >= 2 && bytes[0] == 0xfe && bytes[1] == 0xff {
        let units = bytes[2..]
            .chunks_exact(2)
            .map(|chunk| u16::from_be_bytes([chunk[0], chunk[1]]))
            .collect::<Vec<_>>();
        return String::from_utf16_lossy(&units).replace('\u{0}', "");
    }
    if bytes.iter().filter(|byte| **byte == 0).count() > bytes.len() / 8 {
        let units = bytes
            .chunks_exact(2)
            .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
            .collect::<Vec<_>>();
        return String::from_utf16_lossy(&units).replace('\u{0}', "");
    }
    String::from_utf8_lossy(bytes).replace('\u{0}', "")
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(hex) = u8::from_str_radix(&value[i + 1..i + 3], 16) {
                out.push(hex);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn now_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0)
}

fn home_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        std::env::var_os("USERPROFILE").map(PathBuf::from)
    }
    #[cfg(not(windows))]
    {
        std::env::var_os("HOME").map(PathBuf::from)
    }
}

#[cfg(windows)]
fn env_join(var: &str, child: &str) -> Option<PathBuf> {
    std::env::var_os(var)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .map(|base| base.join(child))
}
