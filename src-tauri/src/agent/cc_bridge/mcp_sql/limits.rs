/// Max rows a single `run_sql` reply renders inline. Larger result sets should
/// go through `run_sql_captured` + `read_result` (Phase 3) to stay out of CC's
/// context; until then `run_sql` clips and says so.
pub(super) const RUN_SQL_ROW_CAP: usize = 200;

/// Rows of head preview included in a `run_sql_captured` summary.
pub(super) const CAPTURE_PREVIEW_ROWS: usize = 20;

/// At most this many running SQL captures per thread (a captured run holds the
/// full result in memory briefly while writing it out).
pub(super) const MAX_RUNNING_CAPTURES: usize = 2;
