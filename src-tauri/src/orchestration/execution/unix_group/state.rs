use std::time::Duration;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Signal {
    Terminate,
    Kill,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum SignalResult {
    Delivered,
    Gone,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(super) struct Member {
    pub pid: u32,
    pub start_ticks: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum GroupState {
    Gone,
    Live,
    Zombies(Vec<Member>),
}

pub(super) trait Operations {
    fn signal(&mut self, signal: Signal) -> Result<SignalResult, String>;
    fn observe(&mut self) -> Result<GroupState, String>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Progress {
    Pending,
    Complete,
}

/// Pure clock-injected cleanup controller. Production supplies OS observations;
/// tests supply exact errors/member snapshots without starting any processes.
pub(super) struct Cleanup {
    grace: Duration,
    total: Duration,
    started: bool,
    killed: bool,
    zombies: Option<Vec<Member>>,
}

impl Cleanup {
    pub fn new(grace: Duration, kill_wait: Duration) -> Self {
        Self {
            grace,
            total: grace.saturating_add(kill_wait),
            started: false,
            killed: false,
            zombies: None,
        }
    }

    pub fn poll(
        &mut self,
        operations: &mut impl Operations,
        elapsed: Duration,
    ) -> Result<Progress, String> {
        if !self.started {
            self.started = true;
            if operations.signal(Signal::Terminate)? == SignalResult::Gone {
                return Ok(Progress::Complete);
            }
        }
        match operations.observe()? {
            GroupState::Gone => return Ok(Progress::Complete),
            GroupState::Live => self.zombies = None,
            GroupState::Zombies(members) if !members.is_empty() => {
                // Two matching contemporaneous scans must find no executable
                // members. Include start time so PID reuse is not stale evidence.
                if self.killed && self.zombies.as_ref() == Some(&members) {
                    return Ok(Progress::Complete);
                }
                self.zombies = Some(members);
            }
            GroupState::Zombies(_) => self.zombies = None,
        }
        if !self.killed && elapsed >= self.grace {
            self.killed = true;
            self.zombies = None;
            if operations.signal(Signal::Kill)? == SignalResult::Gone {
                return Ok(Progress::Complete);
            }
            // Always permit a fresh observation after delivering SIGKILL.
        } else if self.killed && elapsed >= self.total {
            return Err(
                "WORKER_STOP_UNKNOWN: worker process group still has live or unverifiable members"
                    .into(),
            );
        }
        Ok(Progress::Pending)
    }
}
