// Placeholder for the in-process FIM engine.
//
// Real implementation would link `llama-cpp-2` and load Qwen3-0.6B Q4_K_M
// from <cache>/newmob/models/llm_qwen3_0_6b_q4_k_m/. We keep the entry point
// but route through the LlmRouter (TaskKind::TabCompletion) for now — that
// way the user gets working completion as soon as a sidecar is configured,
// even before the in-process build is wired up.

#![allow(dead_code)]

use std::path::PathBuf;

pub struct InProcFim {
    #[allow(dead_code)]
    model_path: PathBuf,
}

impl InProcFim {
    pub fn new(model_path: PathBuf) -> Self {
        Self { model_path }
    }

    /// Generate a completion for the given prefix. Currently always returns
    /// `None` — see `tab::tab_suggest_fim` for the live router-based path.
    pub fn complete_fim(&self, _prefix: &str, _suffix: &str, _max_tokens: u32) -> Option<String> {
        None
    }
}
