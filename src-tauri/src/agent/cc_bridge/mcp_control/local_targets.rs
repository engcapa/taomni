use super::parameters::LocalShellParams;
use super::session_policy::is_secretish_key;
use tauri::Manager;

pub(super) fn is_quick_connect_local_alias(alias: &str) -> bool {
    matches!(
        alias.to_ascii_lowercase().as_str(),
        "shell" | "local" | "bash" | "sh"
    )
}

pub(super) fn quick_connect_target(input: &str) -> Option<(&str, bool)> {
    let raw = input.trim();
    if raw.is_empty() {
        return None;
    }

    if let Some((scheme, _)) = raw.split_once("://") {
        if scheme
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
        {
            return Some((raw, is_quick_connect_local_alias(scheme)));
        }
    }

    let mut parts = raw.splitn(2, char::is_whitespace);
    let first = parts.next().unwrap_or_default();
    let rest = parts.next().map(str::trim).unwrap_or("");
    if matches!(
        first.to_ascii_lowercase().as_str(),
        "ssh"
            | "sftp"
            | "ftp"
            | "telnet"
            | "rdp"
            | "vnc"
            | "serial"
            | "shell"
            | "local"
            | "bash"
            | "sh"
    ) {
        return Some((rest, is_quick_connect_local_alias(first)));
    }

    Some((raw, false))
}

pub(super) fn validate_quick_connect_secret_free(input: &str) -> Result<(), String> {
    let Some((target, is_local)) = quick_connect_target(input) else {
        return Ok(());
    };
    if is_local {
        return Ok(());
    }

    if let Ok(url) = url::Url::parse(target) {
        if url.password().is_some() {
            return Err("quick_connect URLs must not include plaintext passwords".into());
        }
        for (key, value) in url.query_pairs() {
            if is_secretish_key(&key) && !value.is_empty() && !value.starts_with("vault:") {
                return Err(format!(
                    "quick_connect query parameter '{}' looks like a plaintext secret; open the session editor or use the vault UI",
                    key
                ));
            }
        }
    }

    if let Some((userinfo, _host)) = target.rsplit_once('@') {
        let userinfo = userinfo
            .rsplit_once("://")
            .map(|(_, after_scheme)| after_scheme)
            .unwrap_or(userinfo);
        if userinfo.contains(':') {
            return Err(
                "quick_connect userinfo must not include plaintext passwords; use user@host only"
                    .into(),
            );
        }
    }

    Ok(())
}

pub(super) fn normalize_local_shell_type(value: &str) -> String {
    value
        .trim()
        .to_ascii_lowercase()
        .replace('_', "-")
        .replace(' ', "-")
}

pub(super) fn validate_local_shell_params(p: &LocalShellParams) -> Result<(), String> {
    let kind = p
        .shell_type
        .as_deref()
        .map(normalize_local_shell_type)
        .filter(|s| !s.is_empty());
    let has_path = p
        .path
        .as_deref()
        .map(str::trim)
        .is_some_and(|s| !s.is_empty());

    if kind.as_deref() == Some("custom") && !has_path {
        return Err("local_shell.type=custom requires local_shell.path".into());
    }

    if let Some(kind) = kind.as_deref() {
        if !matches!(
            kind,
            "default"
                | "cmd"
                | "cmd.exe"
                | "command-prompt"
                | "powershell"
                | "powershell7"
                | "pwsh"
                | "ps7"
                | "windows-powershell"
                | "windows-powershell5"
                | "powershell5"
                | "git-bash"
                | "gitbash"
                | "wsl"
                | "wsl.exe"
                | "bash"
                | "zsh"
                | "sh"
                | "custom"
        ) {
            return Err(format!(
                "unsupported local_shell.type '{}'; supported values: default, cmd, powershell7, windows-powershell, git-bash, wsl, bash, zsh, sh, custom",
                kind
            ));
        }
    }

    Ok(())
}
