use std::time::Duration;

pub const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(120);
pub(super) const DEFAULT_STDERR_LIMIT: usize = 8 * 1024;
pub(super) const EVENT_CHANNEL_CAPACITY: usize = 256;
/// A local CLI has already made the permission request, so give its JSON-RPC
/// response a brief chance to flush before sending `session/cancel` or closing
/// stdin. This prevents a stop action from looking like a failed tool call.
pub(super) const PERMISSION_RESPONSE_FLUSH_TIMEOUT: Duration = Duration::from_secs(2);
