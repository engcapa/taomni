//! PanWeiDB / openGauss-compatible backend via the native `tokio-opengauss`
//! connector. This is intentionally separate from the PostgreSQL `sqlx`
//! backend because PanWeiDB deployments can require openGauss SHA256
//! authentication that regular PostgreSQL clients do not implement.

use std::{
    sync::Arc,
    time::{Duration, Instant},
};

use tokio::sync::Mutex as AsyncMutex;
use tokio::task::JoinHandle;
use tokio_opengauss::{
    Client as OgClient, Config as OgConfig, NoTls, Row as OgRow, SimpleQueryMessage,
    config::SslMode, types::ToSql,
};
use tokio_util::sync::CancellationToken;

use super::{
    ColumnDescription, ColumnInfo, DbConfig, DbHandle, DbObject, IndexInfo, QueryResult,
    QueryStreamChannel, SchemaInfo, TableInfo, emit_query_result_stream,
};

const DEFAULT_TIMEOUT_SECS: u64 = 15;

#[derive(Clone)]
pub struct PanWeiClient {
    inner: Arc<PanWeiInner>,
}

struct PanWeiInner {
    client: AsyncMutex<OgClient>,
    connection_task: JoinHandle<()>,
}

impl Drop for PanWeiInner {
    fn drop(&mut self) {
        self.connection_task.abort();
    }
}

impl PanWeiClient {
    fn new(client: OgClient, connection_task: JoinHandle<()>) -> Self {
        Self {
            inner: Arc::new(PanWeiInner {
                client: AsyncMutex::new(client),
                connection_task,
            }),
        }
    }
}

fn timeout(config: &DbConfig) -> Duration {
    Duration::from_secs(match config.timeout_secs {
        Some(s) if s > 0 => s,
        _ => DEFAULT_TIMEOUT_SECS,
    })
}

pub async fn connect(config: &DbConfig, password: Option<&str>) -> Result<DbHandle, String> {
    if config.ssl {
        return Err(
            "PanWeiDB SSL connections are not supported by the native openGauss connector yet."
                .into(),
        );
    }

    let mut opts = OgConfig::new();
    opts.host(&config.host)
        .port(config.port)
        .ssl_mode(SslMode::Disable)
        .connect_timeout(timeout(config))
        .application_name("Taomni");
    if let Some(user) = config.username.as_deref().filter(|u| !u.is_empty()) {
        opts.user(user);
    }
    if let Some(pw) = password {
        opts.password(pw);
    }
    if let Some(db) = config.database.as_deref().filter(|d| !d.is_empty()) {
        opts.dbname(db);
    }

    let (client, connection) = tokio::time::timeout(timeout(config), opts.connect(NoTls))
        .await
        .map_err(|_| "PanWeiDB connect timed out".to_string())?
        .map_err(|e| format!("PanWeiDB connect failed: {e}"))?;
    let connection_task = tokio::spawn(async move {
        if let Err(e) = connection.await {
            log::debug!("PanWeiDB connection task ended: {e}");
        }
    });

    Ok(DbHandle::PanWeiDB(PanWeiClient::new(
        client,
        connection_task,
    )))
}

pub async fn ping(client: &PanWeiClient) -> Result<String, String> {
    let guard = client.inner.client.lock().await;
    guard
        .execute("SELECT 1", &[])
        .await
        .map_err(|e| format!("PanWeiDB ping failed: {e}"))?;
    Ok("PanWeiDB connection OK".into())
}

fn simple_messages_to_result(messages: Vec<SimpleQueryMessage>, start: Instant) -> QueryResult {
    let mut columns = Vec::new();
    let mut rows = Vec::new();
    let mut rows_affected = 0;
    let mut warnings = Vec::new();

    for message in messages {
        match message {
            SimpleQueryMessage::Row(row) => {
                let row_columns: Vec<ColumnInfo> = row
                    .columns()
                    .iter()
                    .map(|c| ColumnInfo {
                        name: c.name().to_string(),
                        type_name: "text".to_string(),
                    })
                    .collect();
                if columns.is_empty() {
                    columns = row_columns;
                } else if columns.len() != row_columns.len()
                    || columns
                        .iter()
                        .zip(&row_columns)
                        .any(|(a, b)| a.name != b.name)
                {
                    warnings.push(
                        "Multiple result sets with different columns were flattened into one grid."
                            .to_string(),
                    );
                }

                let values = (0..row.len())
                    .map(|index| {
                        row.try_get(index)
                            .ok()
                            .flatten()
                            .map(|value| value.to_string())
                    })
                    .collect();
                rows.push(values);
            }
            SimpleQueryMessage::CommandComplete(count) => {
                rows_affected += count;
            }
            _ => {}
        }
    }

    QueryResult {
        rows_affected: if columns.is_empty() { rows_affected } else { 0 },
        columns,
        rows,
        duration_ms: start.elapsed().as_millis() as u64,
        warnings,
    }
}

async fn fetch(
    client: &PanWeiClient,
    sql: &str,
    params: &[&(dyn ToSql + Sync)],
) -> Result<Vec<OgRow>, String> {
    let guard = client.inner.client.lock().await;
    guard
        .query(sql, params)
        .await
        .map_err(|e| format!("Query failed: {e}"))
}

async fn fetch_optional(
    client: &PanWeiClient,
    sql: &str,
    params: &[&(dyn ToSql + Sync)],
) -> Result<Option<OgRow>, String> {
    let guard = client.inner.client.lock().await;
    guard
        .query_opt(sql, params)
        .await
        .map_err(|e| format!("Query failed: {e}"))
}

pub async fn execute(
    client: &PanWeiClient,
    sql: &str,
    token: &CancellationToken,
) -> Result<QueryResult, String> {
    let start = Instant::now();
    let guard = client.inner.client.lock().await;
    let cancel = guard.cancel_token();
    let run = guard.simple_query(sql);
    tokio::pin!(run);
    let messages = tokio::select! {
        _ = token.cancelled() => {
            let _ = cancel.cancel_query(NoTls).await;
            return Err("Query cancelled".into());
        }
        r = &mut run => r.map_err(|e| format!("Query failed: {e}"))?,
    };
    Ok(simple_messages_to_result(messages, start))
}

pub async fn execute_stream(
    client: &PanWeiClient,
    sql: &str,
    max_rows: Option<u64>,
    token: &CancellationToken,
    on_event: &QueryStreamChannel,
) -> Result<(), String> {
    let mut result = execute(client, sql, token).await?;
    if let Some(limit) = max_rows.filter(|value| *value > 0) {
        if result.rows.len() as u64 > limit {
            result.rows.truncate(limit as usize);
            result
                .warnings
                .push(format!("Result limited to {limit} rows"));
        }
    }
    emit_query_result_stream(on_event, result)
}

pub async fn list_schemas(client: &PanWeiClient) -> Result<Vec<SchemaInfo>, String> {
    let rows = fetch(
        client,
        "SELECT schema_name FROM information_schema.schemata \
         WHERE schema_name NOT LIKE 'pg_%' AND schema_name <> 'information_schema' \
         ORDER BY schema_name",
        &[],
    )
    .await
    .map_err(|e| format!("list schemas failed: {e}"))?;
    Ok(rows
        .iter()
        .filter_map(|row| row.try_get::<usize, String>(0).ok())
        .map(|name| SchemaInfo { name })
        .collect())
}

pub async fn list_tables(
    client: &PanWeiClient,
    schema: Option<&str>,
) -> Result<Vec<TableInfo>, String> {
    let schema = schema.unwrap_or("public");
    let rows = fetch(
        client,
        "SELECT t.table_name, t.table_type, \
                CASE WHEN c.reltuples >= 0 THEN c.reltuples::bigint ELSE NULL END AS row_count \
         FROM information_schema.tables t \
         LEFT JOIN pg_namespace n ON n.nspname = t.table_schema \
         LEFT JOIN pg_class c ON c.relname = t.table_name AND c.relnamespace = n.oid \
         WHERE t.table_schema = $1 ORDER BY t.table_name",
        &[&schema],
    )
    .await
    .map_err(|e| format!("list tables failed: {e}"))?;

    let mut out: Vec<TableInfo> = rows
        .iter()
        .filter_map(|row| {
            let name: String = row.try_get(0).ok()?;
            let table_type: String = row.try_get(1).unwrap_or_default();
            let row_count: Option<i64> = row.try_get(2).ok().flatten();
            Some(TableInfo {
                name,
                kind: if table_type.eq_ignore_ascii_case("VIEW") {
                    "view"
                } else {
                    "table"
                }
                .to_string(),
                row_count,
            })
        })
        .collect();

    if let Ok(mvs) = fetch(
        client,
        "SELECT matviewname FROM pg_matviews WHERE schemaname = $1",
        &[&schema],
    )
    .await
    {
        for row in &mvs {
            if let Ok(name) = row.try_get::<usize, String>(0) {
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

pub async fn describe_table(
    client: &PanWeiClient,
    schema: Option<&str>,
    table: &str,
) -> Result<Vec<ColumnDescription>, String> {
    let schema = schema.unwrap_or("public");
    let rows = fetch(
        client,
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
        &[&schema, &table],
    )
    .await
    .map_err(|e| format!("describe table failed: {e}"))?;
    Ok(rows
        .iter()
        .filter_map(|row| {
            let name: String = row.try_get(0).ok()?;
            let type_name: String = row.try_get(1).unwrap_or_default();
            let nullable: String = row.try_get(2).unwrap_or_default();
            let default: Option<String> = row.try_get(3).ok().flatten();
            let primary_key: bool = row.try_get(4).unwrap_or(false);
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

pub async fn list_indexes(
    client: &PanWeiClient,
    schema: Option<&str>,
    table: &str,
) -> Result<Vec<IndexInfo>, String> {
    let schema = schema.unwrap_or("public");
    let rows = fetch(
        client,
        "SELECT i.relname AS index_name, a.attname AS column_name, ix.indisunique AS is_unique \
         FROM pg_class t \
         JOIN pg_namespace n ON n.oid = t.relnamespace \
         JOIN pg_index ix ON t.oid = ix.indrelid \
         JOIN pg_class i ON i.oid = ix.indexrelid \
         JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey) \
         WHERE n.nspname = $1 AND t.relname = $2 \
         ORDER BY i.relname, array_position(ix.indkey, a.attnum)",
        &[&schema, &table],
    )
    .await
    .map_err(|e| format!("list indexes failed: {e}"))?;

    let mut grouped: Vec<IndexInfo> = Vec::new();
    for row in &rows {
        let name: String = match row.try_get(0) {
            Ok(value) => value,
            Err(_) => continue,
        };
        let column: String = row.try_get(1).unwrap_or_default();
        let unique: bool = row.try_get(2).unwrap_or(false);
        match grouped.iter_mut().find(|idx| idx.name == name) {
            Some(index) => index.columns.push(column),
            None => grouped.push(IndexInfo {
                name,
                columns: vec![column],
                unique,
            }),
        }
    }
    Ok(grouped)
}

pub async fn list_objects(
    client: &PanWeiClient,
    schema: Option<&str>,
    kind: &str,
) -> Result<Vec<DbObject>, String> {
    let schema = schema.unwrap_or("public");
    let sql = match kind {
        "function" => {
            "SELECT DISTINCT p.proname FROM pg_catalog.pg_proc p \
             JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace \
             WHERE n.nspname = $1 ORDER BY p.proname"
        }
        "sequence" => {
            "SELECT sequence_name FROM information_schema.sequences \
             WHERE sequence_schema = $1 ORDER BY sequence_name"
        }
        _ => return Ok(Vec::new()),
    };
    let rows = fetch(client, sql, &[&schema])
        .await
        .map_err(|e| format!("list {kind} failed: {e}"))?;
    Ok(rows
        .iter()
        .filter_map(|row| {
            let name: String = row.try_get(0).ok()?;
            Some(DbObject {
                name,
                kind: kind.to_string(),
                owner: None,
            })
        })
        .collect())
}

pub async fn object_ddl(
    client: &PanWeiClient,
    schema: Option<&str>,
    kind: &str,
    name: &str,
) -> Result<String, String> {
    let schema = schema.unwrap_or("public");
    match kind {
        "view" | "materialized_view" => {
            let row = fetch_optional(
                client,
                "SELECT pg_get_viewdef(c.oid, true) FROM pg_class c \
                 JOIN pg_namespace n ON n.oid = c.relnamespace \
                 WHERE n.nspname = $1 AND c.relname = $2",
                &[&schema, &name],
            )
            .await
            .map_err(|e| format!("view definition failed: {e}"))?;
            let def: String = row
                .and_then(|row| row.try_get::<usize, String>(0).ok())
                .ok_or_else(|| format!("View {name} not found"))?;
            let kw = if kind == "materialized_view" {
                "MATERIALIZED VIEW"
            } else {
                "VIEW"
            };
            Ok(format!(
                "CREATE OR REPLACE {kw} \"{schema}\".\"{name}\" AS\n{def}"
            ))
        }
        "function" => {
            let row = fetch_optional(
                client,
                "SELECT pg_get_functiondef(p.oid) FROM pg_proc p \
                 JOIN pg_namespace n ON n.oid = p.pronamespace \
                 WHERE n.nspname = $1 AND p.proname = $2 LIMIT 1",
                &[&schema, &name],
            )
            .await
            .map_err(|e| format!("function definition failed: {e}"))?;
            row.and_then(|row| row.try_get::<usize, String>(0).ok())
                .ok_or_else(|| format!("Function {name} not found"))
        }
        "sequence" => Ok(format!("CREATE SEQUENCE \"{schema}\".\"{name}\";")),
        _ => {
            let cols = describe_table(client, Some(schema), name).await?;
            if cols.is_empty() {
                return Err(format!("Table {name} not found"));
            }
            let mut lines: Vec<String> = cols
                .iter()
                .map(|column| {
                    let mut line = format!("  \"{}\" {}", column.name, column.type_name);
                    if !column.nullable {
                        line.push_str(" NOT NULL");
                    }
                    if let Some(default) = &column.default {
                        line.push_str(" DEFAULT ");
                        line.push_str(default);
                    }
                    line
                })
                .collect();
            let pks: Vec<String> = cols
                .iter()
                .filter(|column| column.primary_key)
                .map(|column| format!("\"{}\"", column.name))
                .collect();
            if !pks.is_empty() {
                lines.push(format!("  PRIMARY KEY ({})", pks.join(", ")));
            }
            Ok(format!(
                "CREATE TABLE \"{schema}\".\"{name}\" (\n{}\n);",
                lines.join(",\n")
            ))
        }
    }
}

pub async fn table_stats(
    client: &PanWeiClient,
    schema: Option<&str>,
    table: &str,
) -> Result<QueryResult, String> {
    let schema = schema.unwrap_or("public");
    let row = fetch_optional(
        client,
        "SELECT pg_total_relation_size(c.oid), pg_relation_size(c.oid), \
                pg_indexes_size(c.oid), s.n_live_tup \
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
         LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid \
         WHERE n.nspname = $1 AND c.relname = $2",
        &[&schema, &table],
    )
    .await
    .map_err(|e| format!("table stats failed: {e}"))?
    .ok_or_else(|| format!("Table {table} not found"))?;
    let num = |idx: usize| {
        row.try_get::<usize, Option<i64>>(idx)
            .ok()
            .flatten()
            .map(|v| v.to_string())
    };
    Ok(super::metric_result(vec![
        ("Total size (bytes)", num(0)),
        ("Table size (bytes)", num(1)),
        ("Indexes size (bytes)", num(2)),
        ("Live rows (estimate)", num(3)),
    ]))
}
