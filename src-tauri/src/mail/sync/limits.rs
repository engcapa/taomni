/// Newest cached UIDs whose flags a quiet reconcile refreshes when the server
/// cannot report changes via CONDSTORE.
pub(in crate::mail) const FLAG_RECONCILE_WINDOW: usize = 500;
/// UIDs per `UID FETCH (FLAGS)` command.
// Bound sparse ten-digit UID commands as well as contiguous mailboxes.
pub(super) const FLAG_FETCH_CHUNK: usize = 250;
