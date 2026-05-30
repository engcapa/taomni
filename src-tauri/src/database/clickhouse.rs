//! ClickHouse backend over the HTTP interface (default port 8123) using the
//! existing `reqwest` client. Queries are issued with `FORMAT JSONCompact` so
//! we get column names, types, and row data in one response.

use std::time::{Duration, Instant};

use serde::Deserialize;
use tokio_util::sync::CancellationToken;

use super::{
    ColumnDescription, ColumnInfo, DbConfig, DbHandle, QueryResult, SchemaInfo, TableInfo,
};

const DEFAULT_TIMEOUT_SECS: u64 = 15;

/// A configured ClickHouse HTTP endpoint plus credentials.
#[derive(Clone)]
pub struct ClickHouseClient {
    client: reqwest::Client,
    base_url: String,
    user: Option<String>,
    password: Option<String>,
    database: String,
}

pub async fn connect(config: &DbConfig, password: Option<&str>) -> Result<DbHandle, String> {
    // Only the HTTP interface is implemented. The native binary protocol
    // (default port 9000) is not supported yet — fail with a clear message
    // rather than silently connecting over HTTP on a different port.
    if config
        .protocol
        .as_deref()
        .is_some_and(|p| p.eq_ignore_ascii_case("native"))
    {
        return Err(
            "ClickHouse native protocol is not supported yet — switch the protocol to HTTP."
                .into(),
        );
    }
    let scheme = if config.ssl { "https" } else { "http" };
    // HTTP interface port: explicit http_port wins, else 8123.
    let port = config.http_port.unwrap_or(8123);
    let base_url = format!("{scheme}://{}:{}", config.host, port);
    let timeout = Duration::from_secs(match config.timeout_secs {
        Some(s) if s > 0 => s,
        _ => DEFAULT_TIMEOUT_SECS,
    });
    let client = reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|e| format!("ClickHouse client build failed: {e}"))?;
    let ch = ClickHouseClient {
        client,
        base_url,
        user: config.username.clone().filter(|u| !u.is_empty()),
        password: password.map(|p| p.to_string()),
        database: config
            .database
            .clone()
            .filter(|d| !d.is_empty())
            .unwrap_or_else(|| "default".to_string()),
    };
    // Verify reachability eagerly so db_connect reports failures up front.
    ping(&ch).await?;
    Ok(DbHandle::ClickHouse(ch))
}

/// POST a raw SQL string to the HTTP interface and return the response body.
async fn post_sql(
    client: &ClickHouseClient,
    sql: &str,
    token: Option<&CancellationToken>,
) -> Result<String, String> {
    let mut req = client
        .client
        .post(&client.base_url)
        .query(&[("database", client.database.as_str())])
        .body(sql.to_string());
    if let Some(user) = &client.user {
        req = req.header("X-ClickHouse-User", user);
    }
    if let Some(pw) = &client.password {
        req = req.header("X-ClickHouse-Key", pw);
    }
    let send = req.send();
    let resp = match token {
        Some(t) => tokio::select! {
            _ = t.cancelled() => return Err("Query cancelled".into()),
            r = send => r.map_err(|e| format!("ClickHouse request failed: {e}"))?,
        },
        None => send.await.map_err(|e| format!("ClickHouse request failed: {e}"))?,
    };
    let status = resp.status();
    let body = resp
        .text()
        .await
        .map_err(|e| format!("ClickHouse response read failed: {e}"))?;
    if !status.is_success() {
        return Err(format!("ClickHouse error ({status}): {}", body.trim()));
    }
    Ok(body)
}

pub async fn ping(client: &ClickHouseClient) -> Result<String, String> {
    post_sql(client, "SELECT 1", None).await?;
    Ok("ClickHouse connection OK".into())
}

// ClickHouse JSONCompact response shape.
#[derive(Deserialize)]
struct JsonCompactMeta {
    name: String,
    #[serde(rename = "type")]
    type_name: String,
}

#[derive(Deserialize)]
struct JsonCompactResponse {
    #[serde(default)]
    meta: Vec<JsonCompactMeta>,
    #[serde(default)]
    data: Vec<Vec<serde_json::Value>>,
    #[serde(default)]
    rows: u64,
}

fn json_cell_to_string(v: &serde_json::Value) -> Option<String> {
    match v {
        serde_json::Value::Null => None,
        serde_json::Value::String(s) => Some(s.clone()),
        serde_json::Value::Bool(b) => Some(b.to_string()),
        serde_json::Value::Number(n) => Some(n.to_string()),
        other => Some(other.to_string()),
    }
}

fn is_select(sql: &str) -> bool {
    let head: String = sql
        .trim_start()
        .chars()
        .take_while(|c| c.is_alphabetic())
        .collect::<String>()
        .to_uppercase();
    matches!(
        head.as_str(),
        "SELECT" | "SHOW" | "DESCRIBE" | "DESC" | "EXPLAIN" | "WITH" | "EXISTS"
    )
}

pub async fn execute(
    client: &ClickHouseClient,
    sql: &str,
    token: &CancellationToken,
) -> Result<QueryResult, String> {
    let start = Instant::now();
    if is_select(sql) {
        // Append the JSONCompact format unless the user already specified one.
        let has_format = sql.to_uppercase().contains("FORMAT ");
        let query = if has_format {
            sql.to_string()
        } else {
            format!("{sql} FORMAT JSONCompact")
        };
        let body = post_sql(client, &query, Some(token)).await?;
        if has_format {
            // Caller chose their own format; return the raw text in one cell.
            return Ok(QueryResult {
                columns: vec![ColumnInfo {
                    name: "result".into(),
                    type_name: "String".into(),
                }],
                rows: vec![vec![Some(body)]],
                rows_affected: 0,
                duration_ms: start.elapsed().as_millis() as u64,
                warnings: Vec::new(),
            });
        }
        let parsed: JsonCompactResponse = serde_json::from_str(&body)
            .map_err(|e| format!("ClickHouse response parse failed: {e}"))?;
        let columns = parsed
            .meta
            .iter()
            .map(|m| ColumnInfo {
                name: m.name.clone(),
                type_name: m.type_name.clone(),
            })
            .collect();
        let rows = parsed
            .data
            .iter()
            .map(|row| row.iter().map(json_cell_to_string).collect())
            .collect();
        Ok(QueryResult {
            columns,
            rows,
            rows_affected: parsed.rows,
            duration_ms: start.elapsed().as_millis() as u64,
            warnings: Vec::new(),
        })
    } else {
        // DDL/DML: ClickHouse returns an empty body on success.
        post_sql(client, sql, Some(token)).await?;
        Ok(QueryResult {
            columns: Vec::new(),
            rows: Vec::new(),
            rows_affected: 0,
            duration_ms: start.elapsed().as_millis() as u64,
            warnings: Vec::new(),
        })
    }
}

pub async fn list_schemas(client: &ClickHouseClient) -> Result<Vec<SchemaInfo>, String> {
    let token = CancellationToken::new();
    let res = execute(client, "SELECT name FROM system.databases ORDER BY name", &token).await?;
    Ok(res
        .rows
        .into_iter()
        .filter_map(|r| r.into_iter().next().flatten())
        .map(|name| SchemaInfo { name })
        .collect())
}

pub async fn list_tables(
    client: &ClickHouseClient,
    schema: Option<&str>,
) -> Result<Vec<TableInfo>, String> {
    let db = schema.unwrap_or(&client.database);
    let sql = format!(
        "SELECT name, engine FROM system.tables WHERE database = '{}' ORDER BY name",
        db.replace('\'', "''")
    );
    let token = CancellationToken::new();
    let res = execute(client, &sql, &token).await?;
    Ok(res
        .rows
        .into_iter()
        .filter_map(|mut r| {
            let name = r.first().cloned().flatten()?;
            let engine = r.drain(..).nth(1).flatten().unwrap_or_default();
            let kind = if engine.contains("MaterializedView") {
                "materialized_view"
            } else if engine.contains("View") {
                "view"
            } else {
                "table"
            };
            Some(TableInfo {
                name,
                kind: kind.to_string(),
            })
        })
        .collect())
}

pub async fn describe_table(
    client: &ClickHouseClient,
    schema: Option<&str>,
    table: &str,
) -> Result<Vec<ColumnDescription>, String> {
    let db = schema.unwrap_or(&client.database);
    let sql = format!(
        "SELECT name, type, default_expression, is_in_primary_key \
         FROM system.columns WHERE database = '{}' AND table = '{}' ORDER BY position",
        db.replace('\'', "''"),
        table.replace('\'', "''"),
    );
    let token = CancellationToken::new();
    let res = execute(client, &sql, &token).await?;
    Ok(res
        .rows
        .into_iter()
        .filter_map(|r| {
            let name = r.first().cloned().flatten()?;
            let type_name = r.get(1).cloned().flatten().unwrap_or_default();
            let default = r.get(2).cloned().flatten().filter(|s| !s.is_empty());
            let is_pk = r.get(3).cloned().flatten().unwrap_or_default();
            // Nullable(...) types are nullable.
            let nullable = type_name.contains("Nullable(");
            Some(ColumnDescription {
                name,
                type_name,
                nullable,
                default,
                primary_key: is_pk == "1",
            })
        })
        .collect())
}
