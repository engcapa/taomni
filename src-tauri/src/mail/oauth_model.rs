use super::connection_model::MailProvider;
use crate::terminal::network::NetworkSettings;
use serde::Deserialize;
use serde::Serialize;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MailOAuthSettings {
    #[serde(default)]
    pub client_id: Option<String>,
    #[serde(default)]
    pub client_secret: Option<String>,
    #[serde(default)]
    pub token_ref: Option<String>,
    #[serde(default)]
    pub refresh_token_ref: Option<String>,
    #[serde(default)]
    pub expires_at: Option<i64>,
    #[serde(default)]
    pub scope: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct MailOAuthTokenBundle {
    pub(super) access_token: String,
    #[serde(default)]
    pub(super) refresh_token: Option<String>,
    #[serde(default)]
    pub(super) expires_at: Option<i64>,
    #[serde(default)]
    pub(super) token_type: Option<String>,
    #[serde(default)]
    pub(super) scope: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(super) struct OAuthTokenResponse {
    #[serde(default)]
    pub(super) access_token: String,
    #[serde(default)]
    pub(super) refresh_token: Option<String>,
    #[serde(default)]
    pub(super) expires_in: Option<i64>,
    #[serde(default)]
    pub(super) token_type: Option<String>,
    #[serde(default)]
    pub(super) scope: Option<String>,
    #[serde(default)]
    pub(super) error: Option<String>,
    #[serde(default)]
    pub(super) error_description: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(super) struct OAuthDeviceCodeResponse {
    #[serde(default)]
    pub(super) device_code: String,
    #[serde(default)]
    pub(super) user_code: String,
    #[serde(default, alias = "verification_url")]
    pub(super) verification_uri: String,
    #[serde(default)]
    pub(super) expires_in: Option<i64>,
    #[serde(default)]
    pub(super) interval: Option<i64>,
    #[serde(default)]
    pub(super) message: Option<String>,
    #[serde(default)]
    pub(super) error: Option<String>,
    #[serde(default)]
    pub(super) error_description: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailOAuthAuthorizeRequest {
    pub session_id: String,
    pub provider: MailProvider,
    pub email_address: String,
    pub client_id: String,
    #[serde(default)]
    pub client_secret: Option<String>,
    #[serde(default)]
    pub network_settings: Option<NetworkSettings>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailOAuthDeviceStartRequest {
    pub provider: MailProvider,
    pub client_id: String,
    #[serde(default)]
    pub network_settings: Option<NetworkSettings>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailOAuthDeviceStartResult {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub message: String,
    pub expires_in: i64,
    pub interval: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailOAuthDeviceCompleteRequest {
    pub session_id: String,
    pub provider: MailProvider,
    pub email_address: String,
    pub client_id: String,
    #[serde(default)]
    pub client_secret: Option<String>,
    pub device_code: String,
    #[serde(default)]
    pub interval: Option<i64>,
    #[serde(default)]
    pub expires_in: Option<i64>,
    #[serde(default)]
    pub network_settings: Option<NetworkSettings>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailOAuthAuthorizeResult {
    pub token_ref: String,
    pub expires_at: Option<i64>,
    pub scope: Option<String>,
    pub token_type: Option<String>,
}

pub(super) struct OAuthCallback {
    pub(super) code: String,
}
