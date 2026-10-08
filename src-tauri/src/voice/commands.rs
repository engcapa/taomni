//! Session IDs isolate cancellation and late results across inputs and windows.
use crate::{asr::manager::AsrManager, state::AppState};
use std::sync::{
    Arc, Mutex, OnceLock,
    atomic::{AtomicBool, Ordering},
};
use tauri::State;
use tauri::{AppHandle, Emitter};
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
    streaming: AtomicBool,
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
    cfg!(feature = "voice-capture")
}
#[tauri::command]
pub async fn voice_start_capture(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    voice_start_capture_inner(&session_id, &state, true).await
}

async fn voice_start_capture_inner(
    session_id: &str,
    state: &AppState,
    prepare_engine: bool,
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
        id: session_id.to_string(),
        finishing: AtomicBool::new(false),
        streaming: AtomicBool::new(false),
        cancel: Arc::new(AtomicBool::new(false)),
        engine,
        #[cfg(feature = "voice-capture")]
        capture: Mutex::new(None),
    });
    {
        let mut guard = current().lock().unwrap();
        if take_cancelled(session_id) {
            return Err("Cancelled".into());
        }
        if guard.is_some() {
            return Err("Voice input is busy".into());
        }
        *guard = Some(session.clone());
    }
    let result = async {
        if prepare_engine {
            session.engine.prepare().await?;
        }
        if session.cancel.load(Ordering::Relaxed) {
            return Err("Cancelled".into());
        }
        // Recheck the master switch after model loading (it can take seconds).
        {
            let ai = state.ai_ctx.read().await;
            if ai.config.fully_disabled
                || (prepare_engine && !Arc::ptr_eq(&ai.asr, &session.engine))
            {
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
        remove(session_id);
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

/// Start a true realtime session. Audio chunks are emitted by the capture
/// thread while recording; the selected backend publishes interim/final text
/// through the `voice-transcript` event.
#[tauri::command]
pub async fn voice_start_stream(
    session_id: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    voice_start_capture_inner(&session_id, &state, false).await?;
    let session = current()
        .lock()
        .unwrap()
        .clone()
        .filter(|s| s.id == session_id)
        .ok_or("Recording expired")?;
    let (active, language, full_local_mode) = {
        let ai = state.ai_ctx.read().await;
        (
            ai.config.asr.active.clone(),
            ai.config.asr.language.clone(),
            ai.config.full_local_mode,
        )
    };
    if full_local_mode && ["aliyun", "deepgram", "gemini"].contains(&active.as_str()) {
        voice_stop_capture(session_id);
        return Err(
            "FULL_LOCAL_MODE: online ASR is disabled while full local mode is enabled".into(),
        );
    }
    let provider_config = {
        state
            .ai_ctx
            .read()
            .await
            .config
            .asr
            .providers
            .get(&active)
            .cloned()
    };
    let vault = state.vault.clone();
    let (proxy, proxy_error) = provider_config
        .as_ref()
        .map_or((None, None), |config| match config.proxy_mode.as_str() {
            "app" => match crate::proxy::resolve_default(&state) {
                Ok(proxy) => (proxy, None),
                Err(error) => (None, Some(format!("ASR_PROXY: {error}"))),
            },
            "custom" => match parse_asr_proxy_url(&config.proxy_url) {
                Ok(proxy) => (proxy, None),
                Err(error) => (None, Some(error)),
            },
            "none" | "" => (None, None),
            _ => (None, Some("ASR_PROXY: unknown ASR proxy mode".into())),
        });
    if let Some(error) = proxy_error {
        voice_stop_capture(session_id);
        return Err(error);
    }
    let chunks = session
        .capture
        .lock()
        .unwrap()
        .as_ref()
        .and_then(|capture| capture.chunks.lock().unwrap().take())
        .ok_or("Recording stream is not ready")?;
    session.streaming.store(true, Ordering::SeqCst);
    tokio::spawn(async move {
        let result = match active.as_str() {
            "sherpa-zipformer-zh-en" => {
                crate::voice::streaming::run_local(
                    app.clone(),
                    session_id.clone(),
                    chunks,
                    language,
                )
                .await
            }
            "aliyun" | "deepgram" | "gemini" => {
                if let Some(config) = provider_config {
                    let key_result = if config.api_key.starts_with(crate::vault::VAULT_REF_PREFIX) {
                        match vault.resolve(&config.api_key) {
                            Ok(Some(value)) => Ok((*value).clone()),
                            Ok(None) => Ok(String::new()),
                            Err(e) => Err(e.to_string()),
                        }
                    } else {
                        Ok(config.api_key.clone())
                    };
                    match key_result {
                        Ok(key) => {
                            crate::voice::streaming::run_online(
                                app.clone(),
                                session_id.clone(),
                                chunks,
                                active,
                                config.model,
                                config.endpoint,
                                key,
                                language,
                                proxy,
                            )
                            .await
                        }
                        Err(error) => Err(error),
                    }
                } else {
                    Err("ASR_PROVIDER_MISSING: configure the selected realtime provider".into())
                }
            }
            provider => Err(format!("STREAMING_PROVIDER_UNAVAILABLE: {provider}")),
        };
        if let Err(error) = result {
            let _ = app.emit(
                "voice-transcript-error",
                serde_json::json!({"session_id": session_id, "error": error}),
            );
        }
    });
    Ok(())
}

fn parse_asr_proxy_url(value: &str) -> Result<Option<crate::proxy::ResolvedProxy>, String> {
    let url =
        url::Url::parse(value.trim()).map_err(|_| "ASR_PROXY: invalid proxy URL".to_string())?;
    let kind = match url.scheme() {
        "http" => "http",
        "socks5" | "socks5h" => "socks5",
        _ => return Err("ASR_PROXY: proxy must use http:// or socks5://".into()),
    };
    let host = url.host_str().ok_or("ASR_PROXY: proxy host is missing")?;
    let port = url.port().ok_or("ASR_PROXY: proxy port is missing")?;
    Ok(Some(crate::proxy::ResolvedProxy {
        kind: kind.into(),
        host: host.into(),
        port,
        username: url.username().to_string(),
        password: url.password().unwrap_or_default().to_string(),
    }))
}

#[tauri::command]
pub fn voice_stop_stream(session_id: String) {
    voice_stop_capture(session_id);
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
            streaming: AtomicBool::new(false),
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

    #[test]
    fn asr_proxy_url_requires_supported_explicit_route() {
        let proxy = parse_asr_proxy_url("http://user:pass@10.1.0.80:3228")
            .unwrap()
            .unwrap();
        assert_eq!(proxy.kind, "http");
        assert_eq!(proxy.host, "10.1.0.80");
        assert_eq!(proxy.port, 3228);
        assert_eq!(proxy.username, "user");
        assert_eq!(proxy.password, "pass");
        assert!(parse_asr_proxy_url("https://proxy.example").is_err());
    }
}
