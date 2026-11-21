//! The official Mail host. The profile lease belongs to the SDK, and the
//! mailbox store uses only paths derived from that profile and account IDs.

mod commands;
mod imap_exchange;
mod incoming;
mod outgoing;
mod snapshot;
mod store;

use std::{collections::BTreeSet, io, sync::Arc, time::Duration};

use serde_json::Value;
use taomni_mail_api::{
    CHECK_INCOMING, CHECK_OUTGOING, HOST_REQUEST_TIMEOUT, IMAP_FOLDER_TREE, SEARCH_IMAP, SEND_SMTP,
    SYNC_IMAP_HEADERS, SYNC_IMAP_ROUND,
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
                CHECK_INCOMING,
                CHECK_OUTGOING,
                IMAP_FOLDER_TREE,
                SEND_SMTP,
                SYNC_IMAP_HEADERS,
                SYNC_IMAP_ROUND,
                SEARCH_IMAP,
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
            io: tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()?,
        }))
    })
}

struct Handler {
    store: Arc<store::Store>,
    io: tokio::runtime::Runtime,
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
            IMAP_FOLDER_TREE => {
                let input = serde_json::from_value(params.unwrap_or_default())
                    .map_err(|_| RpcError::from_code(ErrorCode::InvalidParams))?;
                serde_json::to_value(incoming::imap_folder_tree(&self.io, operation, input)?)
            }
            SYNC_IMAP_HEADERS => {
                let input = serde_json::from_value(params.unwrap_or_default())
                    .map_err(|_| RpcError::from_code(ErrorCode::InvalidParams))?;
                serde_json::to_value(imap_exchange::sync_headers(&self.io, operation, input)?)
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
