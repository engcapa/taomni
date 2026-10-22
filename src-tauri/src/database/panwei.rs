//! PanWeiDB / openGauss-compatible backend via the native `tokio-opengauss`
//! connector. This is intentionally separate from the PostgreSQL `sqlx`
//! backend because PanWeiDB deployments can require openGauss SHA256
//! authentication that regular PostgreSQL clients do not implement.

mod connection;

mod catalog;

mod tls;

mod query;

mod table_details;

mod objects;

#[cfg(test)]
mod tests;

pub use connection::{PanWeiClient, connect, ping};

pub use catalog::{list_schemas, list_tables, search_tables};

pub use query::{execute, execute_stream};

pub use table_details::{describe_table, list_foreign_keys, list_indexes};

pub use objects::{list_objects, object_ddl, table_stats};
