//! The operation's trusted core facade supplies its invoking window. This
//! source never resolves a window label or capture backend from host JSON.
use taomni_plugin_api::{
    ErrorCode, RpcError,
    services::{
        CaptureStillResult, CoreServiceError, LUMA_FRAMES_CONTENT_TYPE, LumaFrameRef,
        MAX_CAPTURE_BYTES, encode_luma_frames,
    },
};
use taomni_plugin_services::{
    ReverseRequestPermit, SensitiveServiceFrame, StillCaptureService, offer_binary_for_request,
};
use taomni_plugin_stream::{TransferLimits, TransferPool};

pub(crate) struct WindowStillCapture {
    pub(crate) window: tauri::WebviewWindow,
    pub(crate) pool: TransferPool,
}

impl StillCaptureService for WindowStillCapture {
    fn capture(&self, permit: ReverseRequestPermit) -> Result<SensitiveServiceFrame, RpcError> {
        permit
            .check_current()
            .map_err(CoreServiceError::into_rpc_error)?;
        // Reserve both luma and encoded buffers before OS capture. Native
        // backend/OS scratch allocations are separate from transport memory.
        let scratch = self.pool.reserve(MAX_CAPTURE_BYTES)?;
        let reservation = self.pool.reserve(MAX_CAPTURE_BYTES)?;
        let frames = super::service::capture_luma_hiding_bounded(&self.window, MAX_CAPTURE_BYTES)
            .map_err(|error| match error {
            super::service::StillServiceError::ScreenPermission => {
                RpcError::new(ErrorCode::PermissionDenied, "SCREEN_PERMISSION_REQUIRED")
            }
            super::service::StillServiceError::Capture(
                taomni_capture::still::StillError::NoDisplay(_),
            ) => RpcError::new(ErrorCode::InvalidState, "SCREEN_CAPTURE_NO_DISPLAY"),
            _ => RpcError::new(ErrorCode::InternalError, "SCREEN_CAPTURE_FAILED"),
        })?;
        // Native capture may be synchronous. Its OS lease stays owned until
        // it actually returns and the window is restored; late bytes are lost.
        permit
            .check_current()
            .map_err(CoreServiceError::into_rpc_error)?;
        let views: Vec<_> = frames
            .iter()
            .map(|frame| LumaFrameRef {
                width: frame.width,
                height: frame.height,
                luma: &frame.luma,
            })
            .collect();
        let bytes = encode_luma_frames(&views)?;
        drop(views);
        drop(frames);
        drop(scratch);
        let id = permit.request_id().clone();
        let operation = permit.retain_operation();
        let offer = tauri::async_runtime::block_on(offer_binary_for_request(
            permit,
            reservation,
            bytes,
            LUMA_FRAMES_CONTENT_TYPE,
            TransferLimits::default(),
        ))?;
        let result = CaptureStillResult {
            context: operation.context().clone(),
            binary: offer.descriptor().clone(),
        };
        SensitiveServiceFrame::binary(id, result, operation, offer)
            .map_err(CoreServiceError::into_rpc_error)
    }
}
