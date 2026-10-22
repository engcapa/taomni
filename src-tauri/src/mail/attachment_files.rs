use super::*;

pub(super) fn save_raw_message(
    account: &ResolvedMailAccount,
    folder: &str,
    uid: u32,
    body: &[u8],
) -> Result<(), String> {
    let Some(root) = account
        .config
        .cache
        .save_directory
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(());
    };

    let folder_component = sanitize_path_component(folder);
    let account_component = sanitize_path_component(&account.config.session_id);
    let dir = Path::new(root)
        .join(account_component)
        .join(folder_component);
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("failed to create mail save directory: {e}"))?;
    let path = dir.join(format!("{uid}.eml"));
    if path.exists() {
        return Ok(());
    }
    write_new_file(&path, body).map_err(|e| format!("failed to save fetched email: {e}"))
}

pub(super) fn write_new_file(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write as _;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?;
    file.write_all(bytes)
}

pub(super) fn sanitize_path_component(value: &str) -> String {
    let cleaned = value
        .chars()
        .map(|ch| match ch {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            ch if ch.is_control() => '_',
            ch => ch,
        })
        .collect::<String>()
        .trim()
        .trim_matches('.')
        .to_string();
    if cleaned.is_empty() {
        "_".into()
    } else {
        cleaned
    }
}

pub(super) fn write_attachment_file(target_path: &str, bytes: &[u8]) -> Result<String, String> {
    let path = std::path::PathBuf::from(target_path);
    if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("failed to create attachment folder: {e}"))?;
    }
    std::fs::write(&path, bytes).map_err(|e| format!("failed to write attachment: {e}"))?;
    Ok(path.to_string_lossy().to_string())
}
