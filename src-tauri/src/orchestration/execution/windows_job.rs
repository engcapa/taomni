//! Windows worker ownership independent of the leader's PID/lifetime.
//! Attach immediately after spawn, before writing stdin or awaiting the child.
//! Any attach failure means ownership is unknown, not that cleanup succeeded.
//! Post-spawn attachment cannot capture descendants created before assignment;
//! creation-time containment would require suspended/attribute-list spawning.

use std::mem::size_of;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::time::Duration;

use tokio::process::Child;
use windows::Win32::Foundation::HANDLE;
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, IsProcessInJob, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JobObjectBasicAccountingInformation, JobObjectExtendedLimitInformation,
    QueryInformationJobObject, SetInformationJobObject, TerminateJobObject,
};
use windows::core::{BOOL, PCWSTR};

const TERMINATION_TIMEOUT: Duration = Duration::from_secs(10);
const QUERY_INTERVAL: Duration = Duration::from_millis(25);

/// OwnedHandle closes the final non-inheritable job handle on every exit path.
/// JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE then terminates any remaining members.
/// Explicit terminate_and_wait is still required to establish verified cleanup.
pub(super) struct Job {
    handle: OwnedHandle,
}

pub(super) fn attach(child: &Child) -> Result<Job, String> {
    let process = child
        .raw_handle()
        .ok_or("WORKER_JOB_UNKNOWN: child handle unavailable")?;
    // SAFETY: no security attributes means a non-inheritable handle; a null
    // name creates a new unnamed job rather than opening somebody else's job.
    let handle = unsafe { CreateJobObjectW(None, PCWSTR::null()) }
        .map_err(|_| "WORKER_JOB_UNKNOWN: could not create worker job")?;
    // SAFETY: CreateJobObjectW returned a new owned, valid kernel handle. Move
    // ownership immediately so configuration/assignment failures also close it.
    let job = Job {
        handle: unsafe { OwnedHandle::from_raw_handle(handle.0) },
    };
    let limits = kill_on_close_limits();
    // SAFETY: limits is the generated Windows struct for this information
    // class; the pointer remains valid for the synchronous call and exact size.
    unsafe {
        SetInformationJobObject(
            job.raw(),
            JobObjectExtendedLimitInformation,
            (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    }
    .map_err(|_| "WORKER_JOB_UNKNOWN: could not configure worker job")?;
    // SAFETY: the child is borrowed and not reaped by this function; the job's
    // OwnedHandle stays open. No breakaway limits are enabled for descendants.
    unsafe { AssignProcessToJobObject(job.raw(), HANDLE(process)) }
        .map_err(|_| "WORKER_JOB_UNKNOWN: could not assign child to worker job")?;
    let mut member = BOOL::default();
    // SAFETY: member is writable for the duration of this synchronous query.
    unsafe { IsProcessInJob(HANDLE(process), Some(job.raw()), &mut member) }
        .map_err(|_| "WORKER_JOB_UNKNOWN: could not verify child job membership")?;
    if !member.as_bool() {
        return Err("WORKER_JOB_UNKNOWN: child is not owned by worker job".into());
    }
    // Check that the accounting API is usable now, not only during cleanup.
    job.active_processes()?;
    Ok(job)
}

impl Job {
    fn raw(&self) -> HANDLE {
        HANDLE(self.handle.as_raw_handle())
    }

    /// Kill all members even when the original child already exited, then wait
    /// for a positive job-accounting observation of zero active processes.
    /// Closing a handle alone or observing leader exit is never proof of this.
    pub(super) async fn terminate_and_wait(&self) -> Result<(), String> {
        // SAFETY: OwnedHandle keeps this job valid for the whole call.
        unsafe { TerminateJobObject(self.raw(), 1) }
            .map_err(|_| "WORKER_JOB_UNKNOWN: could not terminate worker job")?;
        wait_until_empty(|| self.active_processes(), TERMINATION_TIMEOUT).await
    }

    fn active_processes(&self) -> Result<u32, String> {
        let mut info = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
        let mut written = 0;
        // SAFETY: generated struct matches the information class, exact buffer
        // size and writable return-length storage remain live for the call.
        unsafe {
            QueryInformationJobObject(
                Some(self.raw()),
                JobObjectBasicAccountingInformation,
                (&mut info as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
                size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                Some(&mut written),
            )
        }
        .map_err(|_| "WORKER_JOB_UNKNOWN: could not query worker job members")?;
        checked_active_count(&info, written)
    }
}

fn kill_on_close_limits() -> JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    limits
}

fn checked_active_count(
    info: &JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
    written: u32,
) -> Result<u32, String> {
    if written as usize != size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() {
        return Err("WORKER_JOB_UNKNOWN: incomplete worker job accounting".into());
    }
    Ok(info.ActiveProcesses)
}

async fn wait_until_empty(
    mut query: impl FnMut() -> Result<u32, String>,
    timeout: Duration,
) -> Result<(), String> {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        if query()? == 0 {
            return Ok(());
        }
        let now = tokio::time::Instant::now();
        if now >= deadline {
            return Err("WORKER_JOB_UNKNOWN: worker job still has active processes".into());
        }
        tokio::time::sleep(QUERY_INTERVAL.min(deadline - now)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn job_is_send_and_sync_without_unsafe_implementations() {
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<Job>();
    }

    #[test]
    fn limits_kill_on_close_without_breakaway_permissions() {
        let limits = kill_on_close_limits();
        assert_eq!(
            limits.BasicLimitInformation.LimitFlags,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        );
    }

    #[test]
    fn accounting_requires_exact_generated_struct_size() {
        let mut info = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
        let size = size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32;
        assert!(checked_active_count(&info, 0).is_err());
        assert!(checked_active_count(&info, size - 1).is_err());
        assert!(checked_active_count(&info, size + 1).is_err());
        assert_eq!(checked_active_count(&info, size).unwrap(), 0);
        info.ActiveProcesses = 2;
        assert_eq!(checked_active_count(&info, size).unwrap(), 2);
    }

    #[tokio::test]
    async fn zero_members_is_verified_without_waiting() {
        let mut queries = 0;
        wait_until_empty(
            || {
                queries += 1;
                Ok(0)
            },
            Duration::ZERO,
        )
        .await
        .unwrap();
        assert_eq!(queries, 1);
    }

    #[tokio::test]
    async fn query_failure_never_becomes_cleanup_success() {
        let error = wait_until_empty(|| Err("query failed".into()), Duration::ZERO)
            .await
            .unwrap_err();
        assert_eq!(error, "query failed");
    }

    #[tokio::test]
    async fn active_members_at_deadline_are_unknown_not_success() {
        let error = wait_until_empty(|| Ok(1), Duration::ZERO)
            .await
            .unwrap_err();
        assert!(error.starts_with("WORKER_JOB_UNKNOWN:"));
    }

    #[tokio::test]
    async fn waits_for_job_members_even_after_initial_observation() {
        let mut active = [2, 1, 0].into_iter();
        wait_until_empty(|| Ok(active.next().unwrap()), Duration::from_secs(1))
            .await
            .unwrap();
        assert!(active.next().is_none());
    }
}
