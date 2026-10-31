use crate::chat::ChatSendRequest;
use crate::chat::context;
use crate::chat::store;
use crate::state::AppState;
use tauri::AppHandle;
use tauri::State;

pub(super) struct StreamTurn<'a> {
    pub(super) req: ChatSendRequest,
    pub(super) app: Option<AppHandle>,
    pub(super) state: &'a AppState,
    pub(super) event_name: String,
    pub(super) thread: store::ChatThread,
    pub(super) history: Vec<store::ChatMessage>,
    pub(super) attachments: Vec<store::ChatAttachment>,
    pub(super) clean_content: String,
    pub(super) redacted_count: usize,
    pub(super) user_msg: store::ChatMessage,
    pub(super) agent_ctx: crate::agent::context::AgentThreadContext,
}
