use crate::mail::limits::DEFAULT_TIMEOUT_SECS;
use crate::mail::oauth_model::OAuthDeviceCodeResponse;
use crate::mail::oauth_model::OAuthTokenResponse;
use crate::terminal::network::NetworkSettings;
use rusqlite::params;
use std::time::Duration;

pub(in crate::mail) fn build_oauth_http_client_blocking(
    network: Option<&NetworkSettings>,
) -> Result<reqwest::blocking::Client, String> {
    let mut builder =
        reqwest::blocking::Client::builder().timeout(Duration::from_secs(DEFAULT_TIMEOUT_SECS));
    if let Some(net) = network {
        match net.proxy_kind.as_str() {
            "" | "none" => {}
            "http" => {
                let url = format!("http://{}:{}", net.proxy_host, net.proxy_port);
                let mut proxy = reqwest::Proxy::all(&url)
                    .map_err(|e| format!("OAuth HTTP proxy config failed: {e}"))?;
                if !net.proxy_user.is_empty() {
                    proxy = proxy.basic_auth(&net.proxy_user, &net.proxy_pass);
                }
                builder = builder.proxy(proxy);
            }
            "socks5" => {
                let url = format!("socks5h://{}:{}", net.proxy_host, net.proxy_port);
                let mut proxy = reqwest::Proxy::all(&url)
                    .map_err(|e| format!("OAuth SOCKS5 proxy config failed: {e}"))?;
                if !net.proxy_user.is_empty() {
                    proxy = proxy.basic_auth(&net.proxy_user, &net.proxy_pass);
                }
                builder = builder.proxy(proxy);
            }
            "ssh-tunnel" => {
                return Err("OAuth2 token requests through SSH tunnel are not supported yet; use HTTP or SOCKS5 proxy for this Mail session.".into());
            }
            "system" => {
                return Err("System proxy is not supported for Mail OAuth yet; use HTTP or SOCKS5 proxy in this session's Network tab.".into());
            }
            other => return Err(format!("Unsupported Mail OAuth proxy type: {other}")),
        }
    }
    builder
        .build()
        .map_err(|e| format!("failed to build OAuth client: {e}"))
}

pub(in crate::mail) fn parse_oauth_token_response(
    response: reqwest::blocking::Response,
    action: &str,
) -> Result<OAuthTokenResponse, String> {
    let status = response.status();
    let text = response
        .text()
        .map_err(|e| format!("OAuth token {action} response read failed: {e}"))?;
    if !status.is_success() {
        return Err(format!("OAuth token {action} failed ({status}): {text}"));
    }
    let token = serde_json::from_str::<OAuthTokenResponse>(&text)
        .map_err(|e| format!("OAuth token {action} response parse failed: {e}"))?;
    if let Some(error) = token.error.as_deref() {
        let detail = token.error_description.as_deref().unwrap_or("");
        return Err(format!("OAuth token {action} failed: {error} {detail}"));
    }
    if token.access_token.trim().is_empty() {
        return Err(format!(
            "OAuth token {action} response did not include an access token"
        ));
    }
    Ok(token)
}

pub(in crate::mail) fn parse_oauth_device_code_response(
    response: reqwest::blocking::Response,
) -> Result<OAuthDeviceCodeResponse, String> {
    let status = response.status();
    let text = response
        .text()
        .map_err(|e| format!("OAuth device code response read failed: {e}"))?;
    let device = serde_json::from_str::<OAuthDeviceCodeResponse>(&text)
        .map_err(|e| format!("OAuth device code response parse failed ({status}): {e}; {text}"))?;
    if !status.is_success() {
        let error = device.error.as_deref().unwrap_or("request_failed");
        let detail = device.error_description.as_deref().unwrap_or("");
        return Err(format!(
            "OAuth device code request failed ({status}): {error} {detail}"
        ));
    }
    if let Some(error) = device.error.as_deref() {
        let detail = device.error_description.as_deref().unwrap_or("");
        return Err(format!(
            "OAuth device code request failed: {error} {detail}"
        ));
    }
    if device.device_code.trim().is_empty()
        || device.user_code.trim().is_empty()
        || device.verification_uri.trim().is_empty()
    {
        return Err("OAuth device code response was missing required fields".into());
    }
    Ok(device)
}

pub(in crate::mail) fn oauth_form_body(params: &[(&str, String)]) -> String {
    let mut serializer = url::form_urlencoded::Serializer::new(String::new());
    for (key, value) in params {
        serializer.append_pair(key, value);
    }
    serializer.finish()
}
