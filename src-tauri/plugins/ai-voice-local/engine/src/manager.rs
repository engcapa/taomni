use std::path::PathBuf;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use taomni_asr_models as catalog;

/// One lazy recognizer per configuration. Loading/decoding never blocks Tokio.
/// A request keeps its own manager snapshot when the selected model changes.
pub struct AsrManager {
    pub model_id: String,
    language: String,
    models_root: PathBuf,
    sense: crate::sensevoice::SenseVoice,
    #[cfg(feature = "asr-whisper")]
    context: Arc<std::sync::Mutex<Option<whisper_rs::WhisperContext>>>,
}
impl AsrManager {
    pub fn supported() -> bool {
        if !cfg!(feature = "asr-whisper") {
            return false;
        }
        #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
        {
            std::is_x86_feature_detected!("avx2")
                && std::is_x86_feature_detected!("fma")
                && std::is_x86_feature_detected!("f16c")
                && std::is_x86_feature_detected!("sse4.2")
        }
        #[cfg(not(any(target_arch = "x86", target_arch = "x86_64")))]
        {
            true
        }
    }

    pub fn language(&self) -> &str {
        &self.language
    }

    pub fn configured(models_root: PathBuf, model_id: &str, language: &str) -> Self {
        Self {
            model_id: model_id.into(),
            language: language.into(),
            sense: crate::sensevoice::SenseVoice::new(models_root.clone()),
            models_root,
            #[cfg(feature = "asr-whisper")]
            context: Arc::new(std::sync::Mutex::new(None)),
        }
    }
    pub async fn prepare(&self) -> Result<(), String> {
        if self.model_id == "sensevoice-small" {
            return self.sense.prepare(&self.language).await;
        }
        if !Self::supported() {
            return Err(
                "Whisper requires a supported build and CPU (AVX2/FMA/F16C/SSE4.2 on x86).".into(),
            );
        }
        let m = catalog::model(&self.model_id)?;
        #[cfg(feature = "asr-whisper")]
        {
            // Suppress native debug token logs as well as normal inference output.
            whisper_rs::install_logging_hooks();
            let context = self.context.clone();
            let path = catalog::version_path(&self.models_root, m);
            tokio::task::spawn_blocking(move || {
                let mut guard = context.lock().map_err(|_| "Recognizer lock failed")?;
                if guard.is_none() {
                    catalog::verify(m, &path)?;
                    let mut params = whisper_rs::WhisperContextParameters::default();
                    params.use_gpu(false); // CPU inference; the x86 instruction baseline is checked before loading.
                    *guard = Some(
                        whisper_rs::WhisperContext::new_with_params(
                            path.to_str().ok_or("Invalid model path")?,
                            params,
                        )
                        .map_err(|e| format!("MODEL_LOAD: {e}"))?,
                    );
                }
                Ok(())
            })
            .await
            .map_err(|e| e.to_string())?
        }
        #[cfg(not(feature = "asr-whisper"))]
        {
            let _ = m;
            Err("Whisper support not built".into())
        }
    }
    pub async fn transcribe(
        &self,
        pcm: Vec<f32>,
        cancel: Arc<AtomicBool>,
    ) -> Result<String, String> {
        if pcm.len() < 1600 || pcm.iter().all(|s| s.abs() < 0.001) {
            return Err("NO_SPEECH: No speech detected.".into());
        }
        if self.model_id == "sensevoice-small" {
            return self.sense.transcribe(pcm, &self.language, cancel).await;
        }
        self.prepare().await?;
        if cancel.load(Ordering::Relaxed) {
            return Err("Cancelled".into());
        }
        #[cfg(feature = "asr-whisper")]
        {
            let context = self.context.clone();
            let language = if self.language == "yue" && self.model_id != "whisper-turbo-q5" {
                "zh".into()
            } else {
                self.language.clone()
            };
            tokio::task::spawn_blocking(move || {
                let guard = context.lock().map_err(|_| "Recognizer lock failed")?;
                if cancel.load(Ordering::Relaxed) {
                    return Err("Cancelled".into());
                }
                let mut state = guard
                    .as_ref()
                    .ok_or("Model not loaded")?
                    .create_state()
                    .map_err(|e| e.to_string())?;
                let mut params =
                    whisper_rs::FullParams::new(whisper_rs::SamplingStrategy::Greedy {
                        best_of: 1,
                    });
                params.set_n_threads(
                    std::thread::available_parallelism()
                        .map(|n| n.get().min(4) as i32)
                        .unwrap_or(2),
                );
                params.set_language(if language == "auto" {
                    None
                } else {
                    Some(&language)
                });
                params.set_translate(false);
                params.set_no_context(true);
                params.set_no_timestamps(true);
                params.set_print_progress(false);
                params.set_print_realtime(false);
                params.set_print_timestamps(false);
                params.set_suppress_nst(true);
                // whisper-rs 0.16's generic safe abort helper boxes a trait object
                // but casts its pointer back to the concrete closure type. Avoid
                // that mismatched layout and its leaked allocation entirely.
                unsafe extern "C" fn abort_on_cancel(data: *mut std::ffi::c_void) -> bool {
                    // SAFETY: data comes from Arc::as_ptr below. The Arc remains
                    // alive until synchronous state.full has joined its workers.
                    unsafe { &*data.cast::<AtomicBool>() }.load(Ordering::Relaxed)
                }
                // SAFETY: only an AtomicBool is shared with the native workers;
                // its address is stable and cancel outlives the full call.
                unsafe {
                    params.set_abort_callback(Some(abort_on_cancel));
                    params.set_abort_callback_user_data(Arc::as_ptr(&cancel).cast_mut().cast());
                }
                let decoded = state.full(params, &pcm);
                if cancel.load(Ordering::Relaxed) {
                    return Err("Cancelled".into());
                }
                decoded.map_err(|e| format!("TRANSCRIPTION: {e}"))?;
                let mut text = String::new();
                for segment in state.as_iter() {
                    text.push_str(&segment.to_str().map_err(|e| e.to_string())?);
                }
                let text = text.trim().to_string();
                if text.is_empty() {
                    Err("NO_SPEECH: No speech detected.".into())
                } else {
                    Ok(text)
                }
            })
            .await
            .map_err(|e| e.to_string())?
        }
        #[cfg(not(feature = "asr-whisper"))]
        {
            Err("Whisper support not built".into())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn silence_never_loads_a_model() {
        let engine = AsrManager::configured(std::path::PathBuf::new(), "whisper-base", "auto");
        let error = engine
            .transcribe(vec![0.0; 16000], Arc::new(AtomicBool::new(false)))
            .await
            .unwrap_err();
        assert!(error.starts_with("NO_SPEECH"));
    }
}
