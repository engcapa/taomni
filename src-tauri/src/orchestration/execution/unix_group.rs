//! Bounded termination of the process group created for one supervised worker.
//! A cached leader exit is never group-termination evidence. This does not claim
//! containment of descendants that deliberately escape with setsid/setpgid.

#[cfg(target_os = "linux")]
mod procfs;
mod state;
#[cfg(test)]
mod tests;

use std::{io, time::Duration};

use state::{Cleanup, GroupState, Operations, Progress, Signal, SignalResult};

const TERM_GRACE: Duration = Duration::from_secs(3);
const KILL_WAIT: Duration = Duration::from_secs(5);
const POLL_INTERVAL: Duration = Duration::from_millis(25);

pub(super) async fn terminate_and_wait(group_id: u32) -> Result<(), String> {
    let group_id = checked_group_id(group_id)?;
    let mut operations = SystemGroup { group_id };
    let mut cleanup = Cleanup::new(TERM_GRACE, KILL_WAIT);
    let started = tokio::time::Instant::now();
    loop {
        if cleanup.poll(&mut operations, started.elapsed())? == Progress::Complete {
            return Ok(());
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

fn checked_group_id(group_id: u32) -> Result<libc::pid_t, String> {
    if group_id == 0 || group_id > i32::MAX as u32 {
        return Err("WORKER_STOP_UNKNOWN: invalid worker process group".into());
    }
    Ok(group_id as libc::pid_t)
}

struct SystemGroup {
    group_id: libc::pid_t,
}

impl Operations for SystemGroup {
    fn signal(&mut self, signal: Signal) -> Result<SignalResult, String> {
        self.send(match signal {
            Signal::Terminate => libc::SIGTERM,
            Signal::Kill => libc::SIGKILL,
        })
    }

    fn observe(&mut self) -> Result<GroupState, String> {
        if self.send(0)? == SignalResult::Gone {
            return Ok(GroupState::Gone);
        }
        #[cfg(target_os = "linux")]
        {
            // Linux kill(-pgid, 0) also succeeds for zombies. Inspect current
            // group membership, never infer it from a stale saved leader PID.
            let observed = procfs::observe(self.group_id)?;
            if self.send(0)? == SignalResult::Gone {
                return Ok(GroupState::Gone);
            }
            Ok(observed)
        }
        #[cfg(not(target_os = "linux"))]
        {
            // Other Unix platforms have no procfs contract here. Conservatively
            // require ESRCH; lingering zombies may keep cleanup unknown rather
            // than being mistaken for proven termination.
            Ok(GroupState::Live)
        }
    }
}

impl SystemGroup {
    fn send(&self, signal: i32) -> Result<SignalResult, String> {
        // SAFETY: checked_group_id excludes zero/negative/overflow values, so
        // negation targets only this worker group, never all permitted processes.
        let result = unsafe { libc::kill(-self.group_id, signal) };
        classify_result(if result == 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        })
    }
}

fn classify_result(result: io::Result<()>) -> Result<SignalResult, String> {
    match result {
        Ok(()) => Ok(SignalResult::Delivered),
        Err(error) if error.raw_os_error() == Some(libc::ESRCH) => Ok(SignalResult::Gone),
        Err(error) if error.raw_os_error() == Some(libc::EPERM) => {
            Err("WORKER_STOP_UNKNOWN: permission denied for worker process group".into())
        }
        Err(_) => Err("WORKER_STOP_UNKNOWN: worker process group signal/query failed".into()),
    }
}
