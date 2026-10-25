//! Journal transitions shared by local snapshots and remote transfers.
use super::{
    failure,
    model::{BackupJob, now_ms},
};

pub(crate) fn request_cancel(job: &mut BackupJob, active: bool) -> bool {
    if ["completed", "failed", "cancelled", "discarded"].contains(&job.phase.as_str()) {
        return false;
    }
    job.cancel_requested = true;
    // A worker can finish into retry_wait just before leaving its registry.
    job.phase = if active && job.phase != "retry_wait" {
        "cancelling"
    } else {
        "cancelled"
    }
    .into();
    job.next_retry_at = None;
    job.updated_at = now_ms();
    job.revision += 1;
    true
}

pub(crate) fn finish(job: &mut BackupJob, result: Result<(), String>, cancelled: bool) {
    job.revision += 1;
    job.updated_at = now_ms();
    job.next_retry_at = None;
    job.failure_kind = None;
    match result {
        // A committed artifact/receipt wins a cancellation arriving after commit.
        Ok(()) => {
            job.phase = "completed".into();
            job.error = None;
        }
        Err(_) if cancelled => {
            job.phase = "cancelled".into();
            job.cancel_requested = true;
            job.error = None;
        }
        Err(error) => {
            let kind = failure::classify(&error);
            job.phase = "failed".into();
            job.error = Some(error);
            job.failure_kind = Some(kind);
            // Local export passwords are intentionally not retained for retries.
            if job.operation != "local" {
                job.next_retry_at = failure::next_retry(kind, job.attempts, job.updated_at);
                if job.next_retry_at.is_some() {
                    job.phase = "retry_wait".into();
                }
            }
        }
    }
}

pub(crate) fn recover(job: &mut BackupJob) -> bool {
    if job.cancel_requested
        && !["completed", "discarded", "cancelled"].contains(&job.phase.as_str())
    {
        job.phase = "cancelled".into();
        job.next_retry_at = None;
        job.error = None;
    } else if ![
        "completed",
        "failed",
        "cancelled",
        "interrupted",
        "retry_wait",
        "discarded",
    ]
    .contains(&job.phase.as_str())
    {
        job.phase = "interrupted".into();
        job.error =
            Some("Application stopped; start a new local backup or retry this transfer".into());
    } else {
        return false;
    }
    job.updated_at = now_ms();
    job.revision += 1;
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    fn job() -> BackupJob {
        serde_json::from_value(serde_json::json!({"id":"legacy", "revision":1,"targetId":"t", "operation":"upload", "phase":"preparing", "bytes":0,"total":null,"error":null,"artifact":null,"remote":null,"receipt":null,"createdAt":0})).unwrap()
    }
    #[test]
    fn legacy_journals_recover_and_persisted_cancellation_never_replays() {
        let mut old = job();
        assert!(!old.cancel_requested);
        assert!(old.local_path.is_none());
        assert!(recover(&mut old));
        assert_eq!(old.phase, "interrupted");
        old.phase = "cancelling".into();
        old.cancel_requested = true;
        old.next_retry_at = Some(1);
        let mut reloaded: BackupJob =
            serde_json::from_slice(&serde_json::to_vec(&old).unwrap()).unwrap();
        assert!(recover(&mut reloaded));
        assert_eq!(reloaded.phase, "cancelled");
        assert!(reloaded.next_retry_at.is_none());
        assert!(!recover(&mut reloaded));
    }
    #[test]
    fn cancellation_does_not_retry_and_committed_results_stay_completed() {
        let mut state = job();
        finish(&mut state, Err("disk read cancelled".into()), true);
        assert_eq!(state.phase, "cancelled");
        assert!(state.cancel_requested && state.next_retry_at.is_none());
        finish(&mut state, Ok(()), true);
        assert_eq!(state.phase, "completed");
        assert!(!recover(&mut state));
    }
    #[test]
    fn local_failures_do_not_schedule_a_cloud_retry() {
        let mut state = job();
        state.operation = "local".into();
        finish(
            &mut state,
            Err("HTTP 503 temporarily unavailable".into()),
            false,
        );
        assert_eq!(state.phase, "failed");
        assert!(state.next_retry_at.is_none());
    }

    #[test]
    fn cancelling_a_just_finished_retry_wait_is_terminal_without_another_worker() {
        let mut state = job();
        state.phase = "retry_wait".into();
        state.next_retry_at = Some(100);
        assert!(request_cancel(&mut state, true));
        assert_eq!(state.phase, "cancelled");
        assert!(state.next_retry_at.is_none());
        state.phase = "completed".into();
        assert!(!request_cancel(&mut state, true));
        assert_eq!(state.phase, "completed");
    }
}
