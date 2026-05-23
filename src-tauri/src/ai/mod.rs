pub mod commands;
pub mod config;
pub mod shell_safety;
pub mod shell_prompt;
pub mod tools_shell;

use crate::asr::manager::AsrManager;
use crate::llm::router::LlmRouter;
use std::sync::Arc;
use tokio::sync::RwLock;

/// Top-level AI context held in AppState.
/// This is the ONLY place that holds both ASR and LLM references.
/// asr::* and llm::* modules must never import each other.
pub struct AppAiCtx {
    pub asr: Arc<AsrManager>,
    pub llm: Arc<RwLock<LlmRouter>>,
}

impl AppAiCtx {
    pub fn new(asr: AsrManager, llm: LlmRouter) -> Self {
        Self {
            asr: Arc::new(asr),
            llm: Arc::new(RwLock::new(llm)),
        }
    }
}
