//! MySQL / StarRocks / PostgreSQL backend via `sqlx` and SQL Server via
//! `tiberius`. Values are decoded to `Option<String>` based on the column's SQL
//! type so the frontend grid can render them as text with a distinct NULL badge.

mod schema_helpers;
mod statements;
mod values;
pub use statements::parse_default_schema_switch;
mod sqlserver_catalog;
pub use sqlserver_catalog::{
    describe_table_sqlserver, list_foreign_keys_sqlserver, list_indexes_sqlserver,
    list_objects_sqlserver, list_schemas_sqlserver, list_tables_sqlserver, object_ddl_sqlserver,
    search_tables_sqlserver, table_stats_sqlserver,
};
mod mysql_catalog;
pub use mysql_catalog::{
    describe_table_mysql, list_foreign_keys_mysql, list_indexes_mysql, list_objects_mysql,
    list_schemas_mysql, list_tables_mysql, object_ddl_mysql, search_tables_mysql,
    table_stats_mysql,
};
mod postgres_catalog;
pub use postgres_catalog::{
    describe_table_postgres, list_foreign_keys_postgres, list_indexes_postgres,
    list_objects_postgres, list_schemas_postgres, list_tables_postgres, object_ddl_postgres,
    search_tables_postgres, table_stats_postgres,
};
mod query;
pub use query::{
    execute_mysql, execute_mysql_stream, execute_postgres, execute_postgres_stream,
    execute_sqlserver, execute_sqlserver_stream,
};
mod connection;
pub use connection::{
    connect_mysql, connect_postgres, connect_sqlserver, connect_starrocks, exec_control_mysql,
    exec_control_postgres, new_active_schema_slot, ping_mysql, ping_postgres, ping_sqlserver,
    ping_starrocks,
};
#[cfg(test)]
mod tests;

use std::sync::Arc;
use tiberius::Client as TdsClient;
use tokio::net::TcpStream;
use tokio::sync::Mutex as AsyncMutex;
use tokio_util::compat::Compat;

const DEFAULT_TIMEOUT_SECS: u64 = 15;
const STREAM_BATCH_ROWS: usize = 100;

pub type SqlServerClient = TdsClient<Compat<TcpStream>>;

// ---------------------------------------------------------------------------
// Connect
// ---------------------------------------------------------------------------

/// Session default schema/database remembered across pool reconnects.
///
/// `USE` / `SET search_path` only affect the live connection. sqlx may recreate
/// the single pooled connection after idle timeout or network blips; the
/// `after_connect` hook re-applies this value so the UI "active schema" sticks.
pub type ActiveSchemaSlot = Arc<AsyncMutex<Option<String>>>;
