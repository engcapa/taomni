use std::time::{Duration, Instant};

use taomni_plugin_api::services::{
    CoreServiceError, HostInstanceId, ProfileGeneration, RevokedKeys, VaultEpoch,
};

use crate::{AuthorizedHost, OperationAdmission};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AdmissionState {
    Open,
    Revoking,
    Locked,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Revocation {
    pub epoch: VaultEpoch,
    pub generation: ProfileGeneration,
    pub hosts: Vec<HostInstanceId>,
}

impl OperationAdmission {
    /// Core-only coordination can join a revocation started by stale-root
    /// detection. Keep the complete member set, including acknowledged hosts,
    /// so a retry never turns a prior acknowledgement into another revoke.
    pub fn begin_or_join_revoke(
        &self,
        hosts: &[AuthorizedHost],
    ) -> Result<Revocation, CoreServiceError> {
        let mut state = self.0.state.lock().expect("service admission poisoned");
        if state.mode == AdmissionState::Open {
            Self::start_revoke(&mut state, hosts, None)?;
        } else if state.mode == AdmissionState::Revoking {
            for host in hosts.iter().filter(|host| !host.termination_confirmed()) {
                if state.revocation_hosts.insert(host.instance().clone()) {
                    state
                        .pending_acknowledgements
                        .insert(host.instance().clone());
                }
            }
        } else {
            return Err(CoreServiceError::StalePluginContext);
        }
        Ok(Self::revocation(&state))
    }

    /// Core retry orchestration must not resend an already acknowledged
    /// revocation or replace an acknowledgement with a needless host kill.
    pub fn host_revoke_pending(
        &self,
        host: &AuthorizedHost,
        revocation: &Revocation,
    ) -> Result<bool, CoreServiceError> {
        let state = self.0.state.lock().expect("service admission poisoned");
        if state.mode != AdmissionState::Revoking
            || state.epoch != revocation.epoch
            || state.generation != revocation.generation
            || !revocation.hosts.contains(host.instance())
            || !state.revocation_hosts.contains(host.instance())
        {
            return Err(CoreServiceError::StalePluginContext);
        }
        Ok(state.pending_acknowledgements.contains(host.instance()))
    }

    /// Close admission and invalidate contexts before sending any host RPC.
    pub fn begin_revoke(&self, hosts: &[AuthorizedHost]) -> Result<Revocation, CoreServiceError> {
        self.begin_revoke_with_generation(hosts, None)
    }

    /// Used after the core has acquired exclusive profile ownership, before
    /// applying restore/rollback. Old profile contexts never become valid again.
    pub fn begin_profile_change(
        &self,
        generation: ProfileGeneration,
        hosts: &[AuthorizedHost],
    ) -> Result<Revocation, CoreServiceError> {
        self.begin_revoke_with_generation(hosts, Some(generation))
    }

    fn begin_revoke_with_generation(
        &self,
        hosts: &[AuthorizedHost],
        generation: Option<ProfileGeneration>,
    ) -> Result<Revocation, CoreServiceError> {
        let mut state = self.0.state.lock().expect("service admission poisoned");
        if state.mode != AdmissionState::Open {
            return Err(CoreServiceError::StalePluginContext);
        }
        Self::start_revoke(&mut state, hosts, generation)?;
        Ok(Self::revocation(&state))
    }

    fn start_revoke(
        state: &mut crate::admission::AdmissionData,
        hosts: &[AuthorizedHost],
        generation: Option<ProfileGeneration>,
    ) -> Result<(), CoreServiceError> {
        let next = state.epoch.next();
        state.mode = AdmissionState::Revoking;
        for operation in state.operations.values() {
            operation.cancelled.cancel();
        }
        state.epoch = next.map_err(|_| CoreServiceError::StalePluginContext)?;
        if let Some(generation) = generation {
            state.generation = generation;
        }
        state.pending_acknowledgements = hosts
            .iter()
            .filter(|host| !host.termination_confirmed())
            .map(|host| host.instance().clone())
            .collect();
        let active_hosts = state
            .operations
            .values()
            .filter(|operation| !operation.host.termination_confirmed())
            .map(|operation| operation.host.instance().clone())
            .collect::<Vec<_>>();
        state.pending_acknowledgements.extend(active_hosts);
        state.revocation_hosts = state.pending_acknowledgements.clone();
        Ok(())
    }

    fn revocation(state: &crate::admission::AdmissionData) -> Revocation {
        let mut instances = state.revocation_hosts.iter().cloned().collect::<Vec<_>>();
        instances.sort_by(|a, b| a.as_str().cmp(b.as_str()));
        Revocation {
            epoch: state.epoch,
            generation: state.generation.clone(),
            hosts: instances,
        }
    }

    pub fn acknowledge_revoke(
        &self,
        host: &AuthorizedHost,
        reply: &RevokedKeys,
    ) -> Result<(), CoreServiceError> {
        let mut state = self.0.state.lock().expect("service admission poisoned");
        if state.mode != AdmissionState::Revoking
            || state.epoch != reply.vault_epoch
            || state.generation != reply.profile_generation
            || host.instance() != &reply.host_instance
        {
            return Err(CoreServiceError::StalePluginContext);
        }
        if !state.pending_acknowledgements.remove(host.instance()) {
            return Err(CoreServiceError::StalePluginContext);
        }
        self.0.drained.notify_all();
        Ok(())
    }

    /// Called only by the core after process-tree termination has completed.
    /// Receiving a host's self-reported exit notification is insufficient.
    pub fn confirm_host_terminated(
        &self,
        host: &AuthorizedHost,
        revocation: &Revocation,
    ) -> Result<(), CoreServiceError> {
        let mut state = self.0.state.lock().expect("service admission poisoned");
        if state.mode != AdmissionState::Revoking
            || state.epoch != revocation.epoch
            || state.generation != revocation.generation
            || !revocation.hosts.contains(host.instance())
        {
            return Err(CoreServiceError::StalePluginContext);
        }
        // HostProcess may already have delivered the same kernel receipt.
        // Retry is valid only for this revocation, never an old epoch.
        Self::record_termination(&mut state, host);
        self.0.drained.notify_all();
        Ok(())
    }

    /// Only the kernel-verified process owner calls this, after the complete
    /// transport process tree has exited. Valid for every future epoch of this
    /// same instance, including when its operation outlives registry replacement.
    pub fn record_host_terminated(&self, host: &AuthorizedHost) {
        let mut state = self.0.state.lock().expect("service admission poisoned");
        Self::record_termination(&mut state, host);
        self.0.drained.notify_all();
    }

    fn record_termination(state: &mut crate::admission::AdmissionData, host: &AuthorizedHost) {
        host.mark_terminated();
        for operation in state.operations.values() {
            if operation.host.instance() == host.instance() {
                operation.cancelled.cancel();
            }
        }
        state.pending_acknowledgements.remove(host.instance());
    }

    pub fn wait_revoke_drained(
        &self,
        deadline: Instant,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<(), CoreServiceError> {
        let mut state = self.0.state.lock().expect("service admission poisoned");
        loop {
            if state.mode != AdmissionState::Revoking {
                return Err(CoreServiceError::StalePluginContext);
            }
            if cancelled() {
                return Err(CoreServiceError::Cancelled);
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(CoreServiceError::TimedOut);
            }
            if state.in_flight == 0 && state.pending_acknowledgements.is_empty() {
                return Ok(());
            }
            state = self
                .0
                .drained
                .wait_timeout(state, remaining.min(Duration::from_millis(10)))
                .expect("service admission poisoned")
                .0;
        }
    }

    pub fn finish_revoke(&self, revocation: &Revocation) -> Result<(), CoreServiceError> {
        let mut state = self.0.state.lock().expect("service admission poisoned");
        if state.mode != AdmissionState::Revoking
            || state.epoch != revocation.epoch
            || state.generation != revocation.generation
        {
            return Err(CoreServiceError::StalePluginContext);
        }
        if state.in_flight != 0 || !state.pending_acknowledgements.is_empty() {
            return Err(CoreServiceError::CoreServiceBusy);
        }
        state.mode = AdmissionState::Locked;
        Ok(())
    }

    /// The core verifies the master password first. Unlocking admission alone
    /// neither unlocks Vault nor authenticates the supplied password.
    pub fn after_verified_unlock(&self) -> Result<VaultEpoch, CoreServiceError> {
        let mut state = self.0.state.lock().expect("service admission poisoned");
        if state.mode != AdmissionState::Locked || state.in_flight != 0 {
            return Err(CoreServiceError::StalePluginContext);
        }
        state.epoch = state
            .epoch
            .next()
            .map_err(|_| CoreServiceError::StalePluginContext)?;
        state.mode = AdmissionState::Open;
        state.seen_operations.clear();
        Ok(state.epoch)
    }
}
