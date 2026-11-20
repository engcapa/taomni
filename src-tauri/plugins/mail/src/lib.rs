//! The official Mail host. The profile lease belongs to the SDK, and the
//! mailbox store uses only paths derived from that profile and account IDs.

mod commands;
mod snapshot;
mod store;

use std::{collections::BTreeSet, io, sync::Arc, time::Duration};

use serde_json::Value;
use taomni_plugin_api::{
    RpcError,
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
                SNAPSHOT_PREPARE_METHOD,
                SNAPSHOT_METHOD,
                SNAPSHOT_RELEASE_METHOD,
            ])
            .map(String::from)
            .collect(),
        permissions: BTreeSet::from([DATA_DIRECTORY_PERMISSION.into()]),
        required_services: Default::default(),
        operation_timeout: Duration::from_secs(10),
        snapshot_timeout: Duration::from_secs(300),
    }
}

pub fn serve_stdio() -> io::Result<()> {
    taomni_plugin_sdk::serve_stdio_with(host_config(), |storage| {
        let storage = storage.ok_or_else(|| io::Error::other("Mail profile ownership required"))?;
        Ok(Arc::new(Handler {
            store: Arc::new(store::Store::new(storage.root().path())),
        }))
    })
}

struct Handler {
    store: Arc<store::Store>,
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
        commands::invoke(&self.store, method, params)
    }
}

#[cfg(test)]
mod tests;
