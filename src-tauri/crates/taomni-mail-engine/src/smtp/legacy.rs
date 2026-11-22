use std::time::Duration;

use crate::delivery::PreparedMail;
use lettre::transport::smtp::{
    authentication::{Credentials, Mechanism},
    client::Tls,
    response::Response,
};
use lettre::{SmtpTransport, Transport};

use super::send_error;

use crate::imap_auth::MailAuthMode;
use crate::tls::{MailConnectionSecurity, smtp_tls_parameters};

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

    pub fn send_prepared(&self, message: &PreparedMail) -> Result<Response, String> {
        self.0
            .send_raw(&message.envelope, &message.bytes)
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
