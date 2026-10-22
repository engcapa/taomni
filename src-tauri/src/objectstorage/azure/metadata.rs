use base64::Engine as _;

pub(super) fn net_err(e: reqwest::Error) -> String {
    format!("request failed: {e}")
}

/// Build a fixed-width, base64-encoded block id (Azure requires all block ids
/// in one blob to be the same length).
pub(super) fn block_id(index: u32) -> String {
    base64::engine::general_purpose::STANDARD.encode(format!("{index:08}"))
}

pub(super) async fn check(resp: reqwest::Response) -> Result<reqwest::Response, String> {
    let status = resp.status();
    if status.is_success() {
        return Ok(resp);
    }
    let code = resp
        .headers()
        .get("x-ms-error-code")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let body = resp.text().await.unwrap_or_default();
    Err(format!(
        "Azure error {} {}: {}",
        status.as_u16(),
        code,
        body.chars().take(400).collect::<String>()
    ))
}

pub(super) fn parse_http_date(s: &str) -> Option<i64> {
    chrono::NaiveDateTime::parse_from_str(s, "%a, %d %b %Y %H:%M:%S GMT")
        .ok()
        .map(|dt| dt.and_utc().timestamp())
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
                .ok_or_else(|| format!("blob '{key}' is outside prefix '{old_prefix}'"))?
                .to_string();
            Ok((key, format!("{new_prefix}{suffix}")))
        })
        .collect()
}
