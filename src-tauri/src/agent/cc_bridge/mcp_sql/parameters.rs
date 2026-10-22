use serde::Deserialize;

// --- tool parameter schemas ------------------------------------------------

#[derive(Deserialize, schemars::JsonSchema, Default)]
pub(super) struct ListCatalogsParams {}

#[derive(Deserialize, schemars::JsonSchema, Default)]
pub(super) struct SelectedTableParams {
    /// When true, also include the selected table's column structure.
    #[serde(default)]
    pub(super) include_columns: bool,
}

#[derive(Deserialize, schemars::JsonSchema, Default)]
pub(super) struct SelectedObjectsParams {
    /// When true, `objects` is filtered to objects that can be queried with SELECT
    /// (table/view/materialized_view). The full split is still returned.
    #[serde(default)]
    pub(super) selectable_only: bool,
    /// When true, include column structure for selected queryable objects.
    #[serde(default)]
    pub(super) include_columns: bool,
}

#[derive(Deserialize, schemars::JsonSchema, Default)]
pub(super) struct ListSchemasParams {
    /// Presto/Trino catalog to list schemas under (ignored by other engines).
    #[serde(default)]
    pub(super) catalog: Option<String>,
}

#[derive(Deserialize, schemars::JsonSchema, Default)]
pub(super) struct ListTablesParams {
    #[serde(default)]
    pub(super) schema: Option<String>,
    #[serde(default)]
    pub(super) catalog: Option<String>,
}

#[derive(Deserialize, schemars::JsonSchema)]
pub(super) struct DescribeTableParams {
    #[serde(default)]
    pub(super) schema: Option<String>,
    pub(super) table: String,
    #[serde(default)]
    pub(super) catalog: Option<String>,
}

#[derive(Deserialize, schemars::JsonSchema)]
pub(super) struct ListIndexesParams {
    #[serde(default)]
    pub(super) schema: Option<String>,
    pub(super) table: String,
}

#[derive(Deserialize, schemars::JsonSchema)]
pub(super) struct ListObjectsParams {
    #[serde(default)]
    pub(super) schema: Option<String>,
    /// One of: procedure | function | trigger | event | sequence | dictionary.
    pub(super) kind: String,
}

#[derive(Deserialize, schemars::JsonSchema)]
pub(super) struct ObjectDdlParams {
    #[serde(default)]
    pub(super) schema: Option<String>,
    pub(super) kind: String,
    pub(super) name: String,
}

#[derive(Deserialize, schemars::JsonSchema)]
pub(super) struct TableStatsParams {
    #[serde(default)]
    pub(super) schema: Option<String>,
    pub(super) table: String,
}

#[derive(Deserialize, schemars::JsonSchema)]
pub(super) struct RunSqlParams {
    /// SQL to run against the bound connection. Read statements stream a bounded
    /// result; mutating statements (INSERT/UPDATE/DELETE/DDL) pause for user
    /// confirmation. For large result sets prefer run_sql_captured.
    pub(super) sql: String,
}

#[derive(Deserialize, schemars::JsonSchema)]
pub(super) struct RunSqlCapturedParams {
    /// SQL whose full result set is captured to a backend file; only a bounded
    /// summary (columns + row count + head preview) is returned. Retrieve more
    /// with read_result, or write a file with export_result.
    pub(super) sql: String,
}

#[derive(Deserialize, schemars::JsonSchema)]
pub(super) struct ReadResultParams {
    pub(super) capture_id: String,
    /// One of: head | tail | range | grep | stats.
    pub(super) op: String,
    /// head/tail: number of rows.
    pub(super) n: Option<u32>,
    /// range: 1-based inclusive bounds (line numbers; line 1 is the CSV header).
    pub(super) start: Option<u32>,
    pub(super) end: Option<u32>,
    /// grep: regex + optional context lines.
    pub(super) pattern: Option<String>,
    pub(super) context: Option<u32>,
}

#[derive(Deserialize, schemars::JsonSchema)]
pub(super) struct ExportResultParams {
    pub(super) capture_id: String,
    /// Output format. v1 supports "csv" (the capture is stored as CSV).
    #[serde(default)]
    pub(super) format: Option<String>,
}
