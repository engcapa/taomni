use super::asr::AsrConfig;
use super::llm::LlmConfig;
use super::web_search::WebSearchConfig;
use serde::Deserialize;
use serde::Serialize;
use std::path::PathBuf;

/// Full AI configuration persisted to ~/.config/taomni/ai.json
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiConfig {
    pub asr: AsrConfig,
    pub llm: LlmConfig,
    #[serde(default)]
    pub web_search: WebSearchConfig,
    #[serde(default)]
    pub cc_bridge: crate::agent::cc_bridge::config::CcBridgeConfig,
    #[serde(default)]
    pub codex_bridge: crate::agent::codex_bridge::config::CodexBridgeConfig,
    #[serde(default)]
    pub acp_bridge: crate::agent::acp_bridge::AcpBridgeConfig,
    /// Master switch: when true, all non-local network calls are refused
    /// (LLM cloud providers, web_search, web_fetch, Claude Code).
    #[serde(default)]
    pub full_local_mode: bool,
    /// Master switch: when true, the entire AI subsystem is silent
    /// (no buttons, no status, no calls). Independent of full_local_mode.
    #[serde(default)]
    pub fully_disabled: bool,
    /// Default chat output format the assistant is asked to produce.
    /// One of "md" (Markdown, default), "html", or "plain".
    /// Per-thread overrides live on `ai_chat_threads.output_format`.
    #[serde(default = "default_chat_output_format")]
    pub chat_output_format: String,
    /// Keyboard shortcut used to send from the AI chat composer.
    /// One of "ctrl_enter" (default) or "enter".
    #[serde(default = "default_chat_send_shortcut")]
    pub chat_send_shortcut: String,
}

pub(super) fn default_chat_output_format() -> String {
    "md".into()
}

pub(super) fn default_chat_send_shortcut() -> String {
    "ctrl_enter".into()
}

impl Default for AiConfig {
    fn default() -> Self {
        Self {
            asr: AsrConfig::default(),
            llm: LlmConfig::default(),
            web_search: WebSearchConfig::default(),
            cc_bridge: crate::agent::cc_bridge::config::CcBridgeConfig::default(),
            codex_bridge: crate::agent::codex_bridge::config::CodexBridgeConfig::default(),
            acp_bridge: crate::agent::acp_bridge::AcpBridgeConfig::default(),
            full_local_mode: false,
            fully_disabled: false,
            chat_output_format: default_chat_output_format(),
            chat_send_shortcut: default_chat_send_shortcut(),
        }
    }
}

impl AiConfig {
    pub fn load(path: &PathBuf) -> Self {
        let mut config: Self = std::fs::read_to_string(path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        config.normalize();
        config
    }

    pub fn normalize(&mut self) {
        self.cc_bridge.normalize();
        self.codex_bridge.normalize();
        self.acp_bridge.normalize();
        self.llm.normalize();
        self.asr.normalize();
    }

    pub fn save(&self, path: &PathBuf) -> std::io::Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut config = self.clone();
        config.normalize();
        let json = serde_json::to_string_pretty(&config)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
        std::fs::write(path, json)
    }
}

// ── Config path ───────────────────────────────────────────────────────────────

pub fn default_ai_config_path() -> PathBuf {
    crate::resolved_config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("taomni")
        .join("ai.json")
}
