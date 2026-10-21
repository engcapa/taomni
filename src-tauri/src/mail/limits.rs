use std::time::Duration;

pub(super) const DEFAULT_TIMEOUT_SECS: u64 = 30;
pub(super) const DEFAULT_MESSAGE_LIMIT: usize = 200;
pub(super) const DEFAULT_BODY_MAX_BYTES: usize = 256 * 1024;
/// Cap for HTML bodies after embedding inline CID images as data URLs for display.
pub(super) const MAX_EMBEDDED_BODY_BYTES: usize = 5 * 1024 * 1024;
/// Skip individual CID parts larger than this when rewriting for display.
pub(super) const MAX_INLINE_CID_IMAGE_BYTES: usize = 2 * 1024 * 1024;
pub(super) const OAUTH_REFRESH_SKEW_SECS: i64 = 300;
pub(super) const OAUTH_REAUTHORIZE_REQUIRED: &str = "OAuth2 authorization expired or was revoked. Reauthorize this mail account in session settings.";
pub(super) const IMAP_LOGIN_RETRY_DELAYS_MS: [u64; 2] = [500, 1500];
/// How long an idle live IMAP session (and its proxy forwarder) is kept.
pub(super) const IMAP_LIVE_IDLE_TTL: Duration = Duration::from_secs(180);
