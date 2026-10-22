use std::time::Duration;

pub(super) const TRACE_START_TIMEOUT: Duration = Duration::from_secs(3);
pub(super) const PREFLIGHT_POLL_INTERVAL: Duration = Duration::from_millis(5);
pub(super) const FLOW_CLAIM_TIMEOUT: Duration = Duration::from_secs(2);
pub(super) const MAX_PENDING_FLOWS: usize = 8192;
pub(super) const LINUX_SOCK_TYPE_MASK: libc::c_int = 0xf;
