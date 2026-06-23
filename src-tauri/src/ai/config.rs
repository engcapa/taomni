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
}

fn default_chat_output_format() -> String {
    "md".into()
}

impl Default for AiConfig {
    fn default() -> Self {
        Self {
            asr: AsrConfig::default(),
            llm: LlmConfig::default(),
            web_search: WebSearchConfig::default(),
            cc_bridge: crate::agent::cc_bridge::config::CcBridgeConfig::default(),
            full_local_mode: false,
            fully_disabled: false,
            chat_output_format: default_chat_output_format(),
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AsrConfig {
    pub active: String,
    pub providers: HashMap<String, AsrProviderConfig>,
    pub warm_on_startup: bool,
    pub vad: String,
}

impl Default for AsrConfig {
    fn default() -> Self {
        let mut providers = HashMap::new();
        providers.insert(
            "sherpa-zipformer-zh-en".into(),
            AsrProviderConfig {
                engine: "sherpa-onnx".into(),
                model: "streaming-zipformer-bilingual-zh-en-small".into(),
            },
        );
        providers.insert(
            "whisper-base".into(),
            AsrProviderConfig {
                engine: "whisper-rs".into(),
                model: "ggml-base-q5_1".into(),
            },
        );
        Self {
            active: "sherpa-zipformer-zh-en".into(),
            providers,
            warm_on_startup: true,
            vad: "silero".into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AsrProviderConfig {
    pub engine: String,
    pub model: String,
}

// ── LLM ──────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmConfig {
    pub active: String,
    pub providers: HashMap<String, LlmProviderConfig>,
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
                model: "deepseek-chat".into(),
                runtime: "openai-compat".into(),
            },
        );
        providers.insert(
            "glm".into(),
            LlmProviderConfig {
                base_url: "https://open.bigmodel.cn/api/paas/v4".into(),
                api_key: String::new(),
                model: "glm-4-flash".into(),
                runtime: "openai-compat".into(),
            },
        );
        providers.insert(
            "siliconflow".into(),
            LlmProviderConfig {
                base_url: "https://api.siliconflow.cn/v1".into(),
                api_key: String::new(),
                model: "Qwen/Qwen2.5-Coder-7B-Instruct".into(),
                runtime: "openai-compat".into(),
            },
        );
        providers.insert(
            "groq".into(),
            LlmProviderConfig {
                base_url: "https://api.groq.com/openai/v1".into(),
                api_key: String::new(),
                model: "llama-3.3-70b-versatile".into(),
                runtime: "openai-compat".into(),
            },
        );
        providers.insert(
            "local".into(),
            LlmProviderConfig {
                base_url: "http://127.0.0.1:8080/v1".into(),
                api_key: "local".into(),
                model: "qwen3-1.7b-q4_k_m".into(),
                runtime: "llama-server".into(),
            },
        );
        providers.insert(
            "anthropic".into(),
            LlmProviderConfig {
                base_url: "https://api.anthropic.com/v1".into(),
                api_key: String::new(),
                model: "claude-sonnet-4-5".into(),
                runtime: "anthropic".into(),
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmProviderConfig {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub runtime: String,
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
    dirs::config_dir()
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
