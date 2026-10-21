#[cfg(windows)]
use super::filesystem::env_join;
use super::filesystem::now_seconds;
use super::filesystem::percent_decode;
use super::filesystem::split_user_host;
use crate::session::models::AuthMethod;
use crate::session::models::SessionConfig;
use crate::session::models::SessionType;
use serde_json::json;
use std::collections::HashSet;
use std::path::PathBuf;
use uuid::Uuid;

#[cfg(windows)]
pub(super) fn platform_putty_sessions() -> Result<Vec<SessionConfig>, String> {
    use winreg::RegKey;
    use winreg::enums::HKEY_CURRENT_USER;

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
pub(super) fn platform_putty_sessions() -> Result<Vec<SessionConfig>, String> {
    Ok(Vec::new())
}

#[cfg(windows)]
pub(super) fn reg_string(key: &winreg::RegKey, name: &str) -> String {
    key.get_value::<String, _>(name).unwrap_or_default()
}

#[cfg(windows)]
pub(super) fn reg_u16(key: &winreg::RegKey, name: &str) -> Option<u16> {
    key.get_value::<u32, _>(name)
        .ok()
        .and_then(|value| u16::try_from(value).ok())
}

#[cfg(windows)]
pub(super) fn platform_wsl_sessions() -> Result<Vec<SessionConfig>, String> {
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
pub(super) fn platform_wsl_sessions() -> Result<Vec<SessionConfig>, String> {
    Ok(Vec::new())
}

pub(super) fn platform_external_bash_sessions() -> Vec<SessionConfig> {
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

pub(super) fn local_shell_session(
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
