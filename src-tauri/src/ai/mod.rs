pub mod commands;
pub mod config;
pub mod network_policy;
pub mod session_safety;
pub mod shell_safety;
pub mod shell_prompt;
pub mod tools_shell;

use crate::asr::manager::AsrManager;
use crate::llm::router::{build_router_from_ai, LlmRouter};
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
        let asr = AsrManager::new(cfg.asr.warm_on_startup);

        // Best-effort: if the active ASR provider is the sherpa engine and a
        // model dir exists under <cache>/newmob/models/<id>/, plug it in.
        // We don't fail startup if the model is missing — AsrManager remains
        // on StubAsr, the UI will show "未下载" and trigger the download.
        if let Some(active) = cfg.asr.providers.get(&cfg.asr.active) {
            if active.engine == "sherpa-onnx" {
                let manifest = crate::models::manifest::load_manifest().ok();
                if let Some(m) = manifest {
                    let model_id = match cfg.asr.active.as_str() {
                        "sherpa-zipformer-zh-en" => "asr_sherpa_zipformer_zh_en_small",
                        "sense-voice-small"      => "asr_sense_voice_small",
                        _ => "",
                    };
                    if let Some(meta) = m.models.get(model_id) {
                        let path = crate::models::store::model_path(model_id, meta);
                        if path.exists() {
                            let engine = std::sync::Arc::new(
                                crate::asr::sherpa_onnx::SherpaOnnxAsr::new(
                                    path.parent().map(|p| p.to_path_buf()).unwrap_or(path),
                                ),
                            );
                            let _ = engine.warm_up();
                            asr.set_engine_sync(engine);
                        }
                    }
                }
            }
        }

        let llm = build_router_from_ai(&cfg, Some(vault.as_ref()));
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
        self.config = cfg;
    }
}


