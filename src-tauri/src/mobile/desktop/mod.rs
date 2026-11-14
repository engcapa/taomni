pub mod browser;
pub mod capture;
#[cfg(test)]
mod tests;
pub mod windows;

pub use browser::{BrowserOpenResult, normalize_browser_url, open_browser};
pub use capture::{DisplaySummary, ScreenCapture, capture_screen};
pub use windows::{
    DesktopWindow, WindowInputRequest, WindowInputResult, list_windows, resolve_window,
    send_window_input,
};

use serde_json::json;
use std::{
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::sync::Notify;

const DESKTOP_POLICY_FILE: &str = "mobile-desktop-remote.json";

#[cfg(test)]
pub trait TestDesktopDriver: Send + Sync {
    fn capture_screen(&self, display_id: Option<&str>) -> Result<ScreenCapture, String>;
    fn list_windows(&self) -> Result<Vec<DesktopWindow>, String>;
    fn send_window_input(
        &self,
        window_id: &str,
        input: &WindowInputRequest,
    ) -> Result<WindowInputResult, String>;
    fn open_browser(&self, url: &url::Url) -> Result<BrowserOpenResult, String>;
}

/// Runtime policy and coordination state for mobile/Feishu desktop viewing and control.
///
/// Screen viewing defaults to `false` (fail-closed) and must be explicitly enabled in Settings.
pub struct DesktopState {
    allow_screen_capture: AtomicBool,
    loaded: Mutex<Option<PathBuf>>,
    pub(super) browser_load_seq: Arc<AtomicU64>,
    pub(super) browser_load_notify: Arc<Notify>,
    #[cfg(test)]
    pub test_driver: Mutex<Option<Arc<dyn TestDesktopDriver>>>,
}

impl Default for DesktopState {
    fn default() -> Self {
        Self {
            allow_screen_capture: AtomicBool::new(false),
            loaded: Mutex::new(None),
            browser_load_seq: Arc::new(AtomicU64::new(0)),
            browser_load_notify: Arc::new(Notify::new()),
            #[cfg(test)]
            test_driver: Mutex::new(None),
        }
    }
}

impl DesktopState {
    pub fn ensure_loaded(&self, data: &Path) {
        let mut loaded = self.loaded.lock().unwrap_or_else(|e| e.into_inner());
        if loaded.as_deref() == Some(data) {
            return;
        }
        let path = data.join(DESKTOP_POLICY_FILE);
        let allowed = std::fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
            .and_then(|value| value["allow_screen_capture"].as_bool())
            .unwrap_or(false);
        self.allow_screen_capture.store(allowed, Ordering::Relaxed);
        *loaded = Some(data.to_path_buf());
    }

    pub fn screen_allowed(&self) -> bool {
        self.allow_screen_capture.load(Ordering::Relaxed)
    }

    pub fn set_screen_allowed(&self, data: &Path, enabled: bool) -> Result<(), String> {
        let path = data.join(DESKTOP_POLICY_FILE);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|_| "mobile_desktop_config_write_failed".to_string())?;
        }
        let raw = serde_json::to_vec_pretty(&json!({ "allow_screen_capture": enabled }))
            .map_err(|_| "mobile_desktop_config_write_failed".to_string())?;
        std::fs::write(&path, raw).map_err(|_| "mobile_desktop_config_write_failed".to_string())?;
        self.allow_screen_capture.store(enabled, Ordering::Relaxed);
        *self.loaded.lock().unwrap_or_else(|e| e.into_inner()) = Some(data.to_path_buf());
        Ok(())
    }

    pub fn mark_browser_loaded(&self) {
        self.browser_load_seq.fetch_add(1, Ordering::SeqCst);
        self.browser_load_notify.notify_waiters();
    }

    pub async fn wait_browser_loaded(&self, prev_seq: u64, timeout: Duration) {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let notified = self.browser_load_notify.notified();
            if self.browser_load_seq.load(Ordering::SeqCst) > prev_seq {
                break;
            }
            if tokio::time::timeout_at(deadline, notified).await.is_err() {
                break;
            }
        }
    }

    #[cfg(test)]
    pub fn set_test_driver(&self, driver: Option<Arc<dyn TestDesktopDriver>>) {
        *self.test_driver.lock().unwrap_or_else(|e| e.into_inner()) = driver;
    }

    #[cfg(test)]
    pub fn test_driver(&self) -> Option<Arc<dyn TestDesktopDriver>> {
        self.test_driver
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }
}

#[cfg(test)]
pub(crate) use windows::validate_window_input;

pub(crate) fn now_unix_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}
