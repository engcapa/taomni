use std::path::PathBuf;

pub(super) fn expanded_path(value: &str) -> PathBuf {
    PathBuf::from(shellexpand::tilde(value).to_string())
}

pub(super) fn initial_dir_from(current_path: Option<&str>) -> Option<PathBuf> {
    if let Some(raw) = current_path {
        let expanded = expanded_path(raw);
        if expanded.is_dir() {
            return Some(expanded);
        }
        if let Some(parent) = expanded.parent() {
            if parent.is_dir() {
                return Some(parent.to_path_buf());
            }
        }
    }

    dirs::home_dir()
        .map(|home| home.join(".ssh"))
        .filter(|path| path.is_dir())
        .or_else(dirs::home_dir)
}

pub(super) fn existing_file_from(current_path: Option<&str>) -> Option<PathBuf> {
    let path = expanded_path(current_path?);
    path.is_file().then_some(path)
}

pub(super) fn clipboard_paths_from_uri_text(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    for path in crate::rdp::cliprdr::uri_list_to_paths(text) {
        let value = path.to_string_lossy().into_owned();
        if !value.is_empty() && !out.contains(&value) {
            out.push(value);
        }
    }
    for line in text.lines() {
        let mut value = line.trim();
        if (value.starts_with('\'') && value.ends_with('\'') && value.len() >= 2)
            || (value.starts_with('"') && value.ends_with('"') && value.len() >= 2)
        {
            value = &value[1..value.len() - 1];
        }
        let value = value.trim();
        if value.is_empty()
            || value.starts_with('#')
            || value.eq_ignore_ascii_case("copy")
            || value.eq_ignore_ascii_case("cut")
            || value.starts_with("file://")
        {
            continue;
        }
        // Treat Unix absolute paths as absolute even on Windows (clipboard
        // content from remote/WSL/file managers often uses /home/... form).
        let is_abs = PathBuf::from(value).is_absolute()
            || value.starts_with('/')
            || (value.len() >= 3
                && value.as_bytes()[1] == b':'
                && value.as_bytes()[0].is_ascii_alphabetic());
        if is_abs && !out.iter().any(|path| path == value) {
            out.push(value.to_string());
        }
    }
    out
}
