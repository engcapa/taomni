//! MySQL / PostgreSQL backend via `sqlx`. Values are decoded to `Option<String>`
//! based on the column's SQL type so the frontend grid can render them as text
//! with a distinct NULL badge.

use std::{
    collections::{BTreeMap, BTreeSet},
    time::{Duration, Instant},
};

use futures::TryStreamExt;
use sqlx::mysql::{MySqlConnectOptions, MySqlPoolOptions, MySqlSslMode};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions, PgSslMode};
use sqlx::{Column, Row, TypeInfo};
use tokio_util::sync::CancellationToken;

use super::{
    send_query_stream_event, ColumnDescription, ColumnInfo, DbConfig, DbHandle, IndexInfo,
    QueryResult, QueryStreamChannel, QueryStreamEvent, SchemaInfo, TableInfo,
};

const DEFAULT_TIMEOUT_SECS: u64 = 15;
const STREAM_BATCH_ROWS: usize = 100;

fn timeout(config: &DbConfig) -> Duration {
    Duration::from_secs(match config.timeout_secs {
        Some(s) if s > 0 => s,
        _ => DEFAULT_TIMEOUT_SECS,
    })
}

// ---------------------------------------------------------------------------
// Connect
// ---------------------------------------------------------------------------

pub async fn connect_mysql(config: &DbConfig, password: Option<&str>) -> Result<DbHandle, String> {
    let mut opts = MySqlConnectOptions::new()
        .host(&config.host)
        .port(config.port);
    if let Some(user) = config.username.as_deref().filter(|u| !u.is_empty()) {
        opts = opts.username(user);
    }
    if let Some(pw) = password {
        opts = opts.password(pw);
    }
    if let Some(db) = config.database.as_deref().filter(|d| !d.is_empty()) {
        opts = opts.database(db);
    }
    opts = opts.ssl_mode(if config.ssl {
        MySqlSslMode::Preferred
    } else {
        MySqlSslMode::Disabled
    });

    let pool = MySqlPoolOptions::new()
        .max_connections(1)
        .acquire_timeout(timeout(config))
        .test_before_acquire(true)
        .connect_with(opts)
        .await
        .map_err(|e| format!("MySQL connect failed: {e}"))?;
    Ok(DbHandle::MySql(pool))
}

pub async fn connect_postgres(
    config: &DbConfig,
    password: Option<&str>,
) -> Result<DbHandle, String> {
    let mut opts = PgConnectOptions::new().host(&config.host).port(config.port);
    if let Some(user) = config.username.as_deref().filter(|u| !u.is_empty()) {
        opts = opts.username(user);
    }
    if let Some(pw) = password {
        opts = opts.password(pw);
    }
    if let Some(db) = config.database.as_deref().filter(|d| !d.is_empty()) {
        opts = opts.database(db);
    }
    opts = opts.ssl_mode(if config.ssl {
        PgSslMode::Prefer
    } else {
        PgSslMode::Disable
    });

    let pool = PgPoolOptions::new()
        .max_connections(1)
        .acquire_timeout(timeout(config))
        .test_before_acquire(true)
        .connect_with(opts)
        .await
        .map_err(|e| format!("PostgreSQL connect failed: {e}"))?;
    Ok(DbHandle::Postgres(pool))
}

// ---------------------------------------------------------------------------
// Ping
// ---------------------------------------------------------------------------

pub async fn ping_mysql(pool: &sqlx::Pool<sqlx::MySql>) -> Result<String, String> {
    sqlx::query("SELECT 1")
        .execute(pool)
        .await
        .map_err(|e| format!("MySQL ping failed: {e}"))?;
    Ok("MySQL connection OK".into())
}

pub async fn ping_postgres(pool: &sqlx::Pool<sqlx::Postgres>) -> Result<String, String> {
    sqlx::query("SELECT 1")
        .execute(pool)
        .await
        .map_err(|e| format!("PostgreSQL ping failed: {e}"))?;
    Ok("PostgreSQL connection OK".into())
}

// ---------------------------------------------------------------------------
// Value decoding
// ---------------------------------------------------------------------------

/// Decode the i-th column of a MySQL row to an optional display string. The
/// column's SQL type name drives which concrete `try_get` is attempted, with a
/// raw-bytes / lossy-utf8 fallback so unknown types never panic.
fn mysql_value_to_string(row: &sqlx::mysql::MySqlRow, i: usize) -> Option<String> {
    let col = &row.columns()[i];
    let type_name = col.type_info().name().to_uppercase();
    macro_rules! try_as {
        ($t:ty) => {
            if let Ok(v) = row.try_get::<Option<$t>, _>(i) {
                return v.map(|x| x.to_string());
            }
        };
    }
    match type_name.as_str() {
        "BOOLEAN" | "BOOL" => try_as!(bool),
        "TINYINT" | "SMALLINT" | "MEDIUMINT" | "INT" | "INTEGER" => try_as!(i64),
        "TINYINT UNSIGNED" | "SMALLINT UNSIGNED" | "INT UNSIGNED" | "BIGINT UNSIGNED" => {
            try_as!(u64)
        }
        "BIGINT" => try_as!(i64),
        "FLOAT" => try_as!(f32),
        "DOUBLE" | "REAL" => try_as!(f64),
        "DECIMAL" | "NUMERIC" => try_as!(sqlx::types::BigDecimal),
        "DATE" => try_as!(chrono::NaiveDate),
        "TIME" => try_as!(chrono::NaiveTime),
        "DATETIME" | "TIMESTAMP" => try_as!(chrono::NaiveDateTime),
        "JSON" => {
            if let Ok(v) = row.try_get::<Option<serde_json::Value>, _>(i) {
                return v.map(|x| x.to_string());
            }
        }
        _ => {}
    }
    // Fallback: text, then raw bytes (lossy utf8 for BLOB/VARBINARY).
    if let Ok(v) = row.try_get::<Option<String>, _>(i) {
        return v;
    }
    if let Ok(v) = row.try_get::<Option<Vec<u8>>, _>(i) {
        return v.map(|b| String::from_utf8_lossy(&b).into_owned());
    }
    None
}

/// Decode the i-th column of a PostgreSQL row to an optional display string.
fn pg_value_to_string(row: &sqlx::postgres::PgRow, i: usize) -> Option<String> {
    let col = &row.columns()[i];
    let type_name = col.type_info().name().to_uppercase();
    macro_rules! try_as {
        ($t:ty) => {
            if let Ok(v) = row.try_get::<Option<$t>, _>(i) {
                return v.map(|x| x.to_string());
            }
        };
    }
    match type_name.as_str() {
        "BOOL" => try_as!(bool),
        "INT2" => try_as!(i16),
        "INT4" => try_as!(i32),
        "INT8" => try_as!(i64),
        "FLOAT4" => try_as!(f32),
        "FLOAT8" => try_as!(f64),
        "NUMERIC" => try_as!(sqlx::types::BigDecimal),
        "DATE" => try_as!(chrono::NaiveDate),
        "TIME" => try_as!(chrono::NaiveTime),
        "TIMESTAMP" => try_as!(chrono::NaiveDateTime),
        "TIMESTAMPTZ" => try_as!(chrono::DateTime<chrono::Utc>),
        "UUID" => try_as!(sqlx::types::Uuid),
        "JSON" | "JSONB" => {
            if let Ok(v) = row.try_get::<Option<serde_json::Value>, _>(i) {
                return v.map(|x| x.to_string());
            }
        }
        _ => {}
    }
    if let Ok(v) = row.try_get::<Option<String>, _>(i) {
        return v;
    }
    if let Ok(v) = row.try_get::<Option<Vec<u8>>, _>(i) {
        return v.map(|b| String::from_utf8_lossy(&b).into_owned());
    }
    None
}

/// Heuristic: does the statement return rows? (SELECT/SHOW/DESCRIBE/WITH/...)
fn is_query(sql: &str) -> bool {
    let trimmed = sql.trim_start();
    let head: String = trimmed
        .chars()
        .take_while(|c| c.is_alphabetic())
        .collect::<String>()
        .to_uppercase();
    matches!(
        head.as_str(),
        "SELECT"
            | "SHOW"
            | "DESCRIBE"
            | "DESC"
            | "EXPLAIN"
            | "WITH"
            | "TABLE"
            | "VALUES"
            | "PRAGMA"
    )
}

fn limit_warning(limit_reached: bool, max_rows: Option<u64>) -> Vec<String> {
    match (limit_reached, max_rows) {
        (true, Some(limit)) => vec![format!("Result limited to {limit} rows")],
        _ => Vec::new(),
    }
}

// ---------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------

pub async fn execute_mysql(
    pool: &sqlx::Pool<sqlx::MySql>,
    sql: &str,
    token: &CancellationToken,
) -> Result<QueryResult, String> {
    let start = Instant::now();
    if is_query(sql) {
        let fetch = sqlx::query(sql).fetch_all(pool);
        let rows = tokio::select! {
            _ = token.cancelled() => return Err("Query cancelled".into()),
            r = fetch => r.map_err(|e| format!("Query failed: {e}"))?,
        };
        let columns = if let Some(first) = rows.first() {
            first
                .columns()
                .iter()
                .map(|c| ColumnInfo {
                    name: c.name().to_string(),
                    type_name: c.type_info().name().to_string(),
                })
                .collect()
        } else {
            Vec::new()
        };
        let mut out_rows = Vec::with_capacity(rows.len());
        for row in &rows {
            let mut vals = Vec::with_capacity(row.columns().len());
            for i in 0..row.columns().len() {
                vals.push(mysql_value_to_string(row, i));
            }
            out_rows.push(vals);
        }
        Ok(QueryResult {
            columns,
            rows_affected: 0,
            rows: out_rows,
            duration_ms: start.elapsed().as_millis() as u64,
            warnings: Vec::new(),
        })
    } else {
        let exec = sqlx::query(sql).execute(pool);
        let res = tokio::select! {
            _ = token.cancelled() => return Err("Query cancelled".into()),
            r = exec => r.map_err(|e| format!("Statement failed: {e}"))?,
        };
        Ok(QueryResult {
            columns: Vec::new(),
            rows: Vec::new(),
            rows_affected: res.rows_affected(),
            duration_ms: start.elapsed().as_millis() as u64,
            warnings: Vec::new(),
        })
    }
}

pub async fn execute_postgres(
    pool: &sqlx::Pool<sqlx::Postgres>,
    sql: &str,
    token: &CancellationToken,
) -> Result<QueryResult, String> {
    let start = Instant::now();
    if is_query(sql) {
        let fetch = sqlx::query(sql).fetch_all(pool);
        let rows = tokio::select! {
            _ = token.cancelled() => return Err("Query cancelled".into()),
            r = fetch => r.map_err(|e| format!("Query failed: {e}"))?,
        };
        let columns = if let Some(first) = rows.first() {
            first
                .columns()
                .iter()
                .map(|c| ColumnInfo {
                    name: c.name().to_string(),
                    type_name: c.type_info().name().to_string(),
                })
                .collect()
        } else {
            Vec::new()
        };
        let mut out_rows = Vec::with_capacity(rows.len());
        for row in &rows {
            let mut vals = Vec::with_capacity(row.columns().len());
            for i in 0..row.columns().len() {
                vals.push(pg_value_to_string(row, i));
            }
            out_rows.push(vals);
        }
        Ok(QueryResult {
            columns,
            rows_affected: 0,
            rows: out_rows,
            duration_ms: start.elapsed().as_millis() as u64,
            warnings: Vec::new(),
        })
    } else {
        let exec = sqlx::query(sql).execute(pool);
        let res = tokio::select! {
            _ = token.cancelled() => return Err("Query cancelled".into()),
            r = exec => r.map_err(|e| format!("Statement failed: {e}"))?,
        };
        Ok(QueryResult {
            columns: Vec::new(),
            rows: Vec::new(),
            rows_affected: res.rows_affected(),
            duration_ms: start.elapsed().as_millis() as u64,
            warnings: Vec::new(),
        })
    }
}

pub async fn execute_mysql_stream(
    pool: &sqlx::Pool<sqlx::MySql>,
    sql: &str,
    max_rows: Option<u64>,
    token: &CancellationToken,
    on_event: &QueryStreamChannel,
) -> Result<(), String> {
    let start = Instant::now();
    if is_query(sql) {
        let mut stream = sqlx::query(sql).fetch(pool);
        let mut columns_sent = false;
        let mut row_count = 0_u64;
        let max_rows = max_rows.filter(|value| *value > 0);
        let mut limit_reached = false;
        let mut batch: Vec<Vec<Option<String>>> = Vec::with_capacity(STREAM_BATCH_ROWS);

        loop {
            if max_rows.is_some_and(|limit| row_count >= limit) {
                limit_reached = true;
                break;
            }
            let next = tokio::select! {
                _ = token.cancelled() => return Err("Query cancelled".into()),
                r = stream.try_next() => r.map_err(|e| format!("Query failed: {e}"))?,
            };
            let Some(row) = next else {
                break;
            };

            if !columns_sent {
                let columns = row
                    .columns()
                    .iter()
                    .map(|c| ColumnInfo {
                        name: c.name().to_string(),
                        type_name: c.type_info().name().to_string(),
                    })
                    .collect();
                send_query_stream_event(on_event, QueryStreamEvent::Columns { columns })?;
                columns_sent = true;
            }

            let mut vals = Vec::with_capacity(row.columns().len());
            for i in 0..row.columns().len() {
                vals.push(mysql_value_to_string(&row, i));
            }
            batch.push(vals);
            row_count += 1;
            if batch.len() >= STREAM_BATCH_ROWS {
                send_query_stream_event(
                    on_event,
                    QueryStreamEvent::Rows {
                        rows: std::mem::take(&mut batch),
                    },
                )?;
            }
        }

        if !batch.is_empty() {
            send_query_stream_event(on_event, QueryStreamEvent::Rows { rows: batch })?;
        }
        send_query_stream_event(
            on_event,
            QueryStreamEvent::Done {
                rows_affected: 0,
                duration_ms: start.elapsed().as_millis() as u64,
                warnings: limit_warning(limit_reached, max_rows),
            },
        )
    } else {
        let exec = sqlx::query(sql).execute(pool);
        let res = tokio::select! {
            _ = token.cancelled() => return Err("Query cancelled".into()),
            r = exec => r.map_err(|e| format!("Statement failed: {e}"))?,
        };
        send_query_stream_event(
            on_event,
            QueryStreamEvent::Done {
                rows_affected: res.rows_affected(),
                duration_ms: start.elapsed().as_millis() as u64,
                warnings: Vec::new(),
            },
        )
    }
}

pub async fn execute_postgres_stream(
    pool: &sqlx::Pool<sqlx::Postgres>,
    sql: &str,
    max_rows: Option<u64>,
    token: &CancellationToken,
    on_event: &QueryStreamChannel,
) -> Result<(), String> {
    let start = Instant::now();
    if is_query(sql) {
        let mut stream = sqlx::query(sql).fetch(pool);
        let mut columns_sent = false;
        let mut row_count = 0_u64;
        let max_rows = max_rows.filter(|value| *value > 0);
        let mut limit_reached = false;
        let mut batch: Vec<Vec<Option<String>>> = Vec::with_capacity(STREAM_BATCH_ROWS);

        loop {
            if max_rows.is_some_and(|limit| row_count >= limit) {
                limit_reached = true;
                break;
            }
            let next = tokio::select! {
                _ = token.cancelled() => return Err("Query cancelled".into()),
                r = stream.try_next() => r.map_err(|e| format!("Query failed: {e}"))?,
            };
            let Some(row) = next else {
                break;
            };

            if !columns_sent {
                let columns = row
                    .columns()
                    .iter()
                    .map(|c| ColumnInfo {
                        name: c.name().to_string(),
                        type_name: c.type_info().name().to_string(),
                    })
                    .collect();
                send_query_stream_event(on_event, QueryStreamEvent::Columns { columns })?;
                columns_sent = true;
            }

            let mut vals = Vec::with_capacity(row.columns().len());
            for i in 0..row.columns().len() {
                vals.push(pg_value_to_string(&row, i));
            }
            batch.push(vals);
            row_count += 1;
            if batch.len() >= STREAM_BATCH_ROWS {
                send_query_stream_event(
                    on_event,
                    QueryStreamEvent::Rows {
                        rows: std::mem::take(&mut batch),
                    },
                )?;
            }
        }

        if !batch.is_empty() {
            send_query_stream_event(on_event, QueryStreamEvent::Rows { rows: batch })?;
        }
        send_query_stream_event(
            on_event,
            QueryStreamEvent::Done {
                rows_affected: 0,
                duration_ms: start.elapsed().as_millis() as u64,
                warnings: limit_warning(limit_reached, max_rows),
            },
        )
    } else {
        let exec = sqlx::query(sql).execute(pool);
        let res = tokio::select! {
            _ = token.cancelled() => return Err("Query cancelled".into()),
            r = exec => r.map_err(|e| format!("Statement failed: {e}"))?,
        };
        send_query_stream_event(
            on_event,
            QueryStreamEvent::Done {
                rows_affected: res.rows_affected(),
                duration_ms: start.elapsed().as_millis() as u64,
                warnings: Vec::new(),
            },
        )
    }
}

// ---------------------------------------------------------------------------
// Schema introspection — MySQL
// ---------------------------------------------------------------------------

fn quote_mysql_ident(ident: &str) -> String {
    format!("`{}`", ident.replace('`', "``"))
}

fn quote_mysql_table(schema: Option<&str>, table: &str) -> String {
    match schema {
        Some(schema) => format!("{}.{}", quote_mysql_ident(schema), quote_mysql_ident(table)),
        None => quote_mysql_ident(table),
    }
}

fn add_mysql_schema_name(names: &mut BTreeSet<String>, name: Option<String>) {
    if let Some(name) = name.map(|n| n.trim().to_string()) {
        if !name.is_empty() {
            names.insert(name);
        }
    }
}

async fn current_mysql_database(
    pool: &sqlx::Pool<sqlx::MySql>,
) -> Result<Option<String>, sqlx::Error> {
    sqlx::query("SELECT DATABASE()")
        .fetch_optional(pool)
        .await?
        .and_then(|r| r.try_get::<Option<String>, _>(0).ok().flatten())
        .map_or(Ok(None), |db| Ok(Some(db)))
}

async fn list_schemas_mysql_show(
    pool: &sqlx::Pool<sqlx::MySql>,
) -> Result<Vec<String>, sqlx::Error> {
    let rows = sqlx::query("SHOW DATABASES").fetch_all(pool).await?;
    Ok(rows
        .iter()
        .filter_map(|r| mysql_value_to_string(r, 0))
        .collect())
}

fn mysql_table_kind(table_type: &str) -> String {
    if table_type.eq_ignore_ascii_case("VIEW") {
        "view".to_string()
    } else {
        "table".to_string()
    }
}

fn mysql_non_unique_is_unique(row: &sqlx::mysql::MySqlRow, index: usize) -> bool {
    if let Ok(v) = row.try_get::<i64, _>(index) {
        return v == 0;
    }
    if let Ok(v) = row.try_get::<u64, _>(index) {
        return v == 0;
    }
    false
}

async fn list_tables_mysql_show(
    pool: &sqlx::Pool<sqlx::MySql>,
    schema: Option<&str>,
) -> Result<Vec<TableInfo>, sqlx::Error> {
    let sql = match schema {
        Some(schema) => format!("SHOW FULL TABLES FROM {}", quote_mysql_ident(schema)),
        None => "SHOW FULL TABLES".to_string(),
    };
    let rows = sqlx::query(&sql).fetch_all(pool).await?;
    Ok(rows
        .iter()
        .filter_map(|r| {
            let name = mysql_value_to_string(r, 0)?;
            let table_type = mysql_value_to_string(r, 1).unwrap_or_default();
            Some(TableInfo {
                name,
                kind: mysql_table_kind(&table_type),
                row_count: None,
            })
        })
        .collect())
}

async fn describe_table_mysql_show(
    pool: &sqlx::Pool<sqlx::MySql>,
    schema: Option<&str>,
    table: &str,
) -> Result<Vec<ColumnDescription>, sqlx::Error> {
    let sql = format!(
        "SHOW FULL COLUMNS FROM {}",
        quote_mysql_table(schema, table)
    );
    let rows = sqlx::query(&sql).fetch_all(pool).await?;
    Ok(rows
        .iter()
        .filter_map(|r| {
            let name = mysql_value_to_string(r, 0)?;
            let type_name = mysql_value_to_string(r, 1).unwrap_or_default();
            let nullable = mysql_value_to_string(r, 3).unwrap_or_default();
            let key = mysql_value_to_string(r, 4).unwrap_or_default();
            let default = mysql_value_to_string(r, 5);
            Some(ColumnDescription {
                name,
                type_name,
                nullable: nullable.eq_ignore_ascii_case("YES"),
                default,
                primary_key: key.eq_ignore_ascii_case("PRI"),
            })
        })
        .collect())
}

async fn list_indexes_mysql_show(
    pool: &sqlx::Pool<sqlx::MySql>,
    schema: Option<&str>,
    table: &str,
) -> Result<Vec<IndexInfo>, sqlx::Error> {
    let sql = format!("SHOW INDEX FROM {}", quote_mysql_table(schema, table));
    let rows = sqlx::query(&sql).fetch_all(pool).await?;
    let mut parsed: Vec<(String, i64, String, bool)> = rows
        .iter()
        .filter_map(|r| {
            let name = mysql_value_to_string(r, 2)?;
            let seq: i64 = r
                .try_get::<i64, _>(3)
                .ok()
                .or_else(|| {
                    r.try_get::<u64, _>(3)
                        .ok()
                        .and_then(|v| i64::try_from(v).ok())
                })
                .unwrap_or(0);
            let col = mysql_value_to_string(r, 4).unwrap_or_default();
            Some((name, seq, col, mysql_non_unique_is_unique(r, 1)))
        })
        .collect();
    parsed.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
    Ok(group_indexes(
        parsed
            .into_iter()
            .map(|(name, _seq, col, unique)| (name, col, unique)),
    ))
}

pub async fn list_schemas_mysql(pool: &sqlx::Pool<sqlx::MySql>) -> Result<Vec<SchemaInfo>, String> {
    let mut names = BTreeSet::new();
    let mut errors = Vec::new();

    match sqlx::query(
        "SELECT schema_name FROM information_schema.schemata \
         WHERE schema_name NOT IN ('information_schema','mysql','sys','performance_schema') \
         ORDER BY schema_name",
    )
    .fetch_all(pool)
    .await
    {
        Ok(rows) => {
            for row in &rows {
                add_mysql_schema_name(&mut names, mysql_value_to_string(row, 0));
            }
        }
        Err(err) => errors.push(format!("information_schema.schemata: {err}")),
    }

    match list_schemas_mysql_show(pool).await {
        Ok(show_names) => {
            for name in show_names {
                add_mysql_schema_name(&mut names, Some(name));
            }
        }
        Err(err) => {
            if names.is_empty() {
                errors.push(format!("SHOW DATABASES: {err}"));
            }
        }
    }

    match current_mysql_database(pool).await {
        Ok(current) => add_mysql_schema_name(&mut names, current),
        Err(err) => errors.push(format!("SELECT DATABASE(): {err}")),
    }

    if names.is_empty() && !errors.is_empty() {
        return Err(format!("list schemas failed: {}", errors.join("; ")));
    }

    Ok(names.into_iter().map(|name| SchemaInfo { name }).collect())
}

pub async fn list_tables_mysql(
    pool: &sqlx::Pool<sqlx::MySql>,
    schema: Option<&str>,
) -> Result<Vec<TableInfo>, String> {
    let q = if schema.is_some() {
        "SELECT table_name, table_type, table_rows FROM information_schema.tables \
         WHERE table_schema = ? ORDER BY table_name"
    } else {
        "SELECT table_name, table_type, table_rows FROM information_schema.tables \
         WHERE table_schema = DATABASE() ORDER BY table_name"
    };
    let mut query = sqlx::query(q);
    if let Some(s) = schema {
        query = query.bind(s);
    }
    let mut tables = BTreeMap::<String, TableInfo>::new();
    let mut errors = Vec::new();

    match query.fetch_all(pool).await {
        Ok(rows) => {
            for r in &rows {
                if let Some(name) = mysql_value_to_string(r, 0) {
                    let table_type = mysql_value_to_string(r, 1).unwrap_or_default();
                    let row_count = r.try_get::<Option<i64>, _>(2).ok().flatten().or_else(|| {
                        r.try_get::<Option<u64>, _>(2)
                            .ok()
                            .flatten()
                            .and_then(|v| i64::try_from(v).ok())
                            .or_else(|| {
                                mysql_value_to_string(r, 2).and_then(|v| v.parse::<i64>().ok())
                            })
                    });
                    tables.insert(
                        name.clone(),
                        TableInfo {
                            name,
                            kind: mysql_table_kind(&table_type),
                            row_count,
                        },
                    );
                }
            }
        }
        Err(err) => errors.push(format!("information_schema.tables: {err}")),
    }

    match list_tables_mysql_show(pool, schema).await {
        Ok(show_tables) => {
            for table in show_tables {
                tables.entry(table.name.clone()).or_insert(table);
            }
        }
        Err(err) => {
            if tables.is_empty() {
                errors.push(format!("SHOW FULL TABLES: {err}"));
            }
        }
    }

    if tables.is_empty() && !errors.is_empty() {
        return Err(format!("list tables failed: {}", errors.join("; ")));
    }

    Ok(tables.into_values().collect())
}

pub async fn describe_table_mysql(
    pool: &sqlx::Pool<sqlx::MySql>,
    schema: Option<&str>,
    table: &str,
) -> Result<Vec<ColumnDescription>, String> {
    let q = "SELECT column_name, column_type, is_nullable, column_default, column_key \
             FROM information_schema.columns \
             WHERE table_schema = COALESCE(?, DATABASE()) AND table_name = ? \
             ORDER BY ordinal_position";
    let rows = match sqlx::query(q)
        .bind(schema)
        .bind(table)
        .fetch_all(pool)
        .await
    {
        Ok(rows) if !rows.is_empty() => rows,
        Ok(_) => {
            return describe_table_mysql_show(pool, schema, table)
                .await
                .map_err(|e| format!("describe table failed: {e}"))
        }
        Err(err) => {
            return describe_table_mysql_show(pool, schema, table)
                .await
                .map_err(|show_err| {
                    format!(
                        "describe table failed: information_schema.columns: {err}; SHOW FULL COLUMNS: {show_err}"
                    )
                });
        }
    };
    Ok(rows
        .iter()
        .filter_map(|r| {
            let name = mysql_value_to_string(r, 0)?;
            let type_name = mysql_value_to_string(r, 1).unwrap_or_default();
            let nullable = mysql_value_to_string(r, 2).unwrap_or_default();
            let default = mysql_value_to_string(r, 3);
            let key = mysql_value_to_string(r, 4).unwrap_or_default();
            Some(ColumnDescription {
                name,
                type_name,
                nullable: nullable.eq_ignore_ascii_case("YES"),
                default,
                primary_key: key.eq_ignore_ascii_case("PRI"),
            })
        })
        .collect())
}

pub async fn list_indexes_mysql(
    pool: &sqlx::Pool<sqlx::MySql>,
    schema: Option<&str>,
    table: &str,
) -> Result<Vec<IndexInfo>, String> {
    let q = "SELECT index_name, column_name, non_unique \
             FROM information_schema.statistics \
             WHERE table_schema = COALESCE(?, DATABASE()) AND table_name = ? \
             ORDER BY index_name, seq_in_index";
    let rows = match sqlx::query(q)
        .bind(schema)
        .bind(table)
        .fetch_all(pool)
        .await
    {
        Ok(rows) if !rows.is_empty() => rows,
        Ok(_) => {
            return list_indexes_mysql_show(pool, schema, table)
                .await
                .map_err(|e| format!("list indexes failed: {e}"))
        }
        Err(err) => {
            return list_indexes_mysql_show(pool, schema, table)
                .await
                .map_err(|show_err| {
                    format!(
                        "list indexes failed: information_schema.statistics: {err}; SHOW INDEX: {show_err}"
                    )
                });
        }
    };
    Ok(group_indexes(rows.iter().filter_map(|r| {
        let name = mysql_value_to_string(r, 0)?;
        let col = mysql_value_to_string(r, 1).unwrap_or_default();
        // non_unique is 0 for unique indexes.
        Some((name, col, mysql_non_unique_is_unique(r, 2)))
    })))
}

// ---------------------------------------------------------------------------
// Schema introspection — PostgreSQL
// ---------------------------------------------------------------------------

pub async fn list_schemas_postgres(
    pool: &sqlx::Pool<sqlx::Postgres>,
) -> Result<Vec<SchemaInfo>, String> {
    let rows = sqlx::query(
        "SELECT schema_name FROM information_schema.schemata \
         WHERE schema_name NOT LIKE 'pg_%' AND schema_name <> 'information_schema' \
         ORDER BY schema_name",
    )
    .fetch_all(pool)
    .await
    .map_err(|e| format!("list schemas failed: {e}"))?;
    Ok(rows
        .iter()
        .filter_map(|r| r.try_get::<String, _>(0).ok())
        .map(|name| SchemaInfo { name })
        .collect())
}

pub async fn list_tables_postgres(
    pool: &sqlx::Pool<sqlx::Postgres>,
    schema: Option<&str>,
) -> Result<Vec<TableInfo>, String> {
    let schema = schema.unwrap_or("public");
    let rows = sqlx::query(
        "SELECT t.table_name, t.table_type, \
                CASE WHEN c.reltuples >= 0 THEN c.reltuples::bigint ELSE NULL END AS row_count \
         FROM information_schema.tables t \
         LEFT JOIN pg_namespace n ON n.nspname = t.table_schema \
         LEFT JOIN pg_class c ON c.relname = t.table_name AND c.relnamespace = n.oid \
         WHERE t.table_schema = $1 ORDER BY t.table_name",
    )
    .bind(schema)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("list tables failed: {e}"))?;
    let mut out: Vec<TableInfo> = rows
        .iter()
        .filter_map(|r| {
            let name: String = r.try_get(0).ok()?;
            let t: String = r.try_get(1).unwrap_or_default();
            let row_count: Option<i64> = r.try_get(2).ok().flatten();
            let kind = if t.eq_ignore_ascii_case("VIEW") {
                "view"
            } else {
                "table"
            };
            Some(TableInfo {
                name,
                kind: kind.to_string(),
                row_count,
            })
        })
        .collect();
    // Materialized views live in pg_matviews, not information_schema.
    if let Ok(mvs) = sqlx::query("SELECT matviewname FROM pg_matviews WHERE schemaname = $1")
        .bind(schema)
        .fetch_all(pool)
        .await
    {
        for r in &mvs {
            if let Ok(name) = r.try_get::<String, _>(0) {
                out.push(TableInfo {
                    name,
                    kind: "materialized_view".to_string(),
                    row_count: None,
                });
            }
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

pub async fn describe_table_postgres(
    pool: &sqlx::Pool<sqlx::Postgres>,
    schema: Option<&str>,
    table: &str,
) -> Result<Vec<ColumnDescription>, String> {
    let schema = schema.unwrap_or("public");
    let rows = sqlx::query(
        "SELECT c.column_name, c.data_type, c.is_nullable, c.column_default, \
            COALESCE(pk.is_pk, false) AS is_pk \
         FROM information_schema.columns c \
         LEFT JOIN ( \
            SELECT kcu.column_name, true AS is_pk \
            FROM information_schema.table_constraints tc \
            JOIN information_schema.key_column_usage kcu \
              ON tc.constraint_name = kcu.constraint_name \
             AND tc.table_schema = kcu.table_schema \
            WHERE tc.constraint_type = 'PRIMARY KEY' \
              AND tc.table_schema = $1 AND tc.table_name = $2 \
         ) pk ON pk.column_name = c.column_name \
         WHERE c.table_schema = $1 AND c.table_name = $2 \
         ORDER BY c.ordinal_position",
    )
    .bind(schema)
    .bind(table)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("describe table failed: {e}"))?;
    Ok(rows
        .iter()
        .filter_map(|r| {
            let name: String = r.try_get(0).ok()?;
            let type_name: String = r.try_get(1).unwrap_or_default();
            let nullable: String = r.try_get(2).unwrap_or_default();
            let default: Option<String> = r.try_get(3).ok().flatten();
            let primary_key: bool = r.try_get(4).unwrap_or(false);
            Some(ColumnDescription {
                name,
                type_name,
                nullable: nullable.eq_ignore_ascii_case("YES"),
                default,
                primary_key,
            })
        })
        .collect())
}

pub async fn list_indexes_postgres(
    pool: &sqlx::Pool<sqlx::Postgres>,
    schema: Option<&str>,
    table: &str,
) -> Result<Vec<IndexInfo>, String> {
    let schema = schema.unwrap_or("public");
    let rows = sqlx::query(
        "SELECT i.relname AS index_name, a.attname AS column_name, ix.indisunique AS is_unique \
         FROM pg_class t \
         JOIN pg_namespace n ON n.oid = t.relnamespace \
         JOIN pg_index ix ON t.oid = ix.indrelid \
         JOIN pg_class i ON i.oid = ix.indexrelid \
         JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey) \
         WHERE n.nspname = $1 AND t.relname = $2 \
         ORDER BY i.relname, array_position(ix.indkey, a.attnum)",
    )
    .bind(schema)
    .bind(table)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("list indexes failed: {e}"))?;
    Ok(group_indexes(rows.iter().filter_map(|r| {
        let name: String = r.try_get(0).ok()?;
        let col: String = r.try_get(1).unwrap_or_default();
        let unique: bool = r.try_get(2).unwrap_or(false);
        Some((name, col, unique))
    })))
}

/// Collapse an ordered (index_name, column, unique) stream into one
/// `IndexInfo` per index, preserving column order.
fn group_indexes(rows: impl Iterator<Item = (String, String, bool)>) -> Vec<IndexInfo> {
    let mut out: Vec<IndexInfo> = Vec::new();
    for (name, col, unique) in rows {
        if let Some(last) = out.last_mut().filter(|x| x.name == name) {
            last.columns.push(col);
        } else {
            out.push(IndexInfo {
                name,
                columns: vec![col],
                unique,
            });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mysql_schema_names_include_visible_databases_and_deduplicate() {
        let mut names = BTreeSet::new();
        add_mysql_schema_name(&mut names, Some("mysql".into()));
        add_mysql_schema_name(&mut names, Some(" information_schema ".into()));
        add_mysql_schema_name(&mut names, Some("test".into()));
        add_mysql_schema_name(&mut names, Some("test".into()));
        add_mysql_schema_name(&mut names, Some("app".into()));

        assert_eq!(
            names.into_iter().collect::<Vec<_>>(),
            vec![
                "app".to_string(),
                "information_schema".to_string(),
                "mysql".to_string(),
                "test".to_string()
            ]
        );
    }

    #[test]
    fn mysql_identifier_quoting_escapes_backticks() {
        assert_eq!(quote_mysql_ident("te`st"), "`te``st`");
        assert_eq!(
            quote_mysql_table(Some("db`1"), "ta`ble"),
            "`db``1`.`ta``ble`"
        );
    }

    #[test]
    fn mysql_table_kind_maps_views() {
        assert_eq!(mysql_table_kind("VIEW"), "view");
        assert_eq!(mysql_table_kind("BASE TABLE"), "table");
    }
}
