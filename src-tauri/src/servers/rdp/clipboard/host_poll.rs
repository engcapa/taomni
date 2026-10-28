use super::limits::CONTENT_POLL;
use std::time::Instant;

/// A producer can declare formats before publishing data without another
/// change token. Recheck empty snapshots at the existing full-content rate;
/// nonempty snapshots retain the cheap token-only path.
pub(super) struct HostPoll {
    last_token: Option<u64>,
    last_read: Instant,
    empty: bool,
}

impl HostPoll {
    pub(super) fn new(token: Option<u64>, now: Instant) -> Self {
        Self {
            last_token: token,
            last_read: now,
            empty: true,
        }
    }

    pub(super) fn should_read(&self, token: Option<u64>, now: Instant) -> bool {
        token.is_none()
            || token != self.last_token
            || (self.empty && now.saturating_duration_since(self.last_read) >= CONTENT_POLL)
    }

    /// Only a completed read/write consumes the token. Busy reads retry.
    pub(super) fn observed(&mut self, token: Option<u64>, empty: bool, now: Instant) {
        self.last_token = token;
        self.last_read = now;
        self.empty = empty;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn delayed_same_token_data_is_checked_after_an_empty_read() {
        let start = Instant::now();
        let mut poll = HostPoll::new(Some(1), start);
        assert!(poll.should_read(Some(2), start));
        poll.observed(Some(2), true, start);
        assert!(!poll.should_read(Some(2), start + Duration::from_millis(250)));
        assert!(!poll.should_read(Some(2), start + Duration::from_millis(999)));
        assert!(poll.should_read(Some(2), start + CONTENT_POLL));
        // The producer has now published its payload, still with token 2.
        poll.observed(Some(2), false, start + CONTENT_POLL);
        assert!(!poll.should_read(Some(2), start + CONTENT_POLL * 20));
    }

    #[test]
    fn stable_empty_content_is_not_read_at_every_token_tick() {
        let start = Instant::now();
        let mut poll = HostPoll::new(Some(1), start);
        let mut reads = 0;
        for quarter in 1..=40 {
            let now = start + Duration::from_millis(quarter * 250);
            if poll.should_read(Some(1), now) {
                reads += 1;
                poll.observed(Some(1), true, now);
            }
        }
        assert_eq!(reads, 10);
    }

    #[test]
    fn new_tokens_are_read_immediately_even_after_nonempty_content() {
        let start = Instant::now();
        let mut poll = HostPoll::new(Some(1), start);
        poll.observed(Some(1), false, start);
        assert!(poll.should_read(Some(2), start + Duration::from_millis(1)));
        assert!(!poll.should_read(Some(1), start + CONTENT_POLL * 20));
    }

    #[test]
    fn busy_reads_do_not_consume_a_new_token_or_an_empty_retry() {
        let start = Instant::now();
        let poll = HostPoll::new(Some(1), start);
        assert!(poll.should_read(Some(2), start));
        assert!(poll.should_read(Some(2), start + Duration::from_millis(250)));
        assert!(poll.should_read(Some(1), start + CONTENT_POLL));
        assert!(poll.should_read(Some(1), start + CONTENT_POLL + Duration::from_millis(250)));
    }

    #[test]
    fn client_write_establishes_a_nonempty_baseline_without_periodic_reads() {
        let start = Instant::now();
        let mut poll = HostPoll::new(Some(1), start);
        poll.observed(Some(3), false, start + CONTENT_POLL);
        assert!(!poll.should_read(Some(3), start + CONTENT_POLL * 100));
        assert!(poll.should_read(Some(4), start + CONTENT_POLL * 100));
    }

    #[test]
    fn sessions_without_a_change_signal_keep_content_polling() {
        let start = Instant::now();
        let mut poll = HostPoll::new(None, start);
        poll.observed(None, false, start);
        assert!(poll.should_read(None, start + CONTENT_POLL));
    }
}
