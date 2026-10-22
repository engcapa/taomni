use serde::Deserialize;
use serde::Serialize;
use std::collections::HashMap;

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
pub(super) fn default_cleanup() -> String {
    "off".into()
}
pub(super) fn default_language_prior() -> String {
    "zh".into()
}
pub(super) fn asr_auto_language() -> String {
    "auto".into()
}
pub(super) fn default_asr_mode() -> String {
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

pub(super) fn default_asr_proxy_mode() -> String {
    "app".into()
}
