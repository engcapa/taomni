//! SMTP delivery using an endpoint selected by the caller's network policy.

#[cfg(feature = "routed-smtp")]
mod routed;
#[cfg(feature = "routed-smtp")]
pub use routed::{check_routed_connection, send_routed_message};

use std::time::Duration;

use lettre::address::Envelope;
use lettre::transport::smtp::{
    authentication::{Credentials, Mechanism},
    client::Tls,
    response::Response,
};
use lettre::{Message, SmtpTransport, Transport};

use crate::imap_auth::MailAuthMode;
use crate::tls::{MailConnectionSecurity, certificate_error_hint, smtp_tls_parameters};

pub struct SmtpEndpoint<'a> {
    pub connect_host: &'a str,
    pub connect_port: u16,
    pub server_name: &'a str,
    pub timeout: Duration,
    pub security: MailConnectionSecurity,
    pub trusted_certificate: Option<&'a str>,
    pub username: &'a str,
    pub secret: &'a str,
    pub authentication: MailAuthMode,
}

pub struct SmtpClient(SmtpTransport);

impl SmtpClient {
    pub fn new(endpoint: SmtpEndpoint<'_>) -> Result<Self, String> {
        let mut builder = SmtpTransport::builder_dangerous(endpoint.connect_host)
            .port(endpoint.connect_port)
            .timeout(Some(endpoint.timeout))
            .credentials(Credentials::new(
                endpoint.username.into(),
                endpoint.secret.into(),
            ));
        if endpoint.authentication == MailAuthMode::OAuth2 {
            builder = builder.authentication(vec![Mechanism::Xoauth2]);
        }
        let tls = match endpoint.security {
            MailConnectionSecurity::Tls => Tls::Wrapper(smtp_tls_parameters(
                endpoint.server_name,
                endpoint.trusted_certificate,
            )?),
            MailConnectionSecurity::Starttls => Tls::Required(smtp_tls_parameters(
                endpoint.server_name,
                endpoint.trusted_certificate,
            )?),
            MailConnectionSecurity::None => Tls::None,
        };
        Ok(Self(builder.tls(tls).build()))
    }

    pub fn send(&self, message: &Message) -> Result<Response, String> {
        self.0
            .send(message)
            .map_err(|error| send_error(&error.to_string()))
    }

    pub fn send_raw(&self, envelope: &Envelope, raw: &[u8]) -> Result<Response, String> {
        self.0
            .send_raw(envelope, raw)
            .map_err(|error| send_error(&error.to_string()))
    }

    pub fn test_connection(&self) -> Result<(), String> {
        let connected = self
            .0
            .test_connection()
            .map_err(|error| format!("SMTP test failed: {error}"))?;
        if connected {
            Ok(())
        } else {
            Err("SMTP test did not establish a connection".into())
        }
    }
}

fn send_error(error: &str) -> String {
    let lower = error.to_ascii_lowercase();
    let too_big = lower.contains("552")
        || lower.contains("message size")
        || lower.contains("too large")
        || lower.contains("exceeds") && lower.contains("size");
    if too_big {
        format!(
            "SMTP send failed: the message is larger than this server accepts (SIZE limit). Remove or shrink attachments, or share them as links. Server said: {error}"
        )
    } else {
        certificate_error_hint(&format!("SMTP send failed: {error}"), false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn smtp_size_rejections_get_a_hint() {
        assert!(
            send_error("permanent error (552): 5.3.4 Message size exceeds fixed limit")
                .contains("SIZE limit")
        );
        assert_eq!(
            send_error("permanent error (550): no such user"),
            "SMTP send failed: permanent error (550): no such user"
        );
    }
}
