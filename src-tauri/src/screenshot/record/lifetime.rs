use super::capture::capture_loop;
use super::encoding::encode_loop;
use super::frames::FRAME_QUEUE;
use super::frames::TimedFrame;
use super::model::RecordFormat;
use super::model::RecordingInfo;
use crate::screenshot::capture::DisplayInfo;
use crate::screenshot::capture::temp_artifact_path;
use anyhow::Context;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::OnceLock;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::sync::mpsc::sync_channel;
use std::thread;
use std::thread::JoinHandle;
use std::time::Duration;
use tauri::AppHandle;
use tauri::Emitter;

/// Event emitted when a recording ends on its own (time limit or failure).
pub const RECORDING_ENDED_EVENT: &str = "screenshot://recording-ended";

pub(super) struct Session {
    pub(super) stop: Arc<AtomicBool>,
    pub(super) capture: Option<JoinHandle<anyhow::Result<()>>>,
    pub(super) encoder: Option<JoinHandle<anyhow::Result<RecordingInfo>>>,
    pub(super) output_path: PathBuf,
    pub(super) _lease: RecordingLease,
}

// Stop, renderer failure and preview closure can race. Share one finalization
// result; only the registry owner may cancel/delete the artifact.
pub(in crate::screenshot) struct Recording {
    pub(super) stop: Arc<AtomicBool>,
    pub(super) output_path: PathBuf,
    pub(super) finished: AtomicBool,
    pub(super) inner: Mutex<(Option<Session>, Option<Result<RecordingInfo, String>>)>,
}

impl From<Session> for Recording {
    fn from(session: Session) -> Self {
        Self {
            stop: session.stop.clone(),
            output_path: session.output_path.clone(),
            finished: AtomicBool::new(false),
            inner: Mutex::new((Some(session), None)),
        }
    }
}

impl Recording {
    pub(in crate::screenshot) fn finish(&self) -> anyhow::Result<RecordingInfo> {
        self.stop.store(true, Ordering::SeqCst);
        let mut inner = self.inner.lock().unwrap();
        if let Some(session) = inner.0.take() {
            inner.1 = Some(finish_session(session).map_err(|error| format!("{error:#}")));
            self.finished.store(true, Ordering::Release);
        }
        inner
            .1
            .as_ref()
            .expect("recording finalized")
            .clone()
            .map_err(anyhow::Error::msg)
    }
}

// Includes startup and timed-out startup cleanup, not just inserted sessions.
pub(super) static RECORDING_ACTIVE: AtomicBool = AtomicBool::new(false);

pub(super) struct RecordingLease;

impl RecordingLease {
    pub(super) fn acquire() -> anyhow::Result<Self> {
        RECORDING_ACTIVE
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .map_err(|_| anyhow::anyhow!("another screen recording is already active"))?;
        Ok(Self)
    }
}

impl Drop for RecordingLease {
    fn drop(&mut self) {
        RECORDING_ACTIVE.store(false, Ordering::SeqCst);
    }
}

pub(super) static SESSIONS: OnceLock<Mutex<HashMap<String, Arc<Recording>>>> = OnceLock::new();

pub(super) fn sessions() -> &'static Mutex<HashMap<String, Arc<Recording>>> {
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The screenshot hotkey also finishes a running clip when controls are hidden.
pub fn request_stop(id: &str) -> anyhow::Result<()> {
    let sessions = sessions().lock().unwrap();
    let session = sessions
        .get(id)
        .ok_or_else(|| anyhow::anyhow!("unknown recording id"))?;
    session.stop.store(true, Ordering::SeqCst);
    Ok(())
}

pub fn recording_status(id: &str) -> (bool, bool) {
    sessions()
        .lock()
        .unwrap()
        .get(id)
        .map(|session| {
            (
                session.finished.load(Ordering::Acquire)
                    || session.inner.try_lock().ok().is_some_and(|inner| {
                        inner.0.as_ref().is_none_or(|session| {
                            session
                                .capture
                                .as_ref()
                                .is_none_or(|thread| thread.is_finished())
                        })
                    }),
                session.stop.load(Ordering::SeqCst),
            )
        })
        .unwrap_or((true, false))
}

/// Start a recording of `region` (display-relative physical pixels, `None`
/// = whole display). Returns the recording id once the capture backend is
/// ready, so backend failures surface to the caller.
pub fn start_recording(
    app: &AppHandle,
    display: DisplayInfo,
    region: Option<(u32, u32, u32, u32)>,
    format: RecordFormat,
    fps: Option<u32>,
) -> anyhow::Result<String> {
    let fps = fps.unwrap_or_else(|| format.default_fps()).clamp(1, 30);
    let region = region.unwrap_or((0, 0, display.width, display.height));
    let region = super::super::capture::clamp_region(display.width, display.height, region);
    if region.2 < 2 || region.3 < 2 {
        anyhow::bail!("recording region must be at least 2x2 pixels");
    }
    let lease = RecordingLease::acquire()?;
    let id = format!("rec-{}", nano_id());
    let output_path = temp_artifact_path("rec", format.extension())?;
    let stop = Arc::new(AtomicBool::new(false));
    let (tx, rx) = sync_channel::<TimedFrame>(FRAME_QUEUE);
    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<anyhow::Result<()>>();

    let encoder = {
        let path = output_path.clone();
        thread::Builder::new()
            .name("screenshot-record-encode".into())
            .spawn(move || encode_loop(rx, format, fps, &path))
            .context("spawn encoder thread")?
    };
    let capture = {
        let app = app.clone();
        let stop = stop.clone();
        let id = id.clone();
        thread::Builder::new()
            .name("screenshot-record-capture".into())
            .spawn(move || {
                let result = capture_loop(&app, display, region, format, fps, &stop, tx, ready_tx);
                super::super::recording_ended(&app, &id);
                let _ = app.emit(
                    RECORDING_ENDED_EVENT,
                    serde_json::json!({
                        "recordingId": id,
                        "error": result.as_ref().err().map(|e| format!("{e:#}")),
                        "stoppedByUser": stop.load(Ordering::SeqCst),
                    }),
                );
                result
            })
    };
    let capture = match capture {
        Ok(capture) => capture,
        Err(e) => {
            // A failed spawn drops the sender, allowing the encoder to exit.
            let _ = encoder.join();
            std::fs::remove_file(&output_path).ok();
            return Err(e).context("spawn capture thread");
        }
    };

    match ready_rx.recv_timeout(Duration::from_secs(15)) {
        Ok(Ok(())) => {}
        Ok(Err(e)) => {
            stop.store(true, Ordering::SeqCst);
            let _ = capture.join();
            let _ = encoder.join();
            std::fs::remove_file(&output_path).ok();
            return Err(e);
        }
        Err(_) => {
            stop.store(true, Ordering::SeqCst);
            // A platform capture API may still be blocked. Reap it without
            // blocking the UI and keep the lease until both threads exit.
            thread::spawn(move || {
                let _lease = lease;
                let _ = capture.join();
                let _ = encoder.join();
                std::fs::remove_file(output_path).ok();
            });
            anyhow::bail!("screen capture did not start within 15 s");
        }
    }

    let mut sessions = sessions().lock().unwrap();
    // Keep the latest completed clip for a preview-renderer failure, not a
    // growing history of recordings. The recording lease bounds active work.
    sessions.retain(|_, session| !session.finished.load(Ordering::Acquire));
    sessions.insert(
        id.clone(),
        Arc::new(Recording::from(Session {
            stop,
            capture: Some(capture),
            encoder: Some(encoder),
            output_path,
            _lease: lease,
        })),
    );
    Ok(id)
}

pub(crate) fn output_path(recording_id: &str) -> Option<PathBuf> {
    sessions()
        .lock()
        .unwrap()
        .get(recording_id)
        .map(|s| s.output_path.clone())
}

/// Stop a recording and finalize the file.
pub fn stop_recording(recording_id: &str) -> anyhow::Result<RecordingInfo> {
    let recording = sessions()
        .lock()
        .unwrap()
        .get(recording_id)
        .cloned()
        .context("unknown recording id")?;
    recording.finish()
}

/// Called while the screenshot owner lock is held, before close can purge its
/// temp files. Taking ownership also excludes cancel_all during app exit.
pub(in crate::screenshot) fn take_for_recovery(recording_id: &str) -> Option<Arc<Recording>> {
    let recording = sessions().lock().unwrap().remove(recording_id)?;
    recording.stop.store(true, Ordering::SeqCst);
    super::super::capture::untrack_artifact(&recording.output_path);
    Some(recording)
}

pub(super) fn finish_session(mut session: Session) -> anyhow::Result<RecordingInfo> {
    session.stop.store(true, Ordering::SeqCst);
    let capture_result = session.capture.take().map(|h| {
        h.join()
            .unwrap_or_else(|_| Err(anyhow::anyhow!("capture thread panicked")))
    });
    let info = session
        .encoder
        .take()
        .context("recording already stopped")?
        .join()
        .unwrap_or_else(|_| Err(anyhow::anyhow!("encoder thread panicked")));
    match (capture_result, info) {
        (Some(Err(capture_error)), _) => {
            std::fs::remove_file(&session.output_path).ok();
            Err(capture_error)
        }
        (_, Ok(info)) => Ok(info),
        (_, Err(e)) => {
            std::fs::remove_file(&session.output_path).ok();
            Err(e)
        }
    }
}

/// Stop a recording and delete the partial file.
pub fn cancel_recording(recording_id: &str) -> anyhow::Result<()> {
    let recording = sessions()
        .lock()
        .unwrap()
        .remove(recording_id)
        .context("unknown recording id")?;
    let _ = recording.finish();
    std::fs::remove_file(&recording.output_path).ok();
    Ok(())
}

/// Stop every recording (app exit / overlay teardown).
pub fn cancel_all() {
    let ids: Vec<String> = sessions().lock().unwrap().keys().cloned().collect();
    for id in ids {
        let _ = cancel_recording(&id);
    }
}

pub(super) fn nano_id() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}
