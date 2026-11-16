use taomni_plugin_api::{
    RequestId,
    services::{CoreServiceError, FixedKeyResult, SensitiveRpcResponse},
};
use zeroize::Zeroizing;

use crate::ReverseRequestPermit;

/// Owns both the zeroizing wire bytes and the operation lease until the
/// transport finishes or discards the write. It cannot be cloned or Debugged.
/// Revocation cannot finish while this frame or its worker still exists.
pub struct SensitiveServiceFrame {
    bytes: Zeroizing<Vec<u8>>,
    permit: ReverseRequestPermit,
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
        Ok(Self { bytes, permit })
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
        Ok(Self { bytes, permit })
    }

    /// Check again when dequeueing. No bytes are made available for a context
    /// invalidated while the frame waited for the bounded writer queue.
    pub fn current_bytes(&self) -> Result<&[u8], CoreServiceError> {
        self.permit.check_current()?;
        Ok(self.bytes.as_slice())
    }
}
