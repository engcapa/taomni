use super::catalog;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

/// One lazy recognizer per configuration. Loading/decoding never blocks Tokio.
/// A request keeps its own manager snapshot when the selected model changes.
pub struct AsrManager {
    pub model_id: String,
    language: String,
    sense: super::sensevoice::SenseVoice,
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

    pub fn configured(model_id: &str, language: &str) -> Self {
        Self {
            model_id: model_id.into(),
            language: language.into(),
            sense: Default::default(),
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
            tokio::task::spawn_blocking(move || {
                let mut guard = context.lock().map_err(|_| "Recognizer lock failed")?;
                if guard.is_none() {
                    let path = catalog::path(m);
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
        let engine = AsrManager::configured("whisper-base", "auto");
        let error = engine
            .transcribe(vec![0.0; 16000], Arc::new(AtomicBool::new(false)))
            .await
            .unwrap_err();
        assert!(error.starts_with("NO_SPEECH"));
    }

    /// Run with NEWMOB_CACHE_DIR pointing at an isolated cache containing the
    /// pinned base model, and TAOMNI_VOICE_PCM pointing at 16 kHz mono f32 LE.
    #[cfg(feature = "asr-whisper")]
    #[tokio::test]
    #[ignore = "requires the pinned base weights and official JFK audio fixture"]
    async fn base_decodes_real_audio_and_cancels() {
        let path = std::env::var("TAOMNI_VOICE_PCM").expect("TAOMNI_VOICE_PCM");
        let bytes = std::fs::read(path).unwrap();
        let pcm: Vec<f32> = bytes
            .chunks_exact(4)
            .map(|v| f32::from_le_bytes(v.try_into().unwrap()))
            .collect();
        let engine = AsrManager::configured("whisper-base", "en");
        let start = std::time::Instant::now();
        let text = engine
            .transcribe(pcm.clone(), Arc::new(AtomicBool::new(false)))
            .await
            .unwrap();
        eprintln!("Whisper Base: {text}; elapsed {:?}", start.elapsed());
        let lower = text.to_lowercase();
        assert!(
            lower.contains("ask not") && lower.contains("country"),
            "{text}"
        );
        assert_eq!(
            engine
                .transcribe(pcm.clone(), Arc::new(AtomicBool::new(true)))
                .await
                .unwrap_err(),
            "Cancelled"
        );
        let cancel = Arc::new(AtomicBool::new(false));
        let signal = cancel.clone();
        let cancellation = tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            signal.store(true, Ordering::Relaxed);
        });
        assert_eq!(
            engine.transcribe(pcm.clone(), cancel).await.unwrap_err(),
            "Cancelled"
        );
        cancellation.await.unwrap();
        // A cancelled decode must not poison the reused recognizer or abort
        // the next recording; also catches invalid native callback user-data.
        let retry = engine
            .transcribe(pcm, Arc::new(AtomicBool::new(false)))
            .await
            .unwrap();
        assert!(retry.to_lowercase().contains("country"), "{retry}");
    }
    #[cfg(feature = "asr-whisper")]
    #[tokio::test]
    #[ignore = "requires the pinned multilingual base model and Chinese audio fixture"]
    async fn base_decodes_chinese_audio() {
        let bytes =
            std::fs::read(std::env::var("TAOMNI_VOICE_ZH_PCM").expect("TAOMNI_VOICE_ZH_PCM"))
                .unwrap();
        let pcm = bytes
            .chunks_exact(4)
            .map(|v| f32::from_le_bytes(v.try_into().unwrap()))
            .collect();
        let engine = AsrManager::configured("whisper-base", "zh");
        let start = std::time::Instant::now();
        let text = engine
            .transcribe(pcm, Arc::new(AtomicBool::new(false)))
            .await
            .unwrap();
        eprintln!(
            "Whisper Base Chinese: {text}; elapsed {:?}",
            start.elapsed()
        );
        // Independent FLEURS ground truth. Normalize punctuation and the
        // traditional variants in this sentence before measuring character errors.
        let actual: Vec<char> = text
            .chars()
            .filter(|c| ('\u{4e00}'..='\u{9fff}').contains(c))
            .map(|c| match c {
                '這' => '这',
                '並' => '并',
                '別' => '别',
                '個' => '个',
                '結' => '结',
                '開' => '开',
                c => c,
            })
            .collect();
        let reference: Vec<char> = "这并不是告别这是一个篇章的结束也是新篇章的开始"
            .chars()
            .collect();
        let mut previous: Vec<usize> = (0..=reference.len()).collect();
        for (i, a) in actual.iter().enumerate() {
            let mut next = vec![i + 1; reference.len() + 1];
            for (j, b) in reference.iter().enumerate() {
                next[j + 1] = (previous[j] + usize::from(a != b))
                    .min(previous[j + 1] + 1)
                    .min(next[j] + 1);
            }
            previous = next;
        }
        let cer = previous[reference.len()] as f64 / reference.len() as f64;
        eprintln!("Chinese fixture character error rate: {cer:.3}");
        assert!(cer <= 0.25, "Chinese fixture CER {cer:.3}: {text}");
    }
}
