//! Native entry for the signed SocksCap module.

use std::{io, sync::Arc, time::Duration};

use serde_json::Value;
use taomni_plugin_api::{ErrorCode, RpcError};
use taomni_plugin_sdk::{HostConfig, Operation, PluginHandler};
use taomni_sockscap_api::{PARSE_SHARE_LINK, share_link};

fn main() -> io::Result<()> {
    taomni_plugin_sdk::serve_stdio_with(
        HostConfig {
            plugin_id: "taomni-plugin-sockscap".into(),
            plugin_version: env!("CARGO_PKG_VERSION").into(),
            commands: [PARSE_SHARE_LINK.to_owned()].into(),
            permissions: Default::default(),
            required_services: Default::default(),
            optional_services: Default::default(),
            operation_timeout: Duration::from_secs(15),
            snapshot_timeout: Duration::from_secs(15),
        },
        |_| Ok(Arc::new(Host)),
    )
}

struct Host;

impl PluginHandler for Host {
    fn invoke(
        &self,
        operation: &Operation,
        method: &str,
        params: Option<Value>,
    ) -> Result<Value, RpcError> {
        operation.check_current()?;
        let input = params
            .as_ref()
            .and_then(Value::as_str)
            .ok_or_else(|| RpcError::from_code(ErrorCode::InvalidParams))?;
        if method != PARSE_SHARE_LINK {
            return Err(RpcError::from_code(ErrorCode::MethodNotFound));
        }
        serde_json::to_value(share_link::parse(input))
            .map_err(|_| RpcError::from_code(ErrorCode::InternalError))
    }
}
