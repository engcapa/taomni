//! Owns RDP protocol and WebSocket sessions in the signed module process.

mod pins;
mod sessions;

use std::{io, sync::Arc, time::Duration};

use serde::{Serialize, de::DeserializeOwned};
use serde_json::Value;
use taomni_plugin_api::{
    ErrorCode, RpcError,
    services::{SNAPSHOT_METHOD, SNAPSHOT_PREPARE_METHOD, SNAPSHOT_RELEASE_METHOD},
};
use taomni_plugin_sdk::{HostConfig, Operation, PluginHandler, SnapshotProvider, serve_stdio_with};
use taomni_rdp_client_api::{
    CLOSE, Connection, GatewayConnection, START, START_GATEWAY, SessionId, TEST, TEST_GATEWAY,
    TRUST_CERTIFICATE,
};

const COMMANDS: [&str; 9] = [
    START,
    CLOSE,
    TEST,
    START_GATEWAY,
    TEST_GATEWAY,
    TRUST_CERTIFICATE,
    SNAPSHOT_PREPARE_METHOD,
    SNAPSHOT_METHOD,
    SNAPSHOT_RELEASE_METHOD,
];

pub fn serve_stdio() -> io::Result<()> {
    let config = HostConfig {
        plugin_id: "taomni-plugin-rdp-client".into(),
        plugin_version: env!("CARGO_PKG_VERSION").into(),
        commands: COMMANDS.into_iter().map(String::from).collect(),
        permissions: ["fs.dataDir".to_owned()].into(),
        required_services: Default::default(),
        optional_services: Default::default(),
        operation_timeout: Duration::from_secs(100),
        snapshot_timeout: Duration::from_secs(30),
    };
    serve_stdio_with(config, |storage| {
        let storage = storage.ok_or_else(|| io::Error::other("RDP profile ownership required"))?;
        let pins = Arc::new(pins::Pins::open(storage.root().path())?);
        Ok(Arc::new(sessions::Sessions::new(pins)?))
    })
}

impl PluginHandler for sessions::Sessions {
    fn snapshot_provider(&self) -> Option<Arc<dyn SnapshotProvider>> {
        Some(self.pins.clone())
    }

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
            TRUST_CERTIFICATE => response(
                self.pins
                    .trust(request(params)?, &|| operation.check_current())?,
            ),
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
