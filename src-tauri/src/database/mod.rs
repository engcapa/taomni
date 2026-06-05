//! Database client backend: MySQL / PostgreSQL (via `sqlx`), ClickHouse and
//! Presto (via the existing `reqwest` HTTP client), and Redis (via `redis-rs`).
//!
//! SQL engines surface a single Tauri command surface (`db_*`, with
//! `redis_*` for Redis). Live connections are cached in
//! [`crate::state::AppState::db_connections`] keyed by session id; a
//! [`DbSession`] wraps the per-engine handle plus a cancellation token used by
//! `db_cancel`.

pub mod clickhouse;
pub mod presto;
pub mod redis_ops;
pub mod sql;

use serde::{Deserialize, Serialize};
use sqlx_core::pool::Pool;
use sqlx_mysql::MySql;
use sqlx_postgres::Postgres;
use std::sync::Arc;
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::State;
use tokio::sync::Mutex as AsyncMutex;
use tokio::task::JoinHandle;
use tokio::time::MissedTickBehavior;
use tokio_util::sync::CancellationToken;

use crate::state::AppState;

/// Connection parameters supplied by the frontend. Mirrors the
/// `DbConnectInfo` TypeScript interface (camelCase over the IPC boundary).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbConfig {
    /// Backend engine: "MySQL" | "PostgreSQL" | "ClickHouse" | "Presto" | "Redis".
    pub engine: String,
    pub host: String,
    pub port: u16,
    #[serde(default)]
    pub username: Option<String>,
    /// Password or a `vault:<id>` reference (resolved server-side).
    #[serde(default)]
    pub password: Option<String>,
    /// Default database / schema name for SQL engines.
    #[serde(default)]
    pub database: Option<String>,
    /// Presto catalog name. Presto needs both catalog + schema to browse tables.
    #[serde(default)]
    pub catalog: Option<String>,
    /// TLS/SSL toggle.
    #[serde(default)]
    pub ssl: bool,
    /// Connection timeout in seconds (0 / absent → engine default).
    #[serde(default)]
    pub timeout_secs: Option<u64>,
    /// ClickHouse HTTP port (defaults to 8123 when absent).
    #[serde(default)]
    pub http_port: Option<u16>,
    /// ClickHouse protocol: "http" (default) or "native".
    #[serde(default)]
    pub protocol: Option<String>,
    /// Redis logical DB index (0-15).
    #[serde(default)]
    pub db_index: Option<i64>,
}

/// A column descriptor in a query result set.
#[derive(Debug, Clone, Serialize)]
pub struct ColumnInfo {
    pub name: String,
    #[serde(rename = "type")]
    pub type_name: String,
}

/// Result of `db_execute`. Rows are arrays of nullable strings aligned with
/// `columns` — the frontend grid renders strings and a distinct NULL badge.
#[derive(Debug, Clone, Serialize)]
pub struct QueryResult {
    pub columns: Vec<ColumnInfo>,
    pub rows: Vec<Vec<Option<String>>>,
    #[serde(rename = "rowsAffected")]
    pub rows_affected: u64,
    #[serde(rename = "durationMs")]
    pub duration_ms: u64,
    /// Server warnings / notices, when the engine exposes them.
    #[serde(default)]
    pub warnings: Vec<String>,
}

/// Incremental query result event sent over a Tauri Channel. Query commands
/// send column metadata first, then row batches, then one final completion
/// event with timing and warning information.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum QueryStreamEvent {
    Columns {
        columns: Vec<ColumnInfo>,
    },
    Rows {
        rows: Vec<Vec<Option<String>>>,
    },
    Done {
        #[serde(rename = "rowsAffected")]
        rows_affected: u64,
        #[serde(rename = "durationMs")]
        duration_ms: u64,
        #[serde(default)]
        warnings: Vec<String>,
    },
}

pub type QueryStreamChannel = Channel<QueryStreamEvent>;

pub(crate) fn send_query_stream_event(
    on_event: &QueryStreamChannel,
    event: QueryStreamEvent,
) -> Result<(), String> {
    on_event
        .send(event)
        .map_err(|e| format!("Query stream event failed: {e}"))
}

pub(crate) fn emit_query_result_stream(
    on_event: &QueryStreamChannel,
    result: QueryResult,
) -> Result<(), String> {
    if !result.columns.is_empty() {
        send_query_stream_event(
            on_event,
            QueryStreamEvent::Columns {
                columns: result.columns,
            },
        )?;
    }
    for rows in result.rows.chunks(100) {
        send_query_stream_event(
            on_event,
            QueryStreamEvent::Rows {
                rows: rows.to_vec(),
            },
        )?;
    }
    send_query_stream_event(
        on_event,
        QueryStreamEvent::Done {
            rows_affected: result.rows_affected,
            duration_ms: result.duration_ms,
            warnings: result.warnings,
        },
    )
}

/// A schema/database node.
#[derive(Debug, Clone, Serialize)]
pub struct SchemaInfo {
    pub name: String,
}

/// A table/view node.
#[derive(Debug, Clone, Serialize)]
pub struct TableInfo {
    pub name: String,
    /// "table" | "view" | "materialized_view".
    pub kind: String,
    /// Best-effort row count from engine catalog metadata. This may be
    /// approximate for engines that only expose estimates.
    #[serde(rename = "rowCount")]
    pub row_count: Option<i64>,
}

/// A column in a table description.
#[derive(Debug, Clone, Serialize)]
pub struct ColumnDescription {
    pub name: String,
    #[serde(rename = "type")]
    pub type_name: String,
    pub nullable: bool,
    pub default: Option<String>,
    #[serde(rename = "primaryKey")]
    pub primary_key: bool,
}

/// Index metadata.
#[derive(Debug, Clone, Serialize)]
pub struct IndexInfo {
    pub name: String,
    pub columns: Vec<String>,
    pub unique: bool,
}

/// The live, engine-specific connection handle. Held behind an `Arc` in
/// `AppState::db_connections`; SQL pools are internally `Send + Sync` so they
/// need no extra lock, while the Redis multiplexed connection is cloneable.
pub enum DbHandle {
    MySql(Pool<MySql>),
    Postgres(Pool<Postgres>),
    ClickHouse(clickhouse::ClickHouseClient),
    Presto(presto::PrestoClient),
    Redis(AsyncMutex<redis::aio::MultiplexedConnection>),
}

/// A cached database session: the live handle + a cancellation token so
/// `db_cancel` can interrupt an in-flight query on the same session.
pub struct DbSession {
    pub handle: DbHandle,
    pub cancel: AsyncMutex<CancellationToken>,
    shutdown: CancellationToken,
    keepalive: Option<JoinHandle<()>>,
}

impl DbSession {
    fn new(handle: DbHandle) -> Self {
        let shutdown = CancellationToken::new();
        let keepalive = start_keepalive(&handle, shutdown.clone());
        Self {
            handle,
            cancel: AsyncMutex::new(CancellationToken::new()),
            shutdown,
            keepalive,
        }
    }

    /// Replace the cancellation token with a fresh one and return it, so each
    /// query gets an independent token that `db_cancel` can trip.
    async fn fresh_cancel_token(&self) -> CancellationToken {
        let mut guard = self.cancel.lock().await;
        let token = CancellationToken::new();
        *guard = token.clone();
        token
    }
}

fn start_keepalive(handle: &DbHandle, shutdown: CancellationToken) -> Option<JoinHandle<()>> {
    const KEEPALIVE_INTERVAL_SECS: u64 = 30;

    match handle {
        DbHandle::MySql(pool) => {
            let pool = pool.clone();
            Some(tokio::spawn(async move {
                let mut interval =
                    tokio::time::interval(Duration::from_secs(KEEPALIVE_INTERVAL_SECS));
                interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
                loop {
                    tokio::select! {
                        _ = shutdown.cancelled() => break,
                        _ = interval.tick() => {
                            let _ = sql::ping_mysql(&pool).await;
                        }
                    }
                }
            }))
        }
        DbHandle::Postgres(pool) => {
            let pool = pool.clone();
            Some(tokio::spawn(async move {
                let mut interval =
                    tokio::time::interval(Duration::from_secs(KEEPALIVE_INTERVAL_SECS));
                interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
                loop {
                    tokio::select! {
                        _ = shutdown.cancelled() => break,
                        _ = interval.tick() => {
                            let _ = sql::ping_postgres(&pool).await;
                        }
                    }
                }
            }))
        }
        DbHandle::ClickHouse(client) => {
            let client = client.clone();
            Some(tokio::spawn(async move {
                let mut interval =
                    tokio::time::interval(Duration::from_secs(KEEPALIVE_INTERVAL_SECS));
                interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
                loop {
                    tokio::select! {
                        _ = shutdown.cancelled() => break,
                        _ = interval.tick() => {
                            let _ = clickhouse::ping(&client).await;
                        }
                    }
                }
            }))
        }
        DbHandle::Presto(client) => {
            let client = client.clone();
            Some(tokio::spawn(async move {
                let mut interval =
                    tokio::time::interval(Duration::from_secs(KEEPALIVE_INTERVAL_SECS));
                interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
                loop {
                    tokio::select! {
                        _ = shutdown.cancelled() => break,
                        _ = interval.tick() => {
                            let _ = presto::ping(&client).await;
                        }
                    }
                }
            }))
        }
        DbHandle::Redis(_) => None,
    }
}

async fn close_session(session: Arc<DbSession>) {
    session.shutdown.cancel();
    if let Some(task) = &session.keepalive {
        task.abort();
    }
    session.cancel.lock().await.cancel();
    match &session.handle {
        DbHandle::MySql(pool) => pool.close().await,
        DbHandle::Postgres(pool) => pool.close().await,
        DbHandle::ClickHouse(_) | DbHandle::Presto(_) | DbHandle::Redis(_) => {}
    }
}

/// Resolve a possibly-`vault:`-prefixed secret to plaintext. Returns the
/// original string when it is not a vault reference (backwards compatible with
/// inline plaintext passwords).
fn resolve_secret(
    state: &State<'_, AppState>,
    value: Option<&str>,
) -> Result<Option<String>, String> {
    match value {
        Some(v) if !v.is_empty() => match state.vault.resolve(v)? {
            Some(z) => Ok(Some((*z).clone())),
            None => Ok(Some(v.to_string())),
        },
        _ => Ok(None),
    }
}

async fn get_session(
    state: &State<'_, AppState>,
    session_id: &str,
) -> Result<Arc<DbSession>, String> {
    let map = state.db_connections.read().await;
    map.get(session_id)
        .cloned()
        .ok_or_else(|| format!("No active database connection for session {session_id}"))
}

// ---------------------------------------------------------------------------
// Tauri commands — connection lifecycle
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct DbConnectResult {
    pub ok: bool,
}

#[tauri::command]
pub async fn db_connect(
    state: State<'_, AppState>,
    session_id: String,
    config: DbConfig,
) -> Result<DbConnectResult, String> {
    let password = resolve_secret(&state, config.password.as_deref())?;
    let handle = match config.engine.as_str() {
        "MySQL" => sql::connect_mysql(&config, password.as_deref()).await?,
        "PostgreSQL" => sql::connect_postgres(&config, password.as_deref()).await?,
        "ClickHouse" => clickhouse::connect(&config, password.as_deref()).await?,
        "Presto" => presto::connect(&config, password.as_deref()).await?,
        "Redis" => redis_ops::connect(&config, password.as_deref()).await?,
        other => return Err(format!("Unsupported database engine: {other}")),
    };
    let session = Arc::new(DbSession::new(handle));
    let previous = {
        let mut map = state.db_connections.write().await;
        // If a stale session exists under this id, close it after releasing the map lock.
        map.insert(session_id, session)
    };
    if let Some(previous) = previous {
        close_session(previous).await;
    }
    Ok(DbConnectResult { ok: true })
}

#[tauri::command]
pub async fn db_ping(state: State<'_, AppState>, session_id: String) -> Result<String, String> {
    let session = get_session(&state, &session_id).await?;
    match &session.handle {
        DbHandle::MySql(pool) => sql::ping_mysql(pool).await,
        DbHandle::Postgres(pool) => sql::ping_postgres(pool).await,
        DbHandle::ClickHouse(client) => clickhouse::ping(client).await,
        DbHandle::Presto(client) => presto::ping(client).await,
        DbHandle::Redis(conn) => redis_ops::ping(conn).await,
    }
}

#[tauri::command]
pub async fn db_disconnect(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    let removed = {
        let mut map = state.db_connections.write().await;
        map.remove(&session_id)
    };
    if let Some(session) = removed {
        close_session(session).await;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Tauri commands — SQL schema introspection + queries
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn db_list_schemas(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Vec<SchemaInfo>, String> {
    let session = get_session(&state, &session_id).await?;
    match &session.handle {
        DbHandle::MySql(pool) => sql::list_schemas_mysql(pool).await,
        DbHandle::Postgres(pool) => sql::list_schemas_postgres(pool).await,
        DbHandle::ClickHouse(client) => clickhouse::list_schemas(client).await,
        DbHandle::Presto(client) => presto::list_schemas(client).await,
        DbHandle::Redis(_) => Err("Redis has no SQL schemas".into()),
    }
}

#[tauri::command]
pub async fn db_list_tables(
    state: State<'_, AppState>,
    session_id: String,
    schema: Option<String>,
) -> Result<Vec<TableInfo>, String> {
    let session = get_session(&state, &session_id).await?;
    match &session.handle {
        DbHandle::MySql(pool) => sql::list_tables_mysql(pool, schema.as_deref()).await,
        DbHandle::Postgres(pool) => sql::list_tables_postgres(pool, schema.as_deref()).await,
        DbHandle::ClickHouse(client) => clickhouse::list_tables(client, schema.as_deref()).await,
        DbHandle::Presto(client) => presto::list_tables(client, schema.as_deref()).await,
        DbHandle::Redis(_) => Err("Redis has no tables".into()),
    }
}

#[tauri::command]
pub async fn db_describe_table(
    state: State<'_, AppState>,
    session_id: String,
    schema: Option<String>,
    table: String,
) -> Result<Vec<ColumnDescription>, String> {
    let session = get_session(&state, &session_id).await?;
    match &session.handle {
        DbHandle::MySql(pool) => sql::describe_table_mysql(pool, schema.as_deref(), &table).await,
        DbHandle::Postgres(pool) => {
            sql::describe_table_postgres(pool, schema.as_deref(), &table).await
        }
        DbHandle::ClickHouse(client) => {
            clickhouse::describe_table(client, schema.as_deref(), &table).await
        }
        DbHandle::Presto(client) => presto::describe_table(client, schema.as_deref(), &table).await,
        DbHandle::Redis(_) => Err("Redis has no tables".into()),
    }
}

#[tauri::command]
pub async fn db_list_indexes(
    state: State<'_, AppState>,
    session_id: String,
    schema: Option<String>,
    table: String,
) -> Result<Vec<IndexInfo>, String> {
    let session = get_session(&state, &session_id).await?;
    match &session.handle {
        DbHandle::MySql(pool) => sql::list_indexes_mysql(pool, schema.as_deref(), &table).await,
        DbHandle::Postgres(pool) => {
            sql::list_indexes_postgres(pool, schema.as_deref(), &table).await
        }
        DbHandle::ClickHouse(_) => Ok(Vec::new()),
        DbHandle::Presto(client) => presto::list_indexes(client, schema.as_deref(), &table).await,
        DbHandle::Redis(_) => Err("Redis has no indexes".into()),
    }
}

#[tauri::command]
pub async fn db_execute(
    state: State<'_, AppState>,
    session_id: String,
    sql: String,
) -> Result<QueryResult, String> {
    let session = get_session(&state, &session_id).await?;
    let token = session.fresh_cancel_token().await;
    match &session.handle {
        DbHandle::MySql(pool) => sql::execute_mysql(pool, &sql, &token).await,
        DbHandle::Postgres(pool) => sql::execute_postgres(pool, &sql, &token).await,
        DbHandle::ClickHouse(client) => clickhouse::execute(client, &sql, &token).await,
        DbHandle::Presto(client) => presto::execute(client, &sql, &token).await,
        DbHandle::Redis(_) => Err("Use redis_exec for Redis commands".into()),
    }
}

#[tauri::command]
pub async fn db_execute_stream(
    state: State<'_, AppState>,
    session_id: String,
    sql: String,
    max_rows: Option<u64>,
    on_event: QueryStreamChannel,
) -> Result<(), String> {
    let session = get_session(&state, &session_id).await?;
    let token = session.fresh_cancel_token().await;
    match &session.handle {
        DbHandle::MySql(pool) => {
            sql::execute_mysql_stream(pool, &sql, max_rows, &token, &on_event).await
        }
        DbHandle::Postgres(pool) => {
            sql::execute_postgres_stream(pool, &sql, max_rows, &token, &on_event).await
        }
        DbHandle::ClickHouse(client) => {
            clickhouse::execute_stream(client, &sql, max_rows, &token, &on_event).await
        }
        DbHandle::Presto(client) => {
            presto::execute_stream(client, &sql, max_rows, &token, &on_event).await
        }
        DbHandle::Redis(_) => Err("Use redis_exec for Redis commands".into()),
    }
}

#[tauri::command]
pub async fn db_cancel(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    let session = get_session(&state, &session_id).await?;
    session.cancel.lock().await.cancel();
    Ok(())
}

// ---------------------------------------------------------------------------
// Tauri commands — Redis
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct RedisKeyEntry {
    pub key: String,
    #[serde(rename = "type")]
    pub kind: String,
    /// TTL in seconds: -1 = persistent, -2 = missing, else seconds remaining.
    pub ttl: i64,
}

#[derive(Debug, Serialize)]
pub struct RedisScanPage {
    pub cursor: String,
    pub keys: Vec<RedisKeyEntry>,
}

#[derive(Debug, Serialize)]
pub struct RedisValue {
    /// "string" | "hash" | "list" | "set" | "zset" | "stream" | "none".
    pub kind: String,
    /// JSON-encoded value whose shape depends on `kind`. Strings → JSON string;
    /// hashes/zsets → array of [field,value]; lists/sets → array of strings;
    /// streams → array of {id, fields}.
    pub value: serde_json::Value,
    pub ttl: i64,
    pub encoding: Option<String>,
    #[serde(rename = "memoryUsage")]
    pub memory_usage: Option<i64>,
}

#[tauri::command]
pub async fn redis_list_keys(
    state: State<'_, AppState>,
    session_id: String,
    pattern: String,
    cursor: String,
    count: u64,
) -> Result<RedisScanPage, String> {
    let session = get_session(&state, &session_id).await?;
    match &session.handle {
        DbHandle::Redis(conn) => redis_ops::list_keys(conn, &pattern, &cursor, count).await,
        _ => Err("redis_list_keys requires a Redis session".into()),
    }
}

#[tauri::command]
pub async fn redis_get_key(
    state: State<'_, AppState>,
    session_id: String,
    key: String,
) -> Result<RedisValue, String> {
    let session = get_session(&state, &session_id).await?;
    match &session.handle {
        DbHandle::Redis(conn) => redis_ops::get_key(conn, &key).await,
        _ => Err("redis_get_key requires a Redis session".into()),
    }
}

#[tauri::command]
pub async fn redis_set_key(
    state: State<'_, AppState>,
    session_id: String,
    key: String,
    kind: String,
    value: serde_json::Value,
    ttl: Option<i64>,
) -> Result<(), String> {
    let session = get_session(&state, &session_id).await?;
    match &session.handle {
        DbHandle::Redis(conn) => redis_ops::set_key(conn, &key, &kind, value, ttl).await,
        _ => Err("redis_set_key requires a Redis session".into()),
    }
}

#[tauri::command]
pub async fn redis_del_key(
    state: State<'_, AppState>,
    session_id: String,
    key: String,
) -> Result<(), String> {
    let session = get_session(&state, &session_id).await?;
    match &session.handle {
        DbHandle::Redis(conn) => redis_ops::del_key(conn, &key).await,
        _ => Err("redis_del_key requires a Redis session".into()),
    }
}

#[tauri::command]
pub async fn redis_exec(
    state: State<'_, AppState>,
    session_id: String,
    raw_command: String,
) -> Result<String, String> {
    let session = get_session(&state, &session_id).await?;
    match &session.handle {
        DbHandle::Redis(conn) => redis_ops::exec(conn, &raw_command).await,
        _ => Err("redis_exec requires a Redis session".into()),
    }
}

#[cfg(test)]
mod live_tests {
    use super::*;

    /// Live Hologres smoke test for issue #101. It is ignored so normal test
    /// runs do not depend on the user's network or credentials.
    #[tokio::test]
    #[ignore = "requires TAOMNI_TEST_HOST1/TAOMNI_TEST_AK1/TAOMNI_TEST_SK1 and Hologres network access"]
    async fn hologres_postgres_session_lists_schemas_and_executes_query() {
        let host = std::env::var("TAOMNI_TEST_HOST1")
            .expect("TAOMNI_TEST_HOST1 must contain the Hologres PostgreSQL host");
        let username = std::env::var("TAOMNI_TEST_AK1")
            .expect("TAOMNI_TEST_AK1 must contain the Hologres access key");
        let password = std::env::var("TAOMNI_TEST_SK1")
            .expect("TAOMNI_TEST_SK1 must contain the Hologres secret key");
        let config = DbConfig {
            engine: "PostgreSQL".into(),
            host,
            port: 80,
            username: Some(username),
            password: Some(password),
            database: Some("cdp".into()),
            catalog: None,
            ssl: false,
            timeout_secs: Some(30),
            http_port: None,
            protocol: None,
            db_index: None,
        };

        let handle = sql::connect_postgres(&config, config.password.as_deref())
            .await
            .expect("Hologres PostgreSQL connect should succeed");
        let pool = match handle {
            DbHandle::Postgres(pool) => pool,
            _ => unreachable!("PostgreSQL config must create a Postgres pool"),
        };

        let schemas = sql::list_schemas_postgres(&pool)
            .await
            .expect("Hologres PostgreSQL schema listing should succeed");
        assert!(
            !schemas.is_empty(),
            "Hologres PostgreSQL schema listing should return at least one schema"
        );

        let result =
            sql::execute_postgres(&pool, "SELECT 1 AS taomni_smoke", &CancellationToken::new())
                .await
                .expect("Hologres PostgreSQL query execution should succeed");
        assert_eq!(result.columns[0].name, "taomni_smoke");
        assert_eq!(result.rows[0][0].as_deref(), Some("1"));

        pool.close().await;
    }
}
