use std::{
    future::pending,
    io,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

use taomni_local_voice_api::{MAX_AUDIO_SAMPLES, Mode, Reply, Transcript, read_audio, write_reply};
use taomni_local_voice_engine::{AsrManager, LocalTranscript, run_segments, run_zipformer};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    net::TcpStream,
    sync::mpsc,
    time::timeout,
};

const SESSION_LIMIT: Duration = Duration::from_secs(145);

pub(super) async fn run(
    stream: TcpStream,
    manager: Arc<AsrManager>,
    models_root: PathBuf,
    mode: Mode,
) {
    let (read, mut write) = stream.into_split();
    let (chunks, audio) = mpsc::channel(8);
    let (results, mut replies) = mpsc::channel(16);
    let cancel = Arc::new(AtomicBool::new(false));
    let mut inference = tokio::spawn(infer(
        manager,
        models_root,
        mode,
        audio,
        cancel.clone(),
        results,
    ));
    let _ = timeout(SESSION_LIMIT, async {
        tokio::select! {
            result = input(read, chunks) => result,
            result = async {
                while let Some(transcript) = replies.recv().await {
                    write_reply(&mut write, &Reply::Transcript(transcript)).await?;
                }
                let result = (&mut inference).await.map_err(io::Error::other)?;
                write_reply(&mut write, &Reply::Complete(result)).await
            } => result,
        }
    })
    .await;
    cancel.store(true, Ordering::Relaxed);
    drop((write, replies));
    if !inference.is_finished() {
        let _ = inference.await;
    }
}

async fn input(mut read: impl AsyncRead + Unpin, chunks: mpsc::Sender<Vec<f32>>) -> io::Result<()> {
    let mut samples = 0;
    while let Some(pcm) = read_audio(&mut read).await? {
        samples += pcm.len();
        if samples > MAX_AUDIO_SAMPLES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Local Voice recording exceeds limit",
            ));
        }
        if chunks.send(pcm).await.is_err() {
            // The decoder owns its error. Let the output task deliver it.
            return pending().await;
        }
    }
    drop(chunks);
    // PCM completion is explicit. Any further input or disconnect cancels inference.
    let _ = read.read_u8().await?;
    Err(io::Error::new(
        io::ErrorKind::InvalidData,
        "Unexpected Local Voice audio",
    ))
}

async fn infer(
    manager: Arc<AsrManager>,
    models_root: PathBuf,
    mode: Mode,
    mut audio: mpsc::Receiver<Vec<f32>>,
    cancel: Arc<AtomicBool>,
    replies: mpsc::Sender<Transcript>,
) -> Result<(), String> {
    let send = |value: LocalTranscript| {
        let replies = replies.clone();
        async move {
            replies
                .send(Transcript {
                    text: value.text,
                    final_text: value.final_text,
                    processing_ms: value.processing_ms,
                    provider: value.provider,
                })
                .await
                .map_err(|_| "Cancelled".to_owned())
        }
    };
    match mode {
        Mode::Decode => {
            let mut pcm = Vec::new();
            while let Some(chunk) = audio.recv().await {
                pcm.extend(chunk);
            }
            if cancel.load(Ordering::Relaxed) {
                return Err("Cancelled".into());
            }
            let started = Instant::now();
            let text = manager.transcribe(pcm, cancel).await?;
            send(LocalTranscript {
                text,
                final_text: true,
                processing_ms: started.elapsed().as_millis() as u64,
                provider: manager.model_id.clone(),
            })
            .await
        }
        Mode::FinalSegments => run_segments(&manager, audio, cancel, send).await,
        Mode::Zipformer {
            directory,
            language,
        } => {
            run_zipformer(
                &models_root,
                &directory,
                audio,
                language,
                manager.language().to_owned(),
                cancel,
                send,
            )
            .await
        }
    }
}
