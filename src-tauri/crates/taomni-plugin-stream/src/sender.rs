use std::{net::Ipv4Addr, time::Duration};

use futures_util::SinkExt;
use rand::RngCore;
use sha2::{Digest, Sha256};
use taomni_plugin_api::{BinaryRef, ErrorCode, RpcError};
use tokio::{
    net::TcpListener,
    task::JoinHandle,
    time::{Instant, timeout, timeout_at},
};
use tokio_tungstenite::{
    accept_hdr_async_with_config,
    tungstenite::{Message, http::HeaderValue},
};

use crate::{CHUNK_BYTES, CancellationToken, TransferLimits, TransferScope, error, handshake};

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

    /// Lets a session discard completed handles without retaining every past
    /// transfer. Result/integrity errors still reach the actual receiver.
    pub fn is_finished(&self) -> bool {
        self.task.is_finished()
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
    let scope = TransferScope {
        cancelled: CancellationToken::new(),
        deadline: std::time::Instant::now() + limits.timeout,
    };
    PendingPayload { payload, owner: () }
        .offer(content_type, limits, scope)
        .await
}

// Field order also protects the unpolled task: reclaim network/payload before
// dropping the caller's admission lease and aggregate memory reservation.
struct SendResources<G> {
    listener: TcpListener,
    payload: Vec<u8>,
    owner: G,
}

impl<G> SendResources<G> {
    async fn transfer(
        self,
        authority: String,
        path: String,
        token: String,
        deadline: Instant,
        cancelled: CancellationToken,
    ) -> Result<u64, RpcError> {
        let Self {
            listener,
            payload,
            owner,
        } = self;
        let result = {
            // This future is destroyed before owner on completion, cancellation
            // and task abort. Revocation cannot drain ahead of its socket.
            let sending = send(listener, authority, path, token, payload, deadline);
            tokio::select! {
                biased;
                _ = cancelled.cancelled() => Err(error(ErrorCode::RequestCancelled, "Binary transfer cancelled")),
                result = timeout_at(deadline, sending) =>
                    result.unwrap_or_else(|_| Err(error(ErrorCode::RequestTimeout, "Binary transfer timed out"))),
            }
        };
        drop(owner);
        result
    }
}

// The preparing future also owns the complete resource, so cancellation while
// binding/hashing cannot return capacity before dropping its buffer.
pub(crate) struct PendingPayload<G> {
    pub(crate) payload: Vec<u8>,
    pub(crate) owner: G,
}

impl<G: Send + 'static> PendingPayload<G> {
    pub(crate) async fn offer(
        self,
        content_type: &str,
        limits: TransferLimits,
        scope: TransferScope,
    ) -> Result<BinaryOffer, RpcError> {
        limits.validate()?;
        let deadline = Instant::from_std(scope.deadline).min(Instant::now() + limits.timeout);
        let payload = &self.payload;
        if payload.len() > limits.max_bytes || content_type.is_empty() || content_type.len() > 256 {
            return Err(error(
                ErrorCode::InvalidParams,
                "Binary payload exceeds its limits",
            ));
        }
        if scope.cancelled.is_cancelled() {
            return Err(error(
                ErrorCode::RequestCancelled,
                "Binary transfer cancelled",
            ));
        }
        if deadline <= Instant::now() {
            return Err(error(
                ErrorCode::RequestTimeout,
                "Binary transfer timed out",
            ));
        }
        let listener = tokio::select! {
            biased;
            _ = scope.cancelled.cancelled() => return Err(error(ErrorCode::RequestCancelled, "Binary transfer cancelled")),
            result = timeout_at(deadline, TcpListener::bind((Ipv4Addr::LOCALHOST, 0))) => result
                .map_err(|_| error(ErrorCode::RequestTimeout, "Binary transfer timed out"))?
                .map_err(|_| {
                error(
                    ErrorCode::InternalError,
                    "Cannot bind binary loopback listener",
                )
            })?,
        };
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
            sha256: hex(&Sha256::digest(payload)),
        };
        if scope.cancelled.is_cancelled() {
            return Err(error(
                ErrorCode::RequestCancelled,
                "Binary transfer cancelled",
            ));
        }
        if deadline <= Instant::now() {
            return Err(error(
                ErrorCode::RequestTimeout,
                "Binary transfer timed out",
            ));
        }
        // Cancelling this offer must not cancel its outer operation or siblings.
        let cancellation = scope.cancelled.child_token();
        let cancelled = cancellation.clone();
        let resources = SendResources {
            listener,
            payload: self.payload,
            owner: self.owner,
        };
        // Pass the complete owner by value, preventing precise closure capture
        // from splitting it into independently dropped task fields.
        let task =
            tokio::spawn(resources.transfer(address.to_string(), path, token, deadline, cancelled));
        Ok(BinaryOffer {
            descriptor,
            cancellation,
            task,
        })
    }
}

async fn send(
    listener: TcpListener,
    authority: String,
    path: String,
    token: String,
    payload: Vec<u8>,
    deadline: Instant,
) -> Result<u64, RpcError> {
    let bearer = HeaderValue::from_str(&format!("Bearer {token}"))
        .map_err(|_| error(ErrorCode::InvalidParams, "Invalid binary bearer"))?;
    let mut socket = loop {
        if deadline <= Instant::now() {
            return Err(error(
                ErrorCode::RequestTimeout,
                "Binary transfer timed out",
            ));
        }
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
        if deadline <= Instant::now() {
            return Err(error(
                ErrorCode::RequestTimeout,
                "Binary transfer timed out",
            ));
        }
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
