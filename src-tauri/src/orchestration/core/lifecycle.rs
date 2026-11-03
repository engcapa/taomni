//! Atomic admission, cancellation and terminal publication under the runtime owner lock.
use super::{
    model::*,
    service::{Inner, assert_revision},
};
use tokio_util::sync::CancellationToken;

#[derive(Debug)]
pub struct RunLease {
    pub run: AgentRun,
    pub resource: AgentResource,
    pub attempt: String,
    pub request: String,
    pub cancel: CancellationToken,
}

impl Inner {
    pub fn reserve(&mut self, id: &str, revision: u64, recovery: bool) -> Result<RunLease, String> {
        if self.closing {
            return Err("APPLICATION_CLOSING: new executions are disabled".into());
        }
        let run = self.store.get(id)?;
        assert_revision(&run, revision)?;
        if recovery {
            if run.status != "partial"
                || run.recovery_count != 0
                || run.intent == AgentIntent::Develop
            {
                return Err(
                    "RECOVERY_UNAVAILABLE: only one explicit document recovery is allowed".into(),
                );
            }
        } else if !matches!(run.status.as_str(), "planned" | "blocked") {
            return Err("RUN_NOT_STARTABLE".into());
        }
        let resource = run.settings_snapshot.resource(&run.intent)?;
        self.check_resource_enabled(&resource)?;
        let (attempt, request) =
            self.store
                .claim(id, &self.owner, recovery, self.settings()?.concurrency)?;
        let updated = self.mutate(
            id,
            "execution_reserved",
            "Execution reserved using the task's immutable shared settings snapshot",
            |r| {
                r.status = "preparing".into();
                r.error = None;
                if recovery {
                    r.recovery_count += 1;
                }
                Ok(())
            },
        );
        let run = match updated {
            Ok(run) => run,
            Err(error) => {
                self.store.finish_attempt(&attempt, &request, "failed")?;
                return Err(error);
            }
        };
        let cancel = CancellationToken::new();
        self.active.insert(id.into(), cancel.clone());
        Ok(RunLease {
            run,
            resource,
            attempt,
            request,
            cancel,
        })
    }

    pub fn check_resource_enabled(&self, resource: &AgentResource) -> Result<(), String> {
        // Configuration edits do not change a queued task's snapshot. Deletion is
        // nevertheless a revocation and must prevent the old snapshot dispatch.
        if !self
            .settings()?
            .resources
            .iter()
            .any(|r| r.id == resource.id)
        {
            return Err(
                "RESOURCE_REVOKED: the task's resource was removed from shared settings".into(),
            );
        }
        Ok(())
    }

    pub fn begin(&mut self, id: &str) -> Result<(), String> {
        self.mutate(
            id,
            "executing",
            "Execution started independently from the frontend lifecycle",
            |r| {
                if r.status != "preparing" {
                    return Err("CANCELLED".into());
                }
                r.status = "running".into();
                Ok(())
            },
        )
        .map(|_| ())
    }

    pub fn request_cancel(&mut self, id: &str) -> Result<AgentRun, String> {
        let run = self.store.get(id)?;
        if matches!(run.status.as_str(), "cancelled" | "stopping") {
            return Ok(run);
        }
        if !matches!(
            run.status.as_str(),
            "planned" | "blocked" | "preparing" | "running"
        ) {
            return Err("RUN_NOT_CANCELLABLE: completed or unknown executions cannot be cleared by cancellation".into());
        }
        let active = self.active.get(id).cloned();
        if matches!(run.status.as_str(), "preparing" | "running") && active.is_none() {
            return Err(
                "EXECUTION_OWNER_UNKNOWN: cancellation cannot prove the process stopped".into(),
            );
        }
        let result = self.mutate(
            id,
            "cancel_requested",
            "Explicit cancellation requested; waiting for execution cleanup",
            |r| {
                r.status = if active.is_some() {
                    "stopping"
                } else {
                    "cancelled"
                }
                .into();
                Ok(())
            },
        )?;
        if let Some(token) = active {
            token.cancel();
        }
        Ok(result)
    }

    pub fn finish(&mut self, lease: &RunLease, result: &Result<(), String>) -> Result<(), String> {
        let error = result.as_ref().err().cloned();
        let unknown = error
            .as_ref()
            .is_some_and(|e| e.contains("STOP_UNKNOWN") || e.contains("JOB_UNKNOWN"));
        let current = self.store.get(&lease.run.id)?;
        let cancelled = current.status == "stopping" || error.as_deref() == Some("CANCELLED");
        let attempt_status = if unknown {
            "unknown"
        } else if cancelled {
            "cancelled"
        } else if result.is_ok() {
            "completed"
        } else {
            "failed"
        };
        let mut run = current;
        let revision = run.revision;
        run.revision = run.revision.checked_add(1).ok_or("REVISION_OVERFLOW")?;
        run.error = error;
        run.status = if unknown {
            "interrupted"
        } else if cancelled {
            "cancelled"
        } else if result.is_ok() {
            "candidate"
        } else if !run.artifacts.is_empty() {
            "partial"
        } else {
            "failed"
        }
        .into();
        run.events.push(AgentEvent {
            sequence: run.events.last().map_or(1, |e| e.sequence + 1),
            kind: "execution_finished".into(),
            message:
                "Execution ended; candidates remain unaccepted and are never automatically merged"
                    .into(),
            created_at: now(),
        });
        // Release capacity only in the same commit that publishes the outcome.
        self.store.complete(
            &run,
            revision,
            &lease.attempt,
            &lease.request,
            attempt_status,
        )?;
        if !unknown {
            self.active.remove(&lease.run.id);
        }
        Ok(())
    }
}
