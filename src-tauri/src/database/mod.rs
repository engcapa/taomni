//! Database client backend: MySQL / PostgreSQL / StarRocks (via `sqlx`),
//! PanWeiDB (via the native openGauss connector), Oracle (via `rust-oracle`),
//! SQL Server (via `tiberius`), ClickHouse and Presto (via the existing
//! `reqwest` HTTP client), and Redis (via `redis-rs`).
//!
//! SQL engines surface a single Tauri command surface (`db_*`, with
//! `redis_*` for Redis). Live connections are cached in
//! [`crate::state::AppState::db_connections`] keyed by session id; a
//! [`DbSession`] wraps the per-engine handle plus a cancellation token used by
//! `db_cancel`.

pub mod bookmarks;

pub mod clickhouse;
mod clickhouse_native;

pub mod forward;

pub mod history;

pub mod oracle;

pub mod panwei;

pub mod presto;

pub mod query_workspace;

pub mod redis_ops;

pub mod saved_queries;

pub mod sql;

pub mod sql_rewrite;

pub mod tx;

pub use bookmarks::*;

pub use history::*;

pub use query_workspace::*;

pub use saved_queries::*;

use serde::{Deserialize, Serialize};

use sqlx_core::pool::Pool;

use sqlx_mysql::MySql;

use sqlx_postgres::Postgres;

use std::sync::Arc;

use std::time::Duration;

use tauri::State;

use tauri::ipc::Channel;

use tokio::sync::Mutex as AsyncMutex;

use tokio::task::JoinHandle;

use tokio::time::MissedTickBehavior;

use tokio_util::sync::CancellationToken;

use crate::state::AppState;

mod catalog_helpers;

mod model;

mod query_commands;

mod session;

mod connection;

mod catalog_commands;

mod transaction_commands;

mod redis_commands;

#[cfg(test)]
mod tests;

#[cfg(test)]
mod live_tests;

pub(crate) use catalog_helpers::group_foreign_keys;

use catalog_helpers::{
    DEFAULT_METADATA_SEARCH_LIMIT, MAX_METADATA_SEARCH_LIMIT, metadata_search_limit,
};

pub use model::{
    CatalogInfo, ColumnDescription, ColumnInfo, DbConfig, DbConnectResult, DbObject,
    ForeignKeyInfo, IndexInfo, QueryResult, QueryStreamChannel, QueryStreamEvent, SchemaInfo,
    TableInfo,
};

pub use query_commands::{db_cancel, db_execute, db_execute_stream};

pub(crate) use query_commands::{emit_query_result_stream, send_query_stream_event};

pub(crate) use query_commands::{
    __cmd__db_cancel, __cmd__db_execute, __cmd__db_execute_stream, __tauri_command_name_db_cancel,
    __tauri_command_name_db_execute, __tauri_command_name_db_execute_stream,
};

pub use session::{DbHandle, DbSession};

use session::{close_session, get_session, start_keepalive};

pub use connection::{db_connect, db_disconnect, db_ping};

use connection::{engine_target_port, prepare_network_forward, resolve_secret};

pub(crate) use connection::{
    __cmd__db_connect, __cmd__db_disconnect, __cmd__db_ping, __tauri_command_name_db_connect,
    __tauri_command_name_db_disconnect, __tauri_command_name_db_ping,
};

pub use catalog_commands::{
    db_describe_table, db_list_catalogs, db_list_foreign_keys, db_list_indexes, db_list_objects,
    db_list_schemas, db_list_tables, db_object_ddl, db_search_tables, db_table_stats,
};

pub(crate) use catalog_commands::metric_result;

pub(crate) use catalog_commands::{
    __cmd__db_describe_table, __cmd__db_list_catalogs, __cmd__db_list_foreign_keys,
    __cmd__db_list_indexes, __cmd__db_list_objects, __cmd__db_list_schemas, __cmd__db_list_tables,
    __cmd__db_object_ddl, __cmd__db_search_tables, __cmd__db_table_stats,
    __tauri_command_name_db_describe_table, __tauri_command_name_db_list_catalogs,
    __tauri_command_name_db_list_foreign_keys, __tauri_command_name_db_list_indexes,
    __tauri_command_name_db_list_objects, __tauri_command_name_db_list_schemas,
    __tauri_command_name_db_list_tables, __tauri_command_name_db_object_ddl,
    __tauri_command_name_db_search_tables, __tauri_command_name_db_table_stats,
};

pub use transaction_commands::{db_tx_commit, db_tx_rollback, db_tx_set_manual, db_tx_status};

use transaction_commands::end_transaction;

pub(crate) use transaction_commands::{
    __cmd__db_tx_commit, __cmd__db_tx_rollback, __cmd__db_tx_set_manual, __cmd__db_tx_status,
    __tauri_command_name_db_tx_commit, __tauri_command_name_db_tx_rollback,
    __tauri_command_name_db_tx_set_manual, __tauri_command_name_db_tx_status,
};

pub use redis_commands::{
    RedisKeyEntry, RedisScanPage, RedisValue, redis_del_key, redis_exec, redis_get_key,
    redis_list_keys, redis_set_key,
};

pub(crate) use redis_commands::{
    __cmd__redis_del_key, __cmd__redis_exec, __cmd__redis_get_key, __cmd__redis_list_keys,
    __cmd__redis_set_key, __tauri_command_name_redis_del_key, __tauri_command_name_redis_exec,
    __tauri_command_name_redis_get_key, __tauri_command_name_redis_list_keys,
    __tauri_command_name_redis_set_key,
};
