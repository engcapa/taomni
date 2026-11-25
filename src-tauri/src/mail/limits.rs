use std::time::Duration;

pub(super) const DEFAULT_TIMEOUT_SECS: u64 = 30;
pub(super) const DEFAULT_MESSAGE_LIMIT: usize = 200;
pub(super) const OAUTH_REFRESH_SKEW_SECS: i64 = 300;
pub(super) const OAUTH_REAUTHORIZE_REQUIRED: &str = "OAuth2 authorization expired or was revoked. Reauthorize this mail account in session settings.";
/// How long an idle live IMAP session (and its proxy forwarder) is kept.
pub(super) const IMAP_LIVE_IDLE_TTL: Duration = Duration::from_secs(180);
