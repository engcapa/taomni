use serde::{Deserialize, Serialize};
use std::collections::HashMap;
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

fn default_chat_output_format() -> String {
    "md".into()
}

fn default_chat_send_shortcut() -> String {
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

// ── ASR ──────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AsrConfig {
    #[serde(default)]
    pub download_proxy: crate::asr::models::DownloadProxyConfig,
    pub active: String,
    pub providers: HashMap<String, AsrProviderConfig>,
    /// `local` (default) keeps audio on-device. `online` uses the selected
    /// realtime provider over its WebSocket API.
    #[serde(default = "default_asr_mode")]
    pub mode: String,
    pub warm_on_startup: bool,
    pub vad: String,
    #[serde(default = "asr_auto_language")]
    pub language: String,
}
fn asr_auto_language() -> String {
    "auto".into()
}
fn default_asr_mode() -> String {
    "local".into()
}
impl AsrConfig {
    pub fn normalize(&mut self) {
        // Previous releases advertised unimplemented engines/quantized files.
        // Migrate them to the runnable multilingual Base without downloading.
        if ![
            "whisper-base",
            "whisper-small",
            "whisper-medium",
            "sherpa-zipformer-zh-en",
            "aliyun",
            "deepgram",
            "gemini",
        ]
        .contains(&self.active.as_str())
        {
            self.active = "whisper-base".into();
        }
        self.mode = if ["aliyun", "deepgram", "gemini"].contains(&self.active.as_str()) {
            "online"
        } else {
            "local"
        }
        .into();
        let defaults = Self::default().providers;
        for (id, provider) in defaults {
            self.providers.entry(id).or_insert(provider);
        }
        if !["auto", "zh", "en", "ja", "ko", "fr", "de", "es"].contains(&self.language.as_str()) {
            self.language = "auto".into();
        }
        self.warm_on_startup = false;
        self.vad = "none".into();
    }
}
impl Default for AsrConfig {
    fn default() -> Self {
        Self {
            download_proxy: Default::default(),
            active: "whisper-base".into(),
            providers: {
                let mut providers = ["base", "small", "medium"]
                    .into_iter()
                    .map(|size| {
                        (
                            format!("whisper-{size}"),
                            AsrProviderConfig {
                                engine: "whisper-rs".into(),
                                model: format!("ggml-{size}.bin"),
                                endpoint: String::new(),
                                api_key: String::new(),
                                proxy_mode: default_asr_proxy_mode(),
                                proxy_url: String::new(),
                            },
                        )
                    })
                    .collect::<HashMap<_, _>>();
                providers.insert(
                    "sherpa-zipformer-zh-en".into(),
                    AsrProviderConfig {
                        engine: "sherpa-onnx".into(),
                        model: "streaming-zipformer-bilingual-zh-en-2023-02-20".into(),
                        endpoint: String::new(),
                        api_key: String::new(),
                        proxy_mode: default_asr_proxy_mode(),
                        proxy_url: String::new(),
                    },
                );
                providers.insert(
                    "aliyun".into(),
                    AsrProviderConfig {
                        engine: "aliyun-dashscope".into(),
                        model: "paraformer-realtime-v2".into(),
                        endpoint: "wss://dashscope.aliyuncs.com/api-ws/v1/inference/".into(),
                        api_key: String::new(),
                        proxy_mode: default_asr_proxy_mode(),
                        proxy_url: String::new(),
                    },
                );
                providers.insert(
                    "deepgram".into(),
                    AsrProviderConfig {
                        engine: "deepgram".into(),
                        model: "nova-3".into(),
                        endpoint: "wss://api.deepgram.com/v1/listen".into(),
                        api_key: String::new(),
                        proxy_mode: default_asr_proxy_mode(),
                        proxy_url: String::new(),
                    },
                );
                providers.insert("gemini".into(), AsrProviderConfig {
                    engine: "gemini".into(), model: "gemini-3.5-transcribe-live".into(),
                    endpoint: "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent".into(), api_key: String::new(), proxy_mode: default_asr_proxy_mode(), proxy_url: String::new(),
                });
                providers
            },
            mode: default_asr_mode(),
            warm_on_startup: false,
            vad: "none".into(),
            language: "auto".into(),
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AsrProviderConfig {
    pub engine: String,
    pub model: String,
    #[serde(default)]
    pub endpoint: String,
    /// A `vault:<id>` reference. Plaintext keys are accepted only transiently
    /// by the UI and must be moved to the credential vault before persistence.
    #[serde(default)]
    pub api_key: String,
    #[serde(default = "default_asr_proxy_mode")]
    pub proxy_mode: String,
    #[serde(default)]
    pub proxy_url: String,
}

fn default_asr_proxy_mode() -> String {
    "app".into()
}

// ── LLM ──────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmConfig {
    pub active: String,
    pub providers: HashMap<String, LlmProviderConfig>,
    #[serde(default)]
    pub provider_groups: HashMap<String, LlmProviderGroupConfig>,
    pub fallback: FallbackConfig,
    pub task_routing: HashMap<String, String>,
}

impl Default for LlmConfig {
    fn default() -> Self {
        let mut providers = HashMap::new();

        providers.insert(
            "deepseek".into(),
            LlmProviderConfig {
                base_url: "https://api.deepseek.com/v1".into(),
                api_key: String::new(),
                api_keys: Vec::new(),
                model: "deepseek-chat".into(),
                runtime: "openai-compat".into(),
                capabilities: LlmProviderCapabilities::default(),
                image_model: None,
                video_model: None,
                proxy_mode: default_provider_proxy_mode(),
                proxy_session_id: None,
                proxy_url: None,
            },
        );
        providers.insert(
            "agnes".into(),
            LlmProviderConfig {
                base_url: "https://apihub.agnes-ai.com/v1".into(),
                api_key: String::new(),
                api_keys: Vec::new(),
                model: "agnes-2.0-flash".into(),
                runtime: "openai-compat".into(),
                capabilities: LlmProviderCapabilities {
                    chat: true,
                    image_generation: true,
                    video_generation: true,
                },
                image_model: Some("agnes-image-2.1-flash".into()),
                video_model: Some("agnes-video-v2.0".into()),
                proxy_mode: default_provider_proxy_mode(),
                proxy_session_id: None,
                proxy_url: None,
            },
        );
        providers.insert(
            "glm".into(),
            LlmProviderConfig {
                base_url: "https://open.bigmodel.cn/api/paas/v4".into(),
                api_key: String::new(),
                api_keys: Vec::new(),
                model: "glm-4-flash".into(),
                runtime: "openai-compat".into(),
                capabilities: LlmProviderCapabilities::default(),
                image_model: None,
                video_model: None,
                proxy_mode: default_provider_proxy_mode(),
                proxy_session_id: None,
                proxy_url: None,
            },
        );
        providers.insert(
            "siliconflow".into(),
            LlmProviderConfig {
                base_url: "https://api.siliconflow.cn/v1".into(),
                api_key: String::new(),
                api_keys: Vec::new(),
                model: "Qwen/Qwen2.5-Coder-7B-Instruct".into(),
                runtime: "openai-compat".into(),
                capabilities: LlmProviderCapabilities::default(),
                image_model: None,
                video_model: None,
                proxy_mode: default_provider_proxy_mode(),
                proxy_session_id: None,
                proxy_url: None,
            },
        );
        providers.insert(
            "groq".into(),
            LlmProviderConfig {
                base_url: "https://api.groq.com/openai/v1".into(),
                api_key: String::new(),
                api_keys: Vec::new(),
                model: "llama-3.3-70b-versatile".into(),
                runtime: "openai-compat".into(),
                capabilities: LlmProviderCapabilities::default(),
                image_model: None,
                video_model: None,
                proxy_mode: default_provider_proxy_mode(),
                proxy_session_id: None,
                proxy_url: None,
            },
        );
        providers.insert(
            "local".into(),
            LlmProviderConfig {
                base_url: "http://127.0.0.1:8080/v1".into(),
                api_key: "local".into(),
                api_keys: Vec::new(),
                model: "qwen3-1.7b-q4_k_m".into(),
                runtime: "llama-server".into(),
                capabilities: LlmProviderCapabilities::default(),
                image_model: None,
                video_model: None,
                proxy_mode: default_provider_proxy_mode(),
                proxy_session_id: None,
                proxy_url: None,
            },
        );
        providers.insert(
            "anthropic".into(),
            LlmProviderConfig {
                base_url: "https://api.anthropic.com/v1".into(),
                api_key: String::new(),
                api_keys: Vec::new(),
                model: "claude-sonnet-4-5".into(),
                runtime: "anthropic".into(),
                capabilities: LlmProviderCapabilities::default(),
                image_model: None,
                video_model: None,
                proxy_mode: default_provider_proxy_mode(),
                proxy_session_id: None,
                proxy_url: None,
            },
        );

        let mut task_routing = HashMap::new();
        task_routing.insert("voice_intent".into(), "deepseek".into());
        task_routing.insert("voice_to_shell".into(), "deepseek".into());
        task_routing.insert("tab_completion".into(), "local".into());
        task_routing.insert("command_rewrite".into(), "deepseek".into());
        task_routing.insert("chat_drawer".into(), "deepseek".into());
        task_routing.insert("inline_qq".into(), "deepseek".into());
        task_routing.insert("agent_default".into(), "deepseek".into());

        Self {
            active: "deepseek".into(),
            providers,
            provider_groups: HashMap::new(),
            fallback: FallbackConfig {
                enabled: true,
                primary: "deepseek".into(),
                secondary: "local".into(),
                timeout_ms: 8000,
            },
            task_routing,
        }
    }
}

impl LlmConfig {
    fn normalize(&mut self) {
        self.ensure_default_providers();
        for provider in self.providers.values_mut() {
            provider.normalize();
        }
    }

    fn ensure_default_providers(&mut self) {
        self.providers
            .entry("agnes".into())
            .or_insert_with(default_agnes_provider);
    }
}

fn default_agnes_provider() -> LlmProviderConfig {
    LlmProviderConfig {
        base_url: "https://apihub.agnes-ai.com/v1".into(),
        api_key: String::new(),
        api_keys: Vec::new(),
        model: "agnes-2.0-flash".into(),
        runtime: "openai-compat".into(),
        capabilities: LlmProviderCapabilities {
            chat: true,
            image_generation: true,
            video_generation: true,
        },
        image_model: Some("agnes-image-2.1-flash".into()),
        video_model: Some("agnes-video-v2.0".into()),
        proxy_mode: default_provider_proxy_mode(),
        proxy_session_id: None,
        proxy_url: None,
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmProviderConfig {
    pub base_url: String,
    pub api_key: String,
    #[serde(default)]
    pub api_keys: Vec<String>,
    pub model: String,
    pub runtime: String,
    #[serde(default = "default_llm_provider_capabilities")]
    pub capabilities: LlmProviderCapabilities,
    #[serde(default)]
    pub image_model: Option<String>,
    #[serde(default)]
    pub video_model: Option<String>,
    /// none | session | manual. Default is direct/no-proxy.
    #[serde(default = "default_provider_proxy_mode")]
    pub proxy_mode: String,
    #[serde(default)]
    pub proxy_session_id: Option<String>,
    #[serde(default)]
    pub proxy_url: Option<String>,
}

impl LlmProviderConfig {
    pub fn normalize(&mut self) {
        self.proxy_url = self
            .proxy_url
            .as_ref()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        self.proxy_session_id = self
            .proxy_session_id
            .as_ref()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        self.proxy_mode = normalize_provider_proxy_mode(&self.proxy_mode);
        if self.proxy_url.is_some() && self.proxy_mode == "none" {
            self.proxy_mode = "manual".into();
        }
    }

    pub fn effective_api_keys(&self) -> Vec<&str> {
        let api_keys = self
            .api_keys
            .iter()
            .map(|key| key.trim())
            .filter(|key| !key.is_empty())
            .collect::<Vec<_>>();
        if api_keys.is_empty() {
            vec![self.api_key.as_str()]
        } else {
            api_keys
        }
    }
}

fn default_provider_proxy_mode() -> String {
    "none".into()
}

pub fn normalize_provider_proxy_mode(mode: &str) -> String {
    match mode.trim() {
        "session" | "manual" => mode.trim().into(),
        _ => "none".into(),
    }
}

pub fn resolve_provider_proxy_url(
    provider: &LlmProviderConfig,
    db: Option<&rusqlite::Connection>,
    vault: Option<&crate::vault::Vault>,
) -> Result<Option<String>, String> {
    match normalize_provider_proxy_mode(&provider.proxy_mode).as_str() {
        "session" => {
            let Some(id) = provider
                .proxy_session_id
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
            else {
                return Ok(None);
            };
            let (Some(db), Some(vault)) = (db, vault) else {
                return Ok(None);
            };
            Ok(crate::proxy::resolve_session_proxy_with_db(db, vault, id)?.map(|p| p.to_url()))
        }
        "manual" => Ok(provider
            .proxy_url
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)),
        _ => Ok(None),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmProviderGroupConfig {
    pub label: String,
    pub provider_ids: Vec<String>,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LlmProviderCapabilities {
    #[serde(default = "default_true")]
    pub chat: bool,
    #[serde(default)]
    pub image_generation: bool,
    #[serde(default)]
    pub video_generation: bool,
}

fn default_true() -> bool {
    true
}

fn default_llm_provider_capabilities() -> LlmProviderCapabilities {
    LlmProviderCapabilities {
        chat: true,
        image_generation: false,
        video_generation: false,
    }
}

impl Default for LlmProviderCapabilities {
    fn default() -> Self {
        default_llm_provider_capabilities()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FallbackConfig {
    pub enabled: bool,
    pub primary: String,
    pub secondary: String,
    pub timeout_ms: u64,
}

// ── Config path ───────────────────────────────────────────────────────────────

pub fn default_ai_config_path() -> PathBuf {
    crate::resolved_config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("taomni")
        .join("ai.json")
}

// ── Web Search ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebSearchConfig {
    /// "searxng" | "tavily" | "serper"
    pub client_provider: String,
    /// Whether client-side web search is enabled (default: false).
    pub client_enabled: bool,
    /// Confirmation mode: "per_call" | "per_thread" | "always" | "disabled"
    pub confirm_mode: String,
    /// BYOK API key for Tavily/Serper (stored here for simplicity; production would use OS keyring).
    #[serde(default)]
    pub byok_key: String,
    /// Custom SearXNG instance URL (overrides public instance probe).
    pub searxng_url: Option<String>,
}

impl Default for WebSearchConfig {
    fn default() -> Self {
        Self {
            client_provider: "searxng".into(),
            client_enabled: false,
            confirm_mode: "per_call".into(),
            byok_key: String::new(),
            searxng_url: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_ai_config_without_acp_section_gets_disabled_grok_preset() {
        let current = AiConfig::default();
        let mut value = serde_json::to_value(&current).unwrap();
        value.as_object_mut().unwrap().remove("acp_bridge");

        let mut loaded: AiConfig = serde_json::from_value(value).unwrap();
        loaded.normalize();

        assert!(!loaded.acp_bridge.enabled);
        assert_eq!(loaded.acp_bridge.profiles.len(), 1);
        assert_eq!(loaded.acp_bridge.profiles[0].id, "grok");
        assert!(!loaded.acp_bridge.profiles[0].enabled);
        assert!(!loaded.llm.providers.contains_key("grok"));
        assert!(!loaded.llm.providers.contains_key("xai"));
        assert_eq!(
            serde_json::to_value(&loaded.cc_bridge).unwrap(),
            serde_json::to_value(&current.cc_bridge).unwrap()
        );
        assert_eq!(
            serde_json::to_value(&loaded.codex_bridge).unwrap(),
            serde_json::to_value(&current.codex_bridge).unwrap()
        );
    }
}

#[cfg(test)]
mod asr_migration_tests {
    use super::*;
    #[test]
    fn legacy_asr_migrates_without_enabling_download_or_warmup() {
        let mut config = AsrConfig::default();
        config.active = "legacy-unavailable-engine".into();
        config.language = "invalid".into();
        config.warm_on_startup = true;
        config.normalize();
        assert_eq!(config.active, "whisper-base");
        assert_eq!(config.language, "auto");
        assert!(!config.warm_on_startup);
        assert!(config.providers.contains_key("whisper-base"));
        assert!(config.providers.contains_key("sherpa-zipformer-zh-en"));
        assert!(config.providers.contains_key("aliyun"));
        assert!(config.providers.contains_key("deepgram"));
        assert!(config.providers.contains_key("gemini"));
        config.active = "whisper-small".into();
        config.normalize();
        assert_eq!(config.active, "whisper-small");
    }
}
