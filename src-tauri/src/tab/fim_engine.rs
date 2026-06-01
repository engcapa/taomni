// In-process FIM (fill-in-the-middle) engine.
//
// The default build routes FIM through the LlmRouter (TaskKind::TabCompletion)
// — this lets users with the local llama-server sidecar OR a cloud provider
// get useful completions today, with the latency budget documented in the
// plan §6.8 (P95 < 300ms).
//
// When the `local-llm-fim` feature is enabled at compile time, this module
// links `llama-cpp-2` directly, loads the Qwen3-0.6B Q4_K_M weights from
// `<cache>/taomni/models/llm_qwen3_0_6b_q4_k_m/`, and serves FIM in-process.
// That eliminates the 30–80ms HTTP roundtrip and is the recommended path for
// users who care about absolute keystroke latency.

#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use tokio::sync::Mutex as AsyncMutex;

pub struct InProcFim {
    model_path: PathBuf,
}

impl InProcFim {
    pub fn new(model_path: PathBuf) -> Self {
        Self { model_path }
    }

    pub fn model_path(&self) -> &Path {
        &self.model_path
    }

    /// Generate a continuation for `prefix`. Without the `local-llm-fim`
    /// feature this returns `None`, signalling the caller to fall through to
    /// the LlmRouter path.
    pub async fn complete_fim(
        &self,
        prefix: &str,
        suffix: &str,
        max_tokens: u32,
    ) -> Option<String> {
        #[cfg(feature = "local-llm-fim")]
        {
            return crate::tab::fim_engine_real::complete(
                &self.model_path,
                prefix,
                suffix,
                max_tokens,
            )
            .await;
        }
        #[cfg(not(feature = "local-llm-fim"))]
        {
            let _ = (prefix, suffix, max_tokens);
            None
        }
    }
}

/// Process-wide singleton; the model is expensive to load (~400MB Q4_K_M),
/// so we keep a single instance alive once initialised.
static INSTANCE: OnceLock<AsyncMutex<Option<InProcFim>>> = OnceLock::new();

fn slot() -> &'static AsyncMutex<Option<InProcFim>> {
    INSTANCE.get_or_init(|| AsyncMutex::new(None))
}

/// Lazily resolve the local FIM engine. Returns `None` when the model file
/// is missing on disk, so callers can fall back to the cloud path silently.
pub async fn resolve() -> Option<InProcFim> {
    let mut guard = slot().lock().await;
    if let Some(existing) = guard.as_ref() {
        return Some(InProcFim {
            model_path: existing.model_path.clone(),
        });
    }
    // Look for the canonical FIM model id under <cache>/taomni/models/.
    let manifest = crate::models::manifest::load_manifest().ok()?;
    let id = "llm_qwen3_0_6b_q4_k_m";
    let meta = manifest.models.get(id)?;
    let path = crate::models::store::model_path(id, meta);
    if !path.exists() {
        return None;
    }
    let engine = InProcFim::new(path);
    *guard = Some(InProcFim {
        model_path: engine.model_path.clone(),
    });
    Some(engine)
}
