use serde::Deserialize;
use serde::Serialize;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicU32;
use std::sync::atomic::Ordering;
use std::time::Duration;
use tauri::AppHandle;
use tauri::Emitter;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScrollCaptureResult {
    pub path: String,
    pub width: u32,
    pub height: u32,
    pub frames: u32,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ScrollMode {
    Auto,
    /// Default: manual scrolling needs no input synthesis or permissions.
    #[default]
    Manual,
}

pub struct ScrollControl {
    pub stop: AtomicBool,
    pub cancel: AtomicBool,
    pub frames: AtomicU32,
    pub(super) automatic: AtomicBool,
    pub(super) needs_overlap: AtomicBool,
    pub(super) waiting_for_content: AtomicBool,
    pub(super) input_error: std::sync::Mutex<Option<String>>,
}

impl Default for ScrollControl {
    fn default() -> Self {
        Self::new(ScrollMode::default())
    }
}

impl ScrollControl {
    pub fn new(mode: ScrollMode) -> Self {
        Self {
            stop: AtomicBool::new(false),
            cancel: AtomicBool::new(false),
            frames: AtomicU32::new(0),
            automatic: AtomicBool::new(mode == ScrollMode::Auto),
            needs_overlap: AtomicBool::new(false),
            waiting_for_content: AtomicBool::new(false),
            input_error: std::sync::Mutex::new(None),
        }
    }

    pub fn mode(&self) -> ScrollMode {
        if self.automatic.load(Ordering::SeqCst) {
            ScrollMode::Auto
        } else {
            ScrollMode::Manual
        }
    }

    pub fn set_mode(&self, mode: ScrollMode) {
        self.automatic
            .store(mode == ScrollMode::Auto, Ordering::SeqCst);
    }

    pub(super) fn set_input_error(&self, message: String) {
        *self.input_error.lock().unwrap_or_else(|e| e.into_inner()) = Some(message);
    }

    pub fn status(&self) -> serde_json::Value {
        serde_json::json!({
            "frames": self.frames.load(Ordering::SeqCst),
            "mode": self.mode(),
            "needsOverlap": self.needs_overlap.load(Ordering::SeqCst),
            "waitingForContent": self.waiting_for_content.load(Ordering::SeqCst),
            "inputError": self.input_error.lock().unwrap_or_else(|e| e.into_inner()).clone(),
        })
    }

    pub fn request_stop(&self, cancel: bool) {
        if cancel {
            self.cancel.store(true, Ordering::SeqCst);
        }
        self.stop.store(true, Ordering::SeqCst);
    }

    pub(super) fn settle(&self, duration: Duration) {
        let until = std::time::Instant::now() + duration;
        while !self.stop.load(Ordering::SeqCst) && std::time::Instant::now() < until {
            std::thread::sleep(
                Duration::from_millis(20)
                    .min(until.saturating_duration_since(std::time::Instant::now())),
            );
        }
    }

    pub(super) fn progress(&self, app: &AppHandle, frames: u32) {
        self.frames.store(frames, Ordering::SeqCst);
        let _ = app.emit("screenshot://scroll-progress", self.status());
    }
}
