//! SQLite mailbox schema and cached header access shared by mail storage.

mod header;
mod schema;
mod settings;

pub use header::{cached_header, row_to_header};
pub use schema::{MAIL_SCHEMA_VERSION, init_cache_tables, migrate_mail_tables};
pub use settings::MailCacheSettings;
