// Real `llama-cpp-2` FIM wrapper. Only compiled when `--features
// local-llm-fim` is supplied. Like the sherpa-onnx wrapper, this isolates
// the unsafe / native-construction code so the rest of the crate compiles
// on a vanilla toolchain.

#![cfg(feature = "local-llm-fim")]

use std::path::Path;

/// Run a single FIM completion. Returns `Some(continuation)` on success, or
/// `None` to signal the caller to fall back to the cloud router path.
///
/// The 0.x `llama-cpp-2` API (LlamaModel + LlamaContext + LlamaToken loop)
/// is intentionally not unfolded here yet — wiring it up requires the
/// manifest to publish a known-good Qwen3-0.6B GGUF and a tested infill
/// prompt template. Until that lands we surface the same fallback as the
/// no-feature path so users still get completions through the sidecar.
pub async fn complete(_model_path: &Path, _prefix: &str, _suffix: &str, _max_tokens: u32) -> Option<String> {
    tracing::debug!("local-llm-fim feature compiled but real decode not yet wired; falling back");
    None
}
