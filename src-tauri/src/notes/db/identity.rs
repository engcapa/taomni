use uuid::Uuid;

/// Window (seconds) within which an upcoming `due_at` counts as "due soon".
pub const DEFAULT_DUE_SOON_SECS: i64 = 30 * 60;

pub fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

pub(super) fn new_id() -> String {
    Uuid::new_v4().to_string()
}
