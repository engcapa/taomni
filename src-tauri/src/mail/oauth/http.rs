use crate::mail::oauth_model::OAuthDeviceCodeResponse;
use crate::mail::oauth_model::OAuthTokenResponse;
use crate::terminal::network::NetworkSettings;

pub(in crate::mail) fn build_oauth_http_client_blocking(
    network: Option<&NetworkSettings>,
    endpoint: &str,
) -> Result<super::transport::OAuthHttpClient, String> {
    super::transport::client(network, endpoint)
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
