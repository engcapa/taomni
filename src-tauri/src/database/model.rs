use serde::Deserialize;
use serde::Serialize;
use tauri::ipc::Channel;

/// Connection parameters supplied by the frontend. Mirrors the
/// `DbConnectInfo` TypeScript interface (camelCase over the IPC boundary).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbConfig {
    /// Backend engine: "MySQL" | "PostgreSQL" | "PanWeiDB" | "Oracle" | "SQLServer" | "StarRocks" | "ClickHouse" | "Presto" | "Redis".
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
    /// Presto/Trino HTTP header dialect: "presto" (default) or "trino".
    /// Controls `X-Presto-*` vs `X-Trino-*` request/response headers.
    #[serde(default)]
    pub presto_dialect: Option<String>,
    /// Redis logical DB index (0-15).
    #[serde(default)]
    pub db_index: Option<i64>,
    /// Per-session network settings (proxy / SSH jump host). When present and
    /// non-`none`, the connection is routed through a loopback forwarder so the
    /// engine client reaches the target via the proxy/jump path. Mirrors the
    /// SSH terminal's `networkSettings` payload (camelCase).
    #[serde(default)]
    pub network_settings: Option<crate::terminal::network::NetworkSettings>,
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

/// A schema/database node.
#[derive(Debug, Clone, Serialize)]
pub struct SchemaInfo {
    pub name: String,
}

/// A top-level catalog node (currently used by Presto/Trino).
#[derive(Debug, Clone, Serialize)]
pub struct CatalogInfo {
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

/// A foreign-key constraint and its ordered local/referenced columns.
#[derive(Debug, Clone, Serialize)]
pub struct ForeignKeyInfo {
    pub name: String,
    pub columns: Vec<String>,
    #[serde(rename = "referencedSchema")]
    pub referenced_schema: Option<String>,
    #[serde(rename = "referencedTable")]
    pub referenced_table: String,
    #[serde(rename = "referencedColumns")]
    pub referenced_columns: Vec<String>,
}

/// Index metadata.
#[derive(Debug, Clone, Serialize)]
pub struct IndexInfo {
    pub name: String,
    pub columns: Vec<String>,
    pub unique: bool,
}

/// A non-table schema object (routine, trigger, event, sequence, dictionary).
#[derive(Debug, Clone, Serialize)]
pub struct DbObject {
    pub name: String,
    /// Canonical kind: "procedure" | "function" | "trigger" | "event" |
    /// "sequence" | "dictionary".
    pub kind: String,
    /// Owning table for triggers (needed to DROP/DISABLE on PostgreSQL); None
    /// for objects that stand on their own.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
}

// ---------------------------------------------------------------------------
// Tauri commands — connection lifecycle
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct DbConnectResult {
    pub ok: bool,
}
