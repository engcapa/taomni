//! POP3 command, authentication and synchronization planning.

mod ledger;
pub mod local_store;
mod synchronization;

pub use ledger::{Pop3Ledger, sqlite_ledger};
pub use synchronization::{Pop3Mailbox, Pop3SyncOutcome, plan_round, sync_inbox};

#[cfg(feature = "pop3-runtime")]
mod session;
#[cfg(feature = "pop3-runtime")]
pub use session::{Pop3Connection, Pop3Session};
