//! IMAP connection negotiation over a socket opened by the caller.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::panic::{AssertUnwindSafe, catch_unwind};

use imap::{Client, Session};
use native_tls::TlsStream;

use crate::cache::MailCacheSettings;
use crate::imap_auth::{MailAuthMode, MailProvider, authenticate};
use crate::imap_folders::{imap_change_folder, imap_list_folders, imap_set_subscription};
use crate::imap_messages::{Mailbox, imap_fetch_attachment, imap_fetch_raw};
use crate::imap_mutations::{imap_delete_messages, imap_set_flags, unread_uids};
use crate::imap_outgoing::{imap_append, store_remote_draft, store_sent_copy};
use crate::imap_sync::{
    BodySyncOutcome, BodySyncRequest, BodySyncTask, FolderRoundOutcome, FolderRoundRequest,
    FolderStepOutcome, HeaderPageOutcome, HeaderPageRequest, HeaderStepRequest, StepParams,
    imap_has_capability, imap_sync_folder_step, sync_folder_round,
};
use crate::search::{ImapSearchRequest, search_imap_messages};
use crate::tls::{MailConnectionSecurity, certificate_error_hint, tls_connector};
use crate::{DownloadedMailAttachment, MailFolder, MailMessageCached, MailMessageHeader};
use serde::{Deserialize, Serialize};
use taomni_mail_api::{ImapFlagUpdate, ImapFolderChange, RemoteDraftLocation};

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

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImapBodyRequest {
    pub account_id: String,
    pub folder: String,
    pub uid: u32,
    pub body_max_bytes: u32,
    pub save_original: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImapBodyReply {
    pub message: MailMessageCached,
    pub original_size: Option<usize>,
}

/// Discard a session after the IMAP library detects an out-of-sequence reply.
pub fn imap_catch_result<T>(work: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    match catch_unwind(AssertUnwindSafe(work)) {
        Ok(result) => result,
        Err(_) => Err("IMAP protocol desync".into()),
    }
}

impl ImapSession {
    pub fn append_imported(&mut self, folder: &str, bytes: &[u8]) -> Result<(), String> {
        let flags = &["\\Seen"];
        match self {
            Self::Plain(session) => imap_append(session, folder, bytes, flags),
            Self::Tls(session) => imap_append(session, folder, bytes, flags),
        }
    }

    pub fn store_remote_draft(
        &mut self,
        account_id: &str,
        configured_folder: Option<&str>,
        bytes: &[u8],
        message_id: &str,
        previous: Option<&RemoteDraftLocation>,
    ) -> Result<Option<RemoteDraftLocation>, String> {
        match self {
            Self::Plain(session) => store_remote_draft(
                session,
                account_id,
                configured_folder,
                bytes,
                message_id,
                previous,
            ),
            Self::Tls(session) => store_remote_draft(
                session,
                account_id,
                configured_folder,
                bytes,
                message_id,
                previous,
            ),
        }
    }

    pub fn discard_remote_draft(&mut self, location: &RemoteDraftLocation) -> Result<(), String> {
        let result = match self {
            Self::Plain(session) => {
                imap_delete_messages(session, &location.folder, &[location.uid], false)
            }
            Self::Tls(session) => {
                imap_delete_messages(session, &location.folder, &[location.uid], false)
            }
        };
        result.map(|_| ())
    }

    pub fn store_sent_copy(
        &mut self,
        account_id: &str,
        configured_folder: Option<&str>,
        bytes: Option<&[u8]>,
        remote_draft: Option<&RemoteDraftLocation>,
    ) -> Result<Option<String>, String> {
        match self {
            Self::Plain(session) => {
                store_sent_copy(session, account_id, configured_folder, bytes, remote_draft)
            }
            Self::Tls(session) => {
                store_sent_copy(session, account_id, configured_folder, bytes, remote_draft)
            }
        }
    }

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

    pub fn change_folder(&mut self, change: &ImapFolderChange) -> Result<(), String> {
        match self {
            Self::Plain(session) => imap_change_folder(session, change),
            Self::Tls(session) => imap_change_folder(session, change),
        }
    }

    pub fn sync_headers(
        &mut self,
        request: &HeaderStepRequest,
    ) -> Result<FolderStepOutcome, String> {
        let cache = MailCacheSettings::default();
        let mut mailbox = header_mailbox(&request.account_id, &request.folder, &cache);
        self.sync_step(&mut mailbox, request, false)
    }

    fn sync_step(
        &mut self,
        mailbox: &mut Mailbox<'_, impl FnMut(u32, &[u8]) -> Result<(), String>>,
        request: &HeaderStepRequest,
        include_bodies: bool,
    ) -> Result<FolderStepOutcome, String> {
        match self {
            Self::Plain(session) => sync_step(session, mailbox, request, include_bodies),
            Self::Tls(session) => sync_step(session, mailbox, request, include_bodies),
        }
    }

    pub fn sync_header_page(
        &mut self,
        page: &HeaderPageRequest,
    ) -> Result<HeaderPageOutcome, String> {
        let cache = MailCacheSettings::default();
        let mut mailbox = header_mailbox(&page.account_id, &page.folder, &cache);
        self.sync_page(&mut mailbox, page, false)
    }

    fn sync_page(
        &mut self,
        mailbox: &mut Mailbox<'_, impl FnMut(u32, &[u8]) -> Result<(), String>>,
        page: &HeaderPageRequest,
        include_bodies: bool,
    ) -> Result<HeaderPageOutcome, String> {
        let folders = page
            .list_folders
            .then(|| self.list_folders(&page.account_id))
            .transpose()?;
        let (selected, messages, has_more) = match self {
            Self::Plain(session) => {
                mailbox.fetch_page(session, page.offset, page.limit, include_bodies)
            }
            Self::Tls(session) => {
                mailbox.fetch_page(session, page.offset, page.limit, include_bodies)
            }
        }?;
        Ok(HeaderPageOutcome {
            folders,
            selected,
            messages,
            has_more,
        })
    }

    pub fn sync_header_round(&mut self, request: &FolderRoundRequest) -> FolderRoundOutcome {
        let cache = MailCacheSettings::default();
        let mut mailbox = header_mailbox(&request.folder.account_id, &request.folder.name, &cache);
        self.sync_round(&mut mailbox, request, false)
    }

    fn sync_round(
        &mut self,
        mailbox: &mut Mailbox<'_, impl FnMut(u32, &[u8]) -> Result<(), String>>,
        request: &FolderRoundRequest,
        include_bodies: bool,
    ) -> FolderRoundOutcome {
        match self {
            Self::Plain(session) => sync_folder_round(session, mailbox, request, include_bodies),
            Self::Tls(session) => sync_folder_round(session, mailbox, request, include_bodies),
        }
    }

    pub fn sync_with_bodies(
        &mut self,
        request: &BodySyncRequest,
        save_original: impl FnMut(u32, &[u8]) -> Result<(), String>,
    ) -> Result<BodySyncOutcome, String> {
        let (account_id, name) = request.task.mailbox();
        let cache = MailCacheSettings {
            body_recent_limit: request.recent_limit,
            body_max_bytes: request.max_bytes,
            ..MailCacheSettings::default()
        };
        let mut mailbox = Mailbox {
            account_id,
            name,
            cache: &cache,
            save_original,
        };
        match &request.task {
            BodySyncTask::Page(page) => self
                .sync_page(&mut mailbox, page, true)
                .map(BodySyncOutcome::Page),
            BodySyncTask::Step(step) => self
                .sync_step(&mut mailbox, step, true)
                .map(BodySyncOutcome::Step),
            BodySyncTask::Round(round) => Ok(BodySyncOutcome::Round(self.sync_round(
                &mut mailbox,
                round,
                true,
            ))),
        }
    }

    pub fn archive_chunk(
        &mut self,
        folder: &str,
        uid: u32,
        offset: u64,
    ) -> Result<(u32, u64, Vec<u8>), String> {
        use crate::archive::fetch_imap_chunk;
        match self {
            Self::Plain(session) => fetch_imap_chunk(session, folder, uid, offset),
            Self::Tls(session) => fetch_imap_chunk(session, folder, uid, offset),
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

    pub fn unread_uids(&mut self, folder: &str) -> Result<Vec<u32>, String> {
        match self {
            Self::Plain(session) => unread_uids(session, folder),
            Self::Tls(session) => unread_uids(session, folder),
        }
    }

    pub fn fetch_raw(&mut self, folder: &str, uid: u32) -> Result<Vec<u8>, String> {
        match self {
            Self::Plain(session) => imap_fetch_raw(session, folder, uid),
            Self::Tls(session) => imap_fetch_raw(session, folder, uid),
        }
    }

    pub fn fetch_body(
        &mut self,
        request: &ImapBodyRequest,
    ) -> Result<(MailMessageCached, Option<Vec<u8>>), String> {
        let cache = MailCacheSettings {
            body_max_bytes: request.body_max_bytes,
            ..MailCacheSettings::default()
        };
        let mut original = None;
        let mut mailbox = Mailbox {
            account_id: &request.account_id,
            name: &request.folder,
            cache: &cache,
            save_original: |_, bytes: &[u8]| {
                if request.save_original {
                    original = Some(bytes.to_vec());
                }
                Ok(())
            },
        };
        let message = match self {
            Self::Plain(session) => mailbox.fetch_body(session, request.uid),
            Self::Tls(session) => mailbox.fetch_body(session, request.uid),
        }?;
        Ok((message, original))
    }

    pub fn fetch_attachment(
        &mut self,
        folder: &str,
        uid: u32,
        index: usize,
        section: Option<&str>,
    ) -> Result<DownloadedMailAttachment, String> {
        match self {
            Self::Plain(session) => imap_fetch_attachment(session, folder, uid, index, section),
            Self::Tls(session) => imap_fetch_attachment(session, folder, uid, index, section),
        }
    }
}

fn sync_step<T: Read + Write>(
    session: &mut Session<T>,
    mailbox: &mut Mailbox<'_, impl FnMut(u32, &[u8]) -> Result<(), String>>,
    step: &HeaderStepRequest,
    include_bodies: bool,
) -> Result<FolderStepOutcome, String> {
    let params = StepParams {
        request: step.mode,
        limit: step.limit,
        include_bodies,
        condstore: imap_has_capability(session, "CONDSTORE"),
    };
    imap_sync_folder_step(session, mailbox, &step.state, &params)
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
