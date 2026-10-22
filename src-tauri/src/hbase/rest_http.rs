use super::rest_session::RestSession;
use reqwest::Method;
use reqwest::header::CONTENT_TYPE;
use serde_json::Value;
pub(super) async fn ping_session(session: &RestSession) -> Result<String, String> {
    let value = get_json(session, "/version/cluster?format=json").await?;
    if let Some(version) = value.get("Version").and_then(Value::as_str) {
        Ok(format!("HBase REST connection OK ({version})"))
    } else if let Some(version) = value.get("version").and_then(Value::as_str) {
        Ok(format!("HBase REST connection OK ({version})"))
    } else {
        Ok("HBase REST connection OK".into())
    }
}

pub(super) async fn get_json(session: &RestSession, path: &str) -> Result<Value, String> {
    send_json(session, Method::GET, path, None).await
}

pub(super) async fn send_json(
    session: &RestSession,
    method: Method,
    path: &str,
    body: Option<Value>,
) -> Result<Value, String> {
    let mut req = session.request(method, session.url(path));
    if let Some(body) = body {
        req = req.header(CONTENT_TYPE, "application/json").json(&body);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| describe_request_error("HBase REST request failed", &e))?;
    response_json(resp).await
}

/// Build a diagnostic message that exposes the underlying transport cause.
///
/// `reqwest::Error`'s top-level `Display` is the unhelpful
/// "error sending request for url (...)"; the real reason (connection refused,
/// timed out, DNS failure, TLS handshake) only lives in its `source()` chain.
/// We classify the failure and append the deepest distinct cause so the user
/// can tell a routing/firewall problem from a wrong port or a TLS mismatch.
pub(super) fn describe_request_error(context: &str, err: &reqwest::Error) -> String {
    use std::error::Error;

    let kind = if err.is_timeout() {
        "timed out"
    } else if err.is_connect() {
        "connection failed"
    } else if err.is_redirect() {
        "too many redirects"
    } else {
        "send failed"
    };

    let mut causes: Vec<String> = Vec::new();
    let mut source = err.source();
    while let Some(cause) = source {
        let msg = cause.to_string();
        if causes.last().map(String::as_str) != Some(msg.as_str()) {
            causes.push(msg);
        }
        source = cause.source();
    }

    if causes.is_empty() {
        format!("{context} ({kind}): {err}")
    } else {
        format!("{context} ({kind}): {}", causes.join(": "))
    }
}

pub(super) async fn response_json(resp: reqwest::Response) -> Result<Value, String> {
    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("HBase REST response read failed: {e}"))?;
    if !status.is_success() {
        return Err(format!("HBase REST error ({status}): {}", text.trim()));
    }
    if text.trim().is_empty() {
        Ok(Value::Null)
    } else {
        serde_json::from_str(&text)
            .map_err(|e| format!("HBase REST JSON parse failed: {e}; body: {}", text.trim()))
    }
}
