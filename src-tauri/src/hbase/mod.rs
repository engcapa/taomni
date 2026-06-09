//! JVM-free HBase shell client over the HBase REST/Stargate API.
//!
//! This module intentionally does not call `hbase shell`, `sqlline`, JDBC, or a
//! helper process. The frontend sends HBase-shell-like commands, we parse the
//! small command language here, and each operation is translated into REST API
//! calls against an HBase-compatible endpoint such as Stargate/Lindorm REST.
//!
//! The `native` submodule provides an alternative transport that speaks the
//! native RegionServer/Master RPC protocol directly (bootstrapped via
//! ZooKeeper), for clusters that do not expose a REST gateway.

pub mod native;


use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use reqwest::header::{HeaderMap, ACCEPT, CONTENT_TYPE, LOCATION};
use reqwest::{Client, Method, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::State;

use crate::state::AppState;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HBaseConfig {
    pub host: String,
    pub port: u16,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub ssl: bool,
    #[serde(default)]
    pub timeout_secs: Option<u64>,
    /// Optional path prefix before the HBase REST routes, e.g. a gateway path.
    #[serde(default)]
    pub rest_path: Option<String>,
    /// Optional namespace automatically prefixed to unqualified table names.
    #[serde(default)]
    pub namespace: Option<String>,
    /// Transport to use: `"native"` (RegionServer/Master RPC via ZooKeeper) or
    /// `"rest"` (HBase REST/Stargate gateway). Defaults to native.
    #[serde(default)]
    pub connection_mode: Option<String>,
    /// Comma-separated ZooKeeper quorum (`host:port,...`) for native mode. When
    /// omitted, falls back to `host:port` (treating `port` as the ZK port).
    #[serde(default)]
    pub zk_quorum: Option<String>,
    /// ZooKeeper root znode for native mode (default `/hbase`).
    #[serde(default)]
    pub zk_root: Option<String>,
    /// Effective user for native simple auth (default `root`).
    #[serde(default)]
    pub effective_user: Option<String>,
    /// Authentication method for native mode: "simple" (default) or "kerberos".
    #[serde(default)]
    pub auth_method: Option<String>,
    /// Service principal for Kerberos auth, e.g. "hbase/host@REALM".
    #[serde(default)]
    pub service_principal: Option<String>,
    /// Client principal for keytab-based Kerberos auth, e.g. "user@REALM".
    #[serde(default)]
    pub principal: Option<String>,
    /// Absolute path to a keytab file. When set together with `principal`,
    /// Taomni runs `kinit -kt <keytab> <principal>` before connecting to
    /// refresh the system ticket cache automatically.
    #[serde(default)]
    pub keytab_path: Option<String>,
    /// Absolute path to a custom krb5.conf file.
    #[serde(default)]
    pub krb5_conf_path: Option<String>,
}

impl HBaseConfig {
    /// True when the native RPC transport should be used. Native is the
    /// default; only an explicit `"rest"` selects the REST backend.
    fn is_native(&self) -> bool {
        !matches!(
            self.connection_mode.as_deref().map(str::trim),
            Some("rest") | Some("REST")
        )
    }
}

/// REST/Stargate transport session (legacy backend).
#[derive(Debug, Clone)]
pub struct RestSession {
    client: Client,
    base_url: String,
    username: Option<String>,
    password: Option<String>,
    namespace: Option<String>,
}

/// A live HBase session, backed by either the native RPC client or the REST
/// gateway. The map in `AppState` stores these behind an `Arc`.
pub enum HBaseSession {
    Native(native::client::NativeClient),
    Rest(RestSession),
}

#[derive(Debug, Serialize)]
pub struct HBaseConnectResult {
    pub ok: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HBaseTableInfo {
    pub name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HBaseColumnFamily {
    pub name: String,
    pub attributes: BTreeMap<String, String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HBaseTableSchema {
    pub name: String,
    pub column_families: Vec<HBaseColumnFamily>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HBaseShellResult {
    pub command: String,
    pub message: String,
    pub columns: Vec<String>,
    pub rows: Vec<Vec<String>>,
    pub warnings: Vec<String>,
    pub duration_ms: u64,
}

#[derive(Debug, Clone)]
enum ShellCommand {
    Help,
    List,
    Status,
    Version,
    Describe {
        table: String,
    },
    Create {
        table: String,
        families: Vec<FamilySpec>,
    },
    Drop {
        table: String,
    },
    Get {
        table: String,
        row: String,
        column: Option<String>,
    },
    Scan {
        table: String,
        limit: usize,
        start_row: Option<String>,
        stop_row: Option<String>,
        columns: Vec<String>,
    },
    Put {
        table: String,
        row: String,
        column: String,
        value: String,
    },
    Delete {
        table: String,
        row: String,
        column: String,
    },
    DeleteAll {
        table: String,
        row: String,
    },
}

#[derive(Debug, Clone)]
struct FamilySpec {
    name: String,
    attributes: BTreeMap<String, String>,
}

#[tauri::command]
pub async fn hbase_connect(
    state: State<'_, AppState>,
    session_id: String,
    config: HBaseConfig,
) -> Result<HBaseConnectResult, String> {
    let password = resolve_secret(&state, config.password.as_deref())?;
    let session = Arc::new(build_session(&config, password).await?);
    ping_backend(&session).await?;
    let mut map = state.hbase_sessions.write().await;
    map.insert(session_id, session);
    Ok(HBaseConnectResult { ok: true })
}

#[tauri::command]
pub async fn hbase_ping(state: State<'_, AppState>, session_id: String) -> Result<String, String> {
    let session = get_session(&state, &session_id).await?;
    ping_backend(&session).await
}

#[tauri::command]
pub async fn hbase_disconnect(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    state.hbase_sessions.write().await.remove(&session_id);
    Ok(())
}

#[tauri::command]
pub async fn hbase_list_tables(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Vec<HBaseTableInfo>, String> {
    let session = get_session(&state, &session_id).await?;
    match session.as_ref() {
        HBaseSession::Rest(rest) => list_tables(rest).await,
        HBaseSession::Native(client) => native_list_tables(client).await,
    }
}

#[tauri::command]
pub async fn hbase_describe_table(
    state: State<'_, AppState>,
    session_id: String,
    table: String,
) -> Result<HBaseTableSchema, String> {
    let session = get_session(&state, &session_id).await?;
    match session.as_ref() {
        HBaseSession::Rest(rest) => describe_table(rest, &table).await,
        HBaseSession::Native(client) => native_describe_table(client, &table).await,
    }
}

#[tauri::command]
pub async fn hbase_execute(
    state: State<'_, AppState>,
    session_id: String,
    command: String,
) -> Result<HBaseShellResult, String> {
    let session = get_session(&state, &session_id).await?;
    let parsed = parse_shell_command(&command)?;
    let started = Instant::now();
    let raw = command.trim().to_string();
    let mut result = match session.as_ref() {
        HBaseSession::Rest(rest) => execute_command(rest, parsed, raw).await?,
        HBaseSession::Native(client) => native_execute(client, parsed, raw).await?,
    };
    result.duration_ms = started.elapsed().as_millis() as u64;
    Ok(result)
}

/// Build a session for the configured transport, resolving any secrets.
async fn build_session(
    config: &HBaseConfig,
    password: Option<String>,
) -> Result<HBaseSession, String> {
    if config.is_native() {
        // If keytab + principal are configured, run kinit to refresh the
        // ticket cache before establishing the GSSAPI connection.
        if config.auth_method.as_deref().map(str::trim) == Some("kerberos") {
            try_keytab_kinit(config)?;
        }
        Ok(HBaseSession::Native(build_native_client(config)?))
    } else {
        Ok(HBaseSession::Rest(RestSession::new(config, password)?))
    }
}

/// Sets the environment variables needed for programmatic Kerberos keytab
/// authentication, avoiding the need for an external `kinit` subprocess.
fn try_keytab_kinit(config: &HBaseConfig) -> Result<(), String> {
    if let Some(krb5_conf) = config.krb5_conf_path.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        std::env::set_var("KRB5_CONFIG", krb5_conf);
    }

    let keytab = match config.keytab_path.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(k) => k,
        None => return Ok(()), // no keytab configured
    };
    let principal = config.principal.as_deref().map(str::trim).filter(|s| !s.is_empty())
        .ok_or_else(|| "Keytab auth requires a client principal (e.g. user@REALM)".to_string())?;

    // Set the client keytab path variable so MIT Kerberos/Heimdal auto-authenticates.
    std::env::set_var("KRB5_CLIENT_KTNAME", keytab);

    // Isolate the ticket cache for this connection so we don't read or pollute the system cache.
    let cache_name = format!("MEMORY:taomni_hbase_{}", principal);
    std::env::set_var("KRB5CCNAME", &cache_name);

    Ok(())
}

/// Construct the native client from the connection config.
fn build_native_client(
    config: &HBaseConfig,
) -> Result<native::client::NativeClient, String> {
    let host = config.host.trim();
    if host.is_empty() {
        return Err("HBase host is required".into());
    }
    // ZK quorum: explicit field wins; otherwise treat host:port as the quorum.
    let zk_quorum = match config.zk_quorum.as_deref().map(str::trim) {
        Some(q) if !q.is_empty() => q.to_string(),
        _ => format!("{host}:{}", config.port),
    };
    let cfg = native::client::NativeConfig {
        zk_quorum,
        zk_root: config
            .zk_root
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("/hbase")
            .to_string(),
        effective_user: config
            .effective_user
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("root")
            .to_string(),
        namespace: config
            .namespace
            .clone()
            .filter(|s| !s.trim().is_empty()),
        timeout: Duration::from_secs(config.timeout_secs.unwrap_or(15).clamp(1, 300)),
        auth: match config.auth_method.as_deref().map(str::trim) {
            Some("kerberos") | Some("Kerberos") | Some("KERBEROS") => {
                let spn = config.service_principal
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .ok_or_else(|| "Kerberos auth requires a service principal (e.g. hbase/host@REALM)".to_string())?;
                native::auth::AuthMethod::Kerberos {
                    service_principal: spn.to_string(),
                }
            }
            _ => native::auth::AuthMethod::Simple,
        },
    };
    Ok(native::client::NativeClient::new(cfg))
}

/// Ping whichever backend the session uses.
async fn ping_backend(session: &HBaseSession) -> Result<String, String> {
    match session {
        HBaseSession::Rest(rest) => ping_session(rest).await,
        HBaseSession::Native(client) => client.ping().await.map_err(|e| e.to_string()),
    }
}

impl RestSession {
    fn new(config: &HBaseConfig, password: Option<String>) -> Result<Self, String> {
        let host = config.host.trim();
        if host.is_empty() {
            return Err("HBase REST host is required".into());
        }
        let scheme = if config.ssl { "https" } else { "http" };
        let path = normalize_rest_path(config.rest_path.as_deref());
        let base_url = format!("{scheme}://{host}:{}{}", config.port, path);
        let timeout_secs = config.timeout_secs.unwrap_or(15).clamp(1, 300);
        let client = Client::builder()
            .timeout(Duration::from_secs(timeout_secs))
            .build()
            .map_err(|e| format!("HBase client build failed: {e}"))?;
        Ok(Self {
            client,
            base_url,
            username: config.username.clone().filter(|s| !s.trim().is_empty()),
            password,
            namespace: config.namespace.clone().filter(|s| !s.trim().is_empty()),
        })
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.base_url, path)
    }

    fn table_name(&self, table: &str) -> String {
        let trimmed = table.trim();
        match self.namespace.as_deref() {
            Some(ns) if !trimmed.contains(':') => format!("{ns}:{trimmed}"),
            _ => trimmed.to_string(),
        }
    }

    fn request(&self, method: Method, url: String) -> reqwest::RequestBuilder {
        let req = self
            .client
            .request(method, url)
            .header(ACCEPT, "application/json");
        match self.username.as_deref() {
            Some(user) => req.basic_auth(user, self.password.clone()),
            None => req,
        }
    }
}

fn normalize_rest_path(value: Option<&str>) -> String {
    let trimmed = value.unwrap_or("").trim();
    if trimmed.is_empty() || trimmed == "/" {
        String::new()
    } else {
        format!("/{}", trimmed.trim_matches('/'))
    }
}

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
) -> Result<Arc<HBaseSession>, String> {
    state
        .hbase_sessions
        .read()
        .await
        .get(session_id)
        .cloned()
        .ok_or_else(|| format!("No active HBase shell session for {session_id}"))
}

async fn ping_session(session: &RestSession) -> Result<String, String> {
    let value = get_json(session, "/version/cluster?format=json").await?;
    if let Some(version) = value.get("Version").and_then(Value::as_str) {
        Ok(format!("HBase REST connection OK ({version})"))
    } else if let Some(version) = value.get("version").and_then(Value::as_str) {
        Ok(format!("HBase REST connection OK ({version})"))
    } else {
        Ok("HBase REST connection OK".into())
    }
}

async fn get_json(session: &RestSession, path: &str) -> Result<Value, String> {
    send_json(session, Method::GET, path, None).await
}

async fn send_json(
    session: &RestSession,
    method: Method,
    path: &str,
    body: Option<Value>,
) -> Result<Value, String> {
    let mut req = session.request(method, session.url(path));
    if let Some(body) = body {
        req = req.header(CONTENT_TYPE, "application/json").json(&body);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| describe_request_error("HBase REST request failed", &e))?;
    response_json(resp).await
}

/// Build a diagnostic message that exposes the underlying transport cause.
///
/// `reqwest::Error`'s top-level `Display` is the unhelpful
/// "error sending request for url (...)"; the real reason (connection refused,
/// timed out, DNS failure, TLS handshake) only lives in its `source()` chain.
/// We classify the failure and append the deepest distinct cause so the user
/// can tell a routing/firewall problem from a wrong port or a TLS mismatch.
fn describe_request_error(context: &str, err: &reqwest::Error) -> String {
    use std::error::Error;

    let kind = if err.is_timeout() {
        "timed out"
    } else if err.is_connect() {
        "connection failed"
    } else if err.is_redirect() {
        "too many redirects"
    } else {
        "send failed"
    };

    let mut causes: Vec<String> = Vec::new();
    let mut source = err.source();
    while let Some(cause) = source {
        let msg = cause.to_string();
        if causes.last().map(String::as_str) != Some(msg.as_str()) {
            causes.push(msg);
        }
        source = cause.source();
    }

    if causes.is_empty() {
        format!("{context} ({kind}): {err}")
    } else {
        format!("{context} ({kind}): {}", causes.join(": "))
    }
}

async fn response_json(resp: reqwest::Response) -> Result<Value, String> {
    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("HBase REST response read failed: {e}"))?;
    if !status.is_success() {
        return Err(format!("HBase REST error ({status}): {}", text.trim()));
    }
    if text.trim().is_empty() {
        Ok(Value::Null)
    } else {
        serde_json::from_str(&text)
            .map_err(|e| format!("HBase REST JSON parse failed: {e}; body: {}", text.trim()))
    }
}

async fn list_tables(session: &RestSession) -> Result<Vec<HBaseTableInfo>, String> {
    let value = get_json(session, "/?format=json").await?;
    Ok(extract_table_names(&value)
        .into_iter()
        .map(|name| HBaseTableInfo { name })
        .collect())
}

fn extract_table_names(value: &Value) -> Vec<String> {
    let candidates = [
        value.get("table"),
        value.get("Table"),
        value.get("tables"),
        value.get("Tables"),
    ];
    for candidate in candidates.into_iter().flatten() {
        if let Some(array) = candidate.as_array() {
            return array
                .iter()
                .filter_map(|item| {
                    item.as_str().map(ToString::to_string).or_else(|| {
                        item.get("name")
                            .and_then(Value::as_str)
                            .map(ToString::to_string)
                    })
                })
                .collect();
        }
    }
    value
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(ToString::to_string))
                .collect()
        })
        .unwrap_or_default()
}

async fn describe_table(session: &RestSession, table: &str) -> Result<HBaseTableSchema, String> {
    let table = session.table_name(table);
    let path = format!("/{}/schema?format=json", enc(&table));
    let value = get_json(session, &path).await?;
    Ok(parse_schema(&table, &value))
}

fn parse_schema(fallback_name: &str, value: &Value) -> HBaseTableSchema {
    let name = value
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or(fallback_name)
        .to_string();
    let schemas = value
        .get("ColumnSchema")
        .or_else(|| value.get("columnSchema"))
        .or_else(|| value.get("columns"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let column_families = schemas
        .into_iter()
        .filter_map(|entry| {
            let obj = entry.as_object()?;
            let name = obj.get("name").and_then(Value::as_str)?.to_string();
            let attributes = obj
                .iter()
                .filter_map(|(key, value)| {
                    if key == "name" {
                        return None;
                    }
                    Some((key.clone(), value_to_shell_string(value)))
                })
                .collect();
            Some(HBaseColumnFamily { name, attributes })
        })
        .collect();
    HBaseTableSchema {
        name,
        column_families,
    }
}

async fn execute_command(
    session: &RestSession,
    command: ShellCommand,
    raw: String,
) -> Result<HBaseShellResult, String> {
    match command {
        ShellCommand::Help => Ok(help_result(raw)),
        ShellCommand::List => {
            let tables = list_tables(session).await?;
            Ok(table_result(
                raw,
                format!("{} table(s)", tables.len()),
                vec!["TABLE"],
                tables.into_iter().map(|t| vec![t.name]).collect(),
            ))
        }
        ShellCommand::Status => {
            let value = get_json(session, "/status/cluster?format=json").await?;
            Ok(value_result(raw, "Cluster status".into(), &value))
        }
        ShellCommand::Version => {
            let value = get_json(session, "/version/cluster?format=json").await?;
            Ok(value_result(raw, "Cluster version".into(), &value))
        }
        ShellCommand::Describe { table } => {
            let schema = describe_table(session, &table).await?;
            let rows = schema
                .column_families
                .into_iter()
                .map(|family| {
                    vec![
                        family.name,
                        family
                            .attributes
                            .into_iter()
                            .map(|(k, v)| format!("{k}={v}"))
                            .collect::<Vec<_>>()
                            .join(", "),
                    ]
                })
                .collect::<Vec<_>>();
            Ok(table_result(
                raw,
                format!("Schema for {}", schema.name),
                vec!["COLUMN FAMILY", "ATTRIBUTES"],
                rows,
            ))
        }
        ShellCommand::Create { table, families } => {
            let table = session.table_name(&table);
            let families_json = families
                .into_iter()
                .map(|family| {
                    let mut obj = Map::new();
                    obj.insert("name".into(), Value::String(family.name));
                    for (key, value) in family.attributes {
                        obj.insert(key, Value::String(value));
                    }
                    Value::Object(obj)
                })
                .collect::<Vec<_>>();
            let body = json!({
                "name": table,
                "ColumnSchema": families_json,
            });
            let path = format!("/{}/schema", enc(&table));
            send_json(session, Method::PUT, &path, Some(body)).await?;
            Ok(message_result(
                raw,
                format!("Created or updated table {table}"),
            ))
        }
        ShellCommand::Drop { table } => {
            let table = session.table_name(&table);
            let path = format!("/{}/schema", enc(&table));
            send_json(session, Method::DELETE, &path, None).await?;
            Ok(message_result(raw, format!("Dropped table {table}")))
        }
        ShellCommand::Get { table, row, column } => {
            let table = session.table_name(&table);
            let path = match column.as_deref() {
                Some(column) => {
                    format!("/{}/{}/{}?format=json", enc(&table), enc(&row), enc(column))
                }
                None => format!("/{}/{}?format=json", enc(&table), enc(&row)),
            };
            let value = get_json(session, &path).await?;
            let rows = cellset_rows(&value);
            Ok(table_result(
                raw,
                format!("{} cell(s)", rows.len()),
                vec!["ROW", "COLUMN", "TIMESTAMP", "VALUE"],
                rows,
            ))
        }
        ShellCommand::Scan {
            table,
            limit,
            start_row,
            stop_row,
            columns,
        } => {
            let table = session.table_name(&table);
            let rows = scan_table(session, &table, limit, start_row, stop_row, columns).await?;
            Ok(table_result(
                raw,
                format!("{} cell(s)", rows.len()),
                vec!["ROW", "COLUMN", "TIMESTAMP", "VALUE"],
                rows,
            ))
        }
        ShellCommand::Put {
            table,
            row,
            column,
            value,
        } => {
            let table = session.table_name(&table);
            let body = cellset_body(&row, &column, &value);
            let path = format!("/{}/{}/{}", enc(&table), enc(&row), enc(&column));
            send_json(session, Method::PUT, &path, Some(body)).await?;
            Ok(message_result(raw, "1 cell written".into()))
        }
        ShellCommand::Delete { table, row, column } => {
            let table = session.table_name(&table);
            let path = format!("/{}/{}/{}", enc(&table), enc(&row), enc(&column));
            send_json(session, Method::DELETE, &path, None).await?;
            Ok(message_result(raw, "Cell deleted".into()))
        }
        ShellCommand::DeleteAll { table, row } => {
            let table = session.table_name(&table);
            let path = format!("/{}/{}", enc(&table), enc(&row));
            send_json(session, Method::DELETE, &path, None).await?;
            Ok(message_result(raw, "Row deleted".into()))
        }
    }
}

async fn scan_table(
    session: &RestSession,
    table: &str,
    limit: usize,
    start_row: Option<String>,
    stop_row: Option<String>,
    columns: Vec<String>,
) -> Result<Vec<Vec<String>>, String> {
    let batch = limit.clamp(1, 1000);
    let mut spec = Map::new();
    spec.insert("batch".into(), json!(batch));
    spec.insert("caching".into(), json!(batch));
    if let Some(row) = start_row.as_deref().filter(|s| !s.is_empty()) {
        spec.insert("startRow".into(), json!(b64(row)));
    }
    if let Some(row) = stop_row.as_deref().filter(|s| !s.is_empty()) {
        spec.insert("endRow".into(), json!(b64(row)));
    }
    if !columns.is_empty() {
        spec.insert(
            "column".into(),
            Value::Array(columns.iter().map(|column| json!(b64(column))).collect()),
        );
    }

    let path = format!("/{}/scanner", enc(table));
    match create_scanner(session, &path, Value::Object(spec)).await {
        Ok(location) => read_scanner(session, &location, limit).await,
        Err(err) => {
            let rows = scan_wildcard(session, table, limit).await?;
            if rows.is_empty() {
                Err(err)
            } else {
                Ok(rows)
            }
        }
    }
}

async fn create_scanner(session: &RestSession, path: &str, body: Value) -> Result<String, String> {
    let resp = session
        .request(Method::PUT, session.url(path))
        .header(CONTENT_TYPE, "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| describe_request_error("HBase scanner create failed", &e))?;
    let status = resp.status();
    let headers = resp.headers().clone();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!(
            "HBase scanner create error ({status}): {}",
            text.trim()
        ));
    }
    scanner_location(&session.base_url, &headers)
        .ok_or_else(|| "HBase scanner response did not include a Location header".into())
}

async fn read_scanner(
    session: &RestSession,
    location: &str,
    limit: usize,
) -> Result<Vec<Vec<String>>, String> {
    let mut rows = Vec::new();
    for _ in 0..1000 {
        if rows.len() >= limit {
            break;
        }
        let resp = session
            .request(Method::GET, location.to_string())
            .send()
            .await
            .map_err(|e| describe_request_error("HBase scanner read failed", &e))?;
        if resp.status() == StatusCode::NO_CONTENT {
            break;
        }
        let value = response_json(resp).await?;
        let mut next = cellset_rows(&value);
        if next.is_empty() {
            break;
        }
        let remaining = limit.saturating_sub(rows.len());
        let take = remaining.min(next.len());
        rows.extend(next.drain(..take));
    }
    let _ = session
        .request(Method::DELETE, location.to_string())
        .send()
        .await;
    Ok(rows)
}

fn scanner_location(base_url: &str, headers: &HeaderMap) -> Option<String> {
    let raw = headers.get(LOCATION)?.to_str().ok()?.trim();
    if raw.starts_with("http://") || raw.starts_with("https://") {
        Some(raw.to_string())
    } else if raw.starts_with('/') {
        let scheme_end = base_url.find("://").map(|index| index + 3)?;
        let origin_end = base_url[scheme_end..]
            .find('/')
            .map(|index| scheme_end + index)
            .unwrap_or(base_url.len());
        Some(format!("{}{}", &base_url[..origin_end], raw))
    } else {
        Some(format!("{base_url}/{raw}"))
    }
}

async fn scan_wildcard(
    session: &RestSession,
    table: &str,
    limit: usize,
) -> Result<Vec<Vec<String>>, String> {
    let path = format!("/{}/%2A?limit={}&format=json", enc(table), limit);
    let value = get_json(session, &path).await?;
    Ok(cellset_rows(&value).into_iter().take(limit).collect())
}

fn parse_shell_command(input: &str) -> Result<ShellCommand, String> {
    let trimmed = input.trim().trim_end_matches(';').trim();
    if trimmed.is_empty() {
        return Err("Enter an HBase shell command".into());
    }
    let (name, rest) = split_command_name(trimmed);
    let args = split_top_level(rest.trim(), ',')
        .into_iter()
        .filter(|s| !s.trim().is_empty())
        .collect::<Vec<_>>();
    match name.to_ascii_lowercase().as_str() {
        "help" | "?" => Ok(ShellCommand::Help),
        "list" => Ok(ShellCommand::List),
        "status" => Ok(ShellCommand::Status),
        "version" => Ok(ShellCommand::Version),
        "describe" | "desc" => Ok(ShellCommand::Describe {
            table: required_arg(&args, 0, "describe table")?,
        }),
        "create" => {
            let table = required_arg(&args, 0, "create table")?;
            let families = args
                .iter()
                .skip(1)
                .map(|arg| parse_family_spec(arg))
                .collect::<Result<Vec<_>, _>>()?;
            if families.is_empty() {
                return Err("create requires at least one column family".into());
            }
            Ok(ShellCommand::Create { table, families })
        }
        "drop" => Ok(ShellCommand::Drop {
            table: required_arg(&args, 0, "drop table")?,
        }),
        "get" => {
            let table = required_arg(&args, 0, "get table")?;
            let row = required_arg(&args, 1, "get row")?;
            // The third arg is either an option map (`{COLUMN=>'cf:q'}`) or a
            // bare column literal (`'cf:q'`). Only parse it as a map when it
            // actually looks like one, so a bare column doesn't error out.
            let third = args.get(2).map(|s| s.trim());
            let column = match third {
                Some(s) if s.starts_with('{') => {
                    parse_options(s)?.get("COLUMN").cloned()
                }
                Some(s) if !s.is_empty() => Some(strip_quotes(s)),
                _ => None,
            };
            Ok(ShellCommand::Get { table, row, column })
        }
        "scan" => {
            let table = required_arg(&args, 0, "scan table")?;
            let opts = args
                .get(1)
                .map(|s| parse_options(s))
                .transpose()?
                .unwrap_or_default();
            let limit = opts
                .get("LIMIT")
                .and_then(|v| v.parse::<usize>().ok())
                .unwrap_or(100)
                .clamp(1, 10_000);
            let columns = opts
                .get("COLUMNS")
                .or_else(|| opts.get("COLUMN"))
                .map(|v| parse_columns_value(v))
                .unwrap_or_default();
            Ok(ShellCommand::Scan {
                table,
                limit,
                start_row: opts.get("STARTROW").cloned(),
                stop_row: opts.get("STOPROW").or_else(|| opts.get("ENDROW")).cloned(),
                columns,
            })
        }
        "put" => Ok(ShellCommand::Put {
            table: required_arg(&args, 0, "put table")?,
            row: required_arg(&args, 1, "put row")?,
            column: required_arg(&args, 2, "put column")?,
            value: required_arg(&args, 3, "put value")?,
        }),
        "delete" => Ok(ShellCommand::Delete {
            table: required_arg(&args, 0, "delete table")?,
            row: required_arg(&args, 1, "delete row")?,
            column: required_arg(&args, 2, "delete column")?,
        }),
        "deleteall" => Ok(ShellCommand::DeleteAll {
            table: required_arg(&args, 0, "deleteall table")?,
            row: required_arg(&args, 1, "deleteall row")?,
        }),
        "enable" | "disable" | "alter" | "count" => Err(format!(
            "{name} is not implemented by the HBase REST shell client yet"
        )),
        other => Err(format!("Unsupported HBase shell command: {other}")),
    }
}

fn split_command_name(value: &str) -> (&str, &str) {
    match value.find(char::is_whitespace) {
        Some(index) => (&value[..index], &value[index + 1..]),
        None => (value, ""),
    }
}

fn required_arg(args: &[String], index: usize, label: &str) -> Result<String, String> {
    args.get(index)
        .map(|value| strip_quotes(value))
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("Missing {label} argument"))
}

fn parse_family_spec(input: &str) -> Result<FamilySpec, String> {
    let trimmed = input.trim();
    if trimmed.starts_with('{') {
        let opts = parse_options(trimmed)?;
        let name = opts
            .get("NAME")
            .cloned()
            .ok_or_else(|| "column family map requires NAME".to_string())?;
        let attributes = opts
            .into_iter()
            .filter(|(key, _)| key != "NAME")
            .collect::<BTreeMap<_, _>>();
        Ok(FamilySpec { name, attributes })
    } else {
        Ok(FamilySpec {
            name: strip_quotes(trimmed),
            attributes: BTreeMap::new(),
        })
    }
}

fn parse_options(input: &str) -> Result<BTreeMap<String, String>, String> {
    let trimmed = input.trim();
    if !trimmed.starts_with('{') || !trimmed.ends_with('}') {
        return Err(format!("Expected option map, got {trimmed}"));
    }
    let inner = &trimmed[1..trimmed.len() - 1];
    let mut out = BTreeMap::new();
    for item in split_top_level(inner, ',') {
        let Some((key, value)) = split_arrow(&item) else {
            continue;
        };
        out.insert(
            strip_quotes(&key).to_ascii_uppercase(),
            strip_quotes(&value),
        );
    }
    Ok(out)
}

fn parse_columns_value(value: &str) -> Vec<String> {
    let trimmed = value.trim();
    if trimmed.starts_with('[') && trimmed.ends_with(']') {
        split_top_level(&trimmed[1..trimmed.len() - 1], ',')
            .into_iter()
            .map(|v| strip_quotes(&v))
            .filter(|v| !v.is_empty())
            .collect()
    } else {
        vec![strip_quotes(trimmed)]
    }
}

fn split_arrow(input: &str) -> Option<(String, String)> {
    let mut single = false;
    let mut double = false;
    let chars = input.chars().collect::<Vec<_>>();
    let mut i = 0;
    while i + 1 < chars.len() {
        match chars[i] {
            '\'' if !double => single = !single,
            '"' if !single => double = !double,
            '=' if !single && !double && chars[i + 1] == '>' => {
                return Some((
                    chars[..i].iter().collect::<String>(),
                    chars[i + 2..].iter().collect::<String>(),
                ));
            }
            _ => {}
        }
        i += 1;
    }
    None
}

fn split_top_level(input: &str, delimiter: char) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    let mut single = false;
    let mut double = false;
    let mut brace_depth = 0usize;
    let mut bracket_depth = 0usize;
    let mut escaped = false;
    for ch in input.chars() {
        if escaped {
            current.push(ch);
            escaped = false;
            continue;
        }
        if ch == '\\' && (single || double) {
            current.push(ch);
            escaped = true;
            continue;
        }
        match ch {
            '\'' if !double => {
                single = !single;
                current.push(ch);
            }
            '"' if !single => {
                double = !double;
                current.push(ch);
            }
            '{' if !single && !double => {
                brace_depth += 1;
                current.push(ch);
            }
            '}' if !single && !double => {
                brace_depth = brace_depth.saturating_sub(1);
                current.push(ch);
            }
            '[' if !single && !double => {
                bracket_depth += 1;
                current.push(ch);
            }
            ']' if !single && !double => {
                bracket_depth = bracket_depth.saturating_sub(1);
                current.push(ch);
            }
            ch if ch == delimiter
                && !single
                && !double
                && brace_depth == 0
                && bracket_depth == 0 =>
            {
                out.push(current.trim().to_string());
                current.clear();
            }
            _ => current.push(ch),
        }
    }
    if !current.trim().is_empty() {
        out.push(current.trim().to_string());
    }
    out
}

fn strip_quotes(input: &str) -> String {
    let trimmed = input.trim();
    let quoted = (trimmed.starts_with('\'') && trimmed.ends_with('\''))
        || (trimmed.starts_with('"') && trimmed.ends_with('"'));
    if quoted && trimmed.len() >= 2 {
        trimmed[1..trimmed.len() - 1]
            .replace("\\'", "'")
            .replace("\\\"", "\"")
            .replace("\\n", "\n")
            .replace("\\t", "\t")
    } else {
        trimmed.to_string()
    }
}

fn cellset_body(row: &str, column: &str, value: &str) -> Value {
    json!({
        "Row": [{
            "key": b64(row),
            "Cell": [{
                "column": b64(column),
                "$": b64(value),
            }]
        }]
    })
}

fn cellset_rows(value: &Value) -> Vec<Vec<String>> {
    let Some(rows) = value
        .get("Row")
        .or_else(|| value.get("row"))
        .and_then(Value::as_array)
    else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for row in rows {
        let key = row
            .get("key")
            .and_then(Value::as_str)
            .map(deb64)
            .unwrap_or_default();
        let cells = row
            .get("Cell")
            .or_else(|| row.get("cell"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        for cell in cells {
            let column = cell
                .get("column")
                .and_then(Value::as_str)
                .map(deb64)
                .unwrap_or_default();
            let timestamp = cell
                .get("timestamp")
                .or_else(|| cell.get("Timestamp"))
                .and_then(|v| v.as_i64().or_else(|| v.as_str()?.parse::<i64>().ok()))
                .map(|v| v.to_string())
                .unwrap_or_default();
            let value = cell
                .get("$")
                .or_else(|| cell.get("value"))
                .and_then(Value::as_str)
                .map(deb64)
                .unwrap_or_default();
            out.push(vec![key.clone(), column, timestamp, value]);
        }
    }
    out
}

fn value_result(command: String, message: String, value: &Value) -> HBaseShellResult {
    match value.as_object() {
        Some(obj) => table_result(
            command,
            message,
            vec!["KEY", "VALUE"],
            obj.iter()
                .map(|(key, value)| vec![key.clone(), value_to_shell_string(value)])
                .collect(),
        ),
        None => message_result(command, value_to_shell_string(value)),
    }
}

fn help_result(command: String) -> HBaseShellResult {
    table_result(
        command,
        "Supported HBase REST shell commands".into(),
        vec!["COMMAND", "EXAMPLE"],
        vec![
            vec!["list".into(), "list".into()],
            vec!["describe".into(), "describe 'table'".into()],
            vec![
                "scan".into(),
                "scan 'table', {LIMIT=>50, STARTROW=>'r1', COLUMNS=>['cf:q']}".into(),
            ],
            vec!["get".into(), "get 'table', 'row', {COLUMN=>'cf:q'}".into()],
            vec!["put".into(), "put 'table', 'row', 'cf:q', 'value'".into()],
            vec!["delete".into(), "delete 'table', 'row', 'cf:q'".into()],
            vec!["deleteall".into(), "deleteall 'table', 'row'".into()],
            vec!["create".into(), "create 'table', 'cf'".into()],
            vec!["drop".into(), "drop 'table'".into()],
            vec!["status".into(), "status".into()],
            vec!["version".into(), "version".into()],
        ],
    )
}

fn table_result(
    command: String,
    message: String,
    columns: Vec<&str>,
    rows: Vec<Vec<String>>,
) -> HBaseShellResult {
    HBaseShellResult {
        command,
        message,
        columns: columns.into_iter().map(ToString::to_string).collect(),
        rows,
        warnings: Vec::new(),
        duration_ms: 0,
    }
}

fn message_result(command: String, message: String) -> HBaseShellResult {
    HBaseShellResult {
        command,
        message,
        columns: Vec::new(),
        rows: Vec::new(),
        warnings: Vec::new(),
        duration_ms: 0,
    }
}

fn value_to_shell_string(value: &Value) -> String {
    match value {
        Value::Null => "NULL".into(),
        Value::Bool(v) => v.to_string(),
        Value::Number(v) => v.to_string(),
        Value::String(v) => v.clone(),
        _ => serde_json::to_string(value).unwrap_or_default(),
    }
}

fn enc(value: &str) -> String {
    urlencoding::encode(value).into_owned()
}

fn b64(value: &str) -> String {
    B64.encode(value.as_bytes())
}

fn deb64(value: &str) -> String {
    B64.decode(value.as_bytes())
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
        .unwrap_or_else(|_| value.to_string())
}

// ---- native backend dispatch -----------------------------------------------

use native::client::{NativeClient, ResultRow};

async fn native_list_tables(client: &NativeClient) -> Result<Vec<HBaseTableInfo>, String> {
    client
        .list_tables()
        .await
        .map(|names| names.into_iter().map(|name| HBaseTableInfo { name }).collect())
        .map_err(|e| e.to_string())
}

async fn native_describe_table(
    client: &NativeClient,
    table: &str,
) -> Result<HBaseTableSchema, String> {
    let (name, families) = client.describe_table(table).await.map_err(|e| e.to_string())?;
    Ok(HBaseTableSchema {
        name,
        column_families: families
            .into_iter()
            .map(|f| HBaseColumnFamily {
                name: f.name,
                attributes: f.attributes,
            })
            .collect(),
    })
}

/// Render result-row cells into the shell's ROW/COLUMN/TIMESTAMP/VALUE table.
fn rows_to_cell_table(raw: String, rows: Vec<ResultRow>) -> HBaseShellResult {
    let body: Vec<Vec<String>> = rows
        .into_iter()
        .map(|r| {
            vec![
                String::from_utf8_lossy(&r.row).into_owned(),
                String::from_utf8_lossy(&r.column).into_owned(),
                r.timestamp.to_string(),
                String::from_utf8_lossy(&r.value).into_owned(),
            ]
        })
        .collect();
    table_result(
        raw,
        format!("{} cell(s)", body.len()),
        vec!["ROW", "COLUMN", "TIMESTAMP", "VALUE"],
        body,
    )
}

/// Execute a parsed shell command against the native client.
async fn native_execute(
    client: &NativeClient,
    command: ShellCommand,
    raw: String,
) -> Result<HBaseShellResult, String> {
    match command {
        ShellCommand::Help => Ok(help_result(raw)),
        ShellCommand::List => {
            let tables = client.list_tables().await.map_err(|e| e.to_string())?;
            Ok(table_result(
                raw,
                format!("{} table(s)", tables.len()),
                vec!["TABLE"],
                tables.into_iter().map(|name| vec![name]).collect(),
            ))
        }
        ShellCommand::Status => {
            let pairs = client.cluster_status().await.map_err(|e| e.to_string())?;
            Ok(table_result(
                raw,
                "Cluster status".into(),
                vec!["KEY", "VALUE"],
                pairs.into_iter().map(|(k, v)| vec![k, v]).collect(),
            ))
        }
        ShellCommand::Version => {
            let msg = client.ping().await.map_err(|e| e.to_string())?;
            Ok(message_result(raw, msg))
        }
        ShellCommand::Describe { table } => {
            let schema = native_describe_table(client, &table).await?;
            let rows = schema
                .column_families
                .into_iter()
                .map(|family| {
                    vec![
                        family.name,
                        family
                            .attributes
                            .into_iter()
                            .map(|(k, v)| format!("{k}={v}"))
                            .collect::<Vec<_>>()
                            .join(", "),
                    ]
                })
                .collect::<Vec<_>>();
            Ok(table_result(
                raw,
                format!("Schema for {}", schema.name),
                vec!["COLUMN FAMILY", "ATTRIBUTES"],
                rows,
            ))
        }
        ShellCommand::Create { table, families } => {
            let specs: Vec<(String, BTreeMap<String, String>)> = families
                .into_iter()
                .map(|f| (f.name, f.attributes))
                .collect();
            client
                .create_table(&table, &specs)
                .await
                .map_err(|e| e.to_string())?;
            Ok(message_result(raw, format!("Created table {table}")))
        }
        ShellCommand::Drop { table } => {
            client.drop_table(&table).await.map_err(|e| e.to_string())?;
            Ok(message_result(raw, format!("Dropped table {table}")))
        }
        ShellCommand::Get { table, row, column } => {
            let rows = client
                .get(&table, row.as_bytes(), column.as_deref())
                .await
                .map_err(|e| e.to_string())?;
            Ok(rows_to_cell_table(raw, rows))
        }
        ShellCommand::Scan {
            table,
            limit,
            start_row,
            stop_row,
            columns,
        } => {
            let rows = client
                .scan(
                    &table,
                    limit,
                    start_row.as_deref().map(str::as_bytes),
                    stop_row.as_deref().map(str::as_bytes),
                    &columns,
                )
                .await
                .map_err(|e| e.to_string())?;
            Ok(rows_to_cell_table(raw, rows))
        }
        ShellCommand::Put {
            table,
            row,
            column,
            value,
        } => {
            client
                .put(&table, row.as_bytes(), &column, value.as_bytes())
                .await
                .map_err(|e| e.to_string())?;
            Ok(message_result(raw, "1 cell written".into()))
        }
        ShellCommand::Delete { table, row, column } => {
            client
                .delete(&table, row.as_bytes(), &column)
                .await
                .map_err(|e| e.to_string())?;
            Ok(message_result(raw, "Cell deleted".into()))
        }
        ShellCommand::DeleteAll { table, row } => {
            client
                .delete_all(&table, row.as_bytes())
                .await
                .map_err(|e| e.to_string())?;
            Ok(message_result(raw, "Row deleted".into()))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_get_with_bare_column() {
        // A bare quoted column must not be mistaken for an option map.
        match parse_shell_command("get 't1', 'row2', 'cf1:name'").unwrap() {
            ShellCommand::Get { table, row, column } => {
                assert_eq!(table, "t1");
                assert_eq!(row, "row2");
                assert_eq!(column.as_deref(), Some("cf1:name"));
            }
            other => panic!("unexpected command: {other:?}"),
        }
    }

    #[test]
    fn parses_get_with_column_map() {
        match parse_shell_command("get 't1', 'row2', {COLUMN=>'cf1:name'}").unwrap() {
            ShellCommand::Get { column, .. } => {
                assert_eq!(column.as_deref(), Some("cf1:name"));
            }
            other => panic!("unexpected command: {other:?}"),
        }
    }

    #[test]
    fn parses_get_without_column() {
        match parse_shell_command("get 't1', 'row2'").unwrap() {
            ShellCommand::Get { column, .. } => assert!(column.is_none()),
            other => panic!("unexpected command: {other:?}"),
        }
    }

    #[test]
    fn parses_scan_options() {
        let command = parse_shell_command(
            "scan 't1', {LIMIT=>20, STARTROW=>'r1', STOPROW=>'r9', COLUMNS=>['cf:q','cf2']}",
        )
        .unwrap();
        match command {
            ShellCommand::Scan {
                table,
                limit,
                start_row,
                stop_row,
                columns,
            } => {
                assert_eq!(table, "t1");
                assert_eq!(limit, 20);
                assert_eq!(start_row.as_deref(), Some("r1"));
                assert_eq!(stop_row.as_deref(), Some("r9"));
                assert_eq!(columns, vec!["cf:q", "cf2"]);
            }
            other => panic!("unexpected command: {other:?}"),
        }
    }

    #[test]
    fn parses_create_family_map() {
        let command = parse_shell_command("create 't1', {NAME=>'cf', VERSIONS=>3}").unwrap();
        match command {
            ShellCommand::Create { table, families } => {
                assert_eq!(table, "t1");
                assert_eq!(families[0].name, "cf");
                assert_eq!(
                    families[0].attributes.get("VERSIONS").map(String::as_str),
                    Some("3")
                );
            }
            other => panic!("unexpected command: {other:?}"),
        }
    }

    #[test]
    fn cellset_rows_decode_base64_payload() {
        let value = json!({
            "Row": [{
                "key": b64("row1"),
                "Cell": [{
                    "column": b64("cf:q"),
                    "timestamp": 10,
                    "$": b64("value")
                }]
            }]
        });
        assert_eq!(
            cellset_rows(&value),
            vec![vec![
                "row1".to_string(),
                "cf:q".to_string(),
                "10".to_string(),
                "value".to_string()
            ]]
        );
    }

    #[test]
    fn scanner_location_uses_origin_for_root_relative_location() {
        let mut headers = HeaderMap::new();
        headers.insert(LOCATION, "/gateway/hbase/t/scanner/1".parse().unwrap());
        assert_eq!(
            scanner_location("http://hbase.example:8080/gateway/hbase", &headers).as_deref(),
            Some("http://hbase.example:8080/gateway/hbase/t/scanner/1")
        );
    }

    #[tokio::test]
    async fn describe_request_error_surfaces_transport_cause() {
        // Port 1 on loopback has no listener, so the connect is refused
        // immediately and deterministically (no network access needed).
        let err = Client::new()
            .get("http://127.0.0.1:1/version/cluster")
            .send()
            .await
            .expect_err("connecting to a closed port must fail");
        let message = describe_request_error("HBase REST request failed", &err);
        assert!(
            message.starts_with("HBase REST request failed (connection failed):"),
            "unexpected message: {message}"
        );
        // The opaque top-level "error sending request" text must be replaced by
        // a concrete underlying cause from the source() chain.
        assert!(
            !message.contains("error sending request"),
            "diagnostic still hides the real cause: {message}"
        );
    }
}

#[cfg(test)]
mod native_shell_live_tests {
    //! End-to-end test of the shell-command path (parse + native_execute)
    //! against a live standalone HBase. Gated by HBASE_LIVE_TEST=1.
    use super::*;

    fn client() -> Option<NativeClient> {
        if std::env::var("HBASE_LIVE_TEST").ok().as_deref() != Some("1") {
            return None;
        }
        let zk = std::env::var("HBASE_ZK").unwrap_or_else(|_| "127.0.0.1:2181".into());
        Some(NativeClient::new(native::client::NativeConfig {
            zk_quorum: zk,
            zk_root: "/hbase".into(),
            effective_user: "test".into(),
            namespace: None,
            timeout: std::time::Duration::from_secs(20),
            auth: native::auth::AuthMethod::Simple,
        }))
    }

    async fn run(c: &NativeClient, cmd: &str) -> HBaseShellResult {
        let parsed = parse_shell_command(cmd).expect("parse");
        native_execute(c, parsed, cmd.to_string())
            .await
            .unwrap_or_else(|e| panic!("exec `{cmd}` failed: {e}"))
    }

    #[tokio::test]
    async fn shell_path_lifecycle() {
        let Some(c) = client() else { return };
        let t = "taomni_shell_it";
        // Best-effort cleanup; tolerate "table not found" if it's absent.
        let _ = native_execute(
            &c,
            parse_shell_command(&format!("drop '{t}'")).unwrap(),
            format!("drop '{t}'"),
        )
        .await;

        let r = run(&c, &format!("create '{t}', {{NAME=>'cf', VERSIONS=>3}}")).await;
        println!("create msg: {}", r.message);

        let list = run(&c, "list").await;
        assert!(list.rows.iter().any(|row| row[0] == t), "list missing {t}");

        run(&c, &format!("put '{t}', 'r1', 'cf:a', 'v1'")).await;
        run(&c, &format!("put '{t}', 'r2', 'cf:a', 'v2'")).await;

        let got = run(&c, &format!("get '{t}', 'r1'")).await;
        assert_eq!(got.rows.len(), 1);
        assert_eq!(got.rows[0][3], "v1");

        let scanned = run(&c, &format!("scan '{t}', {{LIMIT=>50}}")).await;
        assert!(scanned.rows.len() >= 2, "scan rows: {}", scanned.rows.len());

        let desc = run(&c, &format!("describe '{t}'")).await;
        assert!(desc.rows.iter().any(|r| r[0] == "cf"));

        run(&c, &format!("deleteall '{t}', 'r1'")).await;
        let after = run(&c, &format!("get '{t}', 'r1'")).await;
        assert_eq!(after.rows.len(), 0);

        run(&c, &format!("drop '{t}'")).await;
        let list2 = run(&c, "list").await;
        assert!(!list2.rows.iter().any(|row| row[0] == t));
        println!("shell-path lifecycle OK");
    }
}




