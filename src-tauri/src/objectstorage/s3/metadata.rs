use crate::objectstorage::types::ObjectEntry;

/// Percent-encode each path segment of a key while preserving `/` separators
/// (for the `x-amz-copy-source` header).
pub(super) fn encode_key_path(key: &str) -> String {
    key.split('/')
        .map(|seg| urlencoding::encode(seg).into_owned())
        .collect::<Vec<_>>()
        .join("/")
}

pub(super) fn folder_marker_key(prefix: &str) -> String {
    if prefix.is_empty() || prefix.ends_with('/') {
        prefix.to_string()
    } else {
        format!("{prefix}/")
    }
}

pub(super) fn move_prefix_plan(
    old_prefix: &str,
    new_prefix: &str,
    keys: Vec<String>,
) -> Result<Vec<(String, String)>, String> {
    keys.into_iter()
        .map(|key| {
            let suffix = key
                .strip_prefix(old_prefix)
                .ok_or_else(|| format!("object '{key}' is outside prefix '{old_prefix}'"))?
                .to_string();
            Ok((key, format!("{new_prefix}{suffix}")))
        })
        .collect()
}

pub(super) fn folder_marker_entry(prefix: &str, key: &str, size: u64) -> Option<ObjectEntry> {
    if size != 0 || !key.ends_with('/') {
        return None;
    }
    let name = key
        .strip_prefix(prefix)
        .unwrap_or(key)
        .trim_end_matches('/');
    if name.is_empty() || name.contains('/') {
        return None;
    }
    Some(ObjectEntry {
        name: name.to_string(),
        key: key.to_string(),
        is_dir: true,
        size: 0,
        last_modified: None,
        etag: None,
        storage_class: None,
    })
}

pub(super) fn decode_list_value(value: &str) -> String {
    urlencoding::decode(value)
        .map(|decoded| decoded.into_owned())
        .unwrap_or_else(|_| value.to_string())
}

pub(super) fn parse_iso8601(s: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|dt| dt.timestamp())
}

/// Parse an RFC 1123 HTTP date (as returned by HEAD `Last-Modified`).
pub(super) fn parse_http_date(s: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc2822(s)
        .ok()
        .map(|dt| dt.timestamp())
        .or_else(|| {
            chrono::NaiveDateTime::parse_from_str(s, "%a, %d %b %Y %H:%M:%S GMT")
                .ok()
                .map(|dt| dt.and_utc().timestamp())
        })
}
