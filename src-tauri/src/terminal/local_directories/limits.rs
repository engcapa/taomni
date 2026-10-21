use std::time::Duration;

pub(super) const MAX_DISPLAYED_NON_DEFAULT: usize = 24;
pub(super) const MAX_ALIAS_CANDIDATES: usize = 64;
/// Bounded background probe budget for availability checks (design §4.1.4).
pub const PROBE_BUDGET: Duration = Duration::from_secs(2);
pub(super) const PROBE_MAX_WORKERS: usize = 4;

// ---------------------------------------------------------------------------
// Recording confirmed use
// ---------------------------------------------------------------------------

pub const SOURCE_LOCAL_START: &str = "local-start";
pub const SOURCE_LOCAL_CWD: &str = "local-cwd";
