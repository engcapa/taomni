//! Gap-free IMAP folder synchronisation.
//!
//! Invariant (per account + folder, stable UIDVALIDITY): the cache holds
//! exactly the server messages whose UID lies in `[sync_low_uid,
//! sync_high_uid]`. New mail is therefore always `sync_high_uid+1:*`, older
//! history is `1:sync_low_uid-1`, and reconciliation only needs to compare the
//! server's UID set inside the span with the cached one.
//!
//! The previous design inferred progress from `MAX(uid)` of a cache that was
//! filled by newest-N pages, so a newest page after a long absence pushed the
//! resume point past the messages in between and they were never fetched.
//! Every fetch here is planned as a set difference (server − cached), which is
//! idempotent: an interrupted step is simply recomputed by the next call.

#[cfg(feature = "imap-runtime")]
mod folder_step;
mod limits;
#[cfg(any(feature = "imap-runtime", test))]
mod planning;
#[cfg(feature = "imap-runtime")]
mod protocol;
#[cfg(feature = "imap-runtime")]
mod round;

#[cfg(feature = "imap-runtime")]
pub use folder_step::imap_sync_folder_step;
#[cfg(feature = "imap-runtime")]
pub use protocol::imap_has_capability;
#[cfg(feature = "imap-runtime")]
pub use round::{folder_unchanged, sync_folder_round};
pub use taomni_mail_storage::imap_sync::*;

#[cfg(test)]
mod tests;
