use std::sync::{Arc, atomic::AtomicBool};

use taomni_local_voice_api::{Mode, Transcript};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::{asr::manager::AsrManager, plugin::PluginRegistry, voice::local_host};

use super::events::{TranscriptEvent, TranscriptSink, emit};

pub fn is_local_provider(provider: &str) -> bool {
    matches!(
        provider,
        "local-auto" | "sensevoice-small" | "sherpa-zipformer-zh-en"
    )
}

pub async fn run_local(
    plugins: &Arc<PluginRegistry>,
    app: TranscriptSink,
    session_id: String,
    chunks: mpsc::Receiver<Vec<f32>>,
    provider: &str,
    language: String,
    engine: &AsrManager,
    cancel: Arc<AtomicBool>,
    stop: &CancellationToken,
) -> Result<(), String> {
    let use_host = local_host::use_host(plugins)?;
    let forced_zipformer = provider == "sherpa-zipformer-zh-en";
    let mut selection = engine.selection().clone();
    let mode = if forced_zipformer
        || (selection.model_id == "sensevoice-small"
            && ["zh", "en"].contains(&language.as_str())
            && crate::asr::models::voice_sherpa_model_status().installed)
    {
        if forced_zipformer {
            selection.model_id = "sensevoice-small".into();
            selection.language.clone_from(&language);
        }
        Mode::Zipformer {
            directory: local_host::absolute(crate::asr::models::sherpa_model_dir()),
            language,
        }
    } else {
        Mode::FinalSegments
    };
    let emit_transcript = |result: Transcript| {
        emit(
            &app,
            TranscriptEvent {
                session_id: session_id.clone(),
                text: result.text,
                final_text: result.final_text,
                processing_ms: result.processing_ms,
                provider: result.provider,
            },
        );
    };
    if use_host {
        return local_host::run(
            plugins,
            selection,
            mode,
            local_host::Input::Live(chunks),
            stop,
            emit_transcript,
        )
        .await;
    }
    #[cfg(any(feature = "asr-whisper", feature = "asr-sherpa"))]
    {
        let notify = |result: taomni_local_voice_engine::LocalTranscript| {
            emit_transcript(Transcript {
                text: result.text,
                final_text: result.final_text,
                processing_ms: result.processing_ms,
                provider: result.provider,
            });
            std::future::ready(Ok(()))
        };
        match mode {
            Mode::Zipformer {
                directory,
                language,
            } => {
                taomni_local_voice_engine::run_zipformer(
                    &selection.models_root,
                    &directory,
                    chunks,
                    language,
                    selection.language,
                    cancel,
                    notify,
                )
                .await
            }
            _ => {
                taomni_local_voice_engine::run_segments(&engine.legacy, chunks, cancel, notify)
                    .await
            }
        }
    }
    #[cfg(not(any(feature = "asr-whisper", feature = "asr-sherpa")))]
    {
        let _ = cancel;
        Err("Local Voice module is unavailable".into())
    }
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
