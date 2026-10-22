use serde::Serialize;
use tauri::AppHandle;
use tauri::Emitter;

#[derive(Clone, Debug, Serialize)]
pub struct TranscriptEvent {
    pub session_id: String,
    pub text: String,
    pub final_text: bool,
    pub processing_ms: u64,
    pub provider: String,
}

pub(super) fn pcm16(chunk: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(chunk.len() * 2);
    for sample in chunk {
        out.extend_from_slice(&((*sample * 32767.0).clamp(-32768.0, 32767.0) as i16).to_le_bytes());
    }
    out
}

pub type TranscriptSink = std::sync::Arc<dyn Fn(TranscriptEvent) + Send + Sync>;
pub fn event_sink(app: AppHandle) -> TranscriptSink {
    std::sync::Arc::new(move |event| {
        let _ = app.emit("voice-transcript", event);
    })
}
pub(super) fn emit(sink: &TranscriptSink, event: TranscriptEvent) {
    sink(event);
}
