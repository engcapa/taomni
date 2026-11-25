//! Reserve aggregate memory and listener capacity before producing a payload.
//! The reservation and caller's lease stay in the actual network task until
//! its listener, socket and payload have been reclaimed, including on abort.

use std::sync::{Arc, Mutex};

use taomni_plugin_api::{ErrorCode, RpcError};

use crate::{BinaryOffer, MAX_PAYLOAD_BYTES, TransferLimits, TransferScope, error, sender};

#[derive(Clone, Copy, Debug)]
pub struct TransferPoolLimits {
    pub max_transfers: usize,
    pub max_bytes: usize,
}

impl Default for TransferPoolLimits {
    fn default() -> Self {
        Self {
            max_transfers: 8,
            max_bytes: 2 * MAX_PAYLOAD_BYTES,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TransferUsage {
    pub transfers: usize,
    pub bytes: usize,
}

struct PoolInner {
    limits: TransferPoolLimits,
    usage: Mutex<TransferUsage>,
}

/// Clone this single core-owned pool for all service workers. Separate pools
/// deliberately have separate budgets; a view must not create its own pool.
#[derive(Clone)]
pub struct TransferPool(Arc<PoolInner>);

impl TransferPool {
    pub fn new(limits: TransferPoolLimits) -> Result<Self, RpcError> {
        if !(1..=128).contains(&limits.max_transfers)
            || limits.max_bytes == 0
            || limits.max_bytes > 8 * MAX_PAYLOAD_BYTES
        {
            return Err(error(
                ErrorCode::InvalidParams,
                "Invalid binary pool limits",
            ));
        }
        Ok(Self(Arc::new(PoolInner {
            limits,
            usage: Mutex::new(TransferUsage::default()),
        })))
    }

    /// Reserve buffer capacity before allocating/capturing bytes. Zero-length
    /// transfers also consume a slot. Saturation fails immediately instead of
    /// queuing unbounded payloads or extending an operation's deadline.
    pub fn reserve(&self, max_bytes: usize) -> Result<TransferReservation, RpcError> {
        if max_bytes > MAX_PAYLOAD_BYTES || max_bytes > self.0.limits.max_bytes {
            return Err(error(
                ErrorCode::InvalidParams,
                "Binary reservation exceeds its limits",
            ));
        }
        let mut usage = self.0.usage.lock().expect("binary pool poisoned");
        if usage.transfers >= self.0.limits.max_transfers
            || max_bytes > self.0.limits.max_bytes - usage.bytes
        {
            return Err(error(ErrorCode::InvalidState, "BINARY_TRANSFER_BUSY"));
        }
        usage.transfers += 1;
        usage.bytes += max_bytes;
        Ok(TransferReservation {
            pool: self.clone(),
            max_bytes,
        })
    }

    /// Counts reservations and live tasks, without exposing descriptors/tokens.
    pub fn usage(&self) -> TransferUsage {
        *self.0.usage.lock().expect("binary pool poisoned")
    }
}

#[must_use = "retain the reservation until the payload is transferred or discarded"]
pub struct TransferReservation {
    pool: TransferPool,
    max_bytes: usize,
}

impl TransferReservation {
    /// The caller supplies its operation lease and a child cancellation token.
    /// Dropping the returned handle aborts the task; releasing a descriptor or
    /// a UI view alone is not the operation's ownership boundary.
    pub fn offer_with_owner<G: Send + 'static>(
        self,
        payload: Vec<u8>,
        content_type: &str,
        limits: TransferLimits,
        scope: TransferScope,
        owner: G,
    ) -> impl Future<Output = Result<BinaryOffer, RpcError>> + Send + '_ {
        let exceeds_reservation = payload.capacity() > self.max_bytes;
        // Construct the complete resource before returning an unpolled future.
        // Buffer destruction must precede releasing its aggregate reservation.
        let pending = sender::PendingPayload {
            payload,
            owner: (self, owner),
        };
        async move {
            if exceeds_reservation {
                return Err(error(
                    ErrorCode::InvalidParams,
                    "Binary payload exceeds its reservation",
                ));
            }
            pending.offer(content_type, limits, scope).await
        }
    }
}

impl Drop for TransferReservation {
    fn drop(&mut self) {
        let mut usage = self.pool.0.usage.lock().expect("binary pool poisoned");
        usage.transfers -= 1;
        usage.bytes -= self.max_bytes;
    }
}

#[cfg(test)]
#[path = "pool_tests.rs"]
mod tests;
