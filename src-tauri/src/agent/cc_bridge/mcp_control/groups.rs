use crate::session::models::SessionGroup;

pub(super) fn normalize_group_path(path: Option<&str>) -> Option<String> {
    let raw = path?.trim();
    if raw.is_empty() {
        return None;
    }
    let parts: Vec<String> = raw
        .replace('\\', "/")
        .split('/')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToString::to_string)
        .collect();
    if parts.is_empty() {
        None
    } else {
        Some(parts.join(" / "))
    }
}

pub(super) fn parent_group_path(path: &str) -> Option<String> {
    let parts: Vec<&str> = path.split(" / ").collect();
    if parts.len() <= 1 {
        None
    } else {
        Some(parts[..parts.len() - 1].join(" / "))
    }
}

pub(super) fn leaf_group_name(path: &str) -> String {
    path.split(" / ").last().unwrap_or(path).to_string()
}

pub(super) fn ancestor_group_paths(path: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = Vec::new();
    for part in path.split(" / ") {
        current.push(part);
        out.push(current.join(" / "));
    }
    out
}

pub(super) fn path_contains(parent: &str, child: &str) -> bool {
    child == parent || child.starts_with(&format!("{parent} / "))
}

pub(super) fn replace_group_prefix(
    path: Option<&str>,
    old_path: &str,
    new_path: &str,
) -> Option<String> {
    let current = normalize_group_path(path)?;
    if current == old_path {
        Some(new_path.to_string())
    } else {
        current
            .strip_prefix(&format!("{old_path} / "))
            .map(|rest| format!("{new_path} / {rest}"))
    }
}

pub(super) fn group_for_path(path: &str) -> SessionGroup {
    SessionGroup {
        id: path.to_string(),
        name: leaf_group_name(path),
        parent_id: parent_group_path(path),
        sort_order: 0,
        icon: None,
    }
}

pub(super) fn ensure_group_path(
    db: &rusqlite::Connection,
    path: Option<&str>,
) -> Result<(), String> {
    let Some(path) = normalize_group_path(path) else {
        return Ok(());
    };
    for ancestor in ancestor_group_paths(&path) {
        crate::session::db::save_group(db, &group_for_path(&ancestor))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}
