use std::{
    sync::atomic::Ordering,
    time::{Duration, Instant},
};

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
        let next = state.epoch.next();
        state.mode = AdmissionState::Revoking;
        for operation in state.operations.values() {
            operation.cancelled.store(true, Ordering::Release);
        }
        state.epoch = next.map_err(|_| CoreServiceError::StalePluginContext)?;
        if let Some(generation) = generation {
            state.generation = generation;
        }
        state.pending_acknowledgements = hosts.iter().map(|host| host.instance().clone()).collect();
        let active_hosts = state
            .operations
            .values()
            .map(|operation| operation.host.instance().clone())
            .collect::<Vec<_>>();
        state.pending_acknowledgements.extend(active_hosts);
        let mut instances = state
            .pending_acknowledgements
            .iter()
            .cloned()
            .collect::<Vec<_>>();
        instances.sort_by(|a, b| a.as_str().cmp(b.as_str()));
        Ok(Revocation {
            epoch: state.epoch,
            generation: state.generation.clone(),
            hosts: instances,
        })
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
        self.acknowledge_revoke(
            host,
            &RevokedKeys {
                host_instance: host.instance().clone(),
                profile_generation: revocation.generation.clone(),
                vault_epoch: revocation.epoch,
            },
        )
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
