//! The network task owns the same request/admission lease as the reverse RPC.
//! It must not become an untracked task after its descriptor has been flushed.

use std::time::Instant;

use taomni_plugin_api::{RpcError, services::CoreServiceError};
use taomni_plugin_stream::{BinaryOffer, TransferLimits, TransferReservation, TransferScope};

use crate::ReverseRequestPermit;

/// A service worker reserves capacity before capturing/allocating its payload,
/// then transfers this request's permit into the actual network task. This is
/// lifecycle binding, not authorization to capture: the dispatcher must check
/// the signed manifest's service permission before obtaining the payload.
/// The caller retains the handle until completion or explicit cancellation.
pub fn offer_binary_for_request(
    permit: ReverseRequestPermit,
    reservation: TransferReservation,
    payload: Vec<u8>,
    content_type: &str,
    limits: TransferLimits,
) -> impl Future<Output = Result<BinaryOffer, RpcError>> + Send + '_ {
    BinaryRequest {
        payload,
        reservation,
        permit,
    }
    .offer(content_type, limits)
}

// Drop payload before its capacity reservation/OS lease even when the service
// worker is cancelled before it ever polls the preparation future.
struct BinaryRequest {
    payload: Vec<u8>,
    reservation: TransferReservation,
    permit: ReverseRequestPermit,
}

impl BinaryRequest {
    async fn offer(
        self,
        content_type: &str,
        limits: TransferLimits,
    ) -> Result<BinaryOffer, RpcError> {
        self.permit
            .check_current()
            .map_err(CoreServiceError::into_rpc_error)?;
        let deadline = self
            .permit
            .operation()
            .deadline()
            .ok_or_else(|| CoreServiceError::StalePluginContext.into_rpc_error())?;
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(CoreServiceError::TimedOut.into_rpc_error());
        }
        let cancelled = self.permit.operation().cancellation_token();
        self.reservation
            .offer_with_owner(
                self.payload,
                content_type,
                TransferLimits {
                    timeout: limits.timeout.min(remaining),
                    ..limits
                },
                TransferScope {
                    cancelled,
                    deadline,
                },
                self.permit,
            )
            .await
    }
}
