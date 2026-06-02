//! Presto backend over the HTTP statement API. The client follows the
//! `/v1/statement` response `nextUri` chain and translates Presto JSON rows
//! into the same string/null grid shape used by the other SQL engines.

use std::sync::Arc;
use std::time::{Duration, Instant};

use reqwest::header::HeaderMap;
use serde::Deserialize;
use tokio::sync::Mutex as AsyncMutex;
use tokio_util::sync::CancellationToken;

use super::{
    send_query_stream_event, ColumnDescription, ColumnInfo, DbConfig, DbHandle, IndexInfo,
    QueryResult, QueryStreamChannel, QueryStreamEvent, SchemaInfo, TableInfo,
};

const DEFAULT_TIMEOUT_SECS: u64 = 15;
const STREAM_BATCH_ROWS: usize = 100;
const DEFAULT_PRESTO_USER: &str = "taomni";

#[derive(Clone)]
pub struct PrestoClient {
    client: reqwest::Client,
    base_url: String,
    user: String,
    password: Option<String>,
    catalog: Arc<AsyncMutex<Option<String>>>,
    schema: Arc<AsyncMutex<Option<String>>>,
    current_next_uri: Arc<AsyncMutex<Option<String>>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PrestoColumn {
    name: String,
    #[serde(rename = "type")]
    type_name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PrestoResults {
    #[serde(default)]
    next_uri: Option<String>,
    #[serde(default)]
    columns: Vec<PrestoColumn>,
    #[serde(default)]
    data: Vec<Vec<serde_json::Value>>,
    #[serde(default)]
    update_count: Option<u64>,
    #[serde(default)]
    error: Option<PrestoError>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PrestoError {
    message: String,
    #[serde(default)]
    error_name: Option<String>,
    #[serde(default)]
    error_location: Option<PrestoErrorLocation>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PrestoErrorLocation {
    line_number: u64,
    column_number: u64,
}

struct StatementOutcome {
    result: QueryResult,
}

struct StreamState {
    columns_sent: bool,
    row_count: u64,
    rows_affected: u64,
    max_rows: Option<u64>,
    limit_reached: bool,
    batch: Vec<Vec<Option<String>>>,
}

impl StreamState {
    fn new(max_rows: Option<u64>) -> Self {
        Self {
            columns_sent: false,
            row_count: 0,
            rows_affected: 0,
            max_rows: max_rows.filter(|value| *value > 0),
            limit_reached: false,
            batch: Vec::with_capacity(STREAM_BATCH_ROWS),
        }
    }

    fn consume_results(
        &mut self,
        results: PrestoResults,
        on_event: &QueryStreamChannel,
    ) -> Result<bool, String> {
        if let Some(error) = results.error {
            return Err(format_presto_error(error));
        }
        if let Some(update_count) = results.update_count {
            self.rows_affected = update_count;
        }
        if !self.columns_sent && !results.columns.is_empty() {
            send_query_stream_event(
                on_event,
                QueryStreamEvent::Columns {
                    columns: presto_columns(results.columns),
                },
            )?;
            self.columns_sent = true;
        }
        for row in results.data {
            if self.max_rows.is_some_and(|limit| self.row_count >= limit) {
                self.limit_reached = true;
                return Ok(false);
            }
            self.batch
                .push(row.iter().map(json_cell_to_string).collect());
            self.row_count += 1;
            if self.max_rows.is_some_and(|limit| self.row_count >= limit) {
                self.limit_reached = true;
            }
            if self.batch.len() >= STREAM_BATCH_ROWS {
                send_query_stream_event(
                    on_event,
                    QueryStreamEvent::Rows {
                        rows: std::mem::take(&mut self.batch),
                    },
                )?;
            }
        }
        Ok(!self.limit_reached)
    }

    fn finish(mut self, on_event: &QueryStreamChannel, duration_ms: u64) -> Result<(), String> {
        if !self.batch.is_empty() {
            send_query_stream_event(
                on_event,
                QueryStreamEvent::Rows {
                    rows: std::mem::take(&mut self.batch),
                },
            )?;
        }
        send_query_stream_event(
            on_event,
            QueryStreamEvent::Done {
                rows_affected: self.rows_affected,
                duration_ms,
                warnings: match (self.limit_reached, self.max_rows) {
                    (true, Some(limit)) => vec![format!("Result limited to {limit} rows")],
                    _ => Vec::new(),
                },
            },
        )
    }
}

pub async fn connect(config: &DbConfig, password: Option<&str>) -> Result<DbHandle, String> {
    let scheme = if config.ssl { "https" } else { "http" };
    let base_url = format!("{scheme}://{}:{}", config.host, config.port);
    let timeout = Duration::from_secs(match config.timeout_secs {
        Some(s) if s > 0 => s,
        _ => DEFAULT_TIMEOUT_SECS,
    });
    let client = reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|e| format!("Presto client build failed: {e}"))?;
    let presto = PrestoClient {
        client,
        base_url,
        user: config
            .username
            .clone()
            .filter(|u| !u.is_empty())
            .unwrap_or_else(|| DEFAULT_PRESTO_USER.to_string()),
        password: password.map(|value| value.to_string()),
        catalog: Arc::new(AsyncMutex::new(
            config.catalog.clone().filter(|value| !value.is_empty()),
        )),
        schema: Arc::new(AsyncMutex::new(
            config.database.clone().filter(|value| !value.is_empty()),
        )),
        current_next_uri: Arc::new(AsyncMutex::new(None)),
    };
    ping(&presto).await?;
    Ok(DbHandle::Presto(presto))
}

async fn request_context(client: &PrestoClient) -> (Option<String>, Option<String>) {
    let catalog = client.catalog.lock().await.clone();
    let schema = client.schema.lock().await.clone();
    (catalog, schema)
}

fn add_presto_headers(
    client: &PrestoClient,
    mut req: reqwest::RequestBuilder,
    catalog: Option<&str>,
    schema: Option<&str>,
) -> reqwest::RequestBuilder {
    req = req
        .header("X-Presto-User", client.user.as_str())
        .header("X-Presto-Source", "taomni")
        .header("User-Agent", "Taomni Presto Client");
    if let Some(catalog) = catalog.filter(|value| !value.is_empty()) {
        req = req.header("X-Presto-Catalog", catalog);
    }
    if let Some(schema) = schema.filter(|value| !value.is_empty()) {
        req = req.header("X-Presto-Schema", schema);
    }
    if let Some(password) = &client.password {
        req = req.basic_auth(client.user.as_str(), Some(password));
    }
    req
}

async fn apply_session_headers(client: &PrestoClient, headers: &HeaderMap) {
    if let Some(catalog) = header_string(headers, "X-Presto-Set-Catalog") {
        *client.catalog.lock().await = Some(catalog);
    }
    if let Some(schema) = header_string(headers, "X-Presto-Set-Schema") {
        *client.schema.lock().await = Some(schema);
    }
}

fn header_string(headers: &HeaderMap, key: &str) -> Option<String> {
    headers
        .get(key)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

async fn read_results_response(
    client: &PrestoClient,
    resp: reqwest::Response,
) -> Result<PrestoResults, String> {
    let status = resp.status();
    let headers = resp.headers().clone();
    let body = resp
        .text()
        .await
        .map_err(|e| format!("Presto response read failed: {e}"))?;
    if !status.is_success() {
        return Err(format!("Presto error ({status}): {}", body.trim()));
    }
    apply_session_headers(client, &headers).await;
    let results: PrestoResults =
        serde_json::from_str(&body).map_err(|e| format!("Presto response parse failed: {e}"))?;
    Ok(results)
}

async fn post_statement(
    client: &PrestoClient,
    sql: &str,
    token: &CancellationToken,
    track_cancel: bool,
) -> Result<PrestoResults, String> {
    let (catalog, schema) = request_context(client).await;
    let req = add_presto_headers(
        client,
        client
            .client
            .post(format!("{}/v1/statement", client.base_url))
            .body(sql.to_string()),
        catalog.as_deref(),
        schema.as_deref(),
    );
    let send = req.send();
    let resp = tokio::select! {
        _ = token.cancelled() => {
            cancel_current(client).await;
            return Err("Query cancelled".into());
        }
        r = send => r.map_err(|e| format!("Presto request failed: {e}"))?,
    };
    let results = read_results_response(client, resp).await?;
    if track_cancel {
        set_current_next_uri(client, results.next_uri.as_deref()).await;
    }
    Ok(results)
}

async fn get_next(
    client: &PrestoClient,
    uri: &str,
    token: &CancellationToken,
    track_cancel: bool,
) -> Result<PrestoResults, String> {
    let (catalog, schema) = request_context(client).await;
    let req = add_presto_headers(
        client,
        client.client.get(uri),
        catalog.as_deref(),
        schema.as_deref(),
    );
    let send = req.send();
    let resp = tokio::select! {
        _ = token.cancelled() => {
            cancel_current(client).await;
            return Err("Query cancelled".into());
        }
        r = send => r.map_err(|e| format!("Presto request failed: {e}"))?,
    };
    let results = read_results_response(client, resp).await?;
    if track_cancel {
        set_current_next_uri(client, results.next_uri.as_deref()).await;
    }
    Ok(results)
}

async fn set_current_next_uri(client: &PrestoClient, next_uri: Option<&str>) {
    *client.current_next_uri.lock().await = next_uri.map(ToOwned::to_owned);
}

async fn cancel_current(client: &PrestoClient) {
    let uri = client.current_next_uri.lock().await.clone();
    if let Some(uri) = uri {
        let _ = delete_uri(client, &uri).await;
    }
}

async fn delete_uri(client: &PrestoClient, uri: &str) -> Result<(), String> {
    let (catalog, schema) = request_context(client).await;
    let req = add_presto_headers(
        client,
        client.client.delete(uri),
        catalog.as_deref(),
        schema.as_deref(),
    );
    req.send()
        .await
        .map_err(|e| format!("Presto cancel failed: {e}"))?;
    Ok(())
}

fn presto_columns(columns: Vec<PrestoColumn>) -> Vec<ColumnInfo> {
    columns
        .into_iter()
        .map(|column| ColumnInfo {
            name: column.name,
            type_name: column.type_name,
        })
        .collect()
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

fn format_presto_error(error: PrestoError) -> String {
    let mut message = error.message;
    if let Some(name) = error.error_name {
        message = format!("{name}: {message}");
    }
    if let Some(location) = error.error_location {
        message = format!(
            "{message} at line {}, column {}",
            location.line_number, location.column_number
        );
    }
    message
}

async fn run_statement(
    client: &PrestoClient,
    sql: &str,
    max_rows: Option<u64>,
    token: &CancellationToken,
    track_cancel: bool,
) -> Result<StatementOutcome, String> {
    let start = Instant::now();
    let mut columns = Vec::new();
    let mut rows = Vec::new();
    let mut rows_affected = 0_u64;
    let mut limit_reached = false;
    let max_rows = max_rows.filter(|value| *value > 0);

    let first = post_statement(client, sql, token, track_cancel).await?;
    if let Some(error) = first.error {
        return Err(format_presto_error(error));
    }
    if !first.columns.is_empty() {
        columns = presto_columns(first.columns);
    }
    if let Some(update_count) = first.update_count {
        rows_affected = update_count;
    }
    for row in first.data {
        if max_rows.is_some_and(|limit| rows.len() as u64 >= limit) {
            limit_reached = true;
            break;
        }
        rows.push(row.iter().map(json_cell_to_string).collect());
    }
    let mut next = first.next_uri;

    while let Some(uri) = next {
        if limit_reached {
            delete_uri(client, &uri).await?;
            break;
        }
        let result = get_next(client, &uri, token, track_cancel).await?;
        if let Some(error) = result.error {
            return Err(format_presto_error(error));
        }
        if columns.is_empty() && !result.columns.is_empty() {
            columns = presto_columns(result.columns);
        }
        if let Some(update_count) = result.update_count {
            rows_affected = update_count;
        }
        for row in result.data {
            if max_rows.is_some_and(|limit| rows.len() as u64 >= limit) {
                limit_reached = true;
                break;
            }
            rows.push(row.iter().map(json_cell_to_string).collect());
        }
        next = result.next_uri;
    }

    if track_cancel {
        set_current_next_uri(client, None).await;
    }
    Ok(StatementOutcome {
        result: QueryResult {
            columns,
            rows,
            rows_affected,
            duration_ms: start.elapsed().as_millis() as u64,
            warnings: match (limit_reached, max_rows) {
                (true, Some(limit)) => vec![format!("Result limited to {limit} rows")],
                _ => Vec::new(),
            },
        },
    })
}

pub async fn ping(client: &PrestoClient) -> Result<String, String> {
    let token = CancellationToken::new();
    run_statement(client, "SELECT 1", Some(1), &token, false).await?;
    Ok("Presto connection OK".into())
}

pub async fn execute(
    client: &PrestoClient,
    sql: &str,
    token: &CancellationToken,
) -> Result<QueryResult, String> {
    let result = run_statement(client, sql, None, token, true).await?.result;
    apply_use_statement_hint(client, sql).await;
    Ok(result)
}

pub async fn execute_stream(
    client: &PrestoClient,
    sql: &str,
    max_rows: Option<u64>,
    token: &CancellationToken,
    on_event: &QueryStreamChannel,
) -> Result<(), String> {
    let start = Instant::now();
    let mut state = StreamState::new(max_rows);
    let first = post_statement(client, sql, token, true).await?;
    let mut next = first.next_uri.clone();
    if !state.consume_results(first, on_event)? {
        if let Some(uri) = next {
            delete_uri(client, &uri).await?;
        }
        set_current_next_uri(client, None).await;
        return state.finish(on_event, start.elapsed().as_millis() as u64);
    }

    while let Some(uri) = next {
        let result = get_next(client, &uri, token, true).await?;
        next = result.next_uri.clone();
        if !state.consume_results(result, on_event)? {
            if let Some(uri) = next {
                delete_uri(client, &uri).await?;
            }
            break;
        }
    }

    set_current_next_uri(client, None).await;
    apply_use_statement_hint(client, sql).await;
    state.finish(on_event, start.elapsed().as_millis() as u64)
}

#[cfg(test)]
fn quote_presto_ident(ident: &str) -> String {
    format!("\"{}\"", ident.replace('"', "\"\""))
}

#[cfg(test)]
fn quote_presto_qualified(parts: &[&str]) -> String {
    parts
        .iter()
        .filter(|part| !part.is_empty())
        .map(|part| quote_presto_ident(part))
        .collect::<Vec<_>>()
        .join(".")
}

fn sql_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

async fn apply_use_statement_hint(client: &PrestoClient, sql: &str) {
    let Some(parts) = parse_use_parts(sql) else {
        return;
    };
    if let Some(schema) = parts.last().filter(|value| !value.is_empty()) {
        *client.schema.lock().await = Some(schema.clone());
    }
    if parts.len() >= 2 {
        if let Some(catalog) = parts.get(parts.len() - 2).filter(|value| !value.is_empty()) {
            *client.catalog.lock().await = Some(catalog.clone());
        }
    }
}

fn parse_use_parts(sql: &str) -> Option<Vec<String>> {
    let trimmed = sql.trim().trim_end_matches(';').trim();
    let rest = trimmed
        .get(..3)
        .filter(|head| head.eq_ignore_ascii_case("USE"))
        .and_then(|_| trimmed.get(3..))?
        .trim();
    if rest.is_empty() {
        return None;
    }
    let parts = split_qualified_ident(rest);
    if parts.is_empty() {
        None
    } else {
        Some(parts)
    }
}

fn split_qualified_ident(input: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut chars = input.chars().peekable();
    let mut quoted = false;

    while let Some(ch) = chars.next() {
        if quoted {
            if ch == '"' {
                if matches!(chars.peek(), Some('"')) {
                    current.push('"');
                    chars.next();
                } else {
                    quoted = false;
                }
            } else {
                current.push(ch);
            }
            continue;
        }
        match ch {
            '"' => quoted = true,
            '.' => {
                let part = current.trim().to_string();
                if !part.is_empty() {
                    parts.push(part);
                }
                current.clear();
            }
            c if c.is_whitespace() => {
                if !current.trim().is_empty() {
                    current.push(c);
                }
            }
            _ => current.push(ch),
        }
    }

    let part = current.trim().to_string();
    if !part.is_empty() {
        parts.push(part);
    }
    parts
}

async fn current_catalog(client: &PrestoClient) -> Result<String, String> {
    client
        .catalog
        .lock()
        .await
        .clone()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            "Presto catalog is required for schema browsing. Set the Catalog field in this session."
                .to_string()
        })
}

fn table_kind(table_type: &str) -> String {
    if table_type.eq_ignore_ascii_case("VIEW") {
        "view".to_string()
    } else {
        "table".to_string()
    }
}

pub async fn list_schemas(client: &PrestoClient) -> Result<Vec<SchemaInfo>, String> {
    current_catalog(client).await?;
    let token = CancellationToken::new();
    let res = run_statement(
        client,
        "SELECT schema_name FROM information_schema.schemata \
         WHERE schema_name <> 'information_schema' ORDER BY schema_name",
        None,
        &token,
        false,
    )
    .await?
    .result;
    Ok(res
        .rows
        .into_iter()
        .filter_map(|row| row.into_iter().next().flatten())
        .map(|name| SchemaInfo { name })
        .collect())
}

pub async fn list_tables(
    client: &PrestoClient,
    schema: Option<&str>,
) -> Result<Vec<TableInfo>, String> {
    current_catalog(client).await?;
    let schema = match schema.filter(|value| !value.is_empty()) {
        Some(schema) => schema.to_string(),
        None => client.schema.lock().await.clone().ok_or_else(|| {
            "Presto schema is required for table browsing. Select a schema first.".to_string()
        })?,
    };
    let sql = format!(
        "SELECT table_name, table_type FROM information_schema.tables \
         WHERE table_schema = {} ORDER BY table_name",
        sql_literal(&schema)
    );
    let token = CancellationToken::new();
    let res = run_statement(client, &sql, None, &token, false)
        .await?
        .result;
    Ok(res
        .rows
        .into_iter()
        .filter_map(|row| {
            let name = row.first().cloned().flatten()?;
            let kind = row
                .get(1)
                .cloned()
                .flatten()
                .map(|value| table_kind(&value))
                .unwrap_or_else(|| "table".to_string());
            Some(TableInfo {
                name,
                kind,
                row_count: None,
            })
        })
        .collect())
}

pub async fn describe_table(
    client: &PrestoClient,
    schema: Option<&str>,
    table: &str,
) -> Result<Vec<ColumnDescription>, String> {
    current_catalog(client).await?;
    let schema = match schema.filter(|value| !value.is_empty()) {
        Some(schema) => schema.to_string(),
        None => client.schema.lock().await.clone().ok_or_else(|| {
            "Presto schema is required for table description. Select a schema first.".to_string()
        })?,
    };
    let sql = format!(
        "SELECT column_name, data_type, is_nullable, column_default \
         FROM information_schema.columns \
         WHERE table_schema = {} AND table_name = {} \
         ORDER BY ordinal_position",
        sql_literal(&schema),
        sql_literal(table),
    );
    let token = CancellationToken::new();
    let res = run_statement(client, &sql, None, &token, false)
        .await?
        .result;
    Ok(res
        .rows
        .into_iter()
        .filter_map(|row| {
            let name = row.first().cloned().flatten()?;
            let type_name = row.get(1).cloned().flatten().unwrap_or_default();
            let nullable = row
                .get(2)
                .cloned()
                .flatten()
                .is_some_and(|value| value.eq_ignore_ascii_case("YES"));
            let default = row.get(3).cloned().flatten();
            Some(ColumnDescription {
                name,
                type_name,
                nullable,
                default,
                primary_key: false,
            })
        })
        .collect())
}

pub async fn list_indexes(
    _client: &PrestoClient,
    _schema: Option<&str>,
    _table: &str,
) -> Result<Vec<IndexInfo>, String> {
    Ok(Vec::new())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};

    struct ExpectedRequest {
        method: &'static str,
        path: String,
        body_contains: Option<&'static str>,
        headers: Vec<(&'static str, &'static str)>,
        response_body: String,
    }

    async fn read_request(stream: &mut TcpStream) -> String {
        let mut buf = Vec::new();
        let mut tmp = [0_u8; 1024];
        let header_end;
        loop {
            let n = stream.read(&mut tmp).await.unwrap();
            assert!(n > 0, "connection closed before request headers");
            buf.extend_from_slice(&tmp[..n]);
            if let Some(pos) = find_bytes(&buf, b"\r\n\r\n") {
                header_end = pos + 4;
                break;
            }
        }
        let request_head = String::from_utf8_lossy(&buf[..header_end]).to_string();
        let content_length = request_head
            .lines()
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                name.eq_ignore_ascii_case("content-length")
                    .then(|| value.trim().parse::<usize>().ok())
                    .flatten()
            })
            .unwrap_or(0);
        while buf.len() < header_end + content_length {
            let n = stream.read(&mut tmp).await.unwrap();
            assert!(n > 0, "connection closed before request body");
            buf.extend_from_slice(&tmp[..n]);
        }
        String::from_utf8(buf).unwrap()
    }

    fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
        haystack
            .windows(needle.len())
            .position(|value| value == needle)
    }

    fn request_body(request: &str) -> &str {
        request
            .split_once("\r\n\r\n")
            .map(|(_, body)| body)
            .unwrap_or("")
    }

    fn header_value<'a>(request: &'a str, key: &str) -> Option<&'a str> {
        request.lines().find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case(key).then(|| value.trim())
        })
    }

    async fn serve_expected_requests(listener: TcpListener, expected: Vec<ExpectedRequest>) {
        let mut expected = VecDeque::from(expected);
        while let Some(expected) = expected.pop_front() {
            let (mut stream, _) = listener.accept().await.unwrap();
            let request = read_request(&mut stream).await;
            let request_line = request.lines().next().unwrap_or_default();
            assert!(
                request_line.starts_with(&format!("{} {} ", expected.method, expected.path)),
                "unexpected request line: {request_line}"
            );
            for (key, value) in expected.headers {
                assert_eq!(header_value(&request, key), Some(value), "header {key}");
            }
            if let Some(body_part) = expected.body_contains {
                assert!(
                    request_body(&request).contains(body_part),
                    "request body did not contain {body_part:?}: {}",
                    request_body(&request)
                );
            }
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                expected.response_body.len(),
                expected.response_body
            );
            stream.write_all(response.as_bytes()).await.unwrap();
        }
    }

    fn test_client(base_url: String) -> PrestoClient {
        PrestoClient {
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(2))
                .build()
                .unwrap(),
            base_url,
            user: "analyst".to_string(),
            password: None,
            catalog: Arc::new(AsyncMutex::new(Some("hive".to_string()))),
            schema: Arc::new(AsyncMutex::new(Some("sales".to_string()))),
            current_next_uri: Arc::new(AsyncMutex::new(None)),
        }
    }

    #[test]
    fn presto_identifier_quoting_escapes_double_quotes() {
        assert_eq!(quote_presto_ident("te\"st"), "\"te\"\"st\"");
        assert_eq!(
            quote_presto_qualified(&["hive", "sales", "or\"ders"]),
            "\"hive\".\"sales\".\"or\"\"ders\""
        );
    }

    #[test]
    fn json_cells_render_as_nullable_strings() {
        assert_eq!(json_cell_to_string(&serde_json::Value::Null), None);
        assert_eq!(
            json_cell_to_string(&serde_json::json!({"a": 1})),
            Some("{\"a\":1}".to_string())
        );
        assert_eq!(
            json_cell_to_string(&serde_json::json!(["x", 2])),
            Some("[\"x\",2]".to_string())
        );
    }

    #[test]
    fn presto_error_includes_name_and_location() {
        let error = PrestoError {
            message: "bad query".to_string(),
            error_name: Some("SYNTAX_ERROR".to_string()),
            error_location: Some(PrestoErrorLocation {
                line_number: 3,
                column_number: 7,
            }),
        };
        assert_eq!(
            format_presto_error(error),
            "SYNTAX_ERROR: bad query at line 3, column 7"
        );
    }

    #[test]
    fn use_statement_parser_handles_quoted_catalog_schema() {
        assert_eq!(
            parse_use_parts("USE \"hive\".\"sales\";"),
            Some(vec!["hive".to_string(), "sales".to_string()])
        );
        assert_eq!(
            parse_use_parts("use tpch.tiny"),
            Some(vec!["tpch".to_string(), "tiny".to_string()])
        );
        assert_eq!(parse_use_parts("SELECT 1"), None);
    }

    #[tokio::test]
    async fn execute_posts_statement_and_polls_next_uri() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base_url = format!("http://{}", listener.local_addr().unwrap());
        let next_path = "/v1/statement/query-1/1";
        let next_uri = format!("{base_url}{next_path}");
        let server = tokio::spawn(serve_expected_requests(
            listener,
            vec![
                ExpectedRequest {
                    method: "POST",
                    path: "/v1/statement".to_string(),
                    body_contains: Some("SELECT * FROM orders"),
                    headers: vec![
                        ("X-Presto-User", "analyst"),
                        ("X-Presto-Catalog", "hive"),
                        ("X-Presto-Schema", "sales"),
                    ],
                    response_body: format!(
                        r#"{{"id":"query-1","columns":[{{"name":"id","type":"bigint"}}],"data":[[1]],"nextUri":"{next_uri}"}}"#
                    ),
                },
                ExpectedRequest {
                    method: "GET",
                    path: next_path.to_string(),
                    body_contains: None,
                    headers: vec![
                        ("X-Presto-User", "analyst"),
                        ("X-Presto-Catalog", "hive"),
                        ("X-Presto-Schema", "sales"),
                    ],
                    response_body: r#"{"id":"query-1","data":[[2]]}"#.to_string(),
                },
            ],
        ));
        let token = CancellationToken::new();

        let result = execute(&test_client(base_url), "SELECT * FROM orders", &token)
            .await
            .unwrap();
        server.await.unwrap();

        assert_eq!(result.columns.len(), 1);
        assert_eq!(result.columns[0].name, "id");
        assert_eq!(
            result.rows,
            vec![vec![Some("1".to_string())], vec![Some("2".to_string())]]
        );
        assert_eq!(result.rows_affected, 0);
    }

    #[tokio::test]
    async fn metadata_calls_use_catalog_context() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base_url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(serve_expected_requests(
            listener,
            vec![
                ExpectedRequest {
                    method: "POST",
                    path: "/v1/statement".to_string(),
                    body_contains: Some("information_schema.schemata"),
                    headers: vec![
                        ("X-Presto-User", "analyst"),
                        ("X-Presto-Catalog", "hive"),
                        ("X-Presto-Schema", "sales"),
                    ],
                    response_body: r#"{"id":"schemas","data":[["marketing"],["sales"]]}"#
                        .to_string(),
                },
                ExpectedRequest {
                    method: "POST",
                    path: "/v1/statement".to_string(),
                    body_contains: Some("table_schema = 'sales'"),
                    headers: vec![
                        ("X-Presto-User", "analyst"),
                        ("X-Presto-Catalog", "hive"),
                        ("X-Presto-Schema", "sales"),
                    ],
                    response_body: r#"{"id":"tables","data":[["orders","BASE TABLE"],["orders_v","VIEW"]]}"#
                        .to_string(),
                },
                ExpectedRequest {
                    method: "POST",
                    path: "/v1/statement".to_string(),
                    body_contains: Some("table_name = 'orders'"),
                    headers: vec![
                        ("X-Presto-User", "analyst"),
                        ("X-Presto-Catalog", "hive"),
                        ("X-Presto-Schema", "sales"),
                    ],
                    response_body: r#"{"id":"columns","data":[["id","bigint","NO",null],["note","varchar","YES","'new'"]]}"#
                        .to_string(),
                },
            ],
        ));
        let client = test_client(base_url);

        let schemas = list_schemas(&client).await.unwrap();
        let tables = list_tables(&client, Some("sales")).await.unwrap();
        let columns = describe_table(&client, Some("sales"), "orders")
            .await
            .unwrap();
        server.await.unwrap();

        assert_eq!(
            schemas
                .into_iter()
                .map(|schema| schema.name)
                .collect::<Vec<_>>(),
            vec!["marketing", "sales"]
        );
        assert_eq!(tables.len(), 2);
        assert_eq!(tables[0].name, "orders");
        assert_eq!(tables[0].kind, "table");
        assert_eq!(tables[1].name, "orders_v");
        assert_eq!(tables[1].kind, "view");
        assert_eq!(columns.len(), 2);
        assert_eq!(columns[0].name, "id");
        assert_eq!(columns[0].type_name, "bigint");
        assert!(!columns[0].nullable);
        assert_eq!(columns[1].name, "note");
        assert!(columns[1].nullable);
        assert_eq!(columns[1].default.as_deref(), Some("'new'"));
    }
}
