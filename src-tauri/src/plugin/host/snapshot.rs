//! Only the backup owner supplies grants and deadlines; these calls cannot
//! acquire data keys or reuse an ordinary operation permit.
use super::{HostProcess, HostProcessError};
use std::{
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};
use taomni_plugin_api::services::*;

impl HostProcess {
    pub fn prepare_snapshot(
        &mut self,
        request: &PrepareSnapshot,
        deadline: Instant,
        cancelled: &(dyn Fn() -> bool + Sync),
    ) -> Result<PreparedSnapshot, HostProcessError> {
        self.snapshot_identity(&request.profile_generation)?;
        let value = self.snapshot_call(SNAPSHOT_PREPARE_METHOD, request, deadline, cancelled)?;
        let result: PreparedSnapshot =
            serde_json::from_value(value).map_err(|_| HostProcessError::UnexpectedResponse)?;
        if result.job != request.job
            || result.profile_generation != request.profile_generation
            || self.instance.as_ref() != Some(&result.host_instance)
        {
            self.abort_snapshot(deadline)?;
            return Err(HostProcessError::UnexpectedResponse);
        }
        Ok(result)
    }

    pub fn snapshot(
        &mut self,
        prepared: &PreparedSnapshot,
        staging: StagingToken,
        deadline: Instant,
        cancelled: &(dyn Fn() -> bool + Sync),
    ) -> Result<SnapshotResult, HostProcessError> {
        self.snapshot_identity(&prepared.profile_generation)?;
        if self.instance.as_ref() != Some(&prepared.host_instance) {
            return Err(HostProcessError::UnexpectedResponse);
        }
        let request = SnapshotRequest {
            job: prepared.job.clone(),
            barrier: prepared.barrier.clone(),
            staging,
        };
        let result: SnapshotResult = serde_json::from_value(self.snapshot_call(
            SNAPSHOT_METHOD,
            &request,
            deadline,
            cancelled,
        )?)
        .map_err(|_| HostProcessError::UnexpectedResponse)?;
        if result.job != prepared.job
            || result.profile_generation != prepared.profile_generation
            || result.host_instance != prepared.host_instance
        {
            self.abort_snapshot(deadline)?;
            return Err(HostProcessError::UnexpectedResponse);
        }
        Ok(result)
    }

    pub fn release_snapshot(
        &mut self,
        prepared: &PreparedSnapshot,
        deadline: Instant,
    ) -> Result<(), HostProcessError> {
        self.snapshot_identity(&prepared.profile_generation)?;
        if self.instance.as_ref() != Some(&prepared.host_instance) {
            return Err(HostProcessError::UnexpectedResponse);
        }
        let request = ReleaseSnapshot {
            job: prepared.job.clone(),
            barrier: prepared.barrier.clone(),
        };
        let result = self.snapshot_call(SNAPSHOT_RELEASE_METHOD, &request, deadline, &|| false)?;
        if serde_json::from_value::<ReleaseSnapshot>(result)
            .ok()
            .as_ref()
            != Some(&request)
        {
            return Err(HostProcessError::UnexpectedResponse);
        }
        Ok(())
    }

    /// An uncertain barrier is contained, never reused by a later job. The
    /// ordinary supervisor still owns the bounded restart budget.
    pub fn abort_snapshot(&mut self, deadline: Instant) -> Result<(), HostProcessError> {
        self.schedule_restart();
        self.confirm_retired(deadline)
    }

    fn snapshot_identity(&self, generation: &ProfileGeneration) -> Result<(), HostProcessError> {
        if self.active_operation.is_some()
            || self.instance.is_none()
            || self
                .launch
                .profile
                .as_ref()
                .is_none_or(|profile| &profile.context().generation != generation)
        {
            return Err(HostProcessError::UnexpectedResponse);
        }
        Ok(())
    }

    fn snapshot_call(
        &mut self,
        method: &str,
        request: &impl serde::Serialize,
        deadline: Instant,
        cancelled: &(dyn Fn() -> bool + Sync),
    ) -> Result<serde_json::Value, HostProcessError> {
        if !self.launch.commands.iter().any(|command| command == method) {
            return Err(HostProcessError::Rpc {
                code: -32601,
                message: "PLUGIN_SNAPSHOT_UNSUPPORTED".into(),
            });
        }
        if cancelled() {
            return Err(HostProcessError::Cancelled);
        }
        if Instant::now() >= deadline {
            return Err(HostProcessError::Timeout);
        }
        let id = self.next_request_id()?;
        let _request =
            super::cancellation::RequestGuard::new(self.cancellation.clone(), id.clone());
        let handle = self.cancellation.clone();
        let stopped = AtomicBool::new(false);
        std::thread::scope(|scope| {
            let _completion = Completion(&stopped);
            let watched = id.clone();
            let done = &stopped;
            scope.spawn(move || {
                while !done.load(Ordering::Acquire) {
                    if cancelled() {
                        handle.cancel(&watched);
                        break;
                    }
                    std::thread::park_timeout(Duration::from_millis(10));
                }
            });
            self.invoke_until(
                id,
                method,
                Some(
                    serde_json::to_value(request)
                        .map_err(|_| HostProcessError::UnexpectedResponse)?,
                ),
                Some(deadline),
            )
        })
    }
}

struct Completion<'a>(&'a AtomicBool);
impl Drop for Completion<'_> {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Release);
    }
}
