//! Complete MIME objects are immutable and independent of the disposable body cache.

mod model;

mod index;

mod publication;

mod reading;

mod cleanup;

mod relocation;

#[cfg(test)]
mod tests;

pub use model::{ArchiveEntry, FullMessage, FullMessageMode, PreparedMessage};

pub use index::{account_root, init_tables, lookup, stores_full};

pub(super) use index::legacy_attachment_flag;

pub use publication::{prepare, publish, store};

pub use reading::{OpenMessage, list, open, open_entry};

#[cfg(test)]
pub use reading::read;

#[cfg(test)]
pub use reading::export;

#[cfg(test)]
pub use reading::read_entry;

pub use cleanup::{as_sql_error, collect_garbage, remove_entries, snapshot_objects};

pub use relocation::{configured_directory, save_mail_session};

pub(super) use relocation::relocate;
