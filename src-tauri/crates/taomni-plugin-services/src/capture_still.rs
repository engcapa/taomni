//! A signed permission alone cannot hide an arbitrary application window.
//! Trusted core code attaches a source to one admitted operation; the source
//! owns its native target and must check the permit around blocking capture.
use std::sync::Arc;

use taomni_plugin_api::{RpcError, services::CoreServiceError};

use crate::{OperationPermit, ReverseRequestPermit, SensitiveServiceFrame};

pub trait StillCaptureService: Send + Sync + 'static {
    fn capture(&self, permit: ReverseRequestPermit) -> Result<SensitiveServiceFrame, RpcError>;
}

impl OperationPermit {
    /// Core-only authority, never deserialized from a host/renderer request.
    /// A window-bound source cannot be swapped after its operation starts.
    pub fn grant_still_capture(
        &mut self,
        source: Arc<dyn StillCaptureService>,
    ) -> Result<(), CoreServiceError> {
        self.check_current()?;
        self.record.host.authorize_screen_capture()?;
        let mut slot = self
            .record
            .capture_source
            .lock()
            .expect("capture grant poisoned");
        if slot.is_some() {
            return Err(CoreServiceError::PermissionDenied);
        }
        *slot = Some(source);
        Ok(())
    }
}

pub(crate) fn capture(permit: ReverseRequestPermit) -> Result<SensitiveServiceFrame, RpcError> {
    permit
        .check_current()
        .and_then(|()| permit.operation().host().authorize_screen_capture())
        .map_err(CoreServiceError::into_rpc_error)?;
    let source = permit
        .operation()
        .0
        .capture_source
        .lock()
        .expect("capture grant poisoned")
        .clone()
        .ok_or_else(|| CoreServiceError::PermissionDenied.into_rpc_error())?;
    source.capture(permit)
}
