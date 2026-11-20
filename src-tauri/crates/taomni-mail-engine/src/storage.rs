//! Immutable complete mail storage and its SQLite archive index.

mod cleanup;
mod index;
mod model;
mod publication;
pub mod query;
mod reading;

#[cfg(test)]
mod tests;

pub use cleanup::{
    as_sql_error, collect_garbage, remove_entries, snapshot_objects, snapshot_objects_with,
};
pub(crate) use index::object_path;
pub use index::{account_root, init_tables, lookup};
pub use model::{ArchiveEntry, FullMessage, FullMessageMode, PreparedMessage};
pub use publication::{prepare, publish, store};
pub use reading::{OpenMessage, list, open, open_entry, open_with};
