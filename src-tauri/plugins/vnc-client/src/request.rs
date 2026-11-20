use std::time::Duration;

use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::Value;
use taomni_plugin_api::{ErrorCode, RpcError};
use taomni_vnc_engine::{
    error::VncError,
    policy::{VncClipboardPolicy, VncSecurityPolicy},
    quality::VncPictureQuality,
    ws::{RelayRequest, VncDialedTransport, VncRelayOptions, forward::ForwardRoute},
};
use tokio::net::TcpStream;
use zeroize::Zeroizing;

const MAX_CREDENTIAL_BYTES: usize = 64 * 1024;
const TCP_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Start {
    host: String,
    port: u16,
    username: Option<String>,
    password: Option<Zeroizing<String>>,
    forward: Option<ForwardRoute>,
    #[serde(default)]
    security_policy: VncSecurityPolicy,
    #[serde(default)]
    clipboard_policy: VncClipboardPolicy,
    #[serde(default)]
    picture_quality: VncPictureQuality,
    #[serde(default)]
    view_only: bool,
    shared: Option<bool>,
    #[serde(default)]
    allow_unencrypted: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Close {
    pub session_id: String,
}

#[derive(Serialize)]
pub(crate) struct Started {
    pub session_id: String,
    pub ws_port: u16,
    pub ws_token: String,
}

impl Start {
    pub(crate) fn checked(self) -> Result<(RelayRequest, Dial), RpcError> {
        if self.host.is_empty()
            || self.host.len() > 1024
            || self.host.contains(char::is_whitespace)
            || self.host.contains('\0')
            || self.port == 0
            || self.forward.as_ref().is_some_and(|route| !route.is_valid())
            || [
                self.username.as_deref(),
                self.password.as_deref().map(String::as_str),
            ]
            .into_iter()
            .flatten()
            .any(|value| value.len() > MAX_CREDENTIAL_BYTES)
        {
            return Err(RpcError::from_code(ErrorCode::InvalidParams));
        }
        let dial = match self.forward {
            Some(route) => Dial::Forwarded(route),
            None => Dial::Direct(self.host.clone(), self.port),
        };
        Ok((
            RelayRequest {
                host: self.host,
                username: self.username,
                password: self.password,
                security_policy: self.security_policy,
                view_only: self.view_only,
                clipboard_policy: self.clipboard_policy,
                options: VncRelayOptions {
                    picture_quality: self.picture_quality,
                    shared: self.shared.unwrap_or(true),
                    allow_unencrypted: self.allow_unencrypted,
                    ..VncRelayOptions::default()
                },
            },
            dial,
        ))
    }
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

pub(crate) fn connection_error(error: String) -> RpcError {
    let failure = VncError::classify(error);
    RpcError::new(ErrorCode::InvalidState, failure.code)
        .with_data(serde_json::to_value(&failure).expect("VNC failure is serializable"))
}
