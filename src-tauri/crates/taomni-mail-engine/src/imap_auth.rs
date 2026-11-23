//! IMAP authentication for an already connected peer.

#[cfg(feature = "imap-runtime")]
use std::io::{Read, Write};
#[cfg(feature = "imap-runtime")]
use std::time::Duration;

#[cfg(feature = "imap-runtime")]
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64_STANDARD};
pub use taomni_mail_api::{MailAuthMode, MailProvider};

#[cfg(feature = "imap-runtime")]
const IMAP_LOGIN_RETRY_DELAYS_MS: [u64; 2] = [500, 1500];

#[cfg(feature = "imap-runtime")]
struct Xoauth2Authenticator<'a> {
    username: &'a str,
    access_token: &'a str,
}

#[cfg(feature = "imap-runtime")]
impl imap::Authenticator for Xoauth2Authenticator<'_> {
    type Response = String;

    fn process(&self, _challenge: &[u8]) -> Self::Response {
        xoauth2_sasl_response(self.username, self.access_token)
    }
}

pub fn xoauth2_sasl_response(username: &str, access_token: &str) -> String {
    format!("user={username}\x01auth=Bearer {access_token}\x01\x01")
}

#[cfg(feature = "imap-runtime")]
pub fn authenticate<T: Read + Write>(
    client: imap::Client<T>,
    username: &str,
    secret: &str,
    mode: MailAuthMode,
    provider: MailProvider,
) -> Result<imap::Session<T>, String> {
    match mode {
        MailAuthMode::Password => login_imap_client(client, username, secret),
        MailAuthMode::OAuth2 => {
            let auth = Xoauth2Authenticator {
                username,
                access_token: secret,
            };
            if provider == MailProvider::Outlook {
                let initial_response =
                    BASE64_STANDARD.encode(xoauth2_sasl_response(auth.username, auth.access_token));
                client
                    .authenticate(format!("XOAUTH2 {initial_response}"), &auth)
                    .map_err(|(e, _)| imap_xoauth2_auth_error(provider, e))
            } else {
                client
                    .authenticate("XOAUTH2", &auth)
                    .map_err(|(e, _)| imap_xoauth2_auth_error(provider, e))
            }
        }
    }
}

#[cfg(feature = "imap-runtime")]
fn imap_xoauth2_auth_error(provider: MailProvider, error: imap::Error) -> String {
    let detail = error.to_string();
    if provider == MailProvider::Outlook
        && detail.contains("User is authenticated but not connected")
    {
        format!(
            "IMAP XOAUTH2 authentication failed: {detail}. Outlook accepted the OAuth token, but the mailbox was not connected. Enable IMAP in Outlook.com Settings > Mail > Forwarding and IMAP, then retry. If it still fails, approve the recent IMAP sign-in activity at account.live.com/activity."
        )
    } else {
        format!("IMAP XOAUTH2 authentication failed: {detail}")
    }
}

#[cfg(feature = "imap-runtime")]
fn login_imap_client<T: Read + Write>(
    mut client: imap::Client<T>,
    username: &str,
    password: &str,
) -> Result<imap::Session<T>, String> {
    for attempt in 0..=IMAP_LOGIN_RETRY_DELAYS_MS.len() {
        match client.login(username, password) {
            Ok(session) => return Ok(session),
            Err((e, next_client)) => {
                let message = e.to_string();
                client = next_client;
                let retry_limit_reached = attempt >= IMAP_LOGIN_RETRY_DELAYS_MS.len();
                let retryable = should_retry_imap_login(&message);
                if retry_limit_reached || !retryable {
                    return Err(format!("IMAP login failed: {message}"));
                }

                let delay_ms = IMAP_LOGIN_RETRY_DELAYS_MS[attempt];
                tracing::debug!(
                    "transient IMAP login failure; retrying in {delay_ms}ms: {message}"
                );
                std::thread::sleep(Duration::from_millis(delay_ms));
            }
        }
    }

    Err("IMAP login failed".into())
}

#[cfg(any(feature = "imap-runtime", test))]
fn should_retry_imap_login(message: &str) -> bool {
    let message = message.to_ascii_lowercase();
    if message.contains("authenticationfailed")
        || message.contains("authentication failed")
        || message.contains("invalid credentials")
        || message.contains("invalid login")
        || message.contains("bad credentials")
        || (message.contains("password") && message.contains("incorrect"))
    {
        return false;
    }

    message.contains("login error")
        || message.contains("no response")
        || message.contains("temporar")
        || message.contains("try again")
        || message.contains("rate")
        || message.contains("throttl")
        || message.contains("too many")
        || message.contains("timeout")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_provider_aliases_and_oauth_wire_encoding() {
        let provider: MailProvider = serde_json::from_str("\"outlook.com\"").unwrap();
        let auth: MailAuthMode = serde_json::from_str("\"OAuth2\"").unwrap();
        assert_eq!(serde_json::to_string(&provider).unwrap(), "\"outlook\"");
        assert_eq!(serde_json::to_string(&auth).unwrap(), "\"oauth2\"");
        assert_eq!(
            xoauth2_sasl_response("user@example.com", "fixture-token"),
            "user=user@example.com\x01auth=Bearer fixture-token\x01\x01"
        );
    }

    #[test]
    fn imap_login_retry_classifies_transient_and_auth_errors() {
        assert!(should_retry_imap_login("No Response: LOGIN Login error"));
        assert!(should_retry_imap_login(
            "temporary rate limit, try again later"
        ));
        assert!(!should_retry_imap_login(
            "NO [AUTHENTICATIONFAILED] Invalid credentials"
        ));
        assert!(!should_retry_imap_login(
            "NO invalid login or password incorrect"
        ));
    }
}
