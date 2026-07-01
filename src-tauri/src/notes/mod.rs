//! Tao Notes — a unified notes / memo / task feature backed by a dedicated
//! `notes.db` SQLite file. See `tao-notes-feature-plan.md`.

pub mod commands;
pub mod db;

pub use commands::*;
pub use db::init_db;
