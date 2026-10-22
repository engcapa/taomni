use super::echo::emit_sql_echo;
use super::formatting::err;
use super::formatting::fmt_columns;
use super::formatting::fmt_indexes;
use super::formatting::fmt_objects;
use super::formatting::fmt_query_result;
use super::formatting::fmt_schemas;
use super::formatting::fmt_tables;
use super::formatting::json_text;
use super::formatting::query_result_to_csv;
use super::formatting::text;
use super::lifetime::SqlHandler;
use super::limits::CAPTURE_PREVIEW_ROWS;
use super::limits::MAX_RUNNING_CAPTURES;
use super::parameters::DescribeTableParams;
use super::parameters::ExportResultParams;
use super::parameters::ListCatalogsParams;
use super::parameters::ListIndexesParams;
use super::parameters::ListObjectsParams;
use super::parameters::ListSchemasParams;
use super::parameters::ListTablesParams;
use super::parameters::ObjectDdlParams;
use super::parameters::ReadResultParams;
use super::parameters::RunSqlCapturedParams;
use super::parameters::RunSqlParams;
use super::parameters::SelectedObjectsParams;
use super::parameters::SelectedTableParams;
use super::parameters::TableStatsParams;
use super::results::annotate;
use super::results::exports_dir;
use super::results::parse_read_op;
use super::results::selected_object_value;
use crate::agent::capture::CaptureSource;
use crate::agent::capture::CaptureStatus;
use crate::agent::capture::CaptureWriter;
use crate::agent::capture::reduce::reduce_file;
use crate::agent::cc_bridge::mcp_http::PermissionParams;
use crate::agent::cc_bridge::mcp_http::decide_permission;
use crate::agent::cc_bridge::mcp_http::enforce_inline_permission;
use rmcp::ErrorData;
use rmcp::ServerHandler;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::CallToolResult;
use rmcp::model::ServerCapabilities;
use rmcp::model::ServerInfo;
use rmcp::service::RequestContext;
use rmcp::service::RoleServer;
use rmcp::tool;
use rmcp::tool_handler;
use rmcp::tool_router;
use tauri::Manager;

// --- tools -----------------------------------------------------------------

#[tool_router(vis = "pub(super)")]
impl SqlHandler {
    #[tool(
        name = "selected_objects",
        description = "返回当前 DB tab 左侧对象树多选的对象。支持跨对象类型；selectable_only=true 时 objects 只保留可 SELECT 的 table/view/materialized_view，nonSelectableObjects 会列出被过滤对象；include_columns=true 时给可查询对象附带字段结构。"
    )]
    pub(super) async fn selected_objects(
        &self,
        Parameters(p): Parameters<SelectedObjectsParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let scope = self.scope(&ctx)?;
        let conn = self.bound_conn(&scope).await?;
        let selected = self
            .state()
            .agent
            .agent_db_selected_objects
            .read()
            .await
            .get(&scope.thread_id)
            .cloned()
            .unwrap_or_default();

        if selected.is_empty() {
            return Err(ErrorData::invalid_params(
                "no database objects are currently selected in the bound DB tab's object tree"
                    .to_string(),
                None,
            ));
        }

        let mut selectable_values = Vec::new();
        let mut non_selectable_values = Vec::new();
        for object in &selected {
            let mut value = selected_object_value(object);
            if object.is_selectable() {
                if p.include_columns {
                    match crate::database::db_describe_table(
                        self.state(),
                        conn.clone(),
                        object.schema.clone(),
                        object.name.clone(),
                        object.catalog.clone(),
                    )
                    .await
                    {
                        Ok(columns) => {
                            value["columns"] = serde_json::to_value(columns)
                                .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
                        }
                        Err(e) => {
                            value["columnsError"] = serde_json::Value::String(e);
                        }
                    }
                }
                selectable_values.push(value);
            } else {
                non_selectable_values.push(value);
            }
        }

        let objects = if p.selectable_only {
            selectable_values.clone()
        } else {
            selected.iter().map(selected_object_value).collect()
        };
        let selectable_count = selectable_values.len();
        let non_selectable_count = non_selectable_values.len();
        let value = serde_json::json!({
            "objects": objects,
            "selectedCount": selected.len(),
            "selectableObjects": selectable_values,
            "selectableCount": selectable_count,
            "nonSelectableObjects": non_selectable_values,
            "nonSelectableCount": non_selectable_count,
        });

        json_text(&value)
    }

    #[tool(
        name = "selected_table",
        description = "兼容工具：返回当前 DB tab 左侧对象树选中的第一个可 SELECT 对象（table/view/materialized_view）。多选场景优先用 selected_objects；include_columns=true 时同时返回字段结构。"
    )]
    pub(super) async fn selected_table(
        &self,
        Parameters(p): Parameters<SelectedTableParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let scope = self.scope(&ctx)?;
        let conn = self.bound_conn(&scope).await?;
        let selected = self
            .state()
            .agent.agent_db_selected_objects
            .read()
            .await
            .get(&scope.thread_id)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .find(|object| object.is_selectable())
            .ok_or_else(|| {
                ErrorData::invalid_params(
                    "no table/view/materialized_view is currently selected in the bound DB tab's object tree"
                        .to_string(),
                    None,
                )
            })?;

        let mut value = selected_object_value(&selected);
        value["table"] = serde_json::Value::String(selected.name.clone());

        if p.include_columns {
            let columns = crate::database::db_describe_table(
                self.state(),
                conn,
                selected.schema.clone(),
                selected.name.clone(),
                selected.catalog.clone(),
            )
            .await
            .map_err(err)?;
            value["columns"] = serde_json::to_value(columns)
                .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        }

        json_text(&value)
    }

    #[tool(
        name = "list_catalogs",
        description = "列出 catalog（仅 Presto/Trino；其他引擎返回空）"
    )]
    pub(super) async fn list_catalogs(
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
    pub(super) async fn list_schemas(
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
    pub(super) async fn list_tables(
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

    #[tool(
        name = "describe_table",
        description = "查看表结构（列、类型、主键、可空、默认值）"
    )]
    pub(super) async fn describe_table(
        &self,
        Parameters(p): Parameters<DescribeTableParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let scope = self.scope(&ctx)?;
        let conn = self.bound_conn(&scope).await?;
        let rows =
            crate::database::db_describe_table(self.state(), conn, p.schema, p.table, p.catalog)
                .await
                .map_err(err)?;
        Ok(text(fmt_columns(&rows)))
    }

    #[tool(name = "list_indexes", description = "列出表的索引")]
    pub(super) async fn list_indexes(
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

    #[tool(
        name = "list_objects",
        description = "列出非表对象：procedure|function|trigger|event|sequence|dictionary"
    )]
    pub(super) async fn list_objects(
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
    pub(super) async fn object_ddl(
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

    #[tool(
        name = "table_stats",
        description = "查看表的统计信息（行数、大小等，引擎相关）"
    )]
    pub(super) async fn table_stats(
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
    pub(super) async fn run_sql(
        &self,
        Parameters(p): Parameters<RunSqlParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let scope = self.scope(&ctx)?;
        let conn = self.bound_conn(&scope).await?;
        let args = serde_json::json!({ "sql": p.sql.clone() });
        let is_readonly = !scope.confirm_readonly
            && crate::agent::sql_classify::classify(&p.sql)
                == crate::agent::sql_classify::SqlClass::ReadOnly;
        enforce_inline_permission(&self.app, &scope, "run_sql", &args, is_readonly).await?;
        let res = crate::database::db_execute(self.state(), conn, p.sql.clone()).await;
        emit_sql_echo(&self.app, &scope.thread_id, &p.sql, &res, false);
        let r = res.map_err(err)?;
        Ok(text(fmt_query_result(&r)))
    }

    #[tool(
        name = "run_sql_captured",
        description = "执行一条查询并把完整结果集捕获到后端文件，只返回摘要（列、行数、前若干行预览）；用于结果很大、需要后续 grep/分页/导出的场景，避免把大量数据灌进上下文。之后用 read_result 检索、export_result 导出。只读语句自动放行，写/DDL 需用户确认。"
    )]
    pub(super) async fn run_sql_captured(
        &self,
        Parameters(p): Parameters<RunSqlCapturedParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let scope = self.scope(&ctx)?;
        let conn = self.bound_conn(&scope).await?;
        let args = serde_json::json!({ "sql": p.sql.clone() });
        let is_readonly = !scope.confirm_readonly
            && crate::agent::sql_classify::classify(&p.sql)
                == crate::agent::sql_classify::SqlClass::ReadOnly;
        enforce_inline_permission(&self.app, &scope, "run_sql_captured", &args, is_readonly)
            .await?;
        let state = self.state();
        if state.agent.captures.running_count(&scope.thread_id) >= MAX_RUNNING_CAPTURES {
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
        let dir = state.agent.captures.thread_dir(&scope.thread_id);
        let meta = state.agent.captures.begin(
            &scope.thread_id,
            &p.sql,
            CaptureSource::LocalFile(dir.join("placeholder")),
        );
        let writer = CaptureWriter::create(&dir, &meta.id)
            .map_err(|e| ErrorData::internal_error(format!("capture file: {e}"), None))?;
        writer.write_chunk(query_result_to_csv(&r).as_bytes());
        writer.flush();
        let truncated = writer.truncated();
        state
            .agent
            .captures
            .set_source(&meta.id, CaptureSource::LocalFile(writer.path()));
        state.agent.captures.finish(
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
            if truncated {
                " (capture truncated by cap)"
            } else {
                ""
            },
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
    pub(super) async fn read_result(
        &self,
        Parameters(p): Parameters<ReadResultParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let scope = self.scope(&ctx)?;
        let meta = self
            .state()
            .agent
            .captures
            .get_scoped(&scope.thread_id, &p.capture_id)
            .ok_or_else(|| {
                ErrorData::invalid_params(
                    format!("no capture '{}' for this thread", p.capture_id),
                    None,
                )
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
    pub(super) async fn export_result(
        &self,
        Parameters(p): Parameters<ExportResultParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let scope = self.scope(&ctx)?;
        let args = serde_json::json!({
            "capture_id": p.capture_id.clone(),
            "format": p.format.clone(),
        });
        enforce_inline_permission(&self.app, &scope, "export_result", &args, false).await?;
        let format = p.format.as_deref().unwrap_or("csv").to_ascii_lowercase();
        if format != "csv" {
            return Err(ErrorData::invalid_params(
                format!("unsupported export format '{format}' (v1 supports: csv)"),
                None,
            ));
        }
        let meta = self
            .state()
            .agent
            .captures
            .get_scoped(&scope.thread_id, &p.capture_id)
            .ok_or_else(|| {
                ErrorData::invalid_params(
                    format!("no capture '{}' for this thread", p.capture_id),
                    None,
                )
            })?;
        let src = match &meta.source {
            CaptureSource::LocalFile(path) => path.clone(),
            CaptureSource::RemoteFile { .. } => {
                return Err(ErrorData::internal_error(
                    "this capture is not a local SQL result".to_string(),
                    None,
                ));
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
    pub(super) async fn permission_prompt(
        &self,
        Parameters(p): Parameters<PermissionParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let scope = self.scope(&ctx)?;
        let tool = super::super::mcp_http::normalize_tool_name(&p.tool_name);
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
             (MySQL/PostgreSQL/Oracle/SQL Server/StarRocks/ClickHouse/Presto). Use these tools, not local Bash/Read. \
             When the user says selected/current/multiple tables or objects, call selected_objects first; \
             for SELECT workflows pass selectable_only=true to filter out non-queryable objects. \
             Mutating statements route through human confirmation."
                .into(),
        );
        info
    }
}
