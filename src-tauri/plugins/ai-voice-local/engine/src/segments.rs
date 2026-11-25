use std::{
    future::Future,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Instant,
};

use tokio::sync::mpsc;

use crate::{AsrManager, LocalTranscript};

pub async fn run_segments<Emit>(
    engine: &AsrManager,
    mut chunks: mpsc::Receiver<Vec<f32>>,
    cancel: Arc<AtomicBool>,
    mut send: impl FnMut(LocalTranscript) -> Emit + Send,
) -> Result<(), String>
where
    Emit: Future<Output = Result<(), String>> + Send,
{
    engine.prepare().await?;
    let mut utterance = Vec::new();
    let mut silence = 0;
    while let Some(chunk) = chunks.recv().await {
        let quiet =
            chunk.iter().map(|s| s * s).sum::<f32>() / (chunk.len().max(1) as f32) < 0.00001;
        silence = if quiet { silence + chunk.len() } else { 0 };
        utterance.extend(chunk);
        if (silence >= 12800 && utterance.len() >= 16000) || utterance.len() >= 20 * 16000 {
            if let Some(transcript) =
                segment(engine, std::mem::take(&mut utterance), cancel.clone()).await?
            {
                send(transcript).await?;
            }
            silence = 0;
        }
    }
    if !utterance.is_empty()
        && let Some(transcript) = segment(engine, utterance, cancel).await?
    {
        send(transcript).await?;
    }
    Ok(())
}

async fn segment(
    engine: &AsrManager,
    pcm: Vec<f32>,
    cancel: Arc<AtomicBool>,
) -> Result<Option<LocalTranscript>, String> {
    if cancel.load(Ordering::Relaxed) {
        return Err("Cancelled".into());
    }
    let start = Instant::now();
    match engine.transcribe(pcm, cancel).await {
        Ok(text) => Ok(Some(LocalTranscript {
            text,
            final_text: true,
            processing_ms: start.elapsed().as_millis() as u64,
            provider: engine.model_id.clone(),
        })),
        Err(error) if error.starts_with("NO_SPEECH") => Ok(None),
        Err(error) => Err(error),
    }
}
