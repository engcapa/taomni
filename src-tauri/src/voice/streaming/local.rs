use super::events::TranscriptEvent;
use super::events::TranscriptSink;
use super::events::emit;
use base64::Engine;
use futures::SinkExt;
use futures::StreamExt;
use std::path::PathBuf;

/// Run the local streaming Zipformer backend. Model files are deliberately
/// kept outside the installer and are resolved from the user's cache. The
/// model installer will populate this directory in the next phase; a missing
/// bundle produces an actionable error and never falls back to a cloud call.
#[cfg(feature = "asr-sherpa")]
pub async fn run_local(
    app: TranscriptSink,
    session_id: String,
    mut chunks: tokio::sync::mpsc::Receiver<Vec<f32>>,
    language: String,
    decode_language: String,
) -> Result<(), String> {
    if !["auto", "zh", "en"].contains(&language.as_str()) {
        return Err("ASR_LANGUAGE: Zipformer partials support Chinese and English; select Auto local for other languages".into());
    }
    let dir = sherpa_model_dir();
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

    let sense = crate::asr::sensevoice::SenseVoice::cached(&decode_language);
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
                .transcribe(
                    utterance.clone(),
                    &decode_language,
                    std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
                )
                .await
                .unwrap_or(text)
        } else {
            text
        };
        if !text.trim().is_empty() && (text != last || endpoint) {
            last = text.clone();
            emit(
                &app,
                TranscriptEvent {
                    session_id: session_id.clone(),
                    text,
                    final_text: endpoint,
                    processing_ms: started.elapsed().as_millis() as u64,
                    provider: if language == "auto" {
                        "sherpa-zipformer".into()
                    } else {
                        format!("sherpa-zipformer:{language}")
                    },
                },
            );
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
                .transcribe(
                    utterance,
                    &decode_language,
                    std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
                )
                .await
                .unwrap_or(result.text);
        }
        if !result.text.trim().is_empty() {
            emit(
                &app,
                TranscriptEvent {
                    session_id,
                    text: result.text,
                    final_text: true,
                    processing_ms: started.elapsed().as_millis() as u64,
                    provider: "sherpa-zipformer".into(),
                },
            );
        }
    }
    Ok(())
}

#[cfg(not(feature = "asr-sherpa"))]
pub async fn run_local(
    _app: TranscriptSink,
    _session_id: String,
    _chunks: tokio::sync::mpsc::Receiver<Vec<f32>>,
    _language: String,
    _decode_language: String,
) -> Result<(), String> {
    Err("STREAMING_MODEL_UNAVAILABLE: build with the asr-sherpa feature".into())
}

pub(super) fn sherpa_model_dir() -> PathBuf {
    crate::asr::models::sherpa_model_dir()
}

/// Connect one of the supported realtime cloud APIs. The provider receives
/// exactly the same 16 kHz PCM chunks as the local engine and emits the same
/// interim/final event contract. Direct connections are used only when the
/// user explicitly selects `proxy_mode = "none"`; application/custom proxy
/// resolution is handled by the caller and an unavailable proxy is surfaced.
/// Stop sending after five seconds of microphone silence. This is a billing
/// guard for short dictation, not speech detection or a keepalive connection.
pub(super) async fn forward_until_idle(
    mut source: tokio::sync::mpsc::Receiver<Vec<f32>>,
    target: tokio::sync::mpsc::Sender<Vec<f32>>,
) {
    let mut quiet_samples = 0usize;
    loop {
        let chunk =
            match tokio::time::timeout(std::time::Duration::from_secs(5), source.recv()).await {
                Ok(Some(chunk)) => chunk,
                _ => break,
            };
        if chunk.iter().map(|v| v * v).sum::<f32>() / (chunk.len().max(1) as f32) < 0.00001 {
            quiet_samples += chunk.len();
        } else {
            quiet_samples = 0;
        }
        if target.send(chunk).await.is_err() || quiet_samples >= 5 * 16000 {
            break;
        }
    }
}

/// Local routing is explicit and never uploads audio. Zipformer can provide
/// Chinese/English partials; other languages use silence-delimited final decode.
pub async fn run_routed_local(
    app: TranscriptSink,
    session_id: String,
    mut chunks: tokio::sync::mpsc::Receiver<Vec<f32>>,
    language: String,
    engine: std::sync::Arc<crate::asr::manager::AsrManager>,
    cancel: std::sync::Arc<std::sync::atomic::AtomicBool>,
) -> Result<(), String> {
    if engine.model_id == "sensevoice-small"
        && ["zh", "en"].contains(&language.as_str())
        && crate::asr::models::voice_sherpa_model_status().installed
    {
        return run_local(
            app,
            session_id,
            chunks,
            language,
            engine.language().to_owned(),
        )
        .await;
    }
    engine.prepare().await?;
    let mut utterance = Vec::new();
    let mut silence = 0usize;
    while let Some(chunk) = chunks.recv().await {
        let quiet =
            chunk.iter().map(|s| s * s).sum::<f32>() / (chunk.len().max(1) as f32) < 0.00001;
        silence = if quiet { silence + chunk.len() } else { 0 };
        utterance.extend(chunk);
        if (silence >= 12800 && utterance.len() >= 16000) || utterance.len() >= 20 * 16000 {
            let started = std::time::Instant::now();
            match engine
                .transcribe(std::mem::take(&mut utterance), cancel.clone())
                .await
            {
                Ok(text) => emit(
                    &app,
                    TranscriptEvent {
                        session_id: session_id.clone(),
                        text,
                        final_text: true,
                        processing_ms: started.elapsed().as_millis() as u64,
                        provider: engine.model_id.clone(),
                    },
                ),
                Err(e) if e.starts_with("NO_SPEECH") => {}
                Err(e) => return Err(e),
            }
            silence = 0;
        }
    }
    if !utterance.is_empty() {
        let started = std::time::Instant::now();
        match engine.transcribe(utterance, cancel).await {
            Ok(text) => emit(
                &app,
                TranscriptEvent {
                    session_id,
                    text,
                    final_text: true,
                    processing_ms: started.elapsed().as_millis() as u64,
                    provider: engine.model_id.clone(),
                },
            ),
            Err(e) if e.starts_with("NO_SPEECH") => {}
            Err(e) => return Err(e),
        }
    }
    Ok(())
}
