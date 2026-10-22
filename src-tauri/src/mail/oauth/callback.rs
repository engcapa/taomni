use super::endpoints::oauth_authorize_url;
use super::endpoints::oauth_scope;
use crate::mail::connection_model::MailProvider;
use crate::mail::oauth_model::OAuthCallback;
use std::io::Read;
use std::io::Write;
use std::time::Duration;
use std::time::Instant;

pub(in crate::mail) fn oauth_loopback_bind_host(
    provider: MailProvider,
) -> Result<&'static str, String> {
    match provider {
        MailProvider::Gmail => Ok("127.0.0.1"),
        MailProvider::Outlook => Ok("localhost"),
        MailProvider::Custom => Err("OAuth2 mail auth requires Gmail or Outlook provider".into()),
    }
}

pub(in crate::mail) fn oauth_loopback_redirect_uri(
    provider: MailProvider,
    port: u16,
) -> Result<String, String> {
    match provider {
        MailProvider::Gmail => Ok(format!("http://127.0.0.1:{port}")),
        MailProvider::Outlook => Ok(format!("http://localhost:{port}")),
        MailProvider::Custom => Err("OAuth2 mail auth requires Gmail or Outlook provider".into()),
    }
}

pub(in crate::mail) fn build_oauth_authorize_url(
    provider: MailProvider,
    client_id: &str,
    redirect_uri: &str,
    state: &str,
    challenge: &str,
) -> Result<String, String> {
    let mut url = url::Url::parse(oauth_authorize_url(provider)?)
        .map_err(|e| format!("OAuth authorize URL parse failed: {e}"))?;
    {
        let mut query = url.query_pairs_mut();
        query
            .append_pair("client_id", client_id)
            .append_pair("redirect_uri", redirect_uri)
            .append_pair("response_type", "code")
            .append_pair("scope", oauth_scope(provider)?)
            .append_pair("state", state)
            .append_pair("code_challenge", challenge)
            .append_pair("code_challenge_method", "S256");
        if provider == MailProvider::Gmail {
            query
                .append_pair("access_type", "offline")
                .append_pair("prompt", "consent");
        }
    }
    Ok(url.to_string())
}

pub(in crate::mail) fn wait_for_oauth_callback(
    listener: std::net::TcpListener,
    expected_state: &str,
) -> Result<OAuthCallback, String> {
    let deadline = Instant::now() + Duration::from_secs(300);
    let (mut stream, _) = loop {
        match listener.accept() {
            Ok(value) => break value,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                if Instant::now() >= deadline {
                    return Err("OAuth callback timed out".into());
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => return Err(format!("OAuth callback failed: {e}")),
        }
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
    let mut buf = [0u8; 8192];
    let n = stream
        .read(&mut buf)
        .map_err(|e| format!("OAuth callback read failed: {e}"))?;
    let request = String::from_utf8_lossy(&buf[..n]);
    let line = request
        .lines()
        .next()
        .ok_or_else(|| "OAuth callback request was empty".to_string())?;
    let path = line
        .split_whitespace()
        .nth(1)
        .ok_or_else(|| "OAuth callback request was malformed".to_string())?;
    let url = url::Url::parse(&format!("http://127.0.0.1{path}"))
        .map_err(|e| format!("OAuth callback URL parse failed: {e}"))?;
    let mut code = None;
    let mut state = None;
    let mut error = None;
    let mut error_description = None;
    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "code" => code = Some(value.into_owned()),
            "state" => state = Some(value.into_owned()),
            "error" => error = Some(value.into_owned()),
            "error_description" => error_description = Some(value.into_owned()),
            _ => {}
        }
    }

    let result = if let Some(error) = error {
        let detail = error_description.unwrap_or_default();
        Err(format!("OAuth authorization failed: {error} {detail}"))
    } else if state.as_deref() != Some(expected_state) {
        Err("OAuth callback state did not match; authorization was rejected".into())
    } else {
        let code = code.ok_or_else(|| "OAuth callback did not include a code".to_string())?;
        Ok(OAuthCallback { code })
    };

    let body = if result.is_ok() {
        "Taomni Mail authorization complete. You can close this window."
    } else {
        "Taomni Mail authorization failed. You can close this window and retry."
    };
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    let _ = stream.write_all(response.as_bytes());
    result
}
