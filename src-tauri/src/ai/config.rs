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
    #[serde(default = "default_language_prior")]
    pub language_prior: String,
    #[serde(default)]
    pub hotwords: Vec<String>,
    #[serde(default)]
    pub experimental: bool,
    #[serde(default = "default_cleanup")]
    pub cleanup: String,
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
fn default_cleanup() -> String {
    "off".into()
}
fn default_language_prior() -> String {
    "zh".into()
}
fn asr_auto_language() -> String {
    "auto".into()
}
fn default_asr_mode() -> String {
    "local".into()
}
impl AsrConfig {
    pub fn routed_language(&self) -> &str {
        if self.language == "auto" && self.active == "local-auto" {
            &self.language_prior
        } else {
            &self.language
        }
    }
    pub fn routed_model(&self) -> &str {
        if self.active == "local-auto" {
            if ["es", "fr", "it", "de"].contains(&self.routed_language()) {
                "whisper-small-q8"
            } else {
                "sensevoice-small"
            }
        } else {
            &self.active
        }
    }
    pub fn normalize(&mut self) {
        // Previous releases advertised unimplemented engines/quantized files.
        // Migrate them to the runnable multilingual Base without downloading.
        if ![
            "local-auto",
            "sensevoice-small",
            "whisper-base-q8",
            "whisper-small-q8",
            "whisper-medium-q8",
            "whisper-turbo-q5",
            "whisper-base",
            "whisper-small",
            "whisper-medium",
            "sherpa-zipformer-zh-en",
            "aliyun",
            "volcengine",
            "soniox",
            "deepgram",
            "gemini",
        ]
        .contains(&self.active.as_str())
        {
            self.active = "local-auto".into();
        }
        self.mode = if ["aliyun", "volcengine", "soniox", "deepgram", "gemini"]
            .contains(&self.active.as_str())
        {
            "online"
        } else {
            "local"
        }
        .into();
        let defaults = Self::default().providers;
        for (id, provider) in defaults {
            self.providers.entry(id).or_insert(provider);
        }
        if ![
            "auto", "zh", "yue", "en", "ja", "ko", "fr", "de", "es", "it",
        ]
        .contains(&self.language.as_str())
        {
            self.language = "auto".into();
        }
        if !["zh", "yue", "en", "ja", "ko", "fr", "de", "es", "it"]
            .contains(&self.language_prior.as_str())
        {
            self.language_prior = default_language_prior();
        }
        if !["off", "light", "full"].contains(&self.cleanup.as_str()) {
            self.cleanup = default_cleanup();
        }
        self.warm_on_startup = false;
        self.vad = "none".into();
    }
}
impl Default for AsrConfig {
    fn default() -> Self {
        Self {
            download_proxy: Default::default(),
            active: "local-auto".into(),
            language_prior: default_language_prior(),
            hotwords: Vec::new(),
            experimental: false,
            cleanup: default_cleanup(),
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
                                ..Default::default()
                            },
                        )
                    })
                    .collect::<HashMap<_, _>>();
                providers.insert(
                    "volcengine".into(),
                    AsrProviderConfig {
                        engine: "volcengine".into(),
                        model: "bigmodel".into(),
                        endpoint: "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async"
                            .into(),
                        resource_id: "volc.seedasr.sauc.duration".into(),
                        proxy_mode: default_asr_proxy_mode(),
                        ..Default::default()
                    },
                );
                providers.insert(
                    "soniox".into(),
                    AsrProviderConfig {
                        engine: "soniox".into(),
                        model: "stt-rt-v5".into(),
                        endpoint: "wss://stt-rt.soniox.com/transcribe-websocket".into(),
                        proxy_mode: default_asr_proxy_mode(),
                        ..Default::default()
                    },
                );
                for model in crate::asr::catalog::MODELS {
                    providers
                        .entry(model.id.into())
                        .or_insert(AsrProviderConfig {
                            engine: if model.id == "sensevoice-small" {
                                "sherpa-onnx"
                            } else {
                                "whisper-rs"
                            }
                            .into(),
                            model: model.filename.into(),
                            endpoint: String::new(),
                            api_key: String::new(),
                            proxy_mode: default_asr_proxy_mode(),
                            proxy_url: String::new(),
                            ..Default::default()
                        });
                }
                providers.insert(
                    "sherpa-zipformer-zh-en".into(),
                    AsrProviderConfig {
                        engine: "sherpa-onnx".into(),
                        model: "streaming-zipformer-bilingual-zh-en-2023-02-20".into(),
                        endpoint: String::new(),
                        api_key: String::new(),
                        proxy_mode: default_asr_proxy_mode(),
                        proxy_url: String::new(),
                        ..Default::default()
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
                        ..Default::default()
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
                        ..Default::default()
                    },
                );
                providers.insert("gemini".into(), AsrProviderConfig {
                    engine: "gemini".into(), model: "gemini-3.5-transcribe-live".into(),
                    endpoint: "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent".into(), api_key: String::new(), proxy_mode: default_asr_proxy_mode(), proxy_url: String::new(), ..Default::default()
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
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
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
    #[serde(default)]
    pub custom_proxy: Option<crate::proxy::AppProxyConfig>,
    #[serde(default)]
    pub app_id: String,
    #[serde(default)]
    pub resource_id: String,
    #[serde(default)]
    pub vocabulary_endpoint: String,
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
                protocol_overrides: HashMap::new(),
                runtime: "openai-compat".into(),
                capabilities: LlmProviderCapabilities::default(),
                image_model: None,
                video_model: None,
                proxy_mode: default_provider_proxy_mode(),
                proxy_session_id: None,
                proxy_url: None,
                custom_proxy: None,
            },
        );
        providers.insert(
            "agnes".into(),
            LlmProviderConfig {
                base_url: "https://apihub.agnes-ai.com/v1".into(),
                api_key: String::new(),
                api_keys: Vec::new(),
                model: "agnes-2.0-flash".into(),
                protocol_overrides: HashMap::new(),
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
                custom_proxy: None,
            },
        );
        providers.insert(
            "glm".into(),
            LlmProviderConfig {
                base_url: "https://open.bigmodel.cn/api/paas/v4".into(),
                api_key: String::new(),
                api_keys: Vec::new(),
                model: "glm-4-flash".into(),
                protocol_overrides: HashMap::new(),
                runtime: "openai-compat".into(),
                capabilities: LlmProviderCapabilities::default(),
                image_model: None,
                video_model: None,
                proxy_mode: default_provider_proxy_mode(),
                proxy_session_id: None,
                proxy_url: None,
                custom_proxy: None,
            },
        );
        providers.insert(
            "siliconflow".into(),
            LlmProviderConfig {
                base_url: "https://api.siliconflow.cn/v1".into(),
                api_key: String::new(),
                api_keys: Vec::new(),
                model: "Qwen/Qwen2.5-Coder-7B-Instruct".into(),
                protocol_overrides: HashMap::new(),
                runtime: "openai-compat".into(),
                capabilities: LlmProviderCapabilities::default(),
                image_model: None,
                video_model: None,
                proxy_mode: default_provider_proxy_mode(),
                proxy_session_id: None,
                proxy_url: None,
                custom_proxy: None,
            },
        );
        providers.insert(
            "groq".into(),
            LlmProviderConfig {
                base_url: "https://api.groq.com/openai/v1".into(),
                api_key: String::new(),
                api_keys: Vec::new(),
                model: "llama-3.3-70b-versatile".into(),
                protocol_overrides: HashMap::new(),
                runtime: "openai-compat".into(),
                capabilities: LlmProviderCapabilities::default(),
                image_model: None,
                video_model: None,
                proxy_mode: default_provider_proxy_mode(),
                proxy_session_id: None,
                proxy_url: None,
                custom_proxy: None,
            },
        );
        providers.insert(
            "local".into(),
            LlmProviderConfig {
                base_url: "http://127.0.0.1:8080/v1".into(),
                api_key: "local".into(),
                api_keys: Vec::new(),
                model: "qwen3-1.7b-q4_k_m".into(),
                protocol_overrides: HashMap::new(),
                runtime: "llama-server".into(),
                capabilities: LlmProviderCapabilities::default(),
                image_model: None,
                video_model: None,
                proxy_mode: default_provider_proxy_mode(),
                proxy_session_id: None,
                proxy_url: None,
                custom_proxy: None,
            },
        );
        providers.insert(
            "anthropic".into(),
            LlmProviderConfig {
                base_url: "https://api.anthropic.com/v1".into(),
                api_key: String::new(),
                api_keys: Vec::new(),
                model: "claude-sonnet-4-5".into(),
                protocol_overrides: HashMap::new(),
                runtime: "anthropic".into(),
                capabilities: LlmProviderCapabilities::default(),
                image_model: None,
                video_model: None,
                proxy_mode: default_provider_proxy_mode(),
                proxy_session_id: None,
                proxy_url: None,
                custom_proxy: None,
            },
        );

        providers.insert("opencode-go".into(), default_opencode_go_provider());
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
            .entry("opencode-go".into())
            .or_insert_with(default_opencode_go_provider);
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
        protocol_overrides: HashMap::new(),
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
        custom_proxy: None,
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmProviderConfig {
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub protocol_overrides: HashMap<String, String>,
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
    /// Go: app (default) | custom | none; legacy providers: none | session | manual.
    #[serde(default)]
    pub proxy_mode: String,
    #[serde(default)]
    pub proxy_session_id: Option<String>,
    #[serde(default)]
    pub proxy_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_proxy: Option<crate::proxy::AppProxyConfig>,
}

pub fn default_opencode_go_provider() -> LlmProviderConfig {
    LlmProviderConfig {
        base_url: "https://opencode.ai/inference/go/v1".into(),
        api_key: String::new(),
        api_keys: Vec::new(),
        model: "deepseek-v4.1-flash".into(),
        runtime: "opencode-go".into(),
        capabilities: LlmProviderCapabilities::default(),
        image_model: None,
        video_model: None,
        proxy_mode: "app".into(),
        proxy_session_id: None,
        proxy_url: None,
        custom_proxy: None,
        protocol_overrides: HashMap::new(),
    }
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
        if self.runtime == "opencode-go" {
            self.proxy_mode = normalize_go_proxy_mode(&self.proxy_mode);
            return;
        }
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

pub fn normalize_go_proxy_mode(mode: &str) -> String {
    match mode.trim() {
        "custom" | "none" | "session" | "manual" => mode.trim().into(),
        _ => "app".into(),
    }
}

/// Go uses the shared Settings proxy format, with strict failure handling.
pub fn resolve_go_proxy_url(
    provider: &LlmProviderConfig,
    db: Option<&rusqlite::Connection>,
    vault: Option<&crate::vault::Vault>,
) -> Result<Option<String>, String> {
    resolve_go_proxy_with_app(provider, db, vault, || {
        crate::proxy::AppProxyConfig::load_strict(&crate::proxy::default_app_proxy_path())
    })
}

fn resolve_go_proxy_with_app(
    provider: &LlmProviderConfig,
    db: Option<&rusqlite::Connection>,
    vault: Option<&crate::vault::Vault>,
    load_app: impl FnOnce() -> Result<crate::proxy::AppProxyConfig, String>,
) -> Result<Option<String>, String> {
    let mode = normalize_go_proxy_mode(&provider.proxy_mode);
    let config = match mode.as_str() {
        "none" => return Ok(None),
        "app" => load_app()?,
        "custom" => {
            let mut config = provider
                .custom_proxy
                .clone()
                .ok_or("OpenCode Go custom proxy is not configured")?;
            config.enabled = true;
            config
        }
        "session" => crate::proxy::AppProxyConfig {
            enabled: true,
            mode: "session".into(),
            session_id: provider.proxy_session_id.clone().unwrap_or_default(),
            ..Default::default()
        },
        "manual" => {
            let url = provider
                .proxy_url
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or("OpenCode Go manual proxy URL is required")?;
            reqwest::Proxy::all(url).map_err(|_| "OpenCode Go proxy URL is invalid")?;
            return Ok(Some(url.into()));
        }
        _ => unreachable!(),
    };
    crate::proxy::resolve_strict_with_db(&config, db, vault).map(|proxy| proxy.map(|p| p.to_url()))
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
    #[test]
    fn go_proxy_defaults_and_round_trip_preserve_explicit_modes() {
        let mut value = serde_json::to_value(super::default_opencode_go_provider()).unwrap();
        value.as_object_mut().unwrap().remove("proxy_mode");
        let mut go: super::LlmProviderConfig = serde_json::from_value(value.clone()).unwrap();
        go.normalize();
        assert_eq!(go.proxy_mode, "app");
        value["runtime"] = "openai-compat".into();
        let mut legacy: super::LlmProviderConfig = serde_json::from_value(value).unwrap();
        legacy.normalize();
        assert_eq!(legacy.proxy_mode, "none");
        go.custom_proxy = Some(crate::proxy::AppProxyConfig {
            host: "independent".into(),
            ..Default::default()
        });
        go.proxy_url = Some("http://legacy:3128".into());
        for mode in ["app", "custom", "none", "manual", "session"] {
            go.proxy_mode = mode.into();
            let mut restored: super::LlmProviderConfig =
                serde_json::from_value(serde_json::to_value(&go).unwrap()).unwrap();
            restored.normalize();
            assert_eq!(restored.proxy_mode, mode);
            assert_eq!(restored.custom_proxy, go.custom_proxy);
        }
        legacy.proxy_url = go.proxy_url;
        legacy.normalize();
        assert_eq!(legacy.proxy_mode, "manual");
    }

    #[test]
    fn go_proxy_uses_application_or_independent_settings_and_never_falls_back() {
        let app = crate::proxy::AppProxyConfig {
            enabled: true,
            host: "app-proxy".into(),
            ..Default::default()
        };
        let mut go = super::default_opencode_go_provider();
        assert_eq!(
            super::resolve_go_proxy_with_app(&go, None, None, || Ok(app.clone()))
                .unwrap()
                .as_deref(),
            Some("http://app-proxy:3128")
        );
        assert!(
            super::resolve_go_proxy_with_app(&go, None, None, || Err("invalid app config".into()))
                .is_err()
        );
        assert_eq!(
            super::resolve_go_proxy_with_app(&go, None, None, || Ok(Default::default())).unwrap(),
            None
        );
        go.proxy_mode = "custom".into();
        assert!(super::resolve_go_proxy_url(&go, None, None).is_err());
        go.custom_proxy = Some(crate::proxy::AppProxyConfig {
            host: "custom-proxy".into(),
            ..Default::default()
        });
        assert_eq!(
            super::resolve_go_proxy_with_app(&go, None, None, || panic!(
                "custom must not load application proxy"
            ))
            .unwrap()
            .as_deref(),
            Some("http://custom-proxy:3128")
        );
        assert_eq!(app.host, "app-proxy");
        go.custom_proxy.as_mut().unwrap().password_ref = "vault:missing".into();
        assert!(super::resolve_go_proxy_url(&go, None, None).is_err());
        go.proxy_mode = "none".into();
        go.proxy_url = Some("http://retained:3128".into());
        go.normalize();
        assert_eq!(
            super::resolve_go_proxy_with_app(&go, None, None, || panic!(
                "none must bypass application proxy"
            ))
            .unwrap(),
            None
        );
        go.proxy_mode = "session".into();
        assert!(super::resolve_go_proxy_url(&go, None, None).is_err());
        go.proxy_mode = "manual".into();
        assert_eq!(
            super::resolve_go_proxy_url(&go, None, None)
                .unwrap()
                .as_deref(),
            Some("http://retained:3128")
        );
        go.proxy_url = None;
        assert!(super::resolve_go_proxy_url(&go, None, None).is_err());
    }

    #[test]
    fn legacy_go_normalization_preserves_user_configuration() {
        let mut config = super::AiConfig::default();
        config.llm.providers.remove("opencode-go");
        let routes = config.llm.task_routing.clone();
        let original = serde_json::to_value(&config.llm.providers["deepseek"]).unwrap();
        config.llm.normalize();
        let go = &config.llm.providers["opencode-go"];
        assert_eq!(go.model, "deepseek-v4.1-flash");
        assert_eq!(go.runtime, "opencode-go");
        assert_eq!(config.llm.task_routing, routes);
        assert_eq!(
            serde_json::to_value(&config.llm.providers["deepseek"]).unwrap(),
            original
        );
        assert!(
            serde_json::to_value(go)
                .unwrap()
                .get("protocol_overrides")
                .is_none()
        );
        let parsed: super::LlmProviderConfig = serde_json::from_value(original).unwrap();
        assert!(parsed.protocol_overrides.is_empty());
        config.llm.providers.get_mut("opencode-go").unwrap().model = "custom".into();
        config.llm.normalize();
        assert_eq!(config.llm.providers["opencode-go"].model, "custom");
    }
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
    fn local_route_preserves_cantonese_and_covers_eight_languages() {
        let mut config = AsrConfig::default();
        for language in ["zh", "yue", "en", "ja", "ko", "es", "fr", "it"] {
            config.language = language.into();
            config.normalize();
            assert_eq!(config.language, language);
            assert_eq!(
                config.routed_model(),
                if ["es", "fr", "it"].contains(&language) {
                    "whisper-small-q8"
                } else {
                    "sensevoice-small"
                }
            );
        }
        config.language = "auto".into();
        config.language_prior = "it".into();
        assert_eq!(config.routed_model(), "whisper-small-q8");
        config.active = "whisper-base".into();
        config.normalize();
        assert_eq!(
            config.routed_model(),
            "whisper-base",
            "do not silently replace a legacy selection"
        );
    }
    #[test]
    fn legacy_asr_migrates_without_enabling_download_or_warmup() {
        let mut config = AsrConfig::default();
        config.active = "legacy-unavailable-engine".into();
        config.language = "invalid".into();
        config.warm_on_startup = true;
        config.normalize();
        assert_eq!(config.active, "local-auto");
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
