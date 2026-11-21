//! Core-to-host mail connection contract. The token grants access to one
//! destination selected by the core, and the TLS name remains the real server.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use taomni_plugin_stream::routed_tcp::Endpoint;
use zeroize::Zeroizing;

pub const SLUG: &str = "mail";
pub const CHECK_INCOMING: &str = "mail/check-incoming";
pub const IMAP_FOLDER_TREE: &str = "mail/imap-folder-tree";
pub const HOST_REQUEST_TIMEOUT: Duration = Duration::from_secs(70);

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum MailConnectionSecurity {
    #[default]
    #[serde(rename = "tls", alias = "TLS", alias = "Tls")]
    Tls,
    #[serde(rename = "starttls", alias = "STARTTLS", alias = "StartTls")]
    Starttls,
    #[serde(rename = "none", alias = "None", alias = "NONE")]
    None,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum MailProvider {
    #[default]
    #[serde(rename = "custom", alias = "Custom")]
    Custom,
    #[serde(rename = "gmail", alias = "Gmail")]
    Gmail,
    #[serde(rename = "outlook", alias = "Outlook", alias = "outlook.com")]
    Outlook,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum MailAuthMode {
    #[default]
    #[serde(rename = "password", alias = "Password")]
    Password,
    #[serde(rename = "oauth2", alias = "OAuth2", alias = "oauth")]
    OAuth2,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MailIncomingProtocol {
    #[default]
    Imap,
    Pop3,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IncomingTest {
    pub route: Endpoint,
    pub server_name: String,
    pub security: MailConnectionSecurity,
    pub trusted_certificate: Option<String>,
    pub protocol: MailIncomingProtocol,
    pub provider: MailProvider,
    pub authentication: MailAuthMode,
    pub username: String,
    pub secret: Zeroizing<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImapFolderTree {
    pub connection: IncomingTest,
    pub account_id: String,
    pub subscription: Option<FolderSubscription>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FolderSubscription {
    pub folder: String,
    pub subscribed: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserved_session_values_load_after_moving_the_connection_types() {
        assert_eq!(
            serde_json::from_str::<MailProvider>(r#""outlook.com""#).unwrap(),
            MailProvider::Outlook
        );
        assert_eq!(
            serde_json::from_str::<MailAuthMode>(r#""OAuth2""#).unwrap(),
            MailAuthMode::OAuth2
        );
        assert_eq!(
            serde_json::from_str::<MailConnectionSecurity>(r#""STARTTLS""#).unwrap(),
            MailConnectionSecurity::Starttls
        );
        assert_eq!(
            serde_json::to_string(&MailIncomingProtocol::Pop3).unwrap(),
            r#""pop3""#
        );
    }
}
