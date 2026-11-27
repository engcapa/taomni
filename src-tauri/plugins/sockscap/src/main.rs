//! Native entry for the signed SocksCap module.

#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

mod settings;
mod xray;

use std::{io, sync::Arc, time::Duration};

use serde_json::Value;
use taomni_plugin_api::{
    ErrorCode, RpcError,
    services::{SNAPSHOT_METHOD, SNAPSHOT_PREPARE_METHOD, SNAPSHOT_RELEASE_METHOD},
};
use taomni_plugin_sdk::{HostConfig, Operation, PluginHandler, SnapshotProvider};
use taomni_sockscap_api::{
    COMMANDS, PARSE_SHARE_LINK, RULES, SETTINGS, TEST_SAVED_TARGET, TEST_TARGET,
    policy::TargetRuleProbe, share_link,
};

fn main() -> io::Result<()> {
    #[cfg(target_os = "macos")]
    {
        let mut args = std::env::args().skip(1);
        if args.next().as_deref() == Some(taomni_sockscap_api::REDIRECTOR_BRIDGE_ARG) {
            std::process::exit(taomni_sockscap_tools::redirector_bridge::run_from_cli(
                args, true,
            ));
        }
    }

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
                xray: xray::open(storage.root().path())?,
                runtime: tokio::runtime::Builder::new_multi_thread()
                    .worker_threads(1)
                    .enable_all()
                    .build()?,
            }))
        },
    )
}

struct Host {
    settings: Arc<settings::Settings>,
    xray: Arc<taomni_sockscap_xray::XrayManager>,
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
            taomni_sockscap_api::XRAY => {
                return xray::invoke(&self.runtime, &self.xray, operation, params);
            }
            taomni_sockscap_api::RUNTIME_INFO => {
                if params != serde_json::json!({}) {
                    return Err(RpcError::from_code(ErrorCode::InvalidParams));
                }
                #[cfg(target_os = "macos")]
                let (protocol, host_start_micros) = (
                    Some(taomni_redirector::bridge_protocol::BRIDGE_PROTOCOL_VERSION),
                    Some(
                        taomni_sockscap_tools::redirector_bridge::process_start_micros(
                            std::process::id(),
                        )
                        .ok_or_else(|| RpcError::from_code(ErrorCode::InternalError))?,
                    ),
                );
                #[cfg(not(target_os = "macos"))]
                let (protocol, host_start_micros) = (None, None);
                serde_json::to_value(taomni_sockscap_api::RuntimeInfo {
                    host_pid: std::process::id(),
                    host_start_micros,
                    redirector_bridge_protocol: protocol,
                })
            }
            SETTINGS => {
                let endpoint = serde_json::from_value(params)
                    .map_err(|_| RpcError::from_code(ErrorCode::InvalidParams))?;
                return self.settings.exchange(&self.runtime, operation, endpoint);
            }
            RULES => {
                let endpoint = serde_json::from_value(params)
                    .map_err(|_| RpcError::from_code(ErrorCode::InvalidParams))?;
                return self
                    .settings
                    .exchange_rules(&self.runtime, operation, endpoint);
            }
            TEST_SAVED_TARGET => {
                let endpoint = serde_json::from_value(params)
                    .map_err(|_| RpcError::from_code(ErrorCode::InvalidParams))?;
                return self
                    .settings
                    .exchange_saved_target(&self.runtime, operation, endpoint);
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
