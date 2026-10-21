//! Presto/Trino backend over the HTTP statement API. The client follows the
//! `/v1/statement` response `nextUri` chain and translates JSON rows into the
//! same string/null grid shape used by the other SQL engines.
//!
//! Header dialect is selected per connection: Presto uses `X-Presto-*` while
//! Trino uses `X-Trino-*` (see `DbConfig.presto_dialect`).

mod protocol;

mod model;

mod stream_state;

mod transport;

mod statements;

mod values;

mod query;

mod catalog;

#[cfg(test)]
mod tests;

pub use model::PrestoClient;

pub use transport::connect;

pub use query::{execute, execute_stream, ping};

pub use catalog::{
    describe_table, list_catalogs, list_indexes, list_objects, list_schemas, list_tables,
    object_ddl, search_tables, table_stats,
};
