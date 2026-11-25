use std::net::SocketAddrV4;

use futures_util::StreamExt;
use sha2::{Digest, Sha256};
use taomni_plugin_api::{BinaryRef, ErrorCode, RpcError};
use tokio::{net::TcpStream, time::timeout};
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::{
    client_async_with_config,
    tungstenite::{
        Message, client::IntoClientRequest, handshake::client::Request, http::HeaderValue,
    },
};

use crate::{CancellationToken, TransferLimits, error, handshake, sender::hex};

/// Returns data only after a normal close, exact length and SHA-256 match.
/// Direct numeric TCP connection deliberately bypasses DNS and all proxies.
pub async fn receive(
    descriptor: &BinaryRef,
    limits: TransferLimits,
    cancelled: &CancellationToken,
) -> Result<Vec<u8>, RpcError> {
    let (address, request) = prepare(descriptor, limits)?;
    tokio::select! {
        biased;
        _ = cancelled.cancelled() => Err(error(ErrorCode::RequestCancelled, "Binary transfer cancelled")),
        result = timeout(limits.timeout, read(descriptor, address, request)) =>
            result.unwrap_or_else(|_| Err(error(ErrorCode::RequestTimeout, "Binary transfer timed out"))),
    }
}

pub(crate) fn prepare(
    descriptor: &BinaryRef,
    limits: TransferLimits,
) -> Result<(SocketAddrV4, Request), RpcError> {
    descriptor.validate()?;
    limits.validate()?;
    if descriptor.byte_len > limits.max_bytes as u64
        || descriptor.stream_url.len() > 2048
        || descriptor.token.len() > 128
    {
        return Err(error(
            ErrorCode::InvalidParams,
            "Binary descriptor exceeds its limits",
        ));
    }
    // v1 listeners are native loopback ws only. Never downgrade a wss offer.
    let address = descriptor
        .stream_url
        .strip_prefix("ws://")
        .and_then(|url| url.split(['/', '?']).next())
        .and_then(|authority| authority.parse::<SocketAddrV4>().ok())
        .ok_or_else(|| {
            error(
                ErrorCode::InvalidParams,
                "Unsupported binary stream transport",
            )
        })?;
    let mut request = descriptor
        .stream_url
        .as_str()
        .into_client_request()
        .map_err(|_| error(ErrorCode::InvalidParams, "Invalid binary stream request"))?;
    let bearer = HeaderValue::from_str(&format!("Bearer {}", descriptor.token))
        .map_err(|_| error(ErrorCode::InvalidParams, "Invalid binary bearer"))?;
    request.headers_mut().insert("authorization", bearer);
    Ok((address, request))
}

async fn read(
    descriptor: &BinaryRef,
    address: SocketAddrV4,
    request: Request,
) -> Result<Vec<u8>, RpcError> {
    let stream = TcpStream::connect(address)
        .await
        .map_err(|_| error(ErrorCode::PluginCrashed, "Binary stream unavailable"))?;
    let (mut socket, _) = client_async_with_config(request, stream, Some(handshake::config()))
        .await
        .map_err(|_| error(ErrorCode::PermissionDenied, "Binary handshake rejected"))?;
    let mut payload = Payload::new(descriptor);
    while let Some(message) = socket.next().await {
        match message.map_err(|_| error(ErrorCode::PluginCrashed, "Binary stream interrupted"))? {
            Message::Binary(bytes) => payload.append(&bytes)?,
            Message::Close(frame) => {
                if frame
                    .as_ref()
                    .is_some_and(|close| close.code != CloseCode::Normal)
                {
                    return Err(error(
                        ErrorCode::InvalidRequest,
                        "Binary stream failed to close normally",
                    ));
                }
                return payload.finish();
            }
            Message::Ping(_) | Message::Pong(_) => {}
            _ => {
                return Err(error(
                    ErrorCode::InvalidRequest,
                    "Unexpected binary stream message",
                ));
            }
        }
    }
    Err(error(
        ErrorCode::PluginCrashed,
        "Binary stream ended without completion",
    ))
}

pub(crate) struct Payload<'a> {
    descriptor: &'a BinaryRef,
    bytes: Vec<u8>,
    digest: Sha256,
}

impl<'a> Payload<'a> {
    pub(crate) fn new(descriptor: &'a BinaryRef) -> Self {
        // Do not allocate an untrusted advertised length before seeing bytes.
        Self {
            descriptor,
            bytes: Vec::new(),
            digest: Sha256::new(),
        }
    }

    pub(crate) fn append(&mut self, bytes: &[u8]) -> Result<(), RpcError> {
        if bytes.len() as u64
            > self
                .descriptor
                .byte_len
                .saturating_sub(self.bytes.len() as u64)
        {
            return Err(error(
                ErrorCode::InvalidRequest,
                "Binary payload exceeds its declared length",
            ));
        }
        self.digest.update(bytes);
        self.bytes.extend_from_slice(bytes);
        Ok(())
    }

    pub(crate) fn finish(self) -> Result<Vec<u8>, RpcError> {
        if self.bytes.len() as u64 != self.descriptor.byte_len
            || !hex(&self.digest.finalize()).eq_ignore_ascii_case(&self.descriptor.sha256)
        {
            return Err(error(
                ErrorCode::InvalidRequest,
                "Binary payload integrity check failed",
            ));
        }
        Ok(self.bytes)
    }
}
