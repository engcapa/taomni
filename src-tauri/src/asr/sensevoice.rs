//! CPU-only SenseVoice final decoding; weights remain explicitly installed.
use super::catalog;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};

#[derive(Clone, Default)]
pub struct SenseVoice {
    #[cfg(feature = "asr-sherpa")]
    recognizer: Arc<Mutex<Option<sherpa_onnx::OfflineRecognizer>>>,
}
impl SenseVoice {
    pub async fn prepare(&self, language: &str) -> Result<(), String> {
        if !["auto", "zh", "yue", "en", "ja", "ko"].contains(&language) {
            return Err("ASR_LANGUAGE: SenseVoice supports zh/yue/en/ja/ko; select Whisper for this language".into());
        }
        #[cfg(feature = "asr-sherpa")]
        {
            let context = self.recognizer.clone();
            let language = language.to_string();
            tokio::task::spawn_blocking(move || {
                let mut guard = context.lock().map_err(|_| "ASR_MODEL_LOCK")?;
                if guard.is_some() {
                    return Ok(());
                }
                let model = catalog::model("sensevoice-small")?;
                let path = catalog::path(model);
                catalog::verify(model, &path)?;
                let tokens = path.with_file_name("tokens.txt");
                catalog::verify(&catalog::SENSE_TOKENS, &tokens)?;
                let mut cfg = sherpa_onnx::OfflineRecognizerConfig::default();
                cfg.model_config.sense_voice = sherpa_onnx::OfflineSenseVoiceModelConfig {
                    model: Some(path.to_string_lossy().into_owned()),
                    language: Some(language),
                    use_itn: true,
                };
                cfg.model_config.tokens = Some(tokens.to_string_lossy().into_owned());
                cfg.model_config.provider = Some("cpu".into());
                cfg.model_config.num_threads = std::thread::available_parallelism()
                    .map(|n| n.get().min(4) as i32)
                    .unwrap_or(2);
                cfg.decoding_method = Some("greedy_search".into());
                *guard = Some(
                    sherpa_onnx::OfflineRecognizer::create(&cfg)
                        .ok_or("ASR_MODEL_LOAD: cannot load SenseVoice")?,
                );
                Ok(())
            })
            .await
            .map_err(|e| e.to_string())?
        }
        #[cfg(not(feature = "asr-sherpa"))]
        {
            Err("ASR_UNSUPPORTED: SenseVoice support not built".into())
        }
    }
    pub async fn transcribe(
        &self,
        pcm: Vec<f32>,
        language: &str,
        cancel: Arc<AtomicBool>,
    ) -> Result<String, String> {
        if pcm.len() < 1600 || pcm.iter().all(|s| s.abs() < 0.001) {
            return Err("NO_SPEECH: No speech detected".into());
        }
        if cancel.load(Ordering::Relaxed) {
            return Err("Cancelled".into());
        }
        self.prepare(language).await?;
        #[cfg(feature = "asr-sherpa")]
        {
            let context = self.recognizer.clone();
            tokio::task::spawn_blocking(move || {
                if cancel.load(Ordering::Relaxed) {
                    return Err("Cancelled".into());
                }
                let guard = context.lock().map_err(|_| "ASR_MODEL_LOCK")?;
                let recognizer = guard.as_ref().ok_or("ASR_MODEL_LOAD")?;
                let stream = recognizer.create_stream();
                stream.accept_waveform(16000, &pcm);
                recognizer.decode(&stream);
                if cancel.load(Ordering::Relaxed) {
                    return Err("Cancelled".into());
                }
                let text = stream
                    .get_result()
                    .ok_or("ASR_TRANSCRIPTION: empty SenseVoice response")?
                    .text;
                if text.trim().is_empty() {
                    Err("NO_SPEECH: No speech detected".into())
                } else {
                    Ok(text.trim().into())
                }
            })
            .await
            .map_err(|e| e.to_string())?
        }
        #[cfg(not(feature = "asr-sherpa"))]
        {
            let _ = pcm;
            Err("ASR_UNSUPPORTED: SenseVoice support not built".into())
        }
    }
}
