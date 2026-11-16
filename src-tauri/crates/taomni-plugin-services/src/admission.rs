use std::{
    collections::{HashMap, HashSet},
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};

use std::time::Instant;
use taomni_plugin_api::services::{
    CoreServiceError, HostInstanceId, OperationContext, OperationId, ProfileGeneration, VaultEpoch,
};
use taomni_profile_locks::VaultOperationLease;

use crate::{
    AdmissionState, AuthorizedHost, BorrowedOperation, OperationKind, operation::ActiveOperation,
};

pub(crate) struct AdmissionData {
    pub mode: AdmissionState,
    pub epoch: VaultEpoch,
    pub generation: ProfileGeneration,
    pub operations: HashMap<OperationId, Arc<ActiveOperation>>,
    pub in_flight: usize,
    pub paused: bool,
    pub pending_acknowledgements: HashSet<HostInstanceId>,
    pub revocation_hosts: HashSet<HostInstanceId>,
    pub max_in_flight: usize,
    pub seen_operations: HashSet<OperationId>,
}

pub(crate) struct AdmissionInner {
    pub state: Mutex<AdmissionData>,
    pub drained: Condvar,
}

#[derive(Clone)]
pub struct OperationAdmission(pub(crate) Arc<AdmissionInner>);

impl OperationAdmission {
    pub fn new(generation: ProfileGeneration, epoch: VaultEpoch, locked: bool) -> Self {
        Self(Arc::new(AdmissionInner {
            state: Mutex::new(AdmissionData {
                mode: if locked {
                    AdmissionState::Locked
                } else {
                    AdmissionState::Open
                },
                epoch,
                generation,
                operations: HashMap::new(),
                in_flight: 0,
                paused: false,
                pending_acknowledgements: HashSet::new(),
                revocation_hosts: HashSet::new(),
                max_in_flight: 128,
                seen_operations: HashSet::new(),
            }),
            drained: Condvar::new(),
        }))
    }

    /// The caller acquires its cross-process lease before registration, and
    /// must not hold a Vault/DB/host mutex while waiting for that lease.
    pub fn admit(
        &self,
        host: &AuthorizedHost,
        operation: OperationId,
        kind: OperationKind,
        lease: VaultOperationLease,
    ) -> Result<OperationPermit, CoreServiceError> {
        self.admit_inner(host, operation, kind, lease, None)
    }

    /// Production RPC operations have a core-owned deadline; a host cannot
    /// extend it by submitting another reverse request or retrying a busy one.
    pub fn admit_until(
        &self,
        host: &AuthorizedHost,
        operation: OperationId,
        kind: OperationKind,
        lease: VaultOperationLease,
        deadline: Instant,
    ) -> Result<OperationPermit, CoreServiceError> {
        self.admit_inner(host, operation, kind, lease, Some(deadline))
    }

    fn admit_inner(
        &self,
        host: &AuthorizedHost,
        operation: OperationId,
        kind: OperationKind,
        lease: VaultOperationLease,
        deadline: Option<Instant>,
    ) -> Result<OperationPermit, CoreServiceError> {
        if deadline.is_some_and(|deadline| deadline <= Instant::now()) {
            return Err(CoreServiceError::TimedOut);
        }
        if kind.requires_exclusive_lease() && !lease.is_exclusive() {
            return Err(CoreServiceError::PermissionDenied);
        }
        let mut state = self.0.state.lock().expect("service admission poisoned");
        // Serialized with record_host_terminated: a transport cannot be
        // registered after its kernel-verified termination was recorded.
        if host.termination_confirmed() {
            return Err(CoreServiceError::StalePluginContext);
        }
        if state.mode != AdmissionState::Open {
            return Err(CoreServiceError::VaultLocked);
        }
        if state.paused {
            return Err(CoreServiceError::CoreServiceBusy);
        }
        if state.seen_operations.contains(&operation) {
            return Err(CoreServiceError::DuplicateRequest);
        }
        if state.in_flight >= state.max_in_flight || state.seen_operations.len() >= 65_536 {
            return Err(CoreServiceError::CoreServiceBusy);
        }
        let context = OperationContext {
            host_instance: host.instance().clone(),
            operation: operation.clone(),
            profile_generation: state.generation.clone(),
            vault_epoch: state.epoch,
        };
        let record = Arc::new(ActiveOperation {
            context,
            host: host.clone(),
            kind,
            deadline,
            cancelled: AtomicBool::new(false),
            outer_active: AtomicBool::new(true),
            owner: Arc::downgrade(&self.0),
            _lease: lease,
            service_requests: Mutex::new(Default::default()),
            grants: Mutex::new(Default::default()),
        });
        state.in_flight += 1;
        state.seen_operations.insert(operation.clone());
        state.operations.insert(operation, record.clone());
        Ok(OperationPermit {
            owner: self.clone(),
            record,
        })
    }

    pub fn borrow_operation(
        &self,
        authenticated_host: &AuthorizedHost,
        context: &OperationContext,
    ) -> Result<BorrowedOperation, CoreServiceError> {
        let state = self.0.state.lock().expect("service admission poisoned");
        if state.mode != AdmissionState::Open
            || state.epoch != context.vault_epoch
            || state.generation != context.profile_generation
            || authenticated_host.instance() != &context.host_instance
            || authenticated_host.termination_confirmed()
        {
            return Err(CoreServiceError::StalePluginContext);
        }
        let record = state
            .operations
            .get(&context.operation)
            .ok_or(CoreServiceError::StalePluginContext)?;
        if record.context != *context
            || record.host.termination_confirmed()
            || record.host.slug() != authenticated_host.slug()
            || record.cancelled.load(Ordering::Acquire)
            || !record.outer_active.load(Ordering::Acquire)
        {
            return Err(CoreServiceError::StalePluginContext);
        }
        Ok(BorrowedOperation(record.clone()))
    }

    pub fn state(&self) -> AdmissionState {
        self.0
            .state
            .lock()
            .expect("service admission poisoned")
            .mode
    }

    /// Invalidates a replaced/stopped transport without reopening admission or
    /// acknowledging Vault revocation. Actual process termination is separate.
    pub fn cancel_host(&self, host: &AuthorizedHost) {
        let state = self.0.state.lock().expect("service admission poisoned");
        for operation in state.operations.values() {
            if operation.host.instance() == host.instance() {
                operation.cancelled.store(true, Ordering::Release);
            }
        }
    }
}

pub struct OperationPermit {
    owner: OperationAdmission,
    pub(crate) record: Arc<ActiveOperation>,
}

impl OperationPermit {
    pub fn deadline(&self) -> Option<Instant> {
        self.record.deadline
    }
    pub fn context(&self) -> &OperationContext {
        &self.record.context
    }

    pub fn cancel(&self) {
        self.record.cancelled.store(true, Ordering::Release);
    }

    /// Also check before forwarding the host's final result to renderer. A
    /// successful response produced before revoke may arrive after it began.
    pub fn check_current(&self) -> Result<(), CoreServiceError> {
        BorrowedOperation(self.record.clone()).check_current()
    }

    pub fn kind(&self) -> OperationKind {
        self.record.kind
    }
}

impl Drop for OperationPermit {
    fn drop(&mut self) {
        self.record.outer_active.store(false, Ordering::Release);
        let removed = self
            .owner
            .0
            .state
            .lock()
            .expect("service admission poisoned")
            .operations
            .remove(&self.record.context.operation);
        // Drop outside the mutex: ActiveOperation::drop also locks admission.
        drop(removed);
    }
}
