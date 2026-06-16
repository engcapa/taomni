//! Local persistence over `lanchat.sqlite` (phase 2).
//!
//! Owns the schema (profile / peers / groups / group_members / conversations /
//! messages + indexes) and CRUD used by discovery, messaging, and the command
//! surface. Uses the bundled `rusqlite` dependency; the connection is kept in
//! `LanChatState` behind a mutex, separate from the main `taomni.db`.
//!
//! Implemented in phase 2; placeholder from phase 1 to fix the module tree.
