//! POP3 command, authentication and synchronization planning.

mod ledger;
pub mod local_store;
pub mod ownership;
mod synchronization;

pub use ledger::Pop3Ledger;
#[cfg(feature = "mime-parse")]
pub use ledger::sqlite_ledger;
pub use synchronization::{Pop3Mailbox, Pop3SyncOutcome, plan_round, sync_inbox};
