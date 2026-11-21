//! Native-only binary side channel; no payload bytes travel over JSON stdio.
//!
//! Each offer owns a loopback listener, one unpredictable bearer capability,
//! a bounded payload and a deadline. The RPC/service owner must retain the
//! offer and cancel it on request cancellation, host exit or permission revoke.
//! Dropping it aborts the task; `cancel_and_wait` confirms resource reclamation.
//! This library does not itself grant a plugin permission to capture or read.

mod handshake;
pub mod native_channel;
mod pool;
mod receiver;
pub mod routed_tcp;
mod sender;

use std::time::{Duration, Instant};

use taomni_plugin_api::{ErrorCode, RpcError};
pub use tokio_util::sync::CancellationToken;

pub use pool::{TransferPool, TransferPoolLimits, TransferReservation, TransferUsage};
pub use receiver::receive;
pub use sender::{BinaryOffer, offer};

pub const MAX_PAYLOAD_BYTES: usize = 64 * 1024 * 1024;
pub const CHUNK_BYTES: usize = 64 * 1024;

/// The outer operation supplies an absolute deadline that preparing/hashing
/// the payload and retrying a connection can never extend.
pub struct TransferScope {
    pub cancelled: CancellationToken,
    pub deadline: Instant,
}

#[derive(Clone, Copy)]
pub struct TransferLimits {
    pub max_bytes: usize,
    /// Includes connect, handshake, transfer and integrity verification.
    pub timeout: Duration,
}

impl Default for TransferLimits {
    fn default() -> Self {
        Self {
            max_bytes: MAX_PAYLOAD_BYTES,
            timeout: Duration::from_secs(15),
        }
    }
}

impl TransferLimits {
    fn validate(self) -> Result<(), RpcError> {
        if self.max_bytes == 0
            || self.max_bytes > MAX_PAYLOAD_BYTES
            || self.timeout.is_zero()
            || self.timeout > Duration::from_secs(300)
        {
            return Err(error(
                ErrorCode::InvalidParams,
                "Invalid binary transfer limits",
            ));
        }
        Ok(())
    }
}

fn error(code: ErrorCode, message: &'static str) -> RpcError {
    // Do not attach raw handshake errors: those can contain bearer headers.
    RpcError::new(code, message)
}

#[cfg(test)]
mod frame_transport;
#[cfg(test)]
mod tests;
