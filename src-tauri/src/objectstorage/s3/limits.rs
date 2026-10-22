use std::time::Duration;

/// Presign lifetime for one-shot signed requests. Requests are issued
/// immediately, so a short window is plenty.
pub(super) const SIGN_TTL: Duration = Duration::from_secs(300);
pub(super) const UPLOAD_SEND_ATTEMPTS: u32 = 3;
pub(super) const UPLOAD_RETRY_BASE_DELAY: Duration = Duration::from_millis(200);
