use crate::agent::cc_bridge::mcp_http::Flavor;
use crate::agent::cc_bridge::session_card::{self, LocalTerminalEnv};
use crate::session::models::SessionConfig;
use crate::state::AppState;

/// Per-turn execution context shared by Claude Code, Codex app-server, and
/// direct LLM providers that can use Taomni tools.
#[derive(Clone, Debug)]
pub struct AgentThreadContext {
    pub thread_id: String,
    pub linked_session_id: Option<String>,
    pub bound_session_id: Option<String>,
    pub cwd: Option<String>,
    pub local_terminal_env: Option<LocalTerminalEnv>,
    pub bound_db_connection_id: Option<String>,
    pub flavor: Flavor,
    pub session_card: String,
}

impl AgentThreadContext {
    pub async fn refresh_runtime_bindings(&self, state: &AppState) {
        if let Some(cwd) = self.cwd.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            state
                .agent_thread_cwd
                .lock()
                .unwrap()
                .insert(self.thread_id.clone(), cwd.to_string());
        }

        let conn = self
            .bound_db_connection_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let mut bindings = state.agent_db_bindings.write().await;
        match conn {
            Some(c) => {
                bindings.insert(self.thread_id.clone(), c.to_string());
            }
            None => {
                bindings.remove(&self.thread_id);
            }
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct AgentThreadContextInput {
    pub thread_id: String,
    pub linked_session_id: Option<String>,
    pub bound_session_id: Option<String>,
    pub cwd: Option<String>,
    pub local_terminal_env: Option<LocalTerminalEnv>,
    pub bound_db_connection_id: Option<String>,
}

pub fn build_agent_thread_context(
    state: &AppState,
    input: AgentThreadContextInput,
) -> Result<AgentThreadContext, String> {
    let (session, recent) = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        let session = input
            .bound_session_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .and_then(|sid| crate::session::db::get_session(&db, sid).ok());
        let recent = session
            .as_ref()
            .map(|sc| {
                crate::history::db_list_recent(
                    &db,
                    &session_card::host_key_for(sc),
                    session_card::HISTORY_LIMIT,
                )
                .unwrap_or_default()
            })
            .unwrap_or_default();
        (session, recent)
    };

    let flavor = Flavor::for_session_type(session.as_ref().map(|sc| &sc.session_type));
    let session_card = render_session_card(
        session.as_ref(),
        &input.thread_id,
        input.linked_session_id.is_some(),
        &recent,
        input.local_terminal_env.as_ref(),
    );

    Ok(AgentThreadContext {
        thread_id: input.thread_id,
        linked_session_id: input.linked_session_id,
        bound_session_id: input.bound_session_id,
        cwd: input.cwd,
        local_terminal_env: input.local_terminal_env,
        bound_db_connection_id: input.bound_db_connection_id,
        flavor,
        session_card,
    })
}

fn render_session_card(
    session: Option<&SessionConfig>,
    thread_id: &str,
    linked: bool,
    recent: &[String],
    local_terminal_env: Option<&LocalTerminalEnv>,
) -> String {
    let raw = session_card::render_card(session, thread_id, linked, recent, local_terminal_env);
    crate::chat::redact::redact(&raw).0
}
