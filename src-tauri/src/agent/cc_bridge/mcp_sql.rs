//! Phase 6 — the `taomni_sql` MCP flavor: the tool surface a Claude Code thread
//! bound to a SQL DB session (MySQL / PostgreSQL / ClickHouse / Presto) sees.
//!
//! Unlike the shell flavor (which routes side-effects back through the frontend
//! terminal), every tool here runs **backend-direct**: it resolves the thread's
//! live DB connection and reuses the existing `crate::database::db_*` command
//! functions in-process, so results never round-trip the frontend. Engine
//! differences are already handled by `database`'s `DbHandle` dispatch.
//!
//! Connection resolution (D2 for DB): the live `db_connections` key is a
//! frontend-generated runtime id that the backend can't derive, so the frontend
//! bridges it each turn into `AppState.cc_db_bindings[thread_id]`. CC never names
//! a connection id — the handler always targets the thread's bound one, so
//! cross-session access is impossible by construction.

use rmcp::handler::server::tool::ToolRouter;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{CallToolResult, Content, ServerCapabilities, ServerInfo};
use rmcp::service::{RequestContext, RoleServer};
use rmcp::{tool, tool_handler, tool_router, ErrorData, ServerHandler};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use super::mcp_http::{decide_permission, scope_from_ctx, PermissionParams, TokenMap, TokenScope};
use crate::agent::capture::reduce::{reduce_file, ReduceOp, ReduceResult};
use crate::agent::capture::{CaptureSource, CaptureStatus, CaptureWriter};
use crate::database::{ColumnDescription, DbObject, IndexInfo, QueryResult, SchemaInfo, TableInfo};
use crate::state::AppState;

/// Max rows a single `run_sql` reply renders inline. Larger result sets should
/// go through `run_sql_captured` + `read_result` (Phase 3) to stay out of CC's
/// context; until then `run_sql` clips and says so.
const RUN_SQL_ROW_CAP: usize = 200;

/// Rows of head preview included in a `run_sql_captured` summary.
const CAPTURE_PREVIEW_ROWS: usize = 20;

/// At most this many running SQL captures per thread (a captured run holds the
/// full result in memory briefly while writing it out).
const MAX_RUNNING_CAPTURES: usize = 2;

#[derive(Clone)]
pub struct SqlHandler {
    app: AppHandle,
    tokens: TokenMap,
    tool_router: ToolRouter<Self>,
}

impl SqlHandler {
    pub fn new(app: AppHandle, tokens: TokenMap) -> Self {
        Self {
            app,
            tokens,
            tool_router: Self::tool_router(),
        }
    }

    fn scope(&self, ctx: &RequestContext<RoleServer>) -> Result<TokenScope, ErrorData> {
        scope_from_ctx(&self.tokens, ctx)
    }

    fn state(&self) -> tauri::State<'_, AppState> {
        self.app.state::<AppState>()
    }

    /// Resolve the live `db_connections` runtime id this thread is bound to.
    /// Errors (rather than guessing) when the thread has no bound DB connection
    /// — e.g. the DB tab isn't connected yet.
    async fn bound_conn(&self, scope: &TokenScope) -> Result<String, ErrorData> {
        self.state()
            .cc_db_bindings
            .read()
            .await
            .get(&scope.thread_id)
            .cloned()
            .ok_or_else(|| {
                ErrorData::invalid_params(
                    "this chat thread is not bound to a live database connection; \
                     open the DB session tab and try again"
                        .to_string(),
                    None,
                )
            })
    }
}

fn text(s: impl Into<String>) -> CallToolResult {
    CallToolResult::success(vec![Content::text(s.into())])
}

fn err(e: impl Into<String>) -> ErrorData {
    ErrorData::internal_error(e.into(), None)
}

/// Event payload echoed to the frontend after CC runs a statement on the bound
/// connection, so the linked query tab can append it to a query editor (gated
/// by a frontend toggle, default on). Emitted for reads and approved writes
/// alike, on success and failure — the frontend decides whether to surface it.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SqlEcho {
    thread_id: String,
    sql: String,
    ok: bool,
    rows_affected: u64,
    row_count: usize,
    duration_ms: u64,
    /// True when the statement ran via `run_sql_captured` (full result spooled
    /// to a file); the frontend annotates the echoed comment accordingly.
    captured: bool,
    error: Option<String>,
}

/// Best-effort emit of `agent-cc-sql-echo` for a just-executed statement. A
/// failed emit must never affect the tool result, so the error is swallowed.
fn emit_sql_echo(
    app: &AppHandle,
    thread_id: &str,
    sql: &str,
    res: &Result<QueryResult, String>,
    captured: bool,
) {
    let payload = match res {
        Ok(r) => SqlEcho {
            thread_id: thread_id.to_string(),
            sql: sql.to_string(),
            ok: true,
            rows_affected: r.rows_affected,
            row_count: r.rows.len(),
            duration_ms: r.duration_ms,
            captured,
            error: None,
        },
        Err(e) => SqlEcho {
            thread_id: thread_id.to_string(),
            sql: sql.to_string(),
            ok: false,
            rows_affected: 0,
            row_count: 0,
            duration_ms: 0,
            captured,
            error: Some(e.clone()),
        },
    };
    let _ = app.emit("agent-cc-sql-echo", payload);
}

// --- result formatters (compact text for CC) -------------------------------

fn fmt_schemas(rows: &[SchemaInfo]) -> String {
    if rows.is_empty() {
        return "(no schemas)".into();
    }
    rows.iter().map(|s| s.name.clone()).collect::<Vec<_>>().join("\n")
}

fn fmt_tables(rows: &[TableInfo]) -> String {
    if rows.is_empty() {
        return "(no tables)".into();
    }
    rows.iter()
        .map(|t| match t.row_count {
            Some(n) => format!("{} [{}] ~{} rows", t.name, t.kind, n),
            None => format!("{} [{}]", t.name, t.kind),
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn fmt_columns(rows: &[ColumnDescription]) -> String {
    if rows.is_empty() {
        return "(no columns)".into();
    }
    rows.iter()
        .map(|c| {
            let mut line = format!("{} {}", c.name, c.type_name);
            if c.primary_key {
                line.push_str(" PK");
            }
            line.push_str(if c.nullable { " NULL" } else { " NOT NULL" });
            if let Some(d) = &c.default {
                line.push_str(&format!(" default={d}"));
            }
            line
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn fmt_indexes(rows: &[IndexInfo]) -> String {
    if rows.is_empty() {
        return "(no indexes)".into();
    }
    rows.iter()
        .map(|i| {
            format!(
                "{}{} ({})",
                i.name,
                if i.unique { " UNIQUE" } else { "" },
                i.columns.join(", ")
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn fmt_objects(rows: &[DbObject]) -> String {
    if rows.is_empty() {
        return "(none)".into();
    }
    rows.iter()
        .map(|o| match &o.owner {
            Some(owner) => format!("{} [{}] on {}", o.name, o.kind, owner),
            None => format!("{} [{}]", o.name, o.kind),
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Render a `QueryResult` as a compact tab-separated table, clipped to
/// `RUN_SQL_ROW_CAP` rows with a trailing summary line.
fn fmt_query_result(r: &QueryResult) -> String {
    let mut out = String::new();
    if !r.columns.is_empty() {
        let header: Vec<&str> = r.columns.iter().map(|c| c.name.as_str()).collect();
        out.push_str(&header.join("\t"));
        out.push('\n');
    }
    let shown = r.rows.len().min(RUN_SQL_ROW_CAP);
    for row in r.rows.iter().take(shown) {
        let cells: Vec<String> = row
            .iter()
            .map(|c| c.clone().unwrap_or_else(|| "NULL".into()))
            .collect();
        out.push_str(&cells.join("\t"));
        out.push('\n');
    }
    out.push_str(&format!(
        "--- {} row(s){}, {} affected, {} ms ---",
        r.rows.len(),
        if r.rows.len() > shown {
            format!(" (showing first {shown}; use run_sql_captured for the full set)")
        } else {
            String::new()
        },
        r.rows_affected,
        r.duration_ms,
    ));
    if !r.warnings.is_empty() {
        out.push_str(&format!("\nwarnings: {}", r.warnings.join("; ")));
    }
    out
}

/// RFC4180-ish CSV field escaping: quote when the value contains a comma,
/// quote, CR or LF, doubling embedded quotes.
fn csv_field(v: &str) -> String {
    if v.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", v.replace('"', "\"\""))
    } else {
        v.to_string()
    }
}

/// Serialize a `QueryResult` to CSV text (header row + one row per record;
/// NULL → empty field).
fn query_result_to_csv(r: &QueryResult) -> String {
    let mut out = String::new();
    let header: Vec<String> = r.columns.iter().map(|c| csv_field(&c.name)).collect();
    out.push_str(&header.join(","));
    out.push('\n');
    for row in &r.rows {
        let cells: Vec<String> = row
            .iter()
            .map(|c| csv_field(c.as_deref().unwrap_or("")))
            .collect();
        out.push_str(&cells.join(","));
        out.push('\n');
    }
    out
}

/// Managed directory captured results are exported into — the user's Downloads
/// dir (falling back to the system temp dir), never a path CC chooses. Created
/// on demand.
fn exports_dir() -> std::path::PathBuf {
    let base = dirs::download_dir().unwrap_or_else(std::env::temp_dir);
    base.join("taomni-exports")
}

/// Map `read_result` params onto a reduction op (line-oriented over the CSV
/// capture). No `jq` — the capture is CSV, not JSON.
fn parse_read_op(p: &ReadResultParams) -> Result<ReduceOp, String> {
    match p.op.as_str() {
        "head" => Ok(ReduceOp::Head { n: p.n.unwrap_or(50) as usize }),
        "tail" => Ok(ReduceOp::Tail { n: p.n.unwrap_or(50) as usize }),
        "range" => {
            let start = p.start.ok_or("range requires `start`")? as usize;
            let end = p.end.ok_or("range requires `end`")? as usize;
            Ok(ReduceOp::Range { start, end })
        }
        "grep" => Ok(ReduceOp::Grep {
            pattern: p.pattern.clone().ok_or("grep requires `pattern`")?,
            context: p.context.unwrap_or(0) as usize,
        }),
        "stats" => Ok(ReduceOp::Stats),
        other => Err(format!("unknown op '{other}' (expected head|tail|range|grep|stats)")),
    }
}

/// Append a reduction's note / truncation receipt to its text.
fn annotate(r: ReduceResult) -> String {
    let mut text = r.text;
    if let Some(note) = r.note {
        text.push_str(&format!("\n[{note}]"));
    }
    if r.truncated {
        text.push_str("\n[output clipped by read_result cap — narrow with grep/range]");
    }
    text
}

// --- tool parameter schemas ------------------------------------------------

#[derive(Deserialize, schemars::JsonSchema, Default)]
struct ListCatalogsParams {}

#[derive(Deserialize, schemars::JsonSchema, Default)]
struct ListSchemasParams {
    /// Presto/Trino catalog to list schemas under (ignored by other engines).
    #[serde(default)]
    catalog: Option<String>,
}

#[derive(Deserialize, schemars::JsonSchema, Default)]
struct ListTablesParams {
    #[serde(default)]
    schema: Option<String>,
    #[serde(default)]
    catalog: Option<String>,
}

#[derive(Deserialize, schemars::JsonSchema)]
struct DescribeTableParams {
    #[serde(default)]
    schema: Option<String>,
    table: String,
    #[serde(default)]
    catalog: Option<String>,
}

#[derive(Deserialize, schemars::JsonSchema)]
struct ListIndexesParams {
    #[serde(default)]
    schema: Option<String>,
    table: String,
}

#[derive(Deserialize, schemars::JsonSchema)]
struct ListObjectsParams {
    #[serde(default)]
    schema: Option<String>,
    /// One of: procedure | function | trigger | event | sequence | dictionary.
    kind: String,
}

#[derive(Deserialize, schemars::JsonSchema)]
struct ObjectDdlParams {
    #[serde(default)]
    schema: Option<String>,
    kind: String,
    name: String,
}

#[derive(Deserialize, schemars::JsonSchema)]
struct TableStatsParams {
    #[serde(default)]
    schema: Option<String>,
    table: String,
}

#[derive(Deserialize, schemars::JsonSchema)]
struct RunSqlParams {
    /// SQL to run against the bound connection. Read statements stream a bounded
    /// result; mutating statements (INSERT/UPDATE/DELETE/DDL) pause for user
    /// confirmation. For large result sets prefer run_sql_captured.
    sql: String,
}

#[derive(Deserialize, schemars::JsonSchema)]
struct RunSqlCapturedParams {
    /// SQL whose full result set is captured to a backend file; only a bounded
    /// summary (columns + row count + head preview) is returned. Retrieve more
    /// with read_result, or write a file with export_result.
    sql: String,
}

#[derive(Deserialize, schemars::JsonSchema)]
struct ReadResultParams {
    capture_id: String,
    /// One of: head | tail | range | grep | stats.
    op: String,
    /// head/tail: number of rows.
    n: Option<u32>,
    /// range: 1-based inclusive bounds (line numbers; line 1 is the CSV header).
    start: Option<u32>,
    end: Option<u32>,
    /// grep: regex + optional context lines.
    pattern: Option<String>,
    context: Option<u32>,
}

#[derive(Deserialize, schemars::JsonSchema)]
struct ExportResultParams {
    capture_id: String,
    /// Output format. v1 supports "csv" (the capture is stored as CSV).
    #[serde(default)]
    format: Option<String>,
}

// --- tools -----------------------------------------------------------------

#[tool_router]
impl SqlHandler {
    #[tool(name = "list_catalogs", description = "列出 catalog（仅 Presto/Trino；其他引擎返回空）")]
    async fn list_catalogs(
        &self,
        Parameters(_p): Parameters<ListCatalogsParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let scope = self.scope(&ctx)?;
        let conn = self.bound_conn(&scope).await?;
        let rows = crate::database::db_list_catalogs(self.state(), conn)
            .await
            .map_err(err)?;
        let names: Vec<String> = rows.into_iter().map(|c| c.name).collect();
        Ok(text(if names.is_empty() {
            "(no catalogs)".to_string()
        } else {
            names.join("\n")
        }))
    }

    #[tool(name = "list_schemas", description = "列出数据库/schema")]
    async fn list_schemas(
        &self,
        Parameters(p): Parameters<ListSchemasParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let scope = self.scope(&ctx)?;
        let conn = self.bound_conn(&scope).await?;
        let rows = crate::database::db_list_schemas(self.state(), conn, p.catalog)
            .await
            .map_err(err)?;
        Ok(text(fmt_schemas(&rows)))
    }

    #[tool(name = "list_tables", description = "列出指定 schema 下的表/视图")]
    async fn list_tables(
        &self,
        Parameters(p): Parameters<ListTablesParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let scope = self.scope(&ctx)?;
        let conn = self.bound_conn(&scope).await?;
        let rows = crate::database::db_list_tables(self.state(), conn, p.schema, p.catalog)
            .await
            .map_err(err)?;
        Ok(text(fmt_tables(&rows)))
    }

    #[tool(name = "describe_table", description = "查看表结构（列、类型、主键、可空、默认值）")]
    async fn describe_table(
        &self,
        Parameters(p): Parameters<DescribeTableParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let scope = self.scope(&ctx)?;
        let conn = self.bound_conn(&scope).await?;
        let rows = crate::database::db_describe_table(self.state(), conn, p.schema, p.table, p.catalog)
            .await
            .map_err(err)?;
        Ok(text(fmt_columns(&rows)))
    }

    #[tool(name = "list_indexes", description = "列出表的索引")]
    async fn list_indexes(
        &self,
        Parameters(p): Parameters<ListIndexesParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let scope = self.scope(&ctx)?;
        let conn = self.bound_conn(&scope).await?;
        let rows = crate::database::db_list_indexes(self.state(), conn, p.schema, p.table)
            .await
            .map_err(err)?;
        Ok(text(fmt_indexes(&rows)))
    }

    #[tool(name = "list_objects", description = "列出非表对象：procedure|function|trigger|event|sequence|dictionary")]
    async fn list_objects(
        &self,
        Parameters(p): Parameters<ListObjectsParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let scope = self.scope(&ctx)?;
        let conn = self.bound_conn(&scope).await?;
        let rows = crate::database::db_list_objects(self.state(), conn, p.schema, p.kind)
            .await
            .map_err(err)?;
        Ok(text(fmt_objects(&rows)))
    }

    #[tool(name = "object_ddl", description = "取得对象的 DDL/定义文本")]
    async fn object_ddl(
        &self,
        Parameters(p): Parameters<ObjectDdlParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let scope = self.scope(&ctx)?;
        let conn = self.bound_conn(&scope).await?;
        let ddl = crate::database::db_object_ddl(self.state(), conn, p.schema, p.kind, p.name)
            .await
            .map_err(err)?;
        Ok(text(ddl))
    }

    #[tool(name = "table_stats", description = "查看表的统计信息（行数、大小等，引擎相关）")]
    async fn table_stats(
        &self,
        Parameters(p): Parameters<TableStatsParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let scope = self.scope(&ctx)?;
        let conn = self.bound_conn(&scope).await?;
        let r = crate::database::db_table_stats(self.state(), conn, p.schema, p.table)
            .await
            .map_err(err)?;
        Ok(text(fmt_query_result(&r)))
    }

    #[tool(
        name = "run_sql",
        description = "在绑定的数据库连接上执行一条 SQL 并返回结果（只读语句自动放行；写/DDL 会停下等用户确认）。结果有界（最多若干行），大结果集请用 run_sql_captured。"
    )]
    async fn run_sql(
        &self,
        Parameters(p): Parameters<RunSqlParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let scope = self.scope(&ctx)?;
        let conn = self.bound_conn(&scope).await?;
        let res = crate::database::db_execute(self.state(), conn, p.sql.clone()).await;
        emit_sql_echo(&self.app, &scope.thread_id, &p.sql, &res, false);
        let r = res.map_err(err)?;
        Ok(text(fmt_query_result(&r)))
    }

    #[tool(
        name = "run_sql_captured",
        description = "执行一条查询并把完整结果集捕获到后端文件，只返回摘要（列、行数、前若干行预览）；用于结果很大、需要后续 grep/分页/导出的场景，避免把大量数据灌进上下文。之后用 read_result 检索、export_result 导出。只读语句自动放行，写/DDL 需用户确认。"
    )]
    async fn run_sql_captured(
        &self,
        Parameters(p): Parameters<RunSqlCapturedParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let scope = self.scope(&ctx)?;
        let conn = self.bound_conn(&scope).await?;
        let state = self.state();
        if state.captures.running_count(&scope.thread_id) >= MAX_RUNNING_CAPTURES {
            return Err(ErrorData::internal_error(
                "too many captures already running for this thread; retry shortly".to_string(),
                None,
            ));
        }

        // v1 materializes the full result, then streams it to a CSV capture
        // file. (A future optimization can stream via db_execute_stream.)
        let res = crate::database::db_execute(state, conn, p.sql.clone()).await;
        emit_sql_echo(&self.app, &scope.thread_id, &p.sql, &res, true);
        let r = res.map_err(err)?;

        let state = self.state();
        let dir = state.captures.thread_dir(&scope.thread_id);
        let meta = state
            .captures
            .begin(&scope.thread_id, &p.sql, CaptureSource::LocalFile(dir.join("placeholder")));
        let writer = CaptureWriter::create(&dir, &meta.id)
            .map_err(|e| ErrorData::internal_error(format!("capture file: {e}"), None))?;
        writer.write_chunk(query_result_to_csv(&r).as_bytes());
        writer.flush();
        let truncated = writer.truncated();
        state
            .captures
            .set_source(&meta.id, CaptureSource::LocalFile(writer.path()));
        state.captures.finish(
            &meta.id,
            CaptureStatus::Done,
            None,
            writer.lines(),
            writer.bytes(),
            truncated,
        );

        // Bounded summary: schema + a small head preview.
        let mut preview = r.clone();
        preview.rows.truncate(CAPTURE_PREVIEW_ROWS);
        let cols: Vec<&str> = r.columns.iter().map(|c| c.name.as_str()).collect();
        let summary = format!(
            "[capture {}] {} 行, {} 列 [{}], {} ms{}\n--- 前 {} 行预览 ---\n{}\n\
             提示：完整结果已捕获为 CSV。用 read_result(capture_id=\"{}\", op=head|tail|range|grep|stats) 检索，\
             或 export_result(capture_id=\"{}\", format=\"csv\") 落盘；不要为再看一遍而重跑查询。",
            meta.id,
            r.rows.len(),
            r.columns.len(),
            cols.join(", "),
            r.duration_ms,
            if truncated { " (capture truncated by cap)" } else { "" },
            preview.rows.len(),
            fmt_query_result(&preview),
            meta.id,
            meta.id,
        );
        Ok(text(summary))
    }

    #[tool(
        name = "read_result",
        description = "检索 run_sql_captured 的完整结果（CSV）：op=head|tail|range|grep|stats（grep 用正则）。每次返回有界，必要时用 grep/range 收窄。只读、限本线程自己的捕获。"
    )]
    async fn read_result(
        &self,
        Parameters(p): Parameters<ReadResultParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let scope = self.scope(&ctx)?;
        let meta = self
            .state()
            .captures
            .get_scoped(&scope.thread_id, &p.capture_id)
            .ok_or_else(|| {
                ErrorData::invalid_params(format!("no capture '{}' for this thread", p.capture_id), None)
            })?;
        let op = parse_read_op(&p).map_err(|e| ErrorData::invalid_params(e, None))?;
        match &meta.source {
            CaptureSource::LocalFile(path) => {
                let r = reduce_file(path, &op).map_err(err)?;
                Ok(text(annotate(r)))
            }
            CaptureSource::RemoteFile { .. } => Err(ErrorData::internal_error(
                "this capture is not a local SQL result".to_string(),
                None,
            )),
        }
    }

    #[tool(
        name = "export_result",
        description = "把一个已捕获的查询结果写入 Taomni 管理的导出目录（用户下载目录下的 taomni-exports），返回文件路径。v1 支持 format=csv。写文件，需用户确认。"
    )]
    async fn export_result(
        &self,
        Parameters(p): Parameters<ExportResultParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let scope = self.scope(&ctx)?;
        let format = p.format.as_deref().unwrap_or("csv").to_ascii_lowercase();
        if format != "csv" {
            return Err(ErrorData::invalid_params(
                format!("unsupported export format '{format}' (v1 supports: csv)"),
                None,
            ));
        }
        let meta = self
            .state()
            .captures
            .get_scoped(&scope.thread_id, &p.capture_id)
            .ok_or_else(|| {
                ErrorData::invalid_params(format!("no capture '{}' for this thread", p.capture_id), None)
            })?;
        let src = match &meta.source {
            CaptureSource::LocalFile(path) => path.clone(),
            CaptureSource::RemoteFile { .. } => {
                return Err(ErrorData::internal_error(
                    "this capture is not a local SQL result".to_string(),
                    None,
                ))
            }
        };
        let dir = exports_dir();
        std::fs::create_dir_all(&dir)
            .map_err(|e| ErrorData::internal_error(format!("create exports dir: {e}"), None))?;
        let dest = dir.join(format!("taomni-export-{}.csv", p.capture_id));
        std::fs::copy(&src, &dest)
            .map_err(|e| ErrorData::internal_error(format!("write export: {e}"), None))?;
        Ok(text(format!("已导出到 {}", dest.to_string_lossy())))
    }

    #[tool(
        name = "permission_prompt",
        description = "Approve or deny a Claude Code DB tool call per Taomni's safety rules + human-in-the-loop confirmation."
    )]
    async fn permission_prompt(
        &self,
        Parameters(p): Parameters<PermissionParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let scope = self.scope(&ctx)?;
        let tool = super::mcp_http::normalize_tool_name(&p.tool_name);
        // A confidently read-only statement waives the *confirmation* card
        // (unless the user forced confirm-all). Everything not provably
        // read-only stays Mutating (safe default) and still confirms.
        let is_readonly = !scope.confirm_readonly
            && matches!(tool, "run_sql" | "run_sql_captured")
            && p.tool_input
                .get("sql")
                .and_then(|v| v.as_str())
                .map(|sql| {
                    crate::agent::sql_classify::classify(sql)
                        == crate::agent::sql_classify::SqlClass::ReadOnly
                })
                .unwrap_or(false);
        Ok(decide_permission(&self.app, &scope, &p.tool_name, &p.tool_input, is_readonly).await)
    }
}

#[tool_handler]
impl ServerHandler for SqlHandler {
    fn get_info(&self) -> ServerInfo {
        let mut info = ServerInfo::default();
        info.capabilities = ServerCapabilities::builder().enable_tools().build();
        info.instructions = Some(
            "Taomni SQL database tools. You operate on the chat thread's bound DB connection \
             (MySQL/PostgreSQL/ClickHouse/Presto). Use these tools, not local Bash/Read. \
             Mutating statements route through human confirmation."
                .into(),
        );
        info
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::ColumnInfo;

    fn col(name: &str) -> ColumnInfo {
        ColumnInfo { name: name.into(), type_name: "text".into() }
    }

    #[test]
    fn csv_field_quotes_only_when_needed() {
        assert_eq!(csv_field("plain"), "plain");
        assert_eq!(csv_field("a,b"), "\"a,b\"");
        assert_eq!(csv_field("he said \"hi\""), "\"he said \"\"hi\"\"\"");
        assert_eq!(csv_field("line1\nline2"), "\"line1\nline2\"");
    }

    #[test]
    fn query_result_to_csv_has_header_and_null_blanks() {
        let r = QueryResult {
            columns: vec![col("id"), col("name")],
            rows: vec![
                vec![Some("1".into()), Some("alice".into())],
                vec![Some("2".into()), None], // NULL → empty field
            ],
            rows_affected: 0,
            duration_ms: 1,
            warnings: vec![],
        };
        let csv = query_result_to_csv(&r);
        let lines: Vec<&str> = csv.lines().collect();
        assert_eq!(lines[0], "id,name");
        assert_eq!(lines[1], "1,alice");
        assert_eq!(lines[2], "2,");
    }

    #[test]
    fn parse_read_op_rejects_jq_and_unknown() {
        let base = |op: &str| ReadResultParams {
            capture_id: "c".into(),
            op: op.into(),
            n: None,
            start: None,
            end: None,
            pattern: None,
            context: None,
        };
        assert!(parse_read_op(&base("head")).is_ok());
        assert!(parse_read_op(&base("stats")).is_ok());
        assert!(parse_read_op(&base("jq")).is_err(), "jq not supported for CSV");
        assert!(parse_read_op(&base("range")).is_err(), "range needs bounds");
        assert!(parse_read_op(&base("grep")).is_err(), "grep needs pattern");
    }

    #[test]
    fn sql_echo_serializes_camel_case() {
        let r = QueryResult {
            columns: vec![col("id")],
            rows: vec![vec![Some("1".into())], vec![Some("2".into())]],
            rows_affected: 0,
            duration_ms: 7,
            warnings: vec![],
        };
        let payload = SqlEcho {
            thread_id: "t1".into(),
            sql: "SELECT 1".into(),
            ok: true,
            rows_affected: r.rows_affected,
            row_count: r.rows.len(),
            duration_ms: r.duration_ms,
            captured: true,
            error: None,
        };
        let v = serde_json::to_value(&payload).unwrap();
        assert_eq!(v["threadId"], "t1");
        assert_eq!(v["rowCount"], 2);
        assert_eq!(v["durationMs"], 7);
        assert_eq!(v["captured"], true);
        assert_eq!(v["error"], serde_json::Value::Null);
    }
}
