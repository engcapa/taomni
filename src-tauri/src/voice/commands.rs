//! Session IDs isolate cancellation and late results across inputs and windows.
use crate::{asr::manager::AsrManager, state::AppState};
use std::sync::{
    Arc, Mutex, OnceLock,
    atomic::{AtomicBool, Ordering},
};
use tauri::State;
#[derive(serde::Serialize)]
pub struct VoiceTranscriptResult {
    transcript: String,
    audio_duration_ms: u64,
    processing_ms: u64,
}
struct Session {
    id: String,
    cancel: Arc<AtomicBool>,
    finishing: AtomicBool,
    engine: Arc<AsrManager>,
    #[cfg(feature = "voice-capture")]
    capture: Mutex<Option<super::capture::Capture>>,
}
fn current() -> &'static Mutex<Option<Arc<Session>>> {
    static CURRENT: OnceLock<Mutex<Option<Arc<Session>>>> = OnceLock::new();
    CURRENT.get_or_init(|| Mutex::new(None))
}
// IPC cancellation can arrive before the async start command is polled.
// Keep a bounded recent ledger, always accessed while holding current().
fn cancelled_ids() -> &'static Mutex<std::collections::VecDeque<String>> {
    static IDS: OnceLock<Mutex<std::collections::VecDeque<String>>> = OnceLock::new();
    IDS.get_or_init(|| Mutex::new(std::collections::VecDeque::new()))
}
fn take_cancelled(id: &str) -> bool {
    let mut ids = cancelled_ids().lock().unwrap();
    if let Some(index) = ids.iter().position(|value| value == id) {
        ids.remove(index);
        true
    } else {
        false
    }
}
fn remove(id: &str) {
    let mut guard = current().lock().unwrap();
    if guard.as_ref().is_some_and(|s| s.id == id) {
        guard.take();
    }
}
pub fn cancel_all() {
    if let Some(s) = current().lock().unwrap().take() {
        s.cancel.store(true, Ordering::Relaxed);
        #[cfg(feature = "voice-capture")]
        if let Some(c) = s.capture.lock().unwrap().take() {
            let _ = c.stop.send(());
        }
    }
}
#[tauri::command]
pub fn voice_capture_supported() -> bool {
    cfg!(feature = "voice-capture") && AsrManager::supported()
}
#[tauri::command]
pub async fn voice_start_capture(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if !voice_capture_supported() {
        return Err("Voice support not built".into());
    }
    let engine = {
        let ai = state.ai_ctx.read().await;
        if ai.config.fully_disabled {
            return Err("AI is fully disabled".into());
        }
        ai.asr.clone()
    };
    let session = Arc::new(Session {
        id: session_id.clone(),
        finishing: AtomicBool::new(false),
        cancel: Arc::new(AtomicBool::new(false)),
        engine,
        #[cfg(feature = "voice-capture")]
        capture: Mutex::new(None),
    });
    {
        let mut guard = current().lock().unwrap();
        if take_cancelled(&session_id) {
            return Err("Cancelled".into());
        }
        if guard.is_some() {
            return Err("Voice input is busy".into());
        }
        *guard = Some(session.clone());
    }
    let result = async {
        session.engine.prepare().await?;
        if session.cancel.load(Ordering::Relaxed) {
            return Err("Cancelled".into());
        }
        // Recheck the master switch after model loading (it can take seconds).
        {
            let ai = state.ai_ctx.read().await;
            if ai.config.fully_disabled || !Arc::ptr_eq(&ai.asr, &session.engine) {
                return Err("Voice configuration changed".into());
            }
        }
        #[cfg(feature = "voice-capture")]
        {
            let capture = super::capture::start().await?;
            let mut guard = session.capture.lock().unwrap();
            if session.cancel.load(Ordering::Relaxed) {
                let _ = capture.stop.send(());
                return Err("Cancelled".into());
            }
            *guard = Some(capture);
        }
        Ok(())
    }
    .await;
    if result.is_err() {
        remove(&session_id);
    } else {
        // Also expire sessions when their renderer disappears without cleanup.
        let expiry = Arc::downgrade(&session);
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_secs(125)).await;
            if let Some(expiry) = expiry.upgrade() {
                if !expiry.finishing.load(Ordering::SeqCst) {
                    voice_stop_capture(expiry.id.clone());
                }
            }
        });
    }
    result
}
#[tauri::command]
pub fn voice_stop_capture(session_id: String) {
    let mut guard = current().lock().unwrap();
    if guard.as_ref().is_some_and(|s| s.id == session_id) {
        let session = guard.take().unwrap();
        session.cancel.store(true, Ordering::Relaxed);
        #[cfg(feature = "voice-capture")]
        if let Some(capture) = session.capture.lock().unwrap().take() {
            let _ = capture.stop.send(());
        }
    } else {
        let mut ids = cancelled_ids().lock().unwrap();
        if !ids.contains(&session_id) {
            if ids.len() >= 128 {
                ids.pop_front();
            }
            ids.push_back(session_id);
        }
    }
}
#[tauri::command]
pub async fn voice_stop_and_transcribe(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<VoiceTranscriptResult, String> {
    let session = current()
        .lock()
        .unwrap()
        .clone()
        .filter(|s| s.id == session_id)
        .ok_or("Recording expired")?;
    if session.finishing.swap(true, Ordering::SeqCst) {
        return Err("Transcription already running".into());
    }
    let result = async {
        #[cfg(feature = "voice-capture")]
        {
            let capture = session
                .capture
                .lock()
                .unwrap()
                .take()
                .ok_or("Recording is not ready or already stopped")?;
            let _ = capture.stop.send(());
            let pcm = capture.result.await.map_err(|e| e.to_string())??;
            if session.cancel.load(Ordering::Relaxed)
                || state.ai_ctx.read().await.config.fully_disabled
            {
                return Err("Cancelled".into());
            }
            let duration = pcm.len() as u64 * 1000 / 16000;
            let started = std::time::Instant::now();
            let transcript = session
                .engine
                .transcribe(pcm, session.cancel.clone())
                .await?;
            if session.cancel.load(Ordering::Relaxed)
                || state.ai_ctx.read().await.config.fully_disabled
            {
                return Err("Cancelled".into());
            }
            Ok(VoiceTranscriptResult {
                transcript,
                audio_duration_ms: duration,
                processing_ms: started.elapsed().as_millis() as u64,
            })
        }
        #[cfg(not(feature = "voice-capture"))]
        {
            let _ = (session, state);
            Err("Voice support not built".into())
        }
    }
    .await;
    remove(&session_id);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stale_cancel_cannot_stop_another_input_session() {
        let session = Arc::new(Session {
            id: "current-input".into(),
            cancel: Arc::new(AtomicBool::new(false)),
            finishing: AtomicBool::new(false),
            engine: Arc::new(AsrManager::configured("whisper-base", "auto")),
            #[cfg(feature = "voice-capture")]
            capture: Mutex::new(None),
        });
        *current().lock().unwrap() = Some(session.clone());
        voice_stop_capture("old-input".into());
        assert!(!session.cancel.load(Ordering::Relaxed));
        assert!(current().lock().unwrap().is_some());
        voice_stop_capture("current-input".into());
        assert!(session.cancel.load(Ordering::Relaxed));
        assert!(current().lock().unwrap().is_none());
        // A cancel sent before start registration must prevent that late start.
        voice_stop_capture("not-yet-registered".into());
        let _guard = current().lock().unwrap();
        assert!(take_cancelled("not-yet-registered"));
        assert!(!take_cancelled("not-yet-registered"));
        assert!(take_cancelled("old-input"));
    }
}
