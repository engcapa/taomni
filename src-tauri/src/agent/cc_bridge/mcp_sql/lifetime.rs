use crate::agent::cc_bridge::mcp_http::TokenMap;
use crate::agent::cc_bridge::mcp_http::TokenScope;
use crate::agent::cc_bridge::mcp_http::scope_from_ctx;
use crate::state::AppState;
use rmcp::ErrorData;
use rmcp::handler::server::tool::ToolRouter;
use rmcp::service::RequestContext;
use rmcp::service::RoleServer;
use rmcp::tool_router;
use tauri::AppHandle;
use tauri::Manager;

#[derive(Clone)]
pub struct SqlHandler {
    pub(super) app: AppHandle,
    pub(super) tokens: TokenMap,
    pub(super) tool_router: ToolRouter<Self>,
}

impl SqlHandler {
    pub fn new(app: AppHandle, tokens: TokenMap) -> Self {
        Self {
            app,
            tokens,
            tool_router: Self::tool_router(),
        }
    }

    pub(super) fn scope(&self, ctx: &RequestContext<RoleServer>) -> Result<TokenScope, ErrorData> {
        scope_from_ctx(&self.tokens, ctx)
    }

    pub(super) fn state(&self) -> tauri::State<'_, AppState> {
        self.app.state::<AppState>()
    }

    /// Resolve the live `db_connections` runtime id this thread is bound to.
    /// Errors (rather than guessing) when the thread has no bound DB connection
    /// — e.g. the DB tab isn't connected yet.
    pub(super) async fn bound_conn(&self, scope: &TokenScope) -> Result<String, ErrorData> {
        self.state()
            .agent
            .agent_db_bindings
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
