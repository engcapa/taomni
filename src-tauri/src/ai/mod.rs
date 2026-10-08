pub mod commands;
pub mod config;
pub mod network_policy;
pub mod session_safety;
pub mod shell_prompt;
pub mod shell_safety;
pub mod tools_shell;

use crate::asr::manager::AsrManager;
use crate::llm::router::{LlmRouter, build_router_from_ai, build_router_from_ai_with_proxy_db};
use crate::vault::Vault;
use config::AiConfig;
use std::sync::Arc;

/// Top-level AI context held in AppState.
/// This is the ONLY place that holds both ASR and LLM references.
/// asr::* and llm::* modules must never import each other.
///
/// AppState wraps the whole struct in a RwLock so we can hot-rebuild on
/// `save_ai_config` without restarting the app.
pub struct AppAiCtx {
    pub asr: Arc<AsrManager>,
    pub llm: LlmRouter,
    pub config: AiConfig,
    /// Held so reload() can re-resolve `vault:<id>` api keys.
    vault: Arc<Vault>,
}

impl AppAiCtx {
    pub fn from_config(cfg: AiConfig, vault: Arc<Vault>) -> Self {
        Self::from_config_with_proxy_db(cfg, vault, None)
    }

    pub fn from_config_with_proxy_db(
        cfg: AiConfig,
        vault: Arc<Vault>,
        proxy_db: Option<&rusqlite::Connection>,
    ) -> Self {
        let asr = AsrManager::configured(cfg.asr.routed_model(), cfg.asr.routed_language());

        let llm = build_router_from_ai_with_proxy_db(&cfg, Some(vault.as_ref()), proxy_db);
        Self {
            asr: Arc::new(asr),
            llm,
            config: cfg,
            vault,
        }
    }

    /// Reload after the user saved a new config — rebuilds the LlmRouter
    /// while reusing the existing AsrManager (engines are expensive to warm).
    pub fn reload(&mut self, cfg: AiConfig) {
        self.llm = build_router_from_ai(&cfg, Some(self.vault.as_ref()));
        if self.config.asr != cfg.asr || cfg.fully_disabled {
            self.asr = Arc::new(AsrManager::configured(cfg.asr.routed_model(), cfg.asr.routed_language()));
        }
        self.config = cfg;
    }

    pub fn reload_with_proxy_db(&mut self, cfg: AiConfig, proxy_db: Option<&rusqlite::Connection>) {
        self.llm = build_router_from_ai_with_proxy_db(&cfg, Some(self.vault.as_ref()), proxy_db);
        if self.config.asr != cfg.asr || cfg.fully_disabled {
            self.asr = Arc::new(AsrManager::configured(cfg.asr.routed_model(), cfg.asr.routed_language()));
        }
        self.config = cfg;
    }

    pub fn reload_with_router(&mut self, cfg: AiConfig, llm: LlmRouter) {
        self.llm = llm;
        if self.config.asr != cfg.asr || cfg.fully_disabled {
            self.asr = Arc::new(AsrManager::configured(cfg.asr.routed_model(), cfg.asr.routed_language()));
        }
        self.config = cfg;
    }

    /// Rebuild the LlmRouter against the current vault state without touching
    /// the persisted config. Called after `vault_unlock` / `vault_change_master`
    /// so providers whose api_key is `vault:<id>` start working as soon as the
    /// vault is unlocked — no Save click required.
    pub fn rebuild_router(&mut self) {
        self.llm = build_router_from_ai(&self.config, Some(self.vault.as_ref()));
    }

    pub fn rebuild_router_with_proxy_db(&mut self, proxy_db: Option<&rusqlite::Connection>) {
        self.llm =
            build_router_from_ai_with_proxy_db(&self.config, Some(self.vault.as_ref()), proxy_db);
    }

    pub fn replace_router(&mut self, llm: LlmRouter) {
        self.llm = llm;
    }
}
