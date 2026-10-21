use super::groups::ensure_group_path;
use super::groups::group_for_path;
use super::groups::normalize_group_path;
use super::groups::path_contains;
use super::groups::replace_group_prefix;
use super::lifetime::ControlHandler;
use super::local_targets::validate_local_shell_params;
use super::local_targets::validate_quick_connect_secret_free;
use super::parameters::EmptyParams;
use super::parameters::GroupDeleteParams;
use super::parameters::GroupPathParams;
use super::parameters::GroupRenameParams;
use super::parameters::OpenFileBrowserParams;
use super::parameters::OpenLocalTerminalParams;
use super::parameters::QuickConnectParams;
use super::parameters::SessionCreateParams;
use super::parameters::SessionDuplicateParams;
use super::parameters::SessionIdParams;
use super::parameters::SessionListParams;
use super::parameters::SessionMoveGroupParams;
use super::parameters::SessionOpenEditorParams;
use super::parameters::SessionOpenParams;
use super::parameters::SessionUpdateParams;
use super::parameters::TabIdParams;
use super::parameters::TabMoveParams;
use super::parameters::TabRenameParams;
use super::response::json_text;
use super::response::now_seconds;
use super::response::text;
use super::session_policy::apply_auth;
use super::session_policy::merge_options_json;
use super::session_policy::parse_options;
use super::session_policy::parse_session_type;
use super::session_policy::resolve_session_query;
use super::session_policy::session_to_safe_value;
use crate::agent::cc_bridge::mcp_http::PermissionParams;
use crate::agent::cc_bridge::mcp_http::decide_permission;
use crate::agent::cc_bridge::mcp_http::normalize_tool_name;
use crate::session::models::SessionConfig;
use crate::session::models::SessionType;
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
use serde_json::Map;
use serde_json::Value;
use tauri::Manager;
use uuid::Uuid;

#[tool_router(vis = "pub(super)")]
impl ControlHandler {
    #[tool(
        name = "session_list",
        description = "列出 Taomni 已保存 session，可按名称/主机/类型/分组过滤。"
    )]
    pub(super) async fn session_list(
        &self,
        Parameters(p): Parameters<SessionListParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        self.scope(&ctx)?;
        let state = self.app_state();
        let db = state
            .db
            .lock()
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        let sessions = crate::session::db::list_sessions(&db, None)
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        let query = p.query.unwrap_or_default().to_lowercase();
        let session_type = p.session_type.map(|s| s.to_lowercase());
        let group_path = normalize_group_path(p.group_path.as_deref());
        let values: Vec<Value> = sessions
            .iter()
            .filter(|s| {
                (query.is_empty()
                    || s.name.to_lowercase().contains(&query)
                    || s.host.to_lowercase().contains(&query)
                    || s.id.to_lowercase().contains(&query))
                    && session_type
                        .as_deref()
                        .map(|t| s.session_type.as_str().to_lowercase() == t)
                        .unwrap_or(true)
                    && group_path
                        .as_deref()
                        .map(|g| {
                            normalize_group_path(s.group_path.as_deref()).as_deref() == Some(g)
                        })
                        .unwrap_or(true)
            })
            .map(session_to_safe_value)
            .collect();
        json_text(&values)
    }

    #[tool(
        name = "session_get",
        description = "读取一个已保存 session 的配置摘要（secret 字段会被隐藏）。"
    )]
    pub(super) async fn session_get(
        &self,
        Parameters(p): Parameters<SessionIdParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        self.scope(&ctx)?;
        let state = self.app_state();
        let db = state
            .db
            .lock()
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        let session = crate::session::db::get_session(&db, &p.session_id)
            .map_err(|e| ErrorData::invalid_params(e.to_string(), None))?;
        json_text(&session_to_safe_value(&session))
    }

    #[tool(
        name = "session_create",
        description = "新建 Taomni session。禁止传明文密码；密码只能用 auth.method=password_ref + vault:<id>。"
    )]
    pub(super) async fn session_create(
        &self,
        Parameters(p): Parameters<SessionCreateParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let scope = self.scope(&ctx)?;
        let args = serde_json::to_value(&p).unwrap_or(Value::Null);
        self.require_write(&scope, "session_create", &args).await?;
        let session_type =
            parse_session_type(&p.session_type).map_err(|e| ErrorData::invalid_params(e, None))?;
        let mut options =
            parse_options(p.options).map_err(|e| ErrorData::invalid_params(e, None))?;
        let auth = apply_auth(p.auth.as_ref(), &mut options, None)
            .map_err(|e| ErrorData::invalid_params(e, None))?;
        let now = now_seconds();
        let group_path = normalize_group_path(p.group_path.as_deref());
        let session = SessionConfig {
            id: p.id.unwrap_or_else(|| Uuid::new_v4().to_string()),
            name: p.name,
            session_type: session_type.clone(),
            group_path,
            host: p.host.unwrap_or_default(),
            port: p.port.unwrap_or_else(|| session_type.default_port()),
            username: p.username,
            auth_method: auth,
            options_json: Value::Object(options).to_string(),
            created_at: now,
            updated_at: now,
            last_connected_at: None,
            sort_order: 0,
        };
        {
            let state = self.app_state();
            let db = state
                .db
                .lock()
                .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
            ensure_group_path(&db, session.group_path.as_deref())
                .map_err(|e| ErrorData::internal_error(e, None))?;
            crate::session::db::save_session(&db, &session)
                .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        }
        self.emit_sessions_changed();
        json_text(&session_to_safe_value(&session))
    }

    #[tool(
        name = "session_update",
        description = "更新已保存 session。禁止写入明文密码；使用 password_ref/vault。"
    )]
    pub(super) async fn session_update(
        &self,
        Parameters(p): Parameters<SessionUpdateParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let scope = self.scope(&ctx)?;
        let args = serde_json::to_value(&p).unwrap_or(Value::Null);
        self.require_write(&scope, "session_update", &args).await?;
        let state = self.app_state();
        let db = state
            .db
            .lock()
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        let mut session = crate::session::db::get_session(&db, &p.session_id)
            .map_err(|e| ErrorData::invalid_params(e.to_string(), None))?;
        if let Some(v) = p.name {
            session.name = v;
        }
        if let Some(v) = p.session_type {
            session.session_type =
                parse_session_type(&v).map_err(|e| ErrorData::invalid_params(e, None))?;
        }
        if p.group_path.is_some() {
            session.group_path = normalize_group_path(p.group_path.as_deref());
        }
        if let Some(v) = p.host {
            session.host = v;
        }
        if let Some(v) = p.port {
            session.port = v;
        }
        if p.username.is_some() {
            session.username = p.username;
        }
        let mut options = match serde_json::from_str::<Value>(&session.options_json)
            .unwrap_or(Value::Object(Map::new()))
        {
            Value::Object(map) => map,
            _ => Map::new(),
        };
        session.auth_method = apply_auth(p.auth.as_ref(), &mut options, Some(session.auth_method))
            .map_err(|e| ErrorData::invalid_params(e, None))?;
        session.options_json = merge_options_json(&Value::Object(options).to_string(), p.options)
            .map_err(|e| ErrorData::invalid_params(e, None))?;
        session.updated_at = now_seconds();
        ensure_group_path(&db, session.group_path.as_deref())
            .map_err(|e| ErrorData::internal_error(e, None))?;
        crate::session::db::save_session(&db, &session)
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        drop(db);
        self.emit_sessions_changed();
        json_text(&session_to_safe_value(&session))
    }

    #[tool(
        name = "session_duplicate",
        description = "复制一个已保存 session，生成新 id。"
    )]
    pub(super) async fn session_duplicate(
        &self,
        Parameters(p): Parameters<SessionDuplicateParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let scope = self.scope(&ctx)?;
        let args = serde_json::to_value(&p).unwrap_or(Value::Null);
        self.require_write(&scope, "session_duplicate", &args)
            .await?;
        let state = self.app_state();
        let db = state
            .db
            .lock()
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        let source = crate::session::db::get_session(&db, &p.session_id)
            .map_err(|e| ErrorData::invalid_params(e.to_string(), None))?;
        let now = now_seconds();
        let copy = SessionConfig {
            id: Uuid::new_v4().to_string(),
            name: p.name.unwrap_or_else(|| format!("{} (copy)", source.name)),
            created_at: now,
            updated_at: now,
            last_connected_at: None,
            ..source
        };
        crate::session::db::save_session(&db, &copy)
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        drop(db);
        self.emit_sessions_changed();
        json_text(&session_to_safe_value(&copy))
    }

    #[tool(
        name = "session_delete",
        description = "删除一个已保存 session（不会自动关闭已打开 tab）。"
    )]
    pub(super) async fn session_delete(
        &self,
        Parameters(p): Parameters<SessionIdParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let scope = self.scope(&ctx)?;
        let args = serde_json::to_value(&p).unwrap_or(Value::Null);
        self.require_write(&scope, "session_delete", &args).await?;
        let state = self.app_state();
        let db = state
            .db
            .lock()
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        crate::session::db::delete_session(&db, &p.session_id)
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        drop(db);
        self.emit_sessions_changed();
        Ok(text(format!("deleted session {}", p.session_id)))
    }

    #[tool(
        name = "session_move_group",
        description = "移动 session 到指定分组；group_path 为空表示移出分组。"
    )]
    pub(super) async fn session_move_group(
        &self,
        Parameters(p): Parameters<SessionMoveGroupParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let scope = self.scope(&ctx)?;
        let args = serde_json::to_value(&p).unwrap_or(Value::Null);
        self.require_write(&scope, "session_move_group", &args)
            .await?;
        let group_path = normalize_group_path(p.group_path.as_deref());
        let state = self.app_state();
        let db = state
            .db
            .lock()
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        let mut session = crate::session::db::get_session(&db, &p.session_id)
            .map_err(|e| ErrorData::invalid_params(e.to_string(), None))?;
        ensure_group_path(&db, group_path.as_deref())
            .map_err(|e| ErrorData::internal_error(e, None))?;
        session.group_path = group_path;
        session.updated_at = now_seconds();
        crate::session::db::save_session(&db, &session)
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        drop(db);
        self.emit_sessions_changed();
        json_text(&session_to_safe_value(&session))
    }

    #[tool(name = "group_list", description = "列出 session 分组。")]
    pub(super) async fn group_list(
        &self,
        Parameters(_p): Parameters<EmptyParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        self.scope(&ctx)?;
        let state = self.app_state();
        let db = state
            .db
            .lock()
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        let groups = crate::session::db::list_groups(&db)
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        json_text(&groups)
    }

    #[tool(
        name = "group_create",
        description = "创建 session 分组路径，会自动创建祖先分组。"
    )]
    pub(super) async fn group_create(
        &self,
        Parameters(p): Parameters<GroupPathParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let scope = self.scope(&ctx)?;
        let args = serde_json::to_value(&p).unwrap_or(Value::Null);
        self.require_write(&scope, "group_create", &args).await?;
        let path = normalize_group_path(Some(&p.path))
            .ok_or_else(|| ErrorData::invalid_params("path is required", None))?;
        let state = self.app_state();
        let db = state
            .db
            .lock()
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        ensure_group_path(&db, Some(&path)).map_err(|e| ErrorData::internal_error(e, None))?;
        drop(db);
        self.emit_sessions_changed();
        Ok(text(format!("created group {path}")))
    }

    #[tool(
        name = "group_rename",
        description = "重命名 session 分组路径，并更新子分组和组内 session。"
    )]
    pub(super) async fn group_rename(
        &self,
        Parameters(p): Parameters<GroupRenameParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let scope = self.scope(&ctx)?;
        let args = serde_json::to_value(&p).unwrap_or(Value::Null);
        self.require_write(&scope, "group_rename", &args).await?;
        let old_path = normalize_group_path(Some(&p.old_path))
            .ok_or_else(|| ErrorData::invalid_params("old_path is required", None))?;
        let new_path = normalize_group_path(Some(&p.new_path))
            .ok_or_else(|| ErrorData::invalid_params("new_path is required", None))?;
        let state = self.app_state();
        let db = state
            .db
            .lock()
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        ensure_group_path(&db, Some(&new_path)).map_err(|e| ErrorData::internal_error(e, None))?;
        let groups = crate::session::db::list_groups(&db)
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        for group in groups
            .iter()
            .filter(|g| path_contains(&old_path, &g.id))
            .collect::<Vec<_>>()
        {
            crate::session::db::delete_group(&db, &group.id)
                .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        }
        for group in groups.iter().filter(|g| path_contains(&old_path, &g.id)) {
            let replaced = replace_group_prefix(Some(&group.id), &old_path, &new_path)
                .unwrap_or_else(|| new_path.clone());
            let mut next = group_for_path(&replaced);
            next.sort_order = group.sort_order;
            next.icon = group.icon.clone();
            crate::session::db::save_group(&db, &next)
                .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        }
        let sessions = crate::session::db::list_sessions(&db, None)
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        for mut session in sessions {
            if let Some(replaced) =
                replace_group_prefix(session.group_path.as_deref(), &old_path, &new_path)
            {
                session.group_path = Some(replaced);
                session.updated_at = now_seconds();
                crate::session::db::save_session(&db, &session)
                    .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
            }
        }
        drop(db);
        self.emit_sessions_changed();
        Ok(text(format!("renamed group {old_path} to {new_path}")))
    }

    #[tool(
        name = "group_delete",
        description = "删除分组。默认不删 session，而是把受影响 session 移出分组；delete_sessions=true 才删除 session。"
    )]
    pub(super) async fn group_delete(
        &self,
        Parameters(p): Parameters<GroupDeleteParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let scope = self.scope(&ctx)?;
        let args = serde_json::to_value(&p).unwrap_or(Value::Null);
        self.require_write(&scope, "group_delete", &args).await?;
        let path = normalize_group_path(Some(&p.path))
            .ok_or_else(|| ErrorData::invalid_params("path is required", None))?;
        let state = self.app_state();
        let db = state
            .db
            .lock()
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        let groups = crate::session::db::list_groups(&db)
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        let sessions = crate::session::db::list_sessions(&db, None)
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        let mut affected_session_ids = Vec::new();
        for mut session in sessions {
            if normalize_group_path(session.group_path.as_deref())
                .as_deref()
                .map(|g| path_contains(&path, g))
                .unwrap_or(false)
            {
                affected_session_ids.push(session.id.clone());
                if p.delete_sessions {
                    crate::session::db::delete_session(&db, &session.id)
                        .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
                } else {
                    session.group_path = None;
                    session.updated_at = now_seconds();
                    crate::session::db::save_session(&db, &session)
                        .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
                }
            }
        }
        for group in groups.iter().filter(|g| path_contains(&path, &g.id)) {
            crate::session::db::delete_group(&db, &group.id)
                .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        }
        drop(db);
        self.emit_sessions_changed();
        json_text(&serde_json::json!({
            "deleted_group": path,
            "delete_sessions": p.delete_sessions,
            "affected_session_ids": affected_session_ids,
        }))
    }

    #[tool(
        name = "session_open",
        description = "在 Taomni UI 中打开一个已保存 session（不受当前线程绑定终端限制）。支持 session_id 或唯一 query；打开 LocalShell session 时可传 local_shell.type 覆盖本地 shell：cmd、powershell7、windows-powershell、git-bash、wsl、bash、zsh、sh 或 custom。"
    )]
    pub(super) async fn session_open(
        &self,
        Parameters(mut p): Parameters<SessionOpenParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let scope = self.scope(&ctx)?;
        let (id, session_type) = {
            let state = self.app_state();
            let db = state
                .db
                .lock()
                .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
            let sessions = crate::session::db::list_sessions(&db, None)
                .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
            let id = resolve_session_query(&sessions, &p)
                .map_err(|e| ErrorData::invalid_params(e, None))?;
            let session_type = sessions
                .iter()
                .find(|session| session.id == id)
                .map(|session| session.session_type.clone());
            (id, session_type)
        };
        if let Some(local_shell) = p.local_shell.as_ref() {
            validate_local_shell_params(local_shell)
                .map_err(|e| ErrorData::invalid_params(e, None))?;
            if session_type.as_ref() != Some(&SessionType::LocalShell) {
                return Err(ErrorData::invalid_params(
                    "local_shell only applies to saved LocalShell sessions",
                    None,
                ));
            }
        }
        p.session_id = Some(id);
        let args = serde_json::to_value(&p).unwrap_or(Value::Null);
        self.require_write(&scope, "session_open", &args).await?;
        self.dispatch_control_side_effect(&scope, "session_open", args)
            .await
    }

    #[tool(
        name = "session_open_editor",
        description = "打开 Taomni 新建/编辑 session 对话框（UI 控制动作）。可传 session_id 编辑；或传 session_type/group_path 新建。"
    )]
    pub(super) async fn session_open_editor(
        &self,
        Parameters(p): Parameters<SessionOpenEditorParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let scope = self.scope(&ctx)?;
        let args = serde_json::to_value(&p).unwrap_or(Value::Null);
        self.require_write(&scope, "session_open_editor", &args)
            .await?;
        self.dispatch_control_side_effect(&scope, "session_open_editor", args)
            .await
    }

    #[tool(
        name = "quick_connect",
        description = "使用 Taomni Quick Connect 语法打开临时连接。"
    )]
    pub(super) async fn quick_connect(
        &self,
        Parameters(p): Parameters<QuickConnectParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let scope = self.scope(&ctx)?;
        validate_quick_connect_secret_free(&p.input)
            .map_err(|e| ErrorData::invalid_params(e, None))?;
        let args = serde_json::to_value(&p).unwrap_or(Value::Null);
        self.require_write(&scope, "quick_connect", &args).await?;
        self.dispatch_control_side_effect(&scope, "quick_connect", args)
            .await
    }

    #[tool(name = "tab_list", description = "列出当前打开的 Taomni tabs。")]
    pub(super) async fn tab_list(
        &self,
        Parameters(p): Parameters<EmptyParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let scope = self.scope(&ctx)?;
        self.dispatch_control_side_effect(&scope, "tab_list", serde_json::to_value(&p).unwrap())
            .await
    }

    #[tool(name = "tab_switch", description = "切换到指定 tab。")]
    pub(super) async fn tab_switch(
        &self,
        Parameters(p): Parameters<TabIdParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let scope = self.scope(&ctx)?;
        self.dispatch_control_side_effect(&scope, "tab_switch", serde_json::to_value(&p).unwrap())
            .await
    }

    #[tool(name = "tab_duplicate", description = "复制指定 tab，并激活副本。")]
    pub(super) async fn tab_duplicate(
        &self,
        Parameters(p): Parameters<TabIdParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let scope = self.scope(&ctx)?;
        let args = serde_json::to_value(&p).unwrap_or(Value::Null);
        self.require_write(&scope, "tab_duplicate", &args).await?;
        self.dispatch_control_side_effect(&scope, "tab_duplicate", args)
            .await
    }

    #[tool(name = "tab_rename", description = "重命名指定 tab。")]
    pub(super) async fn tab_rename(
        &self,
        Parameters(p): Parameters<TabRenameParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let scope = self.scope(&ctx)?;
        let args = serde_json::to_value(&p).unwrap_or(Value::Null);
        self.require_write(&scope, "tab_rename", &args).await?;
        self.dispatch_control_side_effect(&scope, "tab_rename", args)
            .await
    }

    #[tool(name = "tab_close", description = "关闭指定 tab。")]
    pub(super) async fn tab_close(
        &self,
        Parameters(p): Parameters<TabIdParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let scope = self.scope(&ctx)?;
        let args = serde_json::to_value(&p).unwrap_or(Value::Null);
        self.require_write(&scope, "tab_close", &args).await?;
        self.dispatch_control_side_effect(&scope, "tab_close", args)
            .await
    }

    #[tool(name = "tab_move", description = "移动 tab 到指定索引。")]
    pub(super) async fn tab_move(
        &self,
        Parameters(p): Parameters<TabMoveParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let scope = self.scope(&ctx)?;
        let args = serde_json::to_value(&p).unwrap_or(Value::Null);
        self.require_write(&scope, "tab_move", &args).await?;
        self.dispatch_control_side_effect(&scope, "tab_move", args)
            .await
    }

    #[tool(name = "tab_open_settings", description = "打开或切换到设置 tab。")]
    pub(super) async fn tab_open_settings(
        &self,
        Parameters(p): Parameters<EmptyParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let scope = self.scope(&ctx)?;
        self.dispatch_control_side_effect(
            &scope,
            "tab_open_settings",
            serde_json::to_value(&p).unwrap(),
        )
        .await
    }

    #[tool(
        name = "tab_open_local_terminal",
        description = "打开本地终端 tab。可传 local_shell.type 选择 shell：Windows 常用 cmd、powershell7、windows-powershell、git-bash、wsl；Unix 常用 bash、zsh、sh；custom 需传 path。"
    )]
    pub(super) async fn tab_open_local_terminal(
        &self,
        Parameters(p): Parameters<OpenLocalTerminalParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let scope = self.scope(&ctx)?;
        if let Some(local_shell) = p.local_shell.as_ref() {
            validate_local_shell_params(local_shell)
                .map_err(|e| ErrorData::invalid_params(e, None))?;
        }
        let args = serde_json::to_value(&p).unwrap_or(Value::Null);
        self.require_write(&scope, "tab_open_local_terminal", &args)
            .await?;
        self.dispatch_control_side_effect(&scope, "tab_open_local_terminal", args)
            .await
    }

    #[tool(
        name = "tab_open_file_browser",
        description = "打开本地文件浏览器 tab。"
    )]
    pub(super) async fn tab_open_file_browser(
        &self,
        Parameters(p): Parameters<OpenFileBrowserParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let scope = self.scope(&ctx)?;
        let args = serde_json::to_value(&p).unwrap_or(Value::Null);
        self.require_write(&scope, "tab_open_file_browser", &args)
            .await?;
        self.dispatch_control_side_effect(&scope, "tab_open_file_browser", args)
            .await
    }

    #[tool(
        name = "permission_prompt",
        description = "Approve or deny a Taomni control tool call per Taomni's safety rules + human confirmation."
    )]
    pub(super) async fn permission_prompt(
        &self,
        Parameters(p): Parameters<PermissionParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let scope = self.scope(&ctx)?;
        let tool = normalize_tool_name(&p.tool_name);
        let readonly = matches!(
            tool,
            "session_list" | "session_get" | "group_list" | "tab_list"
        );
        Ok(decide_permission(&self.app, &scope, &p.tool_name, &p.tool_input, readonly).await)
    }
}

#[tool_handler]
impl ServerHandler for ControlHandler {
    fn get_info(&self) -> ServerInfo {
        let mut info = ServerInfo::default();
        info.capabilities = ServerCapabilities::builder().enable_tools().build();
        info.instructions = Some(
            "Taomni control-plane tools for sessions, groups, tabs, and UI commands. Plaintext passwords are rejected; use vault references or the session editor."
                .into(),
        );
        info
    }
}
