/// UIDs per `UID FETCH (FLAGS)` command.
// Bound sparse ten-digit UID commands as well as contiguous mailboxes.
#[cfg(feature = "imap-runtime")]
pub(super) const FLAG_FETCH_CHUNK: usize = 250;
