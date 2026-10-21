use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;

#[derive(Default)]
pub struct StructuralSearchState {
    pub(super) requests: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
}

impl StructuralSearchState {
    pub fn active_request_count(&self) -> usize {
        self.requests.lock().map(|active| active.len()).unwrap_or(0)
    }
}

/// Removes the request's cancel flag when the search finishes, fails or panics,
/// so `active_requests` returns to zero (ED-PARITY-009-A3 resource release).
pub(super) struct ActiveRequestGuard {
    pub(super) requests: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    pub(super) request_id: String,
}

impl Drop for ActiveRequestGuard {
    fn drop(&mut self) {
        if let Ok(mut active) = self.requests.lock() {
            active.remove(&self.request_id);
        }
    }
}
