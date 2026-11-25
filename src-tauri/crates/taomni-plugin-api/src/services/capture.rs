//! Still capture is granted separately from Vault access. The core chooses the
//! invoking window and capture policy; neither is accepted from host params.
use serde::{Deserialize, Serialize};

use crate::{BinaryRef, ErrorCode, RpcError};

use super::OperationContext;

pub const CAPTURE_SCREEN_PERMISSION: &str = "capture.screen";
pub const CAPTURE_STILL_SERVICE: &str = "capture.still";
pub const CAPTURE_STILL_METHOD: &str = "core/capture.still";
pub const LUMA_FRAMES_CONTENT_TYPE: &str = "application/vnd.taomni.luma-frames";

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CaptureStillRequest {}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CaptureStillResult {
    pub context: OperationContext,
    pub binary: BinaryRef,
}

impl CaptureStillResult {
    pub fn validate(&self, expected: &OperationContext) -> Result<(), RpcError> {
        if &self.context != expected {
            return Err(super::CoreServiceError::StalePluginContext.into_rpc_error());
        }
        self.binary.validate()?;
        if self.binary.content_type != LUMA_FRAMES_CONTENT_TYPE
            || self.binary.byte_len < 17
            || self.binary.byte_len > super::MAX_CAPTURE_BYTES as u64
        {
            return Err(RpcError::from_code(ErrorCode::InvalidRequest));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::{HostInstanceId, OperationId, ProfileGeneration, VaultEpoch};

    #[test]
    fn a_host_cannot_select_a_window_display_or_capture_backend() {
        assert_eq!(
            serde_json::to_string(&CaptureStillRequest {}).unwrap(),
            "{}"
        );
        for field in ["window", "displayId", "policy", "maxBytes"] {
            assert!(
                serde_json::from_value::<CaptureStillRequest>(
                    serde_json::json!({field: "selected-by-host"})
                )
                .is_err()
            );
        }
    }

    #[test]
    fn descriptors_require_the_live_context_and_luma_content_type() {
        let id = "a1234567-1234-1234-1234-123456789abc";
        let context = OperationContext {
            host_instance: HostInstanceId::parse(id).unwrap(),
            operation: OperationId::parse(id).unwrap(),
            profile_generation: ProfileGeneration::parse(id).unwrap(),
            vault_epoch: VaultEpoch::new(1).unwrap(),
        };
        let valid = CaptureStillResult {
            context: context.clone(),
            binary: BinaryRef {
                stream_url: "ws://127.0.0.1:1234/binary/frame".into(),
                token: "one-time-capability".into(),
                content_type: LUMA_FRAMES_CONTENT_TYPE.into(),
                byte_len: 17,
                sha256: "ab".repeat(32),
            },
        };
        valid.validate(&context).unwrap();
        let mut wrong = valid.clone();
        wrong.context.vault_epoch = VaultEpoch::new(2).unwrap();
        assert!(wrong.validate(&context).is_err());
        for (field, value) in [
            ("contentType", serde_json::json!("image/png")),
            ("byteLen", serde_json::json!(0)),
            ("byteLen", serde_json::json!(u64::MAX)),
            ("streamUrl", serde_json::json!("ws://example.com/frame")),
        ] {
            let mut value_json = serde_json::to_value(&valid).unwrap();
            value_json["binary"][field] = value;
            let wrong: CaptureStillResult = serde_json::from_value(value_json).unwrap();
            assert!(wrong.validate(&context).is_err());
        }
    }
}
