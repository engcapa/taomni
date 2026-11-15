use std::{
    sync::Arc,
    time::{Duration, Instant},
};

use crate::SnapshotError;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SnapshotPhase {
    Starting,
    Copying,
    WaitingForDatabase,
    Verifying,
    Publishing,
    Completed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SnapshotProgress {
    pub phase: SnapshotPhase,
    pub remaining_pages: Option<u32>,
    pub total_pages: Option<u32>,
}

/// Adapts the caller's cancellation/progress owner. Implementations must not
/// block or panic; UI components should not own this observer's lifetime.
pub trait SnapshotObserver: Send + Sync {
    fn is_cancelled(&self) -> bool {
        false
    }
    fn progress(&self, _progress: SnapshotProgress) {}
}

struct NoopObserver;
impl SnapshotObserver for NoopObserver {}

#[derive(Clone)]
pub struct SnapshotControl {
    deadline: Instant,
    observer: Arc<dyn SnapshotObserver>,
}

impl SnapshotControl {
    pub fn new(deadline: Instant, observer: Arc<dyn SnapshotObserver>) -> Self {
        Self { deadline, observer }
    }

    pub fn with_timeout(timeout: Duration) -> Self {
        Self::new(Instant::now() + timeout, Arc::new(NoopObserver))
    }

    pub fn check(&self) -> Result<(), SnapshotError> {
        if self.observer.is_cancelled() {
            return Err(SnapshotError::Cancelled);
        }
        if Instant::now() >= self.deadline {
            return Err(SnapshotError::TimedOut);
        }
        Ok(())
    }

    pub(crate) fn report(&self, phase: SnapshotPhase, pages: Option<(i32, i32)>) {
        self.observer.progress(SnapshotProgress {
            phase,
            remaining_pages: pages.map(|(remaining, _)| remaining.max(0) as u32),
            total_pages: pages.map(|(_, total)| total.max(0) as u32),
        });
    }

    pub(crate) fn wait(&self, delay: Duration) -> Result<(), SnapshotError> {
        let until = Instant::now() + delay;
        loop {
            self.check()?;
            let remaining = until.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Ok(());
            }
            std::thread::sleep(
                remaining
                    .min(Duration::from_millis(10))
                    .min(self.deadline.saturating_duration_since(Instant::now())),
            );
        }
    }
}

#[derive(Clone, Debug)]
pub struct SnapshotOptions {
    pub pages_per_step: u32,
    pub busy_retry_delay: Duration,
}

impl Default for SnapshotOptions {
    fn default() -> Self {
        Self {
            pages_per_step: 64,
            busy_retry_delay: Duration::from_millis(10),
        }
    }
}

impl SnapshotOptions {
    pub(crate) fn validate(&self) -> Result<(), SnapshotError> {
        if self.pages_per_step == 0
            || self.pages_per_step > i32::MAX as u32
            || self.busy_retry_delay.is_zero()
            || self.busy_retry_delay > Duration::from_secs(1)
        {
            return Err(SnapshotError::InvalidOptions);
        }
        Ok(())
    }
}
