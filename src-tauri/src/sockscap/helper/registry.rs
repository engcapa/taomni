use crate::state::AppState;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::State;

#[derive(Debug, Clone)]
pub struct HelperSession {
    pub token: String,
    pub port: u16,
    pub pid: Option<u32>,
    pub(super) ready_file: PathBuf,
}

impl HelperSession {
    /// Remove the ready file advertising this helper. Idempotent, best effort.
    ///
    /// Must run on every path that abandons a session: a ready file left behind
    /// points at a helper that is dead (or wedged), and boot repair would treat
    /// it as a live orphan.
    pub fn remove_ready_file(&self) {
        let _ = std::fs::remove_file(&self.ready_file);
    }
}

/// In-process registry of the active helper session (if any).
pub struct HelperRegistry {
    pub(crate) inner: Mutex<Option<HelperSession>>,
}

impl HelperRegistry {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(None),
        }
    }
}

impl Default for HelperRegistry {
    fn default() -> Self {
        Self::new()
    }
}

/// Forget a session: clear the registry slot (only if it is still *this*
/// session) and delete its ready file, so neither a retry nor boot repair can
/// rediscover a helper we have given up on.
pub(super) fn discard_helper_session(state: &State<'_, AppState>, sess: &HelperSession) {
    if let Ok(mut guard) = state.sockscap.helper.inner.lock() {
        if guard.as_ref().map(|s| s.port) == Some(sess.port) {
            *guard = None;
        }
    }
    sess.remove_ready_file();
}
