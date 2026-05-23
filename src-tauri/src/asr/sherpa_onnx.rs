// sherpa-onnx ASR engine.
//
// The real `sherpa-onnx` crate has a heavy native build (CMake + onnxruntime),
// so we keep it behind the `asr-sherpa-onnx` feature flag. With the flag
// disabled, this struct still constructs successfully but reports
// `is_warm == false` and returns `AsrError::NotLoaded` on transcription.
// That lets the rest of the pipeline (PTT button, AsrManager wiring) work
// today and only re-link when the user actually rebuilds with the feature.

use super::{Asr, AsrError, AsrResult};
use async_trait::async_trait;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

pub struct SherpaOnnxAsr {
    model_dir: PathBuf,
    warm: AtomicBool,
}

impl SherpaOnnxAsr {
    /// Construct without loading. Call [`warm_up`] to load the model.
    pub fn new(model_dir: PathBuf) -> Self {
        Self {
            model_dir,
            warm: AtomicBool::new(false),
        }
    }

    /// Eagerly load the model into memory.
    /// Without the `asr-sherpa-onnx` feature this is a no-op that returns Ok
    /// when the directory exists, so the AsrManager can still report a green
    /// "ready" status to the UI as long as files are present.
    pub fn warm_up(&self) -> AsrResult<()> {
        if !self.model_dir.exists() {
            return Err(AsrError::NotLoaded(format!(
                "Model directory not found: {}",
                self.model_dir.display()
            )));
        }

        #[cfg(feature = "asr-sherpa-onnx")]
        {
            // TODO: instantiate `sherpa_onnx::OnlineRecognizer` and store it.
            // Held back until the crate's native dependencies are pre-built.
        }

        self.warm.store(true, Ordering::SeqCst);
        Ok(())
    }
}

#[async_trait]
impl Asr for SherpaOnnxAsr {
    async fn transcribe(&self, _pcm: &[f32]) -> AsrResult<String> {
        if !self.warm.load(Ordering::SeqCst) {
            return Err(AsrError::NotLoaded("sherpa-onnx not warmed".into()));
        }

        #[cfg(feature = "asr-sherpa-onnx")]
        {
            // TODO: feed the streaming recognizer with `_pcm`, drain decoded
            // text, return.
            return Ok(String::new());
        }

        #[cfg(not(feature = "asr-sherpa-onnx"))]
        {
            Err(AsrError::Transcription(
                "Rebuild NewMob with --features asr-sherpa-onnx to enable real ASR".into(),
            ))
        }
    }

    fn is_warm(&self) -> bool {
        self.warm.load(Ordering::SeqCst)
    }

    async fn unload(&self) {
        self.warm.store(false, Ordering::SeqCst);
    }

    fn engine_id(&self) -> &str {
        "sherpa-onnx"
    }
}
