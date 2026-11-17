use std::{net::Ipv4Addr, time::Duration};

use futures_util::SinkExt;
use rand::RngCore;
use sha2::{Digest, Sha256};
use taomni_plugin_api::{BinaryRef, ErrorCode, RpcError};
use tokio::{net::TcpListener, task::JoinHandle, time::timeout};
use tokio_tungstenite::{
    accept_hdr_async_with_config,
    tungstenite::{Message, http::HeaderValue},
};

use crate::{CHUNK_BYTES, CancellationToken, TransferLimits, error, handshake};

/// The live RPC operation owns this handle, independently of any UI view.
#[must_use = "retain the offer until its RPC completes or is cancelled"]
pub struct BinaryOffer {
    descriptor: BinaryRef,
    cancellation: CancellationToken,
    task: JoinHandle<Result<u64, RpcError>>,
}

impl BinaryOffer {
    pub fn descriptor(&self) -> &BinaryRef {
        &self.descriptor
    }

    /// Cancellation becomes observable after `finish` or `cancel_and_wait`.
    pub fn cancel(&self) {
        self.cancellation.cancel();
    }

    pub async fn finish(mut self) -> Result<u64, RpcError> {
        (&mut self.task)
            .await
            .map_err(|_| error(ErrorCode::InternalError, "Binary task failed"))?
    }

    pub async fn cancel_and_wait(self) -> Result<u64, RpcError> {
        self.cancel();
        self.finish().await
    }
}

impl Drop for BinaryOffer {
    fn drop(&mut self) {
        self.cancellation.cancel();
        self.task.abort();
    }
}

pub async fn offer(
    payload: Vec<u8>,
    content_type: &str,
    limits: TransferLimits,
) -> Result<BinaryOffer, RpcError> {
    limits.validate()?;
    if payload.len() > limits.max_bytes || content_type.is_empty() || content_type.len() > 256 {
        return Err(error(
            ErrorCode::InvalidParams,
            "Binary payload exceeds its limits",
        ));
    }
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .await
        .map_err(|_| {
            error(
                ErrorCode::InternalError,
                "Cannot bind binary loopback listener",
            )
        })?;
    let address = listener.local_addr().map_err(|_| {
        error(
            ErrorCode::InternalError,
            "Cannot resolve binary listener address",
        )
    })?;
    let mut random = [0_u8; 32];
    rand::rng().fill_bytes(&mut random);
    let token = hex(&random);
    rand::rng().fill_bytes(&mut random);
    let path = format!("/binary/{}", hex(&random));
    let descriptor = BinaryRef {
        stream_url: format!("ws://{address}{path}"),
        token: token.clone(),
        content_type: content_type.into(),
        byte_len: payload.len() as u64,
        sha256: hex(&Sha256::digest(&payload)),
    };
    let cancellation = CancellationToken::new();
    let cancelled = cancellation.clone();
    let task = tokio::spawn(async move {
        tokio::select! {
            biased;
            _ = cancelled.cancelled() => Err(error(ErrorCode::RequestCancelled, "Binary transfer cancelled")),
            result = timeout(limits.timeout, send(listener, address.to_string(), path, token, payload)) =>
                result.unwrap_or_else(|_| Err(error(ErrorCode::RequestTimeout, "Binary transfer timed out"))),
        }
    });
    Ok(BinaryOffer {
        descriptor,
        cancellation,
        task,
    })
}

async fn send(
    listener: TcpListener,
    authority: String,
    path: String,
    token: String,
    payload: Vec<u8>,
) -> Result<u64, RpcError> {
    let bearer = HeaderValue::from_str(&format!("Bearer {token}"))
        .map_err(|_| error(ErrorCode::InvalidParams, "Invalid binary bearer"))?;
    let mut socket = loop {
        let (stream, peer) = listener
            .accept()
            .await
            .map_err(|_| error(ErrorCode::InternalError, "Binary listener failed"))?;
        if !peer.ip().is_loopback() {
            continue;
        }
        let callback = handshake::Authorization {
            authority: &authority,
            path: &path,
            bearer: &bearer,
        };
        // An unauthenticated/stalled connection cannot consume the capability.
        if let Ok(Ok(socket)) = timeout(
            Duration::from_millis(250),
            accept_hdr_async_with_config(stream, callback, Some(handshake::config())),
        )
        .await
        {
            break socket;
        }
    };
    // Close the listener before publishing any bytes. No second peer can use
    // this token, even while a slow receiver keeps the first connection alive.
    drop(listener);
    for chunk in payload.chunks(CHUNK_BYTES) {
        socket
            .send(Message::Binary(chunk.to_vec().into()))
            .await
            .map_err(|_| error(ErrorCode::PluginCrashed, "Binary receiver disconnected"))?;
    }
    socket
        .close(None)
        .await
        .map_err(|_| error(ErrorCode::PluginCrashed, "Binary receiver disconnected"))?;
    Ok(payload.len() as u64)
}

pub(crate) fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
