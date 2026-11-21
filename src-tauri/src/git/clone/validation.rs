use std::path::{Component, Path, PathBuf};

pub(super) fn normalized_url(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("Repository URL is required".into());
    }
    if trimmed.chars().any(char::is_control) {
        return Err("Repository URL contains control characters".into());
    }
    if trimmed.starts_with('-') {
        return Err("Repository URL cannot start with '-'".into());
    }
    let is_local = Path::new(trimmed).is_absolute()
        && !trimmed.contains("://")
        && !looks_like_scp_url(trimmed);
    if is_local {
        return Ok(trimmed.to_string());
    }
    if trimmed.chars().any(char::is_whitespace) {
        return Err("Repository URL cannot contain whitespace".into());
    }
    if looks_like_scp_url(trimmed) {
        return Ok(trimmed.to_string());
    }
    let parsed = url::Url::parse(trimmed)
        .map_err(|_| "Repository URL is not a valid Git URL".to_string())?;
    match parsed.scheme() {
        "http" | "https" => {
            if !parsed.username().is_empty() || parsed.password().is_some() {
                return Err(
                    "Remove credentials from the URL and use the Token field instead".into(),
                );
            }
            if parsed.host_str().is_none() {
                return Err("Repository URL has no host".into());
            }
        }
        "ssh" | "git" => {
            if parsed.host_str().is_none() {
                return Err("Repository URL has no host".into());
            }
        }
        "file" => {}
        other => return Err(format!("Unsupported Git URL scheme: {other}")),
    }
    Ok(trimmed.to_string())
}

fn looks_like_scp_url(value: &str) -> bool {
    if value.contains("://") {
        return false;
    }
    let Some((authority, path)) = value.split_once(':') else {
        return false;
    };
    !authority.is_empty()
        && authority.contains('@')
        && !authority.contains('/')
        && !path.is_empty()
        && !path.starts_with("//")
}

pub(super) fn normalized_branch(value: Option<&str>) -> Result<Option<String>, String> {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let forbidden = ['~', '^', ':', '?', '*', '[', '\\'];
    if value.starts_with('-')
        || value.starts_with('/')
        || value.ends_with('/')
        || value.ends_with('.')
        || value.contains("..")
        || value.contains("@{")
        || value.contains("//")
        || value
            .chars()
            .any(|ch| ch.is_control() || ch.is_whitespace() || forbidden.contains(&ch))
    {
        return Err("Branch name is not a valid Git branch".into());
    }
    Ok(Some(value.to_string()))
}

pub(super) fn normalized_name(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("Workspace name is required".into());
    }
    if trimmed.chars().count() > 120 {
        return Err("Workspace name is too long".into());
    }
    if trimmed.contains('/')
        || trimmed.contains('\\')
        || trimmed.contains("..")
        || trimmed.chars().any(char::is_control)
    {
        return Err("Workspace name cannot contain path separators".into());
    }
    Ok(trimmed.to_string())
}

pub(super) fn normalized_destination(value: &str) -> Result<PathBuf, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("Clone destination is required".into());
    }
    let path = PathBuf::from(trimmed);
    if !path.is_absolute() {
        return Err("Clone destination must be an absolute path".into());
    }
    if path
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return Err("Clone destination cannot contain '..'".into());
    }
    Ok(path)
}

pub(super) fn normalized_proxy(value: Option<&str>) -> Result<Option<String>, String> {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    if value.chars().any(char::is_control) || value.chars().any(char::is_whitespace) {
        return Err("Proxy URL cannot contain whitespace".into());
    }
    let parsed = url::Url::parse(value).map_err(|_| "Proxy URL is not valid".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https" | "socks5") || parsed.host_str().is_none() {
        return Err("Proxy URL must be http(s):// or socks5:// with a host".into());
    }
    Ok(Some(value.to_string()))
}
