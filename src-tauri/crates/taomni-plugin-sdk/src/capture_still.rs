use super::Operation;
use crate::client::{Reply, ReplyKind};
use taomni_plugin_api::{
    ErrorCode, RpcError,
    services::{
        CAPTURE_STILL_METHOD, CaptureStillRequest, MAX_CAPTURE_BYTES, validate_luma_frames,
    },
};

impl Operation {
    /// Business workers use the core-owned capture source. The SDK receives
    /// only an authenticated loopback descriptor, never a screen backend or
    /// a caller-selected window. Cancellation/deadline also cover the bytes.
    pub fn capture_still(&self) -> Result<Vec<u8>, RpcError> {
        let reply = self.client.request(
            self,
            CAPTURE_STILL_METHOD,
            serde_json::to_value(CaptureStillRequest {}).expect("capture request serializable"),
            ReplyKind::Capture,
        )?;
        let Reply::Capture(result) = reply else {
            return Err(RpcError::from_code(ErrorCode::InvalidRequest));
        };
        self.check_current()?;
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|_| RpcError::from_code(ErrorCode::InternalError))?;
        let bytes = runtime.block_on(taomni_plugin_stream::receive(
            &result.binary,
            taomni_plugin_stream::TransferLimits {
                max_bytes: MAX_CAPTURE_BYTES,
                timeout: self
                    .deadline
                    .saturating_duration_since(std::time::Instant::now())
                    .min(std::time::Duration::from_secs(300)),
            },
            &self.cancelled,
        ))?;
        self.check_current()?;
        validate_luma_frames(&bytes)?;
        Ok(bytes)
    }
}
