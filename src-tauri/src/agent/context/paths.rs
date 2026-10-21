use super::limits::MAX_CODE_WORKSPACE_PATH_LEN;

pub(super) fn clean_opt(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToString::to_string)
}

pub(super) fn clean_code_workspace_path(value: &str) -> Option<String> {
    let path = value.trim().replace('\\', "/");
    if path.is_empty()
        || path.starts_with('/')
        || path.contains(':')
        || path
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
        || path.len() > MAX_CODE_WORKSPACE_PATH_LEN
    {
        return None;
    }
    Some(path)
}

pub(super) fn clean_code_workspace_os_path(value: &str) -> Option<String> {
    let path = value.trim().replace('\\', "/");
    if path.is_empty()
        || path.contains('\n')
        || path.contains('\r')
        || path.len() > MAX_CODE_WORKSPACE_PATH_LEN * 4
    {
        return None;
    }
    Some(path)
}

pub(super) fn clean_code_workspace_id(value: &str) -> Option<String> {
    let id = value.trim();
    if id.is_empty()
        || id.len() > 128
        || id.contains('\n')
        || id.contains('\r')
        || id.contains('/')
        || id.contains('\\')
    {
        return None;
    }
    Some(id.to_string())
}

pub(super) fn clean_code_workspace_name(value: &str) -> Option<String> {
    let name = value.trim();
    if name.is_empty() || name.len() > 160 || name.contains('\n') || name.contains('\r') {
        return None;
    }
    Some(name.to_string())
}

pub(super) fn code_workspace_basename(path: &str) -> Option<String> {
    path.trim_end_matches('/')
        .rsplit('/')
        .find(|part| !part.is_empty())
        .and_then(clean_code_workspace_name)
}
