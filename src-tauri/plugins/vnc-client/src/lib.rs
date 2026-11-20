//! Standalone VNC session owner. The desktop owns saved sessions and supplies
//! the original endpoint or a single-use authenticated loopback route.

mod request;
mod sessions;

use std::{io, sync::Arc, time::Duration};

use serde_json::Value;
use taomni_plugin_api::{ErrorCode, RpcError};
use taomni_plugin_sdk::{HostConfig, Operation, PluginHandler};

const PLUGIN_ID: &str = "taomni-plugin-vnc-client";
const PLUGIN_VERSION: &str = env!("CARGO_PKG_VERSION");
const START: &str = "vnc/start";
const CLOSE: &str = "vnc/close";

fn host_config() -> HostConfig {
    HostConfig {
        plugin_id: PLUGIN_ID.into(),
        plugin_version: PLUGIN_VERSION.into(),
        commands: [START, CLOSE].into_iter().map(String::from).collect(),
        permissions: Default::default(),
        required_services: Default::default(),
        optional_services: Default::default(),
        operation_timeout: Duration::from_secs(65),
        snapshot_timeout: Duration::from_secs(30),
    }
}

pub fn serve_stdio() -> io::Result<()> {
    taomni_plugin_sdk::serve_stdio_with(host_config(), |storage| {
        storage.ok_or_else(|| io::Error::other("VNC profile ownership required"))?;
        Ok(Arc::new(sessions::Sessions::new()?))
    })
}

impl PluginHandler for sessions::Sessions {
    fn invoke(
        &self,
        operation: &Operation,
        method: &str,
        params: Option<Value>,
    ) -> Result<Value, RpcError> {
        operation.check_current()?;
        match method {
            START => {
                let input: request::Start = request::decode(params)?;
                let result = self.start(input, &|| operation.check_current())?;
                serde_json::to_value(result)
                    .map_err(|_| RpcError::from_code(ErrorCode::InternalError))
            }
            CLOSE => {
                let input: request::Close = request::decode(params)?;
                Ok(Value::Bool(self.close(&input.session_id)?))
            }
            _ => Err(RpcError::from_code(ErrorCode::MethodNotFound)),
        }
    }
}

#[cfg(test)]
mod tests;
