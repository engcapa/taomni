//! IMAP connection negotiation over a socket opened by the caller.

use std::io::{Read, Write};
use std::net::TcpStream;

use imap::{Client, Session};
use native_tls::TlsStream;

use crate::MailFolder;
use crate::imap_auth::{MailAuthMode, MailProvider, authenticate};
use crate::imap_folders::{imap_list_folders, imap_set_subscription};
use crate::tls::{MailConnectionSecurity, certificate_error_hint, tls_connector};

pub struct ImapConnection<'a> {
    pub server_name: &'a str,
    pub security: MailConnectionSecurity,
    pub trusted_certificate: Option<&'a str>,
    pub username: &'a str,
    pub secret: &'a str,
    pub authentication: MailAuthMode,
    pub provider: MailProvider,
}

pub enum ImapSession {
    Plain(Session<TcpStream>),
    Tls(Session<TlsStream<TcpStream>>),
}

impl ImapSession {
    pub fn list_folders(&mut self, account_id: &str) -> Result<Vec<MailFolder>, String> {
        match self {
            Self::Plain(session) => imap_list_folders(session, account_id),
            Self::Tls(session) => imap_list_folders(session, account_id),
        }
    }

    pub fn set_subscription(&mut self, folder: &str, subscribed: bool) -> Result<(), String> {
        match self {
            Self::Plain(session) => imap_set_subscription(session, folder, subscribed),
            Self::Tls(session) => imap_set_subscription(session, folder, subscribed),
        }
    }
}

impl ImapConnection<'_> {
    pub fn open(&self, stream: TcpStream) -> Result<ImapSession, String> {
        let pinned = self
            .trusted_certificate
            .is_some_and(|value| !value.trim().is_empty());
        match self.security {
            MailConnectionSecurity::Tls => {
                let connector = tls_connector(self.trusted_certificate)?;
                let stream = connector
                    .connect(self.server_name, stream)
                    .map_err(|error| {
                        certificate_error_hint(
                            &format!("IMAP TLS handshake failed: {error}"),
                            pinned,
                        )
                    })?;
                self.authenticate(read_greeting(stream)?)
                    .map(ImapSession::Tls)
            }
            MailConnectionSecurity::Starttls => {
                let client = read_greeting(stream)?;
                let connector = tls_connector(self.trusted_certificate)?;
                let client = client
                    .secure(self.server_name, &connector)
                    .map_err(|error| {
                        certificate_error_hint(&format!("IMAP STARTTLS failed: {error}"), pinned)
                    })?;
                self.authenticate(client).map(ImapSession::Tls)
            }
            MailConnectionSecurity::None => self
                .authenticate(read_greeting(stream)?)
                .map(ImapSession::Plain),
        }
    }

    fn authenticate<T: Read + Write>(&self, client: Client<T>) -> Result<Session<T>, String> {
        authenticate(
            client,
            self.username,
            self.secret,
            self.authentication,
            self.provider,
        )
    }
}

fn read_greeting<T: Read + Write>(stream: T) -> Result<Client<T>, String> {
    let mut client = Client::new(stream);
    client
        .read_greeting()
        .map_err(|error| format!("IMAP greeting failed: {error}"))?;
    Ok(client)
}

#[cfg(test)]
mod tests {
    use super::read_greeting;
    use std::io::Cursor;

    #[test]
    fn closed_connection_reports_the_imap_greeting_error() {
        let error = read_greeting(Cursor::new(Vec::<u8>::new()))
            .err()
            .expect("the server closed before sending its greeting");
        assert!(error.starts_with("IMAP greeting failed: "), "{error}");
    }
}
