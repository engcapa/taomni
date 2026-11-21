//! IMAP connection negotiation over a socket opened by the caller.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::panic::{AssertUnwindSafe, catch_unwind};

use imap::{Client, Session};
use native_tls::TlsStream;

use crate::cache::MailCacheSettings;
use crate::imap_auth::{MailAuthMode, MailProvider, authenticate};
use crate::imap_folders::{imap_list_folders, imap_set_subscription};
use crate::imap_messages::Mailbox;
use crate::imap_mutations::imap_set_flags;
use crate::imap_sync::{
    FolderRoundOutcome, FolderRoundRequest, FolderStepOutcome, HeaderStepRequest, StepParams,
    imap_has_capability, imap_sync_folder_step, sync_folder_round,
};
use crate::search::{ImapSearchRequest, search_imap_messages};
use crate::tls::{MailConnectionSecurity, certificate_error_hint, tls_connector};
use crate::{MailFolder, MailMessageHeader};
use taomni_mail_api::ImapFlagUpdate;

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

/// Discard a session after the IMAP library detects an out-of-sequence reply.
pub fn imap_catch_result<T>(work: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    match catch_unwind(AssertUnwindSafe(work)) {
        Ok(result) => result,
        Err(_) => Err("IMAP protocol desync".into()),
    }
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

    pub fn sync_headers(
        &mut self,
        request: &HeaderStepRequest,
    ) -> Result<FolderStepOutcome, String> {
        match self {
            Self::Plain(session) => sync_headers(session, request),
            Self::Tls(session) => sync_headers(session, request),
        }
    }
    pub fn sync_header_round(&mut self, request: &FolderRoundRequest) -> FolderRoundOutcome {
        let cache = MailCacheSettings::default();
        let mut mailbox = header_mailbox(&request.folder.account_id, &request.folder.name, &cache);
        match self {
            Self::Plain(session) => sync_folder_round(session, &mut mailbox, request, false),
            Self::Tls(session) => sync_folder_round(session, &mut mailbox, request, false),
        }
    }

    pub fn search_imap(
        &mut self,
        request: &ImapSearchRequest,
    ) -> Result<Vec<MailMessageHeader>, String> {
        match self {
            Self::Plain(session) => search_imap_messages(session, request),
            Self::Tls(session) => search_imap_messages(session, request),
        }
    }

    pub fn set_flags(&mut self, update: &ImapFlagUpdate) -> Result<usize, String> {
        let ImapFlagUpdate {
            folder,
            uids,
            add,
            remove,
        } = update;
        match self {
            Self::Plain(session) => imap_set_flags(session, folder, uids, add, remove),
            Self::Tls(session) => imap_set_flags(session, folder, uids, add, remove),
        }
    }
}

fn sync_headers<T: Read + Write>(
    session: &mut Session<T>,
    step: &HeaderStepRequest,
) -> Result<FolderStepOutcome, String> {
    let params = StepParams {
        request: step.mode,
        limit: step.limit,
        include_bodies: false,
        condstore: imap_has_capability(session, "CONDSTORE"),
    };
    let cache = MailCacheSettings::default();
    let mut mailbox = header_mailbox(&step.account_id, &step.folder, &cache);
    imap_sync_folder_step(session, &mut mailbox, &step.state, &params)
}

fn header_mailbox<'a>(
    account_id: &'a str,
    name: &'a str,
    cache: &'a MailCacheSettings,
) -> Mailbox<'a, impl FnMut(u32, &[u8]) -> Result<(), String> + 'a> {
    Mailbox {
        account_id,
        name,
        cache,
        save_original: |_, _: &[u8]| Err("A header step cannot store message originals".into()),
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
