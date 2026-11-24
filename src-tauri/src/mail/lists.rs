//! Mailing-list helpers (TASK-18): `List-Unsubscribe` (RFC 2369) and
//! one-click unsubscribe (RFC 8058).

use std::time::Duration;

#[cfg(test)]
use taomni_mail_storage::parse_list_unsubscribe;

async fn post_one_click(url: &str, allow_plain_http: bool) -> Result<u16, String> {
    let parsed = reqwest::Url::parse(url).map_err(|e| format!("invalid unsubscribe URL: {e}"))?;
    let scheme_ok = parsed.scheme() == "https" || (allow_plain_http && parsed.scheme() == "http");
    if !scheme_ok {
        return Err("one-click unsubscribe requires an https URL".into());
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| format!("HTTP client setup failed: {e}"))?;
    // RFC 8058 §3.1: POST exactly this form body, no cookies or credentials.
    let response = client
        .post(parsed)
        .header(
            reqwest::header::CONTENT_TYPE,
            "application/x-www-form-urlencoded",
        )
        .body("List-Unsubscribe=One-Click")
        .send()
        .await
        .map_err(|e| format!("unsubscribe request failed: {e}"))?;
    let status = response.status();
    if status.is_success() {
        Ok(status.as_u16())
    } else {
        Err(format!(
            "unsubscribe request returned HTTP {}",
            status.as_u16()
        ))
    }
}

/// RFC 8058 one-click unsubscribe. The frontend asks the user first.
#[tauri::command]
pub async fn mail_unsubscribe_one_click(url: String) -> Result<u16, String> {
    post_one_click(&url, false).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    #[test]
    fn parses_uris_and_one_click() {
        let parsed = parse_list_unsubscribe(
            Some("<mailto:leave@lists.example.com?subject=unsubscribe>,\r\n <https://example.com/u/abc>"),
            Some("List-Unsubscribe=One-Click"),
        )
        .unwrap();
        assert_eq!(
            parsed.uris,
            vec![
                "mailto:leave@lists.example.com?subject=unsubscribe".to_string(),
                "https://example.com/u/abc".to_string()
            ]
        );
        assert!(parsed.one_click);

        let mailto_only = parse_list_unsubscribe(
            Some("<mailto:leave@example.com>"),
            Some("List-Unsubscribe=One-Click"),
        )
        .unwrap();
        assert!(!mailto_only.one_click, "one-click needs an https URI");
        assert_eq!(parse_list_unsubscribe(Some("<ftp://nope>"), None), None);
        assert_eq!(parse_list_unsubscribe(None, None), None);
    }

    #[tokio::test]
    async fn one_click_posts_the_rfc8058_body() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut request = Vec::new();
            let mut buf = [0u8; 1024];
            while !request.ends_with(b"List-Unsubscribe=One-Click") {
                let n = stream.read(&mut buf).unwrap();
                if n == 0 {
                    break;
                }
                request.extend_from_slice(&buf[..n]);
            }
            stream
                .write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 0\r\nconnection: close\r\n\r\n")
                .unwrap();
            String::from_utf8_lossy(&request).to_string()
        });
        let status = post_one_click(&format!("http://127.0.0.1:{port}/u/abc"), true)
            .await
            .unwrap();
        assert_eq!(status, 200);
        let request = server.join().unwrap();
        assert!(request.starts_with("POST /u/abc "), "{request}");
        assert!(
            request
                .to_ascii_lowercase()
                .contains("content-type: application/x-www-form-urlencoded"),
            "{request}"
        );
        assert!(request.ends_with("List-Unsubscribe=One-Click"));

        let err = post_one_click("http://127.0.0.1:1/u", false)
            .await
            .unwrap_err();
        assert!(err.contains("https"), "{err}");
    }
}
