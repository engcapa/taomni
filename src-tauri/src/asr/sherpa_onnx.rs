// sherpa-onnx ASR engine.
//
// The real `sherpa-onnx` crate has a heavy native build (CMake + onnxruntime),
// so we keep it behind the `asr-sherpa-onnx` feature flag. The non-feature
// path uses an offline Whisper-style `.bin` reader + a deterministic stub
// decoder that emits "[silence]" / "[unrecognised]" markers based on RMS so
// the UI flow (PTT → composer) is exercised end-to-end without the GB of
// native deps. When the feature is enabled, we hand audio to the real
// streaming recognizer.

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

    /// Eagerly load the model into memory. With the `asr-sherpa-onnx` feature
    /// off, this only verifies that the `.onnx` model files exist so the
    /// fallback decoder can still surface a useful "model installed" signal.
    pub fn warm_up(&self) -> AsrResult<()> {
        if !self.model_dir.exists() {
            return Err(AsrError::NotLoaded(format!(
                "Model directory not found: {}",
                self.model_dir.display()
            )));
        }

        // Both paths require at least one `.onnx` weight to be present so the
        // user gets a clear error instead of a black-box "not warmed" later.
        let has_weights = std::fs::read_dir(&self.model_dir)
            .map_err(|e| AsrError::NotLoaded(format!("read {} failed: {e}", self.model_dir.display())))?
            .flatten()
            .any(|entry| {
                entry
                    .path()
                    .extension()
                    .and_then(|e| e.to_str())
                    .map(|e| e.eq_ignore_ascii_case("onnx"))
                    .unwrap_or(false)
            });
        if !has_weights {
            return Err(AsrError::NotLoaded(format!(
                "No .onnx weights found in {}",
                self.model_dir.display()
            )));
        }

        #[cfg(feature = "asr-sherpa-onnx")]
        {
            // The real recognizer is created on first `transcribe()` so we
            // don't pay the load time on apps that have downloaded weights
            // but never PTT. warm_up is enough to gate the UI status.
        }

        self.warm.store(true, Ordering::SeqCst);
        Ok(())
    }
}

#[async_trait]
impl Asr for SherpaOnnxAsr {
    async fn transcribe(&self, pcm: &[f32]) -> AsrResult<String> {
        if !self.warm.load(Ordering::SeqCst) {
            return Err(AsrError::NotLoaded("sherpa-onnx not warmed".into()));
        }

        #[cfg(feature = "asr-sherpa-onnx")]
        {
            // The real recognizer takes f32 PCM at 16kHz and returns text.
            // A failure here surfaces to the UI as Transcription error.
            // We instantiate lazily and lock for the duration of the call —
            // sherpa-onnx's recognizer is not Send/Sync-safe across awaits.
            return crate::asr::sherpa_onnx_real::decode(&self.model_dir, pcm)
                .map_err(AsrError::Transcription);
        }

        #[cfg(not(feature = "asr-sherpa-onnx"))]
        {
            // No-feature fallback: classify the audio energy so the UI is
            // exercised end-to-end. Real text decoding still requires a
            // build with `--features asr-sherpa-onnx`.
            let rms = compute_rms(pcm);
            if rms < 0.005 {
                return Ok("[silence]".to_string());
            }
            Err(AsrError::Transcription(
                "ASR feature not built. Rebuild NewMob with --features asr-sherpa-onnx to decode audio."
                    .into(),
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

#[cfg(not(feature = "asr-sherpa-onnx"))]
fn compute_rms(pcm: &[f32]) -> f32 {
    if pcm.is_empty() { return 0.0; }
    let sum_sq: f64 = pcm.iter().map(|s| (*s as f64) * (*s as f64)).sum();
    (sum_sq / pcm.len() as f64).sqrt() as f32
}
