//! Supply a recording to an isolated QA profile on runners without a microphone.

use std::{
    io::Read,
    path::Path,
    sync::{Arc, Mutex, mpsc},
};

use super::Capture;

pub(super) fn start(profile: &Path, streaming: bool) -> Result<Option<Capture>, String> {
    if !crate::qa_profile_active() {
        return Ok(None);
    }
    let path = profile.join("qa-local-voice.f32le");
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    let limit = taomni_local_voice_api::MAX_AUDIO_SAMPLES * size_of::<f32>();
    let mut data = Vec::new();
    file.take((limit + 1) as u64)
        .read_to_end(&mut data)
        .map_err(|error| error.to_string())?;
    if data.is_empty() || data.len() > limit || !data.len().is_multiple_of(size_of::<f32>()) {
        return Err("Invalid QA voice recording length".into());
    }
    let samples: Vec<_> = data
        .chunks_exact(size_of::<f32>())
        .map(|value| f32::from_le_bytes(value.try_into().expect("four bytes per sample")))
        .collect();
    if samples.iter().any(|sample| !sample.is_finite()) {
        return Err("Invalid sample in QA voice recording".into());
    }

    let (stop, stopped) = mpsc::channel();
    let (output, result) = tokio::sync::oneshot::channel();
    let (sender, receiver) = tokio::sync::mpsc::channel(32);
    std::thread::Builder::new()
        .name("qa-voice-input".into())
        .spawn(move || {
            if streaming {
                for chunk in samples.chunks(1600) {
                    if sender.blocking_send(chunk.to_vec()).is_err() {
                        return;
                    }
                }
            }
            let _ = stopped.recv();
            drop(sender);
            let _ = output.send(Ok(samples));
        })
        .map_err(|error| error.to_string())?;
    Ok(Some(Capture {
        stop,
        result,
        chunks: Arc::new(Mutex::new(Some(receiver))),
    }))
}
