//! Writer tasks own the original sensitive frame and its operation permit.
use taomni_plugin_api::services::CoreServiceError;
use taomni_plugin_services::SensitiveServiceFrame;

pub(super) enum WireBytes {
    Plain(Vec<u8>),
    Sensitive(SensitiveServiceFrame),
}

impl WireBytes {
    pub(super) fn current_bytes(&self) -> Result<&[u8], CoreServiceError> {
        match self {
            Self::Plain(bytes) => Ok(bytes),
            Self::Sensitive(frame) => frame.current_bytes(),
        }
    }
}
