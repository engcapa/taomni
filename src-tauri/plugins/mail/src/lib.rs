//! The official Mail host. The profile lease belongs to the SDK, and the
//! mailbox store uses only paths derived from that profile and account IDs.

mod address_book;
mod agenda;
mod archive;
mod archive_decoding;
mod archive_encoding;
mod attachment_cache;
mod commands;
mod imap_body_sync;
mod imap_exchange;
mod imap_idle;
mod incoming;
mod local_drafts;
mod mailbox;
mod outgoing;
mod pop3_sync;
mod prefetch;
mod snapshot;
mod store;

use std::{collections::BTreeSet, io, sync::Arc, time::Duration};

use serde_json::Value;
use taomni_mail_api::{
    CHECK_INCOMING, CHECK_OUTGOING, DISCARD_IMAP_DRAFT, FETCH_IMAP_ATTACHMENT, FETCH_IMAP_BODY,
    FETCH_IMAP_RAW, HOST_REQUEST_TIMEOUT, IMAP_FOLDER_TREE, LIST_IMAP_UNREAD, MUTATE_IMAP_FOLDER,
    OPEN_IMAP_ARCHIVE, OPEN_POP3_SYNC, PREFETCH_IMAP_BODIES, SEARCH_IMAP, SEND_SMTP,
    SET_IMAP_FLAGS, STORE_IMAP_DRAFT, STORE_IMAP_SENT, SYNC_IMAP_HEADERS, SYNC_IMAP_PAGE,
    SYNC_IMAP_ROUND,
};
use taomni_plugin_api::{
    ErrorCode, RpcError,
    services::{SNAPSHOT_METHOD, SNAPSHOT_PREPARE_METHOD, SNAPSHOT_RELEASE_METHOD},
};
use taomni_plugin_sdk::{HostConfig, Operation, PluginHandler, SnapshotProvider};

const PLUGIN_ID: &str = "taomni-plugin-mail";
const PLUGIN_VERSION: &str = env!("CARGO_PKG_VERSION");
const DATA_DIRECTORY_PERMISSION: &str = "fs.dataDir";

fn host_config() -> HostConfig {
    HostConfig {
        plugin_id: PLUGIN_ID.into(),
        plugin_version: PLUGIN_VERSION.into(),
        commands: commands::METHODS
            .into_iter()
            .chain([
                taomni_mail_api::LOCAL_DRAFTS,
                taomni_mail_api::ADDRESS_BOOK,
                taomni_mail_api::CALDAV_AGENDA,
                taomni_mail_api::ATTACHMENT_CACHE,
                CHECK_INCOMING,
                CHECK_OUTGOING,
                IMAP_FOLDER_TREE,
                MUTATE_IMAP_FOLDER,
                SEND_SMTP,
                taomni_mail_api::SEND_RESPONSE,
                STORE_IMAP_SENT,
                STORE_IMAP_DRAFT,
                DISCARD_IMAP_DRAFT,
                SYNC_IMAP_HEADERS,
                taomni_mail_api::SYNC_IMAP_BODIES,
                SYNC_IMAP_PAGE,
                SYNC_IMAP_ROUND,
                SEARCH_IMAP,
                taomni_mail_api::FILTER_IMAP_BODIES,
                SET_IMAP_FLAGS,
                LIST_IMAP_UNREAD,
                taomni_mail_api::OPEN_IMAP_IDLE,
                FETCH_IMAP_RAW,
                FETCH_IMAP_BODY,
                PREFETCH_IMAP_BODIES,
                taomni_mail_api::ENCODE_ARCHIVE_ORIGINAL,
                taomni_mail_api::DECODE_ARCHIVE_ORIGINAL,
                taomni_mail_api::DECODE_ARCHIVE_ATTACHMENT,
                OPEN_IMAP_ARCHIVE,
                OPEN_POP3_SYNC,
                FETCH_IMAP_ATTACHMENT,
                SNAPSHOT_PREPARE_METHOD,
                SNAPSHOT_METHOD,
                SNAPSHOT_RELEASE_METHOD,
            ])
            .map(String::from)
            .collect(),
        permissions: BTreeSet::from([DATA_DIRECTORY_PERMISSION.into()]),
        required_services: Default::default(),
        optional_services: Default::default(),
        operation_timeout: HOST_REQUEST_TIMEOUT,
        snapshot_timeout: Duration::from_secs(300),
    }
}

pub fn serve_stdio() -> io::Result<()> {
    taomni_plugin_sdk::serve_stdio_with(host_config(), |storage| {
        let storage = storage.ok_or_else(|| io::Error::other("Mail profile ownership required"))?;
        Ok(Arc::new(Handler {
            store: Arc::new(store::Store::new(storage.root().path())),
            io: tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .enable_all()
                .build()?,
            encoders: Arc::new(tokio::sync::Semaphore::new(2)),
            prefetch: Arc::new(tokio::sync::Semaphore::new(2)),
        }))
    })
}

struct Handler {
    store: Arc<store::Store>,
    io: tokio::runtime::Runtime,
    encoders: Arc<tokio::sync::Semaphore>,
    prefetch: Arc<tokio::sync::Semaphore>,
}

impl PluginHandler for Handler {
    fn snapshot_provider(&self) -> Option<Arc<dyn SnapshotProvider>> {
        Some(self.store.clone())
    }

    fn invoke(
        &self,
        operation: &Operation,
        method: &str,
        params: Option<Value>,
    ) -> Result<Value, RpcError> {
        operation.check_current()?;
        let result = match method {
            taomni_mail_api::DECODE_ARCHIVE_ORIGINAL => {
                let request = serde_json::from_value(params.unwrap_or_default())
                    .map_err(|_| RpcError::from_code(ErrorCode::InvalidParams))?;
                serde_json::to_value(archive_decoding::decode(&self.io, operation, request)?)
            }
            taomni_mail_api::DECODE_ARCHIVE_ATTACHMENT => {
                let request = serde_json::from_value(params.unwrap_or_default())
                    .map_err(|_| RpcError::from_code(ErrorCode::InvalidParams))?;
                serde_json::to_value(archive_decoding::attachment(&self.io, operation, request)?)
            }
            taomni_mail_api::ATTACHMENT_CACHE => {
                let request = serde_json::from_value(params.unwrap_or_default())
                    .map_err(|_| RpcError::from_code(ErrorCode::InvalidParams))?;
                serde_json::to_value(attachment_cache::transfer(
                    &self.io,
                    &self.store,
                    operation,
                    request,
                )?)
            }
            taomni_mail_api::CALDAV_AGENDA => {
                use taomni_mail_engine::agenda::handoff;
                let endpoint = serde_json::from_value(params.unwrap_or_default())
                    .map_err(|_| RpcError::from_code(ErrorCode::InvalidParams))?;
                serde_json::to_value(mailbox::serve(
                    &self.io,
                    &self.store,
                    operation,
                    endpoint,
                    handoff::is_owned,
                    handoff::adopt,
                    agenda::execute,
                )?)
            }
            taomni_mail_api::LOCAL_DRAFTS | taomni_mail_api::ADDRESS_BOOK => {
                let endpoint = serde_json::from_value(params.unwrap_or_default())
                    .map_err(|_| RpcError::from_code(ErrorCode::InvalidParams))?;
                let result = if method == taomni_mail_api::LOCAL_DRAFTS {
                    use taomni_mail_engine::draft_import;
                    mailbox::serve(
                        &self.io,
                        &self.store,
                        operation,
                        endpoint,
                        draft_import::is_owned,
                        draft_import::adopt,
                        local_drafts::execute,
                    )
                } else {
                    use taomni_mail_engine::contacts::handoff;
                    mailbox::serve(
                        &self.io,
                        &self.store,
                        operation,
                        endpoint,
                        handoff::is_owned,
                        handoff::adopt,
                        address_book::execute,
                    )
                };
                serde_json::to_value(result?)
            }
            CHECK_INCOMING => {
                let input = serde_json::from_value(params.unwrap_or_default())
                    .map_err(|_| RpcError::from_code(ErrorCode::InvalidParams))?;
                serde_json::to_value(incoming::check(&self.io, operation, input)?)
            }
            CHECK_OUTGOING => {
                let input = serde_json::from_value(params.unwrap_or_default())
                    .map_err(|_| RpcError::from_code(ErrorCode::InvalidParams))?;
                serde_json::to_value(outgoing::check(&self.io, operation, input)?)
            }
            SEND_SMTP => {
                let input = serde_json::from_value(params.unwrap_or_default())
                    .map_err(|_| RpcError::from_code(ErrorCode::InvalidParams))?;
                serde_json::to_value(outgoing::send(&self.io, operation, input)?)
            }
            taomni_mail_api::SEND_RESPONSE => {
                let input = serde_json::from_value(params.unwrap_or_default())
                    .map_err(|_| RpcError::from_code(ErrorCode::InvalidParams))?;
                serde_json::to_value(outgoing::respond(&self.io, operation, input)?)
            }
            STORE_IMAP_SENT => {
                let input = serde_json::from_value(params.unwrap_or_default())
                    .map_err(|_| RpcError::from_code(ErrorCode::InvalidParams))?;
                serde_json::to_value(outgoing::store_sent(&self.io, operation, input)?)
            }
            STORE_IMAP_DRAFT => {
                let input = serde_json::from_value(params.unwrap_or_default())
                    .map_err(|_| RpcError::from_code(ErrorCode::InvalidParams))?;
                serde_json::to_value(outgoing::store_draft(&self.io, operation, input)?)
            }
            DISCARD_IMAP_DRAFT => {
                let input = serde_json::from_value(params.unwrap_or_default())
                    .map_err(|_| RpcError::from_code(ErrorCode::InvalidParams))?;
                serde_json::to_value(outgoing::discard_draft(&self.io, operation, input)?)
            }
            IMAP_FOLDER_TREE => {
                let input = serde_json::from_value(params.unwrap_or_default())
                    .map_err(|_| RpcError::from_code(ErrorCode::InvalidParams))?;
                serde_json::to_value(incoming::imap_folder_tree(&self.io, operation, input)?)
            }
            MUTATE_IMAP_FOLDER => {
                let input = serde_json::from_value(params.unwrap_or_default())
                    .map_err(|_| RpcError::from_code(ErrorCode::InvalidParams))?;
                serde_json::to_value(imap_exchange::mutate_folder(&self.io, operation, input)?)
            }
            SYNC_IMAP_HEADERS => {
                let input = serde_json::from_value(params.unwrap_or_default())
                    .map_err(|_| RpcError::from_code(ErrorCode::InvalidParams))?;
                serde_json::to_value(imap_exchange::sync_headers(&self.io, operation, input)?)
            }
            taomni_mail_api::SYNC_IMAP_BODIES => {
                let input = serde_json::from_value(params.unwrap_or_default())
                    .map_err(|_| RpcError::from_code(ErrorCode::InvalidParams))?;
                serde_json::to_value(imap_body_sync::serve(&self.io, operation, input)?)
            }
            SYNC_IMAP_PAGE => {
                let input = serde_json::from_value(params.unwrap_or_default())
                    .map_err(|_| RpcError::from_code(ErrorCode::InvalidParams))?;
                serde_json::to_value(imap_exchange::sync_page(&self.io, operation, input)?)
            }
            SYNC_IMAP_ROUND => {
                let input = serde_json::from_value(params.unwrap_or_default())
                    .map_err(|_| RpcError::from_code(ErrorCode::InvalidParams))?;
                serde_json::to_value(imap_exchange::sync_round(&self.io, operation, input)?)
            }
            SEARCH_IMAP => {
                let input = serde_json::from_value(params.unwrap_or_default())
                    .map_err(|_| RpcError::from_code(ErrorCode::InvalidParams))?;
                serde_json::to_value(imap_exchange::search(&self.io, operation, input)?)
            }
            taomni_mail_api::FILTER_IMAP_BODIES => {
                let input = serde_json::from_value(params.unwrap_or_default())
                    .map_err(|_| RpcError::from_code(ErrorCode::InvalidParams))?;
                serde_json::to_value(imap_exchange::filter_bodies(&self.io, operation, input)?)
            }
            SET_IMAP_FLAGS => {
                let input = serde_json::from_value(params.unwrap_or_default())
                    .map_err(|_| RpcError::from_code(ErrorCode::InvalidParams))?;
                serde_json::to_value(imap_exchange::set_flags(&self.io, operation, input)?)
            }
            LIST_IMAP_UNREAD => {
                let input = serde_json::from_value(params.unwrap_or_default())
                    .map_err(|_| RpcError::from_code(ErrorCode::InvalidParams))?;
                serde_json::to_value(imap_exchange::list_unread(&self.io, operation, input)?)
            }
            taomni_mail_api::OPEN_IMAP_IDLE => {
                let input = serde_json::from_value(params.unwrap_or_default())
                    .map_err(|_| RpcError::from_code(ErrorCode::InvalidParams))?;
                serde_json::to_value(imap_idle::start(&self.io, operation, input)?)
            }
            FETCH_IMAP_RAW => {
                let input = serde_json::from_value(params.unwrap_or_default())
                    .map_err(|_| RpcError::from_code(ErrorCode::InvalidParams))?;
                serde_json::to_value(imap_exchange::fetch_raw(&self.io, operation, input)?)
            }
            FETCH_IMAP_BODY => {
                let input = serde_json::from_value(params.unwrap_or_default())
                    .map_err(|_| RpcError::from_code(ErrorCode::InvalidParams))?;
                serde_json::to_value(imap_exchange::fetch_body(&self.io, operation, input)?)
            }
            PREFETCH_IMAP_BODIES => {
                let input = serde_json::from_value(params.unwrap_or_default())
                    .map_err(|_| RpcError::from_code(ErrorCode::InvalidParams))?;
                serde_json::to_value(prefetch::start(&self.io, operation, input, &self.prefetch)?)
            }
            taomni_mail_api::ENCODE_ARCHIVE_ORIGINAL => {
                let input = serde_json::from_value(params.unwrap_or_default())
                    .map_err(|_| RpcError::from_code(ErrorCode::InvalidParams))?;
                serde_json::to_value(archive_encoding::start(
                    &self.io,
                    operation,
                    input,
                    &self.encoders,
                )?)
            }
            OPEN_IMAP_ARCHIVE => {
                let input = serde_json::from_value(params.unwrap_or_default())
                    .map_err(|_| RpcError::from_code(ErrorCode::InvalidParams))?;
                serde_json::to_value(archive::start(&self.io, operation, input)?)
            }
            OPEN_POP3_SYNC => {
                let input = serde_json::from_value(params.unwrap_or_default())
                    .map_err(|_| RpcError::from_code(ErrorCode::InvalidParams))?;
                serde_json::to_value(pop3_sync::start(&self.io, operation, input)?)
            }
            FETCH_IMAP_ATTACHMENT => {
                let input = serde_json::from_value(params.unwrap_or_default())
                    .map_err(|_| RpcError::from_code(ErrorCode::InvalidParams))?;
                serde_json::to_value(imap_exchange::fetch_attachment(&self.io, operation, input)?)
            }
            _ => {
                return commands::invoke(&self.store, method, params, &|| {
                    operation.check_current()
                });
            }
        };
        result.map_err(|_| RpcError::from_code(ErrorCode::InternalError))
    }
}

#[cfg(test)]
mod tests;
