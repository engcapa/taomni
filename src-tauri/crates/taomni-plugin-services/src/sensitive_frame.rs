use taomni_plugin_api::{
    RequestId,
    services::{CaptureStillResult, CoreServiceError, FixedKeyResult, SensitiveRpcResponse},
};
use taomni_plugin_stream::BinaryOffer;
use zeroize::Zeroizing;

use crate::{BorrowedOperation, ReverseRequestPermit};

enum FramePermit {
    Request(ReverseRequestPermit),
    Binary(BorrowedOperation),
}

impl FramePermit {
    fn check_current(&self) -> Result<(), CoreServiceError> {
        match self {
            Self::Request(permit) => permit.check_current(),
            Self::Binary(operation) => operation.check_current(),
        }
    }
}

/// Owns both the zeroizing wire bytes and the operation lease until the
/// transport finishes or discards the write. It cannot be cloned or Debugged.
/// Revocation cannot finish while this frame or its worker still exists.
pub struct SensitiveServiceFrame {
    bytes: Zeroizing<Vec<u8>>,
    permit: FramePermit,
    // The session takes the offer before handing this frame to the writer.
    // Failed/undeliverable completions retain it here and abort it on drop.
    binary_offer: Option<BinaryOffer>,
}

impl SensitiveServiceFrame {
    /// Grant acknowledgements also retain admission until flush. Their
    /// non-secret payload uses the same owned frame to prevent stale success.
    pub(crate) fn export_grant_ack(
        id: RequestId,
        permit: ReverseRequestPermit,
    ) -> Result<Self, CoreServiceError> {
        permit.check_current()?;
        if &id != permit.request_id() {
            return Err(CoreServiceError::StalePluginContext);
        }
        let bytes = SensitiveRpcResponse::success(id, true)
            .encode_line()
            .map_err(|_| CoreServiceError::StalePluginContext)?;
        Ok(Self {
            bytes,
            permit: FramePermit::Request(permit),
            binary_offer: None,
        })
    }

    pub fn encode(
        id: RequestId,
        result: FixedKeyResult,
        permit: ReverseRequestPermit,
    ) -> Result<Self, CoreServiceError> {
        permit.check_current()?;
        if &id != permit.request_id() {
            return Err(CoreServiceError::StalePluginContext);
        }
        if let FixedKeyResult::Key { context, .. } = &result
            && context != permit.operation().context()
        {
            return Err(CoreServiceError::StalePluginContext);
        }
        let bytes = SensitiveRpcResponse::success(id, result)
            .encode_line()
            .map_err(|_| CoreServiceError::StalePluginContext)?;
        permit.check_current()?;
        Ok(Self {
            bytes,
            permit: FramePermit::Request(permit),
            binary_offer: None,
        })
    }

    pub fn binary(
        id: RequestId,
        result: CaptureStillResult,
        operation: BorrowedOperation,
        offer: BinaryOffer,
    ) -> Result<Self, CoreServiceError> {
        operation.check_current()?;
        result
            .validate(operation.context())
            .map_err(|_| CoreServiceError::StalePluginContext)?;
        if &result.binary != offer.descriptor() {
            return Err(CoreServiceError::StalePluginContext);
        }
        let bytes = SensitiveRpcResponse::success(id, result)
            .encode_line()
            .map_err(|_| CoreServiceError::StalePluginContext)?;
        operation.check_current()?;
        Ok(Self {
            bytes,
            permit: FramePermit::Binary(operation),
            binary_offer: Some(offer),
        })
    }

    pub(crate) fn take_binary_offer(&mut self) -> Option<BinaryOffer> {
        self.binary_offer.take()
    }

    /// Check again when dequeueing. No bytes are made available for a context
    /// invalidated while the frame waited for the bounded writer queue.
    pub fn current_bytes(&self) -> Result<&[u8], CoreServiceError> {
        self.permit.check_current()?;
        Ok(self.bytes.as_slice())
    }
}
