use crate::llm::TaskKind;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

/// Full AI configuration persisted to ~/.config/newmob/ai.json
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiConfig {
    pub asr: AsrConfig,
    pub llm: LlmConfig,
}

impl Default for AiConfig {
    fn default() -> Self {
        Self {
            asr: AsrConfig::default(),
            llm: LlmConfig::default(),
        }
    }
}

impl AiConfig {
    pub fn load(path: &PathBuf) -> Self {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, path: &PathBuf) -> std::io::Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let json = serde_json::to_string_pretty(self)
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

        providers.insert("deepseek".into(), LlmProviderConfig {
            base_url: "https://api.deepseek.com/v1".into(),
            api_key: String::new(),
            model: "deepseek-chat".into(),
            runtime: "openai-compat".into(),
        });
        providers.insert("glm".into(), LlmProviderConfig {
            base_url: "https://open.bigmodel.cn/api/paas/v4".into(),
            api_key: String::new(),
            model: "glm-4-flash".into(),
            runtime: "openai-compat".into(),
        });
        providers.insert("siliconflow".into(), LlmProviderConfig {
            base_url: "https://api.siliconflow.cn/v1".into(),
            api_key: String::new(),
            model: "Qwen/Qwen2.5-Coder-7B-Instruct".into(),
            runtime: "openai-compat".into(),
        });
        providers.insert("groq".into(), LlmProviderConfig {
            base_url: "https://api.groq.com/openai/v1".into(),
            api_key: String::new(),
            model: "llama-3.3-70b-versatile".into(),
            runtime: "openai-compat".into(),
        });
        providers.insert("local".into(), LlmProviderConfig {
            base_url: "http://127.0.0.1:8080/v1".into(),
            api_key: "local".into(),
            model: "qwen3-1.7b-q4_k_m".into(),
            runtime: "llama-server".into(),
        });

        let mut task_routing = HashMap::new();
        task_routing.insert("voice_intent".into(),    "deepseek".into());
        task_routing.insert("voice_to_shell".into(),  "deepseek".into());
        task_routing.insert("tab_completion".into(),  "local".into());
        task_routing.insert("command_rewrite".into(), "deepseek".into());
        task_routing.insert("chat_drawer".into(),     "deepseek".into());
        task_routing.insert("inline_qq".into(),       "deepseek".into());
        task_routing.insert("agent_default".into(),   "deepseek".into());

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
        .join("newmob")
        .join("ai.json")
}
