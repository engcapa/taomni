//! A snapshot pauses new work and lets admitted work finish. Unlike a Vault
//! lock/rekey it neither revokes keys nor invalidates the current epoch.
use crate::{AdmissionState, AuthorizedHost, OperationAdmission, OperationPermit};
use std::time::{Duration, Instant};
use taomni_plugin_api::services::CoreServiceError;
use taomni_profile_locks::VaultOperationLease;

pub struct AdmissionPause {
    owner: OperationAdmission,
    mode: AdmissionState,
}

impl OperationAdmission {
    pub fn is_paused(&self) -> bool {
        self.0
            .state
            .lock()
            .expect("service admission poisoned")
            .paused
    }

    /// Call without any OS lease or store/host mutex. New admissions also
    /// check paused under the same mutex, closing the wait/acquire race.
    pub fn wait_while_paused(
        &self,
        deadline: Instant,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<(), CoreServiceError> {
        let mut state = self.0.state.lock().expect("service admission poisoned");
        loop {
            let remaining = remaining(deadline, cancelled)?;
            if !state.paused {
                return Ok(());
            }
            state = self
                .0
                .drained
                .wait_timeout(state, remaining)
                .expect("service admission poisoned")
                .0;
        }
    }

    pub fn pause_and_drain(
        &self,
        deadline: Instant,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<AdmissionPause, CoreServiceError> {
        remaining(deadline, cancelled)?;
        let mut state = self.0.state.lock().expect("service admission poisoned");
        if state.paused || state.mode == AdmissionState::Revoking {
            return Err(CoreServiceError::CoreServiceBusy);
        }
        state.paused = true;
        let mode = state.mode;
        drop(state);
        let pause = AdmissionPause {
            owner: self.clone(),
            mode,
        };
        pause.wait_drained(deadline, cancelled)?;
        Ok(pause)
    }
}

impl AdmissionPause {
    /// A confirmed MFA reset is the sole operation permitted during its own
    /// drained pause. Retain this guard until the reset and its result finish.
    pub fn admit_mfa_reset(
        &mut self,
        host: &AuthorizedHost,
        lease: VaultOperationLease,
        deadline: Instant,
    ) -> Result<OperationPermit, CoreServiceError> {
        if self.mode != AdmissionState::Open {
            return Err(CoreServiceError::VaultLocked);
        }
        self.owner.admit_paused_mfa_reset(host, lease, deadline)
    }

    fn wait_drained(
        &self,
        deadline: Instant,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<(), CoreServiceError> {
        let mut state = self
            .owner
            .0
            .state
            .lock()
            .expect("service admission poisoned");
        loop {
            let remaining = remaining(deadline, cancelled)?;
            if state.mode != self.mode {
                return Err(CoreServiceError::StalePluginContext);
            }
            if state.in_flight == 0 {
                return Ok(());
            }
            state = self
                .owner
                .0
                .drained
                .wait_timeout(state, remaining)
                .expect("service admission poisoned")
                .0;
        }
    }
}

impl Drop for AdmissionPause {
    fn drop(&mut self) {
        self.owner
            .0
            .state
            .lock()
            .expect("service admission poisoned")
            .paused = false;
        self.owner.0.drained.notify_all();
    }
}

fn remaining(
    deadline: Instant,
    cancelled: &dyn Fn() -> bool,
) -> Result<Duration, CoreServiceError> {
    if cancelled() {
        return Err(CoreServiceError::Cancelled);
    }
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return Err(CoreServiceError::TimedOut);
    }
    Ok(remaining.min(Duration::from_millis(10)))
}
