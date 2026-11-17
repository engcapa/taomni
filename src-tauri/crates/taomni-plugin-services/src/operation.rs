use std::sync::{
    Arc, Mutex, Weak,
    atomic::{AtomicBool, Ordering},
};
use std::time::Instant;

use taomni_plugin_api::services::{CoreServiceError, OperationContext};
use taomni_profile_locks::VaultOperationLease;
use tokio_util::sync::CancellationToken;

use crate::{AuthorizedHost, admission::AdmissionInner};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OperationKind {
    ReadData,
    WriteData,
    InitializeEmptyStore,
    ResetStore,
    ExportSecret,
}

impl OperationKind {
    pub fn requires_exclusive_lease(self) -> bool {
        matches!(self, Self::InitializeEmptyStore | Self::ResetStore)
    }
}

pub(crate) struct ActiveOperation {
    pub context: OperationContext,
    pub host: AuthorizedHost,
    pub kind: OperationKind,
    pub deadline: Option<Instant>,
    pub cancelled: CancellationToken,
    pub outer_active: AtomicBool,
    pub owner: Weak<AdmissionInner>,
    pub _lease: VaultOperationLease,
    pub service_requests: Mutex<crate::service_request::RequestLedger>,
    pub grants: Mutex<crate::grants::OperationGrants>,
    pub capture_source: Mutex<Option<Arc<dyn crate::StillCaptureService>>>,
}

impl Drop for ActiveOperation {
    fn drop(&mut self) {
        if let Some(owner) = self.owner.upgrade() {
            let mut state = owner.state.lock().expect("service admission poisoned");
            state.in_flight -= 1;
            owner.drained.notify_all();
        }
    }
}

/// Reverse RPC borrows the outer admitted operation, including its existing
/// OS lease. It never tries to acquire a second read lock behind a waiting
/// snapshot/rekey writer. Holding this value also delays revocation completion.
pub struct BorrowedOperation(pub(crate) Arc<ActiveOperation>);

impl BorrowedOperation {
    pub fn context(&self) -> &OperationContext {
        &self.0.context
    }
    pub fn host(&self) -> &AuthorizedHost {
        &self.0.host
    }
    pub fn kind(&self) -> OperationKind {
        self.0.kind
    }

    pub fn deadline(&self) -> Option<Instant> {
        self.0.deadline
    }

    /// Children observe operation cancellation/retirement/revocation without
    /// polling. Cancelling a child never cancels its operation or siblings.
    pub fn cancellation_token(&self) -> CancellationToken {
        self.0.cancelled.child_token()
    }

    pub fn check_current(&self) -> Result<(), CoreServiceError> {
        if self
            .0
            .deadline
            .is_some_and(|deadline| Instant::now() >= deadline)
        {
            return Err(CoreServiceError::TimedOut);
        }
        if self.0.cancelled.is_cancelled() || !self.0.outer_active.load(Ordering::Acquire) {
            return Err(CoreServiceError::StalePluginContext);
        }
        let owner = self
            .0
            .owner
            .upgrade()
            .ok_or(CoreServiceError::StalePluginContext)?;
        let state = owner.state.lock().expect("service admission poisoned");
        if state.epoch != self.0.context.vault_epoch
            || state.generation != self.0.context.profile_generation
            || state.mode != crate::AdmissionState::Open
            || self.0.host.termination_confirmed()
            || self.0.cancelled.is_cancelled()
            || !self.0.outer_active.load(Ordering::Acquire)
        {
            return Err(CoreServiceError::StalePluginContext);
        }
        Ok(())
    }
}
