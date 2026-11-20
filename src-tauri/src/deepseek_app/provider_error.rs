//! Preserve actionable provider errors without retaining raw responses or keys.
use futures::StreamExt;
use serde_json::Value;

const MAX_BODY: usize = 16 * 1024;

pub async fn describe(response: reqwest::Response, api_key: &str) -> String {
    let status = response.status().as_u16();
    let body = tokio::time::timeout(std::time::Duration::from_secs(3), async {
        let mut stream = response.bytes_stream();
        let mut body = Vec::new();
        while let Some(Ok(chunk)) = stream.next().await {
            if body.len() + chunk.len() > MAX_BODY {
                return Vec::new();
            }
            body.extend_from_slice(&chunk);
        }
        body
    })
    .await
    .unwrap_or_default();
    format_error(status, &body, api_key)
}

fn format_error(status: u16, body: &[u8], api_key: &str) -> String {
    let mut message = format!("http: provider returned HTTP {status}");
    if let Ok(json) = serde_json::from_slice::<Value>(body) {
        let error = json.get("error").unwrap_or(&json);
        let detail = error
            .get("message")
            .and_then(Value::as_str)
            .or_else(|| error.as_str());
        if let Some(detail) = detail {
            let safe = if api_key.is_empty() {
                detail.to_owned()
            } else {
                detail.replace(api_key, "[REDACTED]")
            };
            let safe = crate::chat::redact::redact(&safe).0;
            let safe = safe.split_whitespace().collect::<Vec<_>>().join(" ");
            let safe: String = safe.chars().take(400).collect();
            if !safe.is_empty() {
                message.push_str(": ");
                message.push_str(&safe);
            }
        }
    }
    if status == 401 || status == 403 {
        message.push_str(
            ". Check the provider URL, API key and access to the selected model in Settings.",
        );
    }
    message
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn forbidden_retains_model_access_reason_and_redacts_the_actual_key() {
        let secret = "opaque-test-credential";
        let body =
            serde_json::json!({"error":{"message":format!("Model access denied\nfor {secret}")}});
        let error = format_error(403, body.to_string().as_bytes(), secret);
        assert!(error.contains("HTTP 403: Model access denied"));
        assert!(error.contains("selected model in Settings"));
        assert!(!error.contains(secret));
        assert!(!error.contains('\n'));
    }

    #[test]
    fn non_json_proxy_pages_are_not_exposed_and_json_details_are_bounded() {
        let page = b"<html>proxy session cookie secret</html>";
        let error = format_error(403, page, "");
        assert!(error.contains("HTTP 403"));
        assert!(!error.contains("cookie"));
        let body = serde_json::json!({"message":"x".repeat(10_000)});
        assert!(format_error(429, body.to_string().as_bytes(), "").len() < 500);
        assert_eq!(
            format_error(502, b"invalid", ""),
            "http: provider returned HTTP 502"
        );
    }

    #[tokio::test]
    async fn bounded_http_response_retains_only_the_safe_error() {
        let response = reqwest::Response::from(
            tauri::http::Response::builder()
                .status(403)
                .body(r#"{"error":{"message":"Model unavailable"}}"#)
                .unwrap(),
        );
        assert!(describe(response, "").await.contains("Model unavailable"));
        let response = reqwest::Response::from(
            tauri::http::Response::builder()
                .status(403)
                .body("x".repeat(MAX_BODY + 1))
                .unwrap(),
        );
        assert_eq!(describe(response, "").await, format_error(403, &[], ""));
    }
}
