use super::proxy::default_provider_proxy_mode;
use super::proxy::normalize_go_proxy_mode;
use serde::Deserialize;
use serde::Serialize;
use std::collections::HashMap;

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
    pub(super) fn normalize(&mut self) {
        self.ensure_default_providers();
        for provider in self.providers.values_mut() {
            provider.normalize();
        }
    }

    pub(super) fn ensure_default_providers(&mut self) {
        self.providers
            .entry("opencode-go".into())
            .or_insert_with(default_opencode_go_provider);
        self.providers
            .entry("agnes".into())
            .or_insert_with(default_agnes_provider);
    }
}

pub(super) fn default_agnes_provider() -> LlmProviderConfig {
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
    /// app (default) | custom | none; session/manual remain readable for migration.
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
        // Preserve explicit direct mode, including a dormant legacy URL.
        self.proxy_mode = if self.runtime != "opencode-go"
            && self.proxy_mode.trim().is_empty()
            && self.proxy_url.is_some()
        {
            "manual".into()
        } else {
            normalize_go_proxy_mode(&self.proxy_mode)
        };
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

pub(super) fn default_true() -> bool {
    true
}

pub(super) fn default_llm_provider_capabilities() -> LlmProviderCapabilities {
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
