//! Small, dependency-free state machine. No polling or resource lifecycle ownership.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Healthy,
    Failed,
    Recovering,
    Ready,
    Closing,
}

#[derive(Debug)]
pub struct Lifecycle {
    pub phase: Phase,
    pub generation: u64,
    pub failed_at: u64,
    last_attempt: Option<u64>,
}

impl Default for Lifecycle {
    fn default() -> Self {
        Self {
            phase: Phase::Healthy,
            generation: 0,
            failed_at: 0,
            last_attempt: None,
        }
    }
}

impl Lifecycle {
    pub fn terminated(&mut self, now: u64) -> bool {
        if matches!(self.phase, Phase::Failed | Phase::Closing) {
            return false;
        }
        self.generation += 1;
        self.failed_at = now;
        self.phase = Phase::Failed;
        true
    }

    // Automatic recovery deliberately remains disabled until isolated engine /
    // Channel queue probes pass. Manual retry uses the same bounded handshake.
    pub fn retry(&mut self, now: u64) -> Option<u64> {
        if self.phase != Phase::Failed
            || self.last_attempt.is_some_and(|last| now.saturating_sub(last) < 60_000)
        {
            return None;
        }
        self.generation += 1;
        self.last_attempt = Some(now);
        self.phase = Phase::Recovering;
        Some(self.generation)
    }

    pub fn ready(&mut self, generation: u64) -> bool {
        if self.phase != Phase::Recovering || self.generation != generation {
            return false;
        }
        self.phase = Phase::Ready;
        true
    }

    pub fn timeout(&mut self, generation: u64) -> bool {
        if self.phase != Phase::Recovering || self.generation != generation {
            return false;
        }
        self.phase = Phase::Failed;
        true
    }

    pub fn closing(&mut self) {
        self.phase = Phase::Closing;
        self.generation += 1;
    }

    pub fn needs_native_close(&self) -> bool {
        matches!(self.phase, Phase::Failed | Phase::Recovering | Phase::Ready)
    }

    pub fn permits_output(&self, generation: Option<u64>) -> bool {
        generation == Some(self.generation) && matches!(self.phase, Phase::Healthy | Phase::Ready)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn coalesces_failure_and_rate_limits_retry() {
        let mut state = Lifecycle::default();
        assert!(state.terminated(1));
        assert!(!state.terminated(2));
        let generation = state.retry(3).unwrap();
        assert!(state.ready(generation));
        assert!(state.terminated(4));
        assert_eq!(state.retry(5), None);
        assert!(state.retry(60_003).is_some());
    }

    #[test]
    fn close_always_wins_and_stale_callbacks_cannot_finish() {
        let mut state = Lifecycle::default();
        state.terminated(0);
        let generation = state.retry(0).unwrap();
        state.closing();
        assert!(!state.ready(generation));
        assert!(!state.timeout(generation));
        assert!(!state.terminated(1));
        assert_eq!(state.retry(90_000), None);
    }

    #[test]
    fn crash_during_bootstrap_invalidates_previous_generation() {
        let mut state = Lifecycle::default();
        state.terminated(0);
        let old = state.retry(1).unwrap();
        assert!(state.terminated(2));
        assert!(!state.ready(old));
        assert!(!state.timeout(old));
        let next = state.retry(60_001).unwrap();
        assert!(state.timeout(next));
        assert!(!state.ready(next));
        assert!(state.needs_native_close());
    }

    #[test]
    fn healthy_windows_do_not_intercept_normal_frontend_close() {
        assert!(!Lifecycle::default().needs_native_close());
    }

    #[test]
    fn dead_and_stale_output_cannot_reenter_after_ready() {
        let mut state = Lifecycle::default();
        assert!(state.permits_output(Some(0)));
        state.terminated(0);
        assert!(!state.permits_output(Some(0)));
        assert!(!state.permits_output(Some(1)));
        let generation = state.retry(1).unwrap();
        assert!(!state.permits_output(Some(generation)));
        state.ready(generation);
        assert!(state.permits_output(Some(generation)));
        assert!(!state.permits_output(Some(0)));
        state.closing();
        assert!(!state.permits_output(Some(state.generation)));
    }
}
