//! Owns RDP protocol and WebSocket sessions in the signed module process.

mod sessions;

use std::{io, sync::Arc, time::Duration};

use serde::{Serialize, de::DeserializeOwned};
use serde_json::Value;
use taomni_plugin_api::{ErrorCode, RpcError};
use taomni_plugin_sdk::{HostConfig, Operation, PluginHandler, serve_stdio_with};
use taomni_rdp_client_api::{
    CLOSE, Connection, GatewayConnection, START, START_GATEWAY, SessionId, TEST, TEST_GATEWAY,
};

const COMMANDS: [&str; 5] = [START, CLOSE, TEST, START_GATEWAY, TEST_GATEWAY];

pub fn serve_stdio() -> io::Result<()> {
    let config = HostConfig {
        plugin_id: "taomni-plugin-rdp-client".into(),
        plugin_version: env!("CARGO_PKG_VERSION").into(),
        commands: COMMANDS.into_iter().map(String::from).collect(),
        permissions: Default::default(),
        required_services: Default::default(),
        optional_services: Default::default(),
        operation_timeout: Duration::from_secs(100),
        snapshot_timeout: Duration::from_secs(30),
    };
    serve_stdio_with(config, |storage| {
        storage.ok_or_else(|| io::Error::other("RDP profile ownership required"))?;
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
            START => response(self.start(request(params)?, None, &|| operation.check_current())?),
            TEST => response(self.test(request(params)?, None, &|| operation.check_current())?),
            START_GATEWAY => {
                let request: GatewayConnection = request(params)?;
                response(self.start(request.connection, Some(request.outbound), &|| {
                    operation.check_current()
                })?)
            }
            TEST_GATEWAY => {
                let request: GatewayConnection = request(params)?;
                response(self.test(request.connection, Some(request.outbound), &|| {
                    operation.check_current()
                })?)
            }
            CLOSE => {
                let request: SessionId = request(params)?;
                response(self.close(&request.session_id)?)
            }
            _ => Err(RpcError::from_code(ErrorCode::MethodNotFound)),
        }
    }
}

fn request<T: DeserializeOwned>(params: Option<Value>) -> Result<T, RpcError> {
    serde_json::from_value(params.unwrap_or_default())
        .map_err(|_| RpcError::from_code(ErrorCode::InvalidParams))
}

fn response(value: impl Serialize) -> Result<Value, RpcError> {
    serde_json::to_value(value).map_err(|_| RpcError::from_code(ErrorCode::InternalError))
}

fn validate_endpoint(request: &Connection) -> Result<(), RpcError> {
    if request.host.is_empty()
        || request.host.len() > 1024
        || request
            .host
            .contains(|character: char| character.is_whitespace() || character == '\0')
        || request.port == 0
    {
        return Err(RpcError::from_code(ErrorCode::InvalidParams));
    }
    Ok(())
}
