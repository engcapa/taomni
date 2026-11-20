use std::time::Duration;

/// Messages downloaded per sync call; the tab repeats while `more`.
pub(in crate::mail) const POP3_FETCH_BATCH: usize = 50;
pub(super) const READ_TIMEOUT: Duration = Duration::from_secs(60);
