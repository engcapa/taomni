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
    stop_task: tokio_util::sync::CancellationToken,
    completed: tokio::sync::watch::Sender<Option<Result<(), String>>>,
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
        s.stop_task.cancel();
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
        stop_task: tokio_util::sync::CancellationToken::new(),
        completed: tokio::sync::watch::channel(None).0,
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
            let capture = super::capture::start(!prepare_engine).await?;
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
    // Resolve one configuration snapshot before acquiring the microphone.
    let (active, language, provider_config, full_local_mode, disabled) = {
        let ai = state.ai_ctx.read().await;
        let asr = &ai.config.asr;
        (
            asr.active.clone(),
            asr.routed_language().to_owned(),
            asr.providers.get(&asr.active).cloned(),
            ai.config.full_local_mode,
            ai.config.fully_disabled,
        )
    };
    if disabled {
        return Err("AI is fully disabled".into());
    }
    let online = ["aliyun", "deepgram", "gemini"].contains(&active.as_str());
    if full_local_mode && online {
        return Err(
            "FULL_LOCAL_MODE: online ASR is disabled while full local mode is enabled".into(),
        );
    }
    let (proxy, key) = if online {
        let config = provider_config
            .as_ref()
            .ok_or("ASR_PROVIDER_MISSING: configure the selected realtime provider")?;
        let proxy = match config.proxy_mode.as_str() {
            "app" => {
                crate::proxy::resolve_default(&state).map_err(|e| format!("ASR_PROXY: {e}"))?
            }
            "custom" => parse_asr_proxy_url(&config.proxy_url)?,
            "none" | "" => None,
            _ => return Err("ASR_PROXY: unknown ASR proxy mode".into()),
        };
        let key = if config.api_key.starts_with(crate::vault::VAULT_REF_PREFIX) {
            state
                .vault
                .resolve(&config.api_key)
                .map_err(|_| "ASR_CREDENTIAL: unlock the credential vault")?
                .map(|v| (*v).clone())
                .unwrap_or_default()
        } else {
            config.api_key.clone()
        };
        if key.trim().is_empty() {
            return Err("ASR_KEY_MISSING: configure the provider API key".into());
        }
        (proxy, key)
    } else {
        (None, String::new())
    };
    voice_start_capture_inner(&session_id, &state, false).await?;
    let session = current()
        .lock()
        .unwrap()
        .clone()
        .filter(|s| s.id == session_id)
        .ok_or("ASR_CANCELLED: recording expired")?;
    {
        let ai = state.ai_ctx.read().await;
        if ai.config.asr.active != active
            || ai.config.asr.routed_language() != language
            || ai.config.asr.providers.get(&active) != provider_config.as_ref()
            || ai.config.fully_disabled
            || ai.config.full_local_mode != full_local_mode
        {
            voice_stop_capture(session_id);
            return Err("ASR_CONFIG_CHANGED: voice configuration changed".into());
        }
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
        let backend = async {
            match active.as_str() {
                "local-auto" | "sensevoice-small" => {
                    crate::voice::streaming::run_routed_local(
                        app.clone(),
                        session_id.clone(),
                        chunks,
                        language,
                        session.engine.clone(),
                        session.cancel.clone(),
                    )
                    .await
                }
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
                    let config = provider_config.ok_or("ASR_PROVIDER_MISSING")?;
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
                provider => Err(format!("ASR_PROVIDER_UNAVAILABLE: {provider}")),
            }
        };
        let result = tokio::select! {
            biased;
            _ = session.stop_task.cancelled() => Err("ASR_CANCELLED".into()),
            result = tokio::time::timeout(std::time::Duration::from_secs(130), backend) =>
                result.unwrap_or_else(|_| Err("ASR_TIMEOUT: dictation exceeded its time limit".into())),
        };
        // Dropping the backend closes its socket. Also release the microphone
        // when the provider ends or fails without a renderer stop command.
        if let Some(capture) = session.capture.lock().unwrap().take() {
            let _ = capture.stop.send(());
        }
        session.completed.send_replace(Some(result.clone()));
        if let Err(error) = result {
            if session.stop_task.is_cancelled() {
                return;
            }
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
pub async fn voice_stop_stream(session_id: String) -> Result<(), String> {
    let session = current()
        .lock()
        .unwrap()
        .clone()
        .filter(|s| s.id == session_id)
        .ok_or("ASR_CANCELLED: recording expired")?;
    session.finishing.store(true, Ordering::SeqCst);
    let mut completed = session.completed.subscribe();
    if let Some(capture) = session.capture.lock().unwrap().take() {
        let _ = capture.stop.send(());
    }
    let result = tokio::time::timeout(std::time::Duration::from_secs(15), async {
        loop {
            if let Some(result) = completed.borrow().clone() {
                return result;
            }
            completed
                .changed()
                .await
                .map_err(|_| "ASR_SESSION_CLOSED".to_string())?;
        }
    })
    .await
    .unwrap_or_else(|_| {
        session.stop_task.cancel();
        Err("ASR_FINAL_TIMEOUT: the provider did not finish within 15 seconds".into())
    });
    remove(&session_id);
    result
}
#[tauri::command]
pub fn voice_stop_capture(session_id: String) {
    let mut guard = current().lock().unwrap();
    if guard.as_ref().is_some_and(|s| s.id == session_id) {
        let session = guard.take().unwrap();
        session.cancel.store(true, Ordering::Relaxed);
        session.stop_task.cancel();
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
            stop_task: tokio_util::sync::CancellationToken::new(),
            completed: tokio::sync::watch::channel(None).0,
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
