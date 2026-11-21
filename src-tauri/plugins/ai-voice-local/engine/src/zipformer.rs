use std::{
    future::Future,
    path::Path,
    sync::{Arc, atomic::AtomicBool},
};
use tokio::sync::mpsc;

pub struct LocalTranscript {
    pub text: String,
    pub final_text: bool,
    pub processing_ms: u64,
    pub provider: String,
}

/// Run the local streaming Zipformer backend. Model files are deliberately
/// kept outside the installer and are resolved from the user's cache. The
/// model installer will populate this directory in the next phase; a missing
/// bundle produces an actionable error and never falls back to a cloud call.
#[cfg(feature = "asr-sherpa")]
pub async fn run_zipformer<Emit>(
    models_root: &Path,
    dir: &Path,
    mut chunks: mpsc::Receiver<Vec<f32>>,
    language: String,
    decode_language: String,
    cancel: Arc<AtomicBool>,
    mut send: impl FnMut(LocalTranscript) -> Emit + Send,
) -> Result<(), String>
where
    Emit: Future<Output = Result<(), String>> + Send,
{
    if !["auto", "zh", "en"].contains(&language.as_str()) {
        return Err("ASR_LANGUAGE: Zipformer partials support Chinese and English; select Auto local for other languages".into());
    }
    let encoder = dir.join("encoder-epoch-99-avg-1.int8.onnx");
    let decoder = dir.join("decoder-epoch-99-avg-1.onnx");
    let joiner = dir.join("joiner-epoch-99-avg-1.int8.onnx");
    let tokens = dir.join("tokens.txt");
    for path in [&encoder, &decoder, &joiner, &tokens] {
        if !path.is_file() {
            return Err(format!(
                "STREAMING_MODEL_MISSING: install sherpa Zipformer model files in {} (missing {})",
                dir.display(),
                path.file_name().unwrap_or_default().to_string_lossy()
            ));
        }
    }
    let (recognizer, stream) = tokio::task::spawn_blocking(move || {
        let mut cfg = sherpa_onnx::OnlineRecognizerConfig::default();
        cfg.model_config.transducer.encoder = Some(encoder.to_string_lossy().into_owned());
        cfg.model_config.transducer.decoder = Some(decoder.to_string_lossy().into_owned());
        cfg.model_config.transducer.joiner = Some(joiner.to_string_lossy().into_owned());
        cfg.model_config.tokens = Some(tokens.to_string_lossy().into_owned());
        cfg.model_config.num_threads = std::thread::available_parallelism()
            .map(|n| n.get().min(4) as i32)
            .unwrap_or(2);
        cfg.enable_endpoint = true;
        cfg.rule1_min_trailing_silence = 1.2;
        cfg.rule2_min_trailing_silence = 0.8;
        // Rule 3 is a maximum utterance length, not trailing silence.
        cfg.rule3_min_utterance_length = 20.0;
        cfg.decoding_method = Some("greedy_search".into());
        let recognizer = sherpa_onnx::OnlineRecognizer::create(&cfg).ok_or_else(|| {
            "STREAMING_MODEL_LOAD: unable to create Zipformer recognizer".to_string()
        })?;
        let stream = recognizer.create_stream();
        Ok::<_, String>((recognizer, stream))
    })
    .await
    .map_err(|e| e.to_string())??;

    let sense = crate::sensevoice::SenseVoice::cached(models_root, &decode_language);
    let refine = sense.prepare(&decode_language).await.is_ok();
    let mut utterance = Vec::new();
    let started = std::time::Instant::now();
    let mut last = String::new();
    while let Some(chunk) = chunks.recv().await {
        let pcm = chunk;
        utterance.extend_from_slice(&pcm);
        let (text, endpoint) = tokio::task::block_in_place(|| {
            stream.accept_waveform(16_000, &pcm);
            while recognizer.is_ready(&stream) {
                recognizer.decode(&stream);
            }
            let result = recognizer
                .get_result(&stream)
                .map(|r| r.text)
                .unwrap_or_default();
            (result, recognizer.is_endpoint(&stream))
        });
        let text = if endpoint && refine {
            sense
                .transcribe(utterance.clone(), &decode_language, cancel.clone())
                .await
                .unwrap_or(text)
        } else {
            text
        };
        if !text.trim().is_empty() && (text != last || endpoint) {
            last = text.clone();
            send(LocalTranscript {
                text,
                final_text: endpoint,
                processing_ms: started.elapsed().as_millis() as u64,
                provider: if language == "auto" {
                    "sherpa-zipformer".into()
                } else {
                    format!("sherpa-zipformer:{language}")
                },
            })
            .await?;
        }
        if endpoint {
            recognizer.reset(&stream);
            last.clear();
            utterance.clear();
        }
    }
    // Flush the feature extraction tail before marking input complete.
    stream.accept_waveform(16_000, &vec![0.0; 4800]);
    stream.input_finished();
    while recognizer.is_ready(&stream) {
        recognizer.decode(&stream);
    }
    if let Some(mut result) = recognizer.get_result(&stream) {
        if refine && !utterance.is_empty() {
            result.text = sense
                .transcribe(utterance, &decode_language, cancel)
                .await
                .unwrap_or(result.text);
        }
        if !result.text.trim().is_empty() {
            send(LocalTranscript {
                text: result.text,
                final_text: true,
                processing_ms: started.elapsed().as_millis() as u64,
                provider: "sherpa-zipformer".into(),
            })
            .await?;
        }
    }
    Ok(())
}

#[cfg(not(feature = "asr-sherpa"))]
pub async fn run_zipformer<Emit>(
    _models_root: &Path,
    _dir: &Path,
    _chunks: mpsc::Receiver<Vec<f32>>,
    _language: String,
    _decode_language: String,
    _cancel: Arc<AtomicBool>,
    _send: impl FnMut(LocalTranscript) -> Emit + Send,
) -> Result<(), String>
where
    Emit: Future<Output = Result<(), String>> + Send,
{
    Err("STREAMING_MODEL_UNAVAILABLE: build with the asr-sherpa feature".into())
}
