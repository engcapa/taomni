//! In-process protected work shares the host admission/drain barrier without
//! inventing a plugin identity or making its permit usable by reverse RPC.
use std::{
    sync::atomic::{AtomicBool, Ordering},
    time::Instant,
};
use taomni_plugin_api::services::{CoreServiceError, OperationId, ProfileGeneration, VaultEpoch};
use taomni_profile_locks::VaultOperationLease;

use crate::{AdmissionState, OperationAdmission, OperationKind, Revocation};

pub struct CoreOperationPermit {
    owner: OperationAdmission,
    operation: OperationId,
    generation: ProfileGeneration,
    epoch: VaultEpoch,
    kind: OperationKind,
    mode: AdmissionState,
    deadline: Instant,
    cancelled: AtomicBool,
    reset_grant_used: AtomicBool,
    lease: Option<VaultOperationLease>,
}

impl OperationAdmission {
    /// The caller acquires the lease before any business/Vault/host mutex.
    /// A core permit has no HostInstance or wire context and cannot authorize
    /// a plugin fixed-key/export request. Its core-generated ID is reserved
    /// only while the permit lives; completed local work consumes no space in
    /// the host's epoch-long replay ledger.
    pub fn admit_core_until(
        &self,
        operation: OperationId,
        kind: OperationKind,
        lease: VaultOperationLease,
        deadline: Instant,
    ) -> Result<CoreOperationPermit, CoreServiceError> {
        self.admit_core_inner(operation, kind, lease, deadline, None)
    }

    /// Explicit reset runs with ordinary admission closed, after every old
    /// operation/host has drained, and retains exclusive OS ownership.
    pub fn admit_core_reset_after_drain(
        &self,
        operation: OperationId,
        revocation: &Revocation,
        lease: VaultOperationLease,
        deadline: Instant,
    ) -> Result<CoreOperationPermit, CoreServiceError> {
        self.admit_core_inner(
            operation,
            OperationKind::ResetStore,
            lease,
            deadline,
            Some(revocation),
        )
    }

    fn admit_core_inner(
        &self,
        operation: OperationId,
        kind: OperationKind,
        lease: VaultOperationLease,
        deadline: Instant,
        revocation: Option<&Revocation>,
    ) -> Result<CoreOperationPermit, CoreServiceError> {
        if deadline <= Instant::now() {
            return Err(CoreServiceError::TimedOut);
        }
        if kind.requires_exclusive_lease() && !lease.is_exclusive() {
            return Err(CoreServiceError::PermissionDenied);
        }
        if kind == OperationKind::ResetStore && revocation.is_none() {
            return Err(CoreServiceError::PermissionDenied);
        }
        let mut state = self.0.state.lock().expect("service admission poisoned");
        if let Some(revocation) = revocation {
            if state.mode != AdmissionState::Revoking
                || state.epoch != revocation.epoch
                || state.generation != revocation.generation
            {
                return Err(CoreServiceError::StalePluginContext);
            }
            if state.in_flight != 0 || !state.pending_acknowledgements.is_empty() {
                return Err(CoreServiceError::CoreServiceBusy);
            }
        } else if state.mode != AdmissionState::Open {
            return Err(CoreServiceError::VaultLocked);
        }
        if state.paused {
            return Err(CoreServiceError::CoreServiceBusy);
        }
        if crate::issued_operations::is_core_issued(&operation)
            || state.seen_operations.contains(&operation)
            || state.active_core_operations.contains(&operation)
        {
            return Err(CoreServiceError::DuplicateRequest);
        }
        if state.in_flight >= state.max_in_flight {
            return Err(CoreServiceError::CoreServiceBusy);
        }
        state.in_flight += 1;
        state.active_core_operations.insert(operation.clone());
        Ok(CoreOperationPermit {
            owner: self.clone(),
            operation,
            generation: state.generation.clone(),
            epoch: state.epoch,
            kind,
            mode: state.mode,
            deadline,
            cancelled: AtomicBool::new(false),
            reset_grant_used: AtomicBool::new(false),
            lease: Some(lease),
        })
    }
}

impl CoreOperationPermit {
    pub fn lease(&self) -> &VaultOperationLease {
        self.lease
            .as_ref()
            .expect("live permit owns its operation lease")
    }

    /// Release admission while the coordinator retains OS ownership through
    /// validation and reopening. Consuming self makes further use impossible.
    pub fn release_admission(mut self) -> VaultOperationLease {
        self.lease
            .take()
            .expect("live permit owns its operation lease")
    }
    pub fn kind(&self) -> OperationKind {
        self.kind
    }
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
    }

    /// One explicit repair may follow the coordinator's drained reset. An
    /// ordinary exclusive operation cannot mint or reuse this authorization.
    pub fn consume_reset_grant(&self) -> Result<(), CoreServiceError> {
        self.check_current()?;
        if self.kind != OperationKind::ResetStore || self.mode != AdmissionState::Revoking {
            return Err(CoreServiceError::PermissionDenied);
        }
        if self.reset_grant_used.swap(true, Ordering::AcqRel) {
            return Err(CoreServiceError::PermissionDenied);
        }
        Ok(())
    }

    pub fn check_current(&self) -> Result<(), CoreServiceError> {
        if Instant::now() >= self.deadline {
            return Err(CoreServiceError::TimedOut);
        }
        let state = self
            .owner
            .0
            .state
            .lock()
            .expect("service admission poisoned");
        if self.cancelled.load(Ordering::Acquire)
            || state.mode != self.mode
            || state.epoch != self.epoch
            || state.generation != self.generation
        {
            return Err(CoreServiceError::StalePluginContext);
        }
        Ok(())
    }
}

impl Drop for CoreOperationPermit {
    fn drop(&mut self) {
        let mut state = self
            .owner
            .0
            .state
            .lock()
            .expect("service admission poisoned");
        state.in_flight -= 1;
        state.active_core_operations.remove(&self.operation);
        self.owner.0.drained.notify_all();
    }
}

#[cfg(test)]
#[path = "core_operation_tests.rs"]
mod tests;
