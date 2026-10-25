use super::endpoints::oauth_device_code_url;
use super::endpoints::oauth_scope;
use super::endpoints::oauth_token_url;
use super::http::build_oauth_http_client_blocking;
use super::http::oauth_form_body;
use super::http::parse_oauth_device_code_response;
use super::http::parse_oauth_token_response;
use crate::mail::connection_model::MailProvider;
use crate::mail::oauth_model::OAuthDeviceCodeResponse;
use crate::mail::oauth_model::OAuthTokenResponse;
use crate::mail::utilities::non_empty_str;
use crate::terminal::network::NetworkSettings;
use lettre::Transport;
use rusqlite::params;
use std::time::Duration;
use std::time::Instant;

/// Run `f` on a thread that has **not** entered a Tokio runtime.
///
/// `reqwest::blocking` creates a temporary Runtime in debug builds to detect
/// nested use; dropping that Runtime while the current thread is already inside
/// Tokio panics with "Cannot drop a runtime in a context where blocking is not
/// allowed". OAuth refresh is often invoked from async Tauri commands, so isolate
/// the blocking HTTP client onto a plain OS thread when needed.
pub(in crate::mail) fn run_outside_tokio_context<R: Send + 'static>(
    f: impl FnOnce() -> R + Send + 'static,
) -> Result<R, String> {
    if tokio::runtime::Handle::try_current().is_err() {
        return Ok(f());
    }
    std::thread::Builder::new()
        .name("mail-oauth-http".into())
        .spawn(f)
        .map_err(|e| format!("failed to spawn mail HTTP worker: {e}"))?
        .join()
        .map_err(|_| "mail HTTP worker thread panicked".to_string())
}

pub(in crate::mail) fn refresh_oauth_token_blocking(
    provider: MailProvider,
    client_id: &str,
    client_secret: Option<&str>,
    refresh_token: &str,
    scope: Option<&str>,
    network: Option<&NetworkSettings>,
) -> Result<OAuthTokenResponse, String> {
    let token_url = oauth_token_url(provider)?;
    let mut params = vec![
        ("client_id", client_id.to_string()),
        ("grant_type", "refresh_token".to_string()),
        ("refresh_token", refresh_token.to_string()),
    ];
    if let Some(secret) = client_secret.and_then(non_empty_str) {
        params.push(("client_secret", secret.to_string()));
    }
    if let Some(scope) = scope.and_then(non_empty_str) {
        params.push(("scope", scope.to_string()));
    }

    let client = build_oauth_http_client_blocking(network, token_url)?;
    let response = client
        .post()
        .header(
            reqwest::header::CONTENT_TYPE,
            "application/x-www-form-urlencoded",
        )
        .body(oauth_form_body(&params))
        .send()
        .map_err(|e| format!("OAuth token refresh failed: {e}"))?;
    parse_oauth_token_response(response, "refresh")
}

pub(in crate::mail) fn exchange_oauth_code_blocking(
    provider: MailProvider,
    client_id: &str,
    client_secret: Option<&str>,
    redirect_uri: &str,
    code: &str,
    verifier: &str,
    network: Option<&NetworkSettings>,
) -> Result<OAuthTokenResponse, String> {
    let token_url = oauth_token_url(provider)?;
    let mut params = vec![
        ("client_id", client_id.to_string()),
        ("grant_type", "authorization_code".to_string()),
        ("code", code.to_string()),
        ("redirect_uri", redirect_uri.to_string()),
        ("code_verifier", verifier.to_string()),
    ];
    if let Some(secret) = client_secret.and_then(non_empty_str) {
        params.push(("client_secret", secret.to_string()));
    }

    let client = build_oauth_http_client_blocking(network, token_url)?;
    let response = client
        .post()
        .header(
            reqwest::header::CONTENT_TYPE,
            "application/x-www-form-urlencoded",
        )
        .body(oauth_form_body(&params))
        .send()
        .map_err(|e| format!("OAuth token exchange failed: {e}"))?;
    parse_oauth_token_response(response, "exchange")
}

pub(in crate::mail) fn start_oauth_device_code_blocking(
    provider: MailProvider,
    client_id: &str,
    network: Option<&NetworkSettings>,
) -> Result<OAuthDeviceCodeResponse, String> {
    let device_url = oauth_device_code_url(provider)?;
    let params = vec![
        ("client_id", client_id.to_string()),
        ("scope", oauth_scope(provider)?.to_string()),
    ];

    let client = build_oauth_http_client_blocking(network, device_url)?;
    let response = client
        .post()
        .header(
            reqwest::header::CONTENT_TYPE,
            "application/x-www-form-urlencoded",
        )
        .body(oauth_form_body(&params))
        .send()
        .map_err(|e| format!("OAuth device code request failed: {e}"))?;
    parse_oauth_device_code_response(response)
}

pub(in crate::mail) fn complete_oauth_device_code_blocking(
    provider: MailProvider,
    client_id: &str,
    client_secret: Option<&str>,
    device_code: &str,
    interval: i64,
    expires_in: i64,
    network: Option<&NetworkSettings>,
) -> Result<OAuthTokenResponse, String> {
    let token_url = oauth_token_url(provider)?;
    let client_secret = client_secret.and_then(non_empty_str);
    if provider == MailProvider::Gmail && client_secret.is_none() {
        return Err(
            "Gmail device code authorization requires the OAuth client secret from a Google TV and Limited Input OAuth client"
                .into(),
        );
    }
    let client = build_oauth_http_client_blocking(network, token_url)?;
    let deadline = Instant::now() + Duration::from_secs(expires_in.clamp(1, 3600) as u64);
    let mut poll_interval = Duration::from_secs(interval.clamp(1, 30) as u64);

    loop {
        if Instant::now() >= deadline {
            return Err("OAuth device code expired before authorization completed".into());
        }

        let mut params = vec![
            ("client_id", client_id.to_string()),
            (
                "grant_type",
                "urn:ietf:params:oauth:grant-type:device_code".to_string(),
            ),
            ("device_code", device_code.to_string()),
        ];
        if let Some(secret) = client_secret {
            params.push(("client_secret", secret.to_string()));
        }
        let response = client
            .post()
            .header(
                reqwest::header::CONTENT_TYPE,
                "application/x-www-form-urlencoded",
            )
            .body(oauth_form_body(&params))
            .send()
            .map_err(|e| format!("OAuth device token polling failed: {e}"))?;
        let status = response.status();
        let text = response
            .text()
            .map_err(|e| format!("OAuth device token response read failed: {e}"))?;
        let token = serde_json::from_str::<OAuthTokenResponse>(&text).map_err(|e| {
            format!("OAuth device token response parse failed ({status}): {e}; {text}")
        })?;

        if status.is_success() && token.error.is_none() {
            if token.access_token.trim().is_empty() {
                return Err("OAuth device token response did not include an access token".into());
            }
            return Ok(token);
        }

        let error = token.error.as_deref().unwrap_or(if status.is_success() {
            "invalid_response"
        } else {
            "http_error"
        });
        let detail = token.error_description.as_deref().unwrap_or("");
        match error {
            "authorization_pending" => {
                std::thread::sleep(poll_interval);
            }
            "slow_down" => {
                poll_interval =
                    (poll_interval + Duration::from_secs(5)).min(Duration::from_secs(30));
                std::thread::sleep(poll_interval);
            }
            "authorization_declined" => {
                return Err("OAuth device authorization was declined".into());
            }
            "bad_verification_code" => {
                return Err("OAuth device authorization failed: bad verification code".into());
            }
            "expired_token" => {
                return Err("OAuth device code expired before authorization completed".into());
            }
            _ => {
                return Err(format!(
                    "OAuth device authorization failed ({status}): {error} {detail}"
                ));
            }
        }
    }
}
