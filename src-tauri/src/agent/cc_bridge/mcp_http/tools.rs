use super::handler::CcHandler;
use super::parameters::ListSessionsParams;
use super::parameters::OpenSessionEditorParams;
use super::parameters::PermissionParams;
use super::parameters::ReadCaptureParams;
use super::parameters::ReadTerminalTailParams;
use super::parameters::RunCapturedParams;
use super::parameters::RunInTerminalParams;
use super::parameters::SaveAsRunbookParams;
use super::parameters::SearchHistoryParams;
use super::parameters::SftpDownloadParams;
use super::parameters::SftpUploadParams;
use super::parameters::SwitchTabParams;
use super::parameters::as_value;
use super::permissions::decide_permission;
use super::permissions::enforce_inline_permission;
use super::scope::enforce_session_scope;
use super::scope::fill_session_id;
use super::scope::normalize_tool_name;
use crate::agent::tools::ToolCall;
use rmcp::ErrorData;
use rmcp::ServerHandler;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::CallToolResult;
use rmcp::model::Content;
use rmcp::model::ServerCapabilities;
use rmcp::model::ServerInfo;
use rmcp::service::RequestContext;
use rmcp::service::RoleServer;
use rmcp::tool;
use rmcp::tool_handler;
use rmcp::tool_router;

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

#[tool_router(vis = "pub(super)")]
impl CcHandler {
    #[tool(
        name = "list_sessions",
        description = "列出所有已保存的 SSH/终端会话（可按名称/主机过滤）"
    )]
    pub(super) async fn list_sessions(
        &self,
        Parameters(p): Parameters<ListSessionsParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        self.scope(&ctx)?;
        let q = p.query.unwrap_or_default().to_lowercase();
        let state = self.app_state();
        let db = state
            .db
            .lock()
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        let sessions = crate::session::db::list_sessions(&db, None)
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        let lines: Vec<String> = sessions
            .iter()
            .filter(|s| {
                q.is_empty()
                    || s.name.to_lowercase().contains(&q)
                    || s.host.to_lowercase().contains(&q)
            })
            .map(|s| {
                format!(
                    "{}: {} ({}@{}:{})",
                    s.id,
                    s.name,
                    s.username.as_deref().unwrap_or(""),
                    s.host,
                    s.port
                )
            })
            .collect();
        Ok(CallToolResult::success(vec![Content::text(
            lines.join("\n"),
        )]))
    }

    #[tool(
        name = "search_history",
        description = "搜索命令历史记录并返回匹配的命令列表"
    )]
    pub(super) async fn search_history(
        &self,
        Parameters(p): Parameters<SearchHistoryParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        self.scope(&ctx)?;
        let state = self.app_state();
        let db = state
            .db
            .lock()
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        let results = crate::history::db_search(&db, &p.query, 20)
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        Ok(CallToolResult::success(vec![Content::text(
            results.join("\n"),
        )]))
    }

    #[tool(
        name = "read_terminal_tail",
        description = "读取当前活跃终端最近 N 行输出（需 user_invoked=true）"
    )]
    pub(super) async fn read_terminal_tail(
        &self,
        Parameters(p): Parameters<ReadTerminalTailParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let scope = self.scope(&ctx)?;
        let mut args = as_value(&p);
        fill_session_id(&mut args, &scope);
        enforce_session_scope(&scope, &args).map_err(|e| ErrorData::invalid_params(e, None))?;
        self.dispatch_side_effect(&scope, "read_terminal_tail", args)
            .await
    }

    #[tool(
        name = "run_in_terminal",
        description = "在指定会话的终端中执行命令（危险动作，需用户确认）"
    )]
    pub(super) async fn run_in_terminal(
        &self,
        Parameters(p): Parameters<RunInTerminalParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let scope = self.scope(&ctx)?;
        let mut args = as_value(&p);
        fill_session_id(&mut args, &scope);
        enforce_session_scope(&scope, &args).map_err(|e| ErrorData::invalid_params(e, None))?;
        let is_readonly = !scope.confirm_readonly
            && crate::agent::cmd_classify::classify(&p.command)
                == crate::agent::cmd_classify::CommandClass::ReadOnly;
        enforce_inline_permission(&self.app, &scope, "run_in_terminal", &args, is_readonly).await?;
        // Defense in depth: re-run the blacklist even though permission_prompt
        // already did (CC may have an allowlist that skips the prompt).
        let call = ToolCall {
            tool: "run_in_terminal".into(),
            args: args.clone(),
        };
        crate::agent::safety::check_tool_call(&call)
            .map_err(|e| ErrorData::invalid_params(e, None))?;
        self.dispatch_side_effect(&scope, "run_in_terminal", args)
            .await
    }

    #[tool(
        name = "switch_tab",
        description = "旧版兼容工具；打开/切换 Taomni 会话请优先使用 taomni_control.session_open，切换已打开标签请用 taomni_control.tab_switch。"
    )]
    pub(super) async fn switch_tab(
        &self,
        Parameters(p): Parameters<SwitchTabParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let scope = self.scope(&ctx)?;
        self.dispatch_side_effect(&scope, "switch_tab", as_value(&p))
            .await
    }

    #[tool(
        name = "open_session_editor",
        description = "旧版兼容工具；打开 Taomni 会话编辑器请优先使用 taomni_control.session_open_editor。"
    )]
    pub(super) async fn open_session_editor(
        &self,
        Parameters(p): Parameters<OpenSessionEditorParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let scope = self.scope(&ctx)?;
        self.dispatch_side_effect(&scope, "open_session_editor", as_value(&p))
            .await
    }

    #[tool(
        name = "sftp_upload",
        description = "上传一个或多个本地文件/目录到绑定的 SFTP 会话；local_path 传单个，local_paths 传多个；remote_path 可为远端目录，单文件时也可为完整目标路径。超过 60 MiB 时界面会提示耗时和进度。危险动作需用户确认。"
    )]
    pub(super) async fn sftp_upload(
        &self,
        Parameters(p): Parameters<SftpUploadParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let scope = self.scope(&ctx)?;
        let mut args = as_value(&p);
        fill_session_id(&mut args, &scope);
        enforce_session_scope(&scope, &args).map_err(|e| ErrorData::invalid_params(e, None))?;
        enforce_inline_permission(&self.app, &scope, "sftp_upload", &args, false).await?;
        self.dispatch_side_effect(&scope, "sftp_upload", args).await
    }

    #[tool(
        name = "sftp_download",
        description = "从绑定的 SFTP 会话下载远程文件/目录到本地目录；若目标已存在，界面会自动加序号避免覆盖。"
    )]
    pub(super) async fn sftp_download(
        &self,
        Parameters(p): Parameters<SftpDownloadParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let scope = self.scope(&ctx)?;
        let mut args = as_value(&p);
        fill_session_id(&mut args, &scope);
        enforce_session_scope(&scope, &args).map_err(|e| ErrorData::invalid_params(e, None))?;
        self.dispatch_side_effect(&scope, "sftp_download", args)
            .await
    }

    #[tool(
        name = "save_as_runbook",
        description = "把一组命令打包成 Runbook（写动作，需用户确认）"
    )]
    pub(super) async fn save_as_runbook(
        &self,
        Parameters(p): Parameters<SaveAsRunbookParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let scope = self.scope(&ctx)?;
        let args = as_value(&p);
        enforce_inline_permission(&self.app, &scope, "save_as_runbook", &args, false).await?;
        self.dispatch_side_effect(&scope, "save_as_runbook", args)
            .await
    }

    #[tool(
        name = "run_captured",
        description = "在绑定会话主机上运行命令并完整捕获输出（stdout+stderr+退出码），只返回摘要；用于输出很大、需要后续 grep/分页分析的场景，避免把大量输出灌进上下文。之后用 read_capture 检索。reflect_session=false（默认）在独立通道运行（输出干净、与交互 shell 状态隔离）；true 在当前交互会话内运行并可见（保留 cwd/环境，仅支持 POSIX 远端 SSH）。危险动作需用户确认。"
    )]
    pub(super) async fn run_captured(
        &self,
        Parameters(p): Parameters<RunCapturedParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let scope = self.scope(&ctx)?;
        let mut args = as_value(&p);
        fill_session_id(&mut args, &scope);
        enforce_session_scope(&scope, &args).map_err(|e| ErrorData::invalid_params(e, None))?;
        let is_readonly = !scope.confirm_readonly
            && crate::agent::cmd_classify::classify(&p.command)
                == crate::agent::cmd_classify::CommandClass::ReadOnly;
        enforce_inline_permission(&self.app, &scope, "run_captured", &args, is_readonly).await?;
        // Defense in depth: re-run the blacklist (permission_prompt already did,
        // but CC may have an allowlist that skips the prompt).
        let call = ToolCall {
            tool: "run_captured".into(),
            args: args.clone(),
        };
        crate::agent::safety::check_tool_call(&call)
            .map_err(|e| ErrorData::invalid_params(e, None))?;
        let session_id = args
            .get("session_id")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        self.run_captured_impl(&scope, &p.command, p.reflect_session, session_id)
            .await
    }

    #[tool(
        name = "read_capture",
        description = "检索 run_captured 的完整输出：op=head|tail|range|grep|jq|stats（grep 用正则、jq 用 jq 表达式）。每次返回有界，必要时用 grep/range 收窄。只读、限本线程自己的捕获。"
    )]
    pub(super) async fn read_capture(
        &self,
        Parameters(p): Parameters<ReadCaptureParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let scope = self.scope(&ctx)?;
        self.read_capture_impl(&scope, &p).await
    }

    #[tool(
        name = "permission_prompt",
        description = "Approve or deny a Claude Code tool call per Taomni's safety rules + human-in-the-loop confirmation."
    )]
    pub(super) async fn permission_prompt(
        &self,
        Parameters(p): Parameters<PermissionParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let scope = self.scope(&ctx)?;

        // CC sends MCP tools as `mcp__taomni__<tool>`; grade the bare name.
        let tool_name = normalize_tool_name(&p.tool_name).to_string();

        // 3.6 — a confidently read-only shell command waives the *confirmation*
        // card (unless the user forced confirm-all via config). Anything not
        // provably read-only stays Mutating (the safe default) and still
        // confirms. The safety checks inside `decide_permission` always run, so
        // this only ever waives confirmation, never safety.
        let is_readonly = !scope.confirm_readonly
            && matches!(
                tool_name.as_str(),
                "Bash" | "run_in_terminal" | "run_captured"
            )
            && p.tool_input
                .get("command")
                .and_then(|v| v.as_str())
                .map(|cmd| {
                    crate::agent::cmd_classify::classify(cmd)
                        == crate::agent::cmd_classify::CommandClass::ReadOnly
                })
                .unwrap_or(false);

        Ok(decide_permission(&self.app, &scope, &p.tool_name, &p.tool_input, is_readonly).await)
    }
}

#[tool_handler]
impl ServerHandler for CcHandler {
    fn get_info(&self) -> ServerInfo {
        let mut info = ServerInfo::default();
        info.capabilities = ServerCapabilities::builder().enable_tools().build();
        info.instructions =
            Some("Taomni in-app tools. Side-effect tools route through human confirmation.".into());
        info
    }
}
