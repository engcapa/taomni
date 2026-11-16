//! In-process protected work shares the host admission/drain barrier without
//! inventing a plugin identity or making its permit usable by reverse RPC.
use std::{
    sync::atomic::{AtomicBool, Ordering},
    time::Instant,
};
use taomni_plugin_api::services::{CoreServiceError, OperationId, ProfileGeneration, VaultEpoch};
use taomni_profile_locks::VaultOperationLease;

use crate::{AdmissionState, OperationAdmission, OperationKind};

pub struct CoreOperationPermit {
    owner: OperationAdmission,
    generation: ProfileGeneration,
    epoch: VaultEpoch,
    kind: OperationKind,
    deadline: Instant,
    cancelled: AtomicBool,
    lease: VaultOperationLease,
}

impl OperationAdmission {
    /// The caller acquires the lease before any business/Vault/host mutex.
    /// A core permit has no HostInstance or wire context and cannot authorize
    /// a plugin fixed-key/export request.
    pub fn admit_core_until(
        &self,
        operation: OperationId,
        kind: OperationKind,
        lease: VaultOperationLease,
        deadline: Instant,
    ) -> Result<CoreOperationPermit, CoreServiceError> {
        if deadline <= Instant::now() {
            return Err(CoreServiceError::TimedOut);
        }
        if kind.requires_exclusive_lease() && !lease.is_exclusive() {
            return Err(CoreServiceError::PermissionDenied);
        }
        let mut state = self.0.state.lock().expect("service admission poisoned");
        if state.mode != AdmissionState::Open {
            return Err(CoreServiceError::VaultLocked);
        }
        if state.seen_operations.contains(&operation) {
            return Err(CoreServiceError::DuplicateRequest);
        }
        if state.in_flight >= state.max_in_flight || state.seen_operations.len() >= 65_536 {
            return Err(CoreServiceError::CoreServiceBusy);
        }
        state.in_flight += 1;
        state.seen_operations.insert(operation);
        Ok(CoreOperationPermit {
            owner: self.clone(),
            generation: state.generation.clone(),
            epoch: state.epoch,
            kind,
            deadline,
            cancelled: AtomicBool::new(false),
            lease,
        })
    }
}

impl CoreOperationPermit {
    pub fn lease(&self) -> &VaultOperationLease {
        &self.lease
    }
    pub fn kind(&self) -> OperationKind {
        self.kind
    }
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
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
            || state.mode != AdmissionState::Open
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
        self.owner.0.drained.notify_all();
    }
}

#[cfg(test)]
#[path = "core_operation_tests.rs"]
mod tests;
