//! POP3 command, authentication and synchronization planning.

pub mod local_store;
mod synchronization;

pub use synchronization::{Pop3Mailbox, Pop3SyncOutcome, plan_round, sync_inbox};

#[cfg(feature = "pop3-runtime")]
mod session;
#[cfg(feature = "pop3-runtime")]
pub use session::{Pop3Connection, Pop3Session};
