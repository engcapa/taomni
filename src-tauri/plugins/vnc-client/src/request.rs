use std::time::Duration;

use serde::{Deserialize, de::DeserializeOwned};
use serde_json::Value;
use taomni_plugin_api::{ErrorCode, RpcError};
use taomni_vnc_api::forward::ForwardRoute;
pub(crate) use taomni_vnc_api::{ConnectionRequest as Start, Started};
use taomni_vnc_engine::ws::{RelayRequest, VncDialedTransport};
use tokio::net::TcpStream;

const MAX_CREDENTIAL_BYTES: usize = 64 * 1024;
const TCP_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Close {
    pub session_id: String,
}

pub(crate) fn checked(mut input: Start) -> Result<(RelayRequest, Dial), RpcError> {
    if input.host.is_empty()
        || input.host.len() > 1024
        || input.host.contains(char::is_whitespace)
        || input.host.contains('\0')
        || input.port == 0
        || input
            .forward
            .as_ref()
            .is_some_and(|route| !route.is_valid())
        || [
            input.username.as_deref(),
            input.password.as_deref().map(String::as_str),
        ]
        .into_iter()
        .flatten()
        .any(|value| value.len() > MAX_CREDENTIAL_BYTES)
    {
        return Err(RpcError::from_code(ErrorCode::InvalidParams));
    }
    let dial = match input.forward.take() {
        Some(route) => Dial::Forwarded(route),
        None => Dial::Direct(input.host.clone(), input.port),
    };
    Ok((input.into(), dial))
}

pub(crate) enum Dial {
    Direct(String, u16),
    Forwarded(ForwardRoute),
}

impl Dial {
    pub(crate) async fn connect(self) -> Result<VncDialedTransport, String> {
        let stream = tokio::time::timeout(TCP_TIMEOUT, async {
            match self {
                Self::Direct(host, port) => {
                    let stream = TcpStream::connect((host.as_str(), port)).await?;
                    stream.set_nodelay(true)?;
                    Ok(stream)
                }
                Self::Forwarded(route) => route.connect().await,
            }
        })
        .await
        .map_err(|_| "VNC TCP connection timed out after 15 seconds")?
        .map_err(|error| format!("VNC TCP connection failed: {error}"))?;
        Ok(VncDialedTransport {
            stream,
            network_forward_task: None,
        })
    }
}

pub(crate) fn decode<T: DeserializeOwned>(params: Option<Value>) -> Result<T, RpcError> {
    serde_json::from_value(params.unwrap_or_default())
        .map_err(|_| RpcError::from_code(ErrorCode::InvalidParams))
}
