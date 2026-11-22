//! Native entry for the signed SocksCap module.

mod settings;

use std::{io, sync::Arc, time::Duration};

use serde_json::Value;
use taomni_plugin_api::{
    ErrorCode, RpcError,
    services::{SNAPSHOT_METHOD, SNAPSHOT_PREPARE_METHOD, SNAPSHOT_RELEASE_METHOD},
};
use taomni_plugin_sdk::{HostConfig, Operation, PluginHandler, SnapshotProvider};
use taomni_sockscap_api::{
    COMMANDS, PARSE_SHARE_LINK, SETTINGS, TEST_TARGET, policy::TargetRuleProbe, share_link,
};

fn main() -> io::Result<()> {
    taomni_plugin_sdk::serve_stdio_with(
        HostConfig {
            plugin_id: "taomni-plugin-sockscap".into(),
            plugin_version: env!("CARGO_PKG_VERSION").into(),
            commands: COMMANDS
                .into_iter()
                .chain([
                    SNAPSHOT_PREPARE_METHOD,
                    SNAPSHOT_METHOD,
                    SNAPSHOT_RELEASE_METHOD,
                ])
                .map(str::to_owned)
                .collect(),
            permissions: ["fs.dataDir".to_owned()].into(),
            required_services: Default::default(),
            optional_services: Default::default(),
            operation_timeout: Duration::from_secs(15),
            snapshot_timeout: Duration::from_secs(15),
        },
        |storage| {
            let storage =
                storage.ok_or_else(|| io::Error::other("SocksCap profile is unavailable"))?;
            Ok(Arc::new(Host {
                settings: Arc::new(settings::Settings::new(storage.root().path())),
                runtime: tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()?,
            }))
        },
    )
}

struct Host {
    settings: Arc<settings::Settings>,
    runtime: tokio::runtime::Runtime,
}

impl PluginHandler for Host {
    fn snapshot_provider(&self) -> Option<Arc<dyn SnapshotProvider>> {
        Some(self.settings.clone())
    }

    fn invoke(
        &self,
        operation: &Operation,
        method: &str,
        params: Option<Value>,
    ) -> Result<Value, RpcError> {
        operation.check_current()?;
        let params = params.ok_or_else(|| RpcError::from_code(ErrorCode::InvalidParams))?;
        let reply = match method {
            SETTINGS => {
                let endpoint = serde_json::from_value(params)
                    .map_err(|_| RpcError::from_code(ErrorCode::InvalidParams))?;
                return self.settings.exchange(&self.runtime, operation, endpoint);
            }
            PARSE_SHARE_LINK => {
                let input = params
                    .as_str()
                    .ok_or_else(|| RpcError::from_code(ErrorCode::InvalidParams))?;
                serde_json::to_value(share_link::parse(input))
            }
            TEST_TARGET => {
                let probe: TargetRuleProbe = serde_json::from_value(params)
                    .map_err(|_| RpcError::from_code(ErrorCode::InvalidParams))?;
                serde_json::to_value(probe.evaluate())
            }
            _ => return Err(RpcError::from_code(ErrorCode::MethodNotFound)),
        };
        operation.check_current()?;
        reply.map_err(|_| RpcError::from_code(ErrorCode::InternalError))
    }
}
