// ⚠️ This module must NOT use crate::llm::*
// ASR produces plain text (transcription). It has no knowledge of LLM providers.

pub mod manager;
pub mod sherpa_onnx;
pub mod sherpa_onnx_real;

use async_trait::async_trait;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AsrError {
    #[error("Model not loaded: {0}")]
    NotLoaded(String),
    #[error("Transcription failed: {0}")]
    Transcription(String),
    #[error("Model download failed: {0}")]
    Download(String),
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
}

pub type AsrResult<T> = Result<T, AsrError>;

/// The core ASR trait. All implementations must be Send + Sync.
/// Audio NEVER leaves the process — this trait only produces text.
#[async_trait]
pub trait Asr: Send + Sync {
    /// Transcribe PCM audio (f32, mono, 16 kHz) to text.
    async fn transcribe(&self, pcm: &[f32]) -> AsrResult<String>;

    /// Returns true if the model is loaded and ready (warm).
    fn is_warm(&self) -> bool;

    /// Unload the model from memory (called on idle timeout).
    async fn unload(&self);

    /// Engine identifier for display/logging.
    fn engine_id(&self) -> &str;
}

/// A stub ASR implementation used when no real engine is configured.
/// Returns an error on transcription attempts.
pub struct StubAsr;

#[async_trait]
impl Asr for StubAsr {
    async fn transcribe(&self, _pcm: &[f32]) -> AsrResult<String> {
        Err(AsrError::NotLoaded(
            "No ASR engine configured. Download a model in Settings → AI → ASR.".into(),
        ))
    }

    fn is_warm(&self) -> bool {
        false
    }

    async fn unload(&self) {}

    fn engine_id(&self) -> &str {
        "stub"
    }
}
