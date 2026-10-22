//! Test-only in-process IMAP4rev1 server.
//!
//! Implements just the commands the mail backend issues (LOGIN, CAPABILITY,
//! LIST, EXAMINE/SELECT incl. `(CONDSTORE)`, UID SEARCH, UID FETCH incl.
//! `CHANGEDSINCE`, UID STORE, UID COPY/MOVE, EXPUNGE, APPEND, NOOP, LOGOUT)
//! over a real TCP socket, so tests exercise the `imap` crate's parser and the
//! sync planner together. State is shared so a test can deliver, expunge or
//! re-flag messages between sync steps, as another client would.

mod model;

mod lifetime;

mod syntax;

mod server;

pub use model::{FakeFolder, FakeMessage, FakeState};

pub use lifetime::{FakeImap, raw_message};
