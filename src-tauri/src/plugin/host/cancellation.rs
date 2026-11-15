use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use taomni_plugin_api::RequestId;

/// Separate from the process mutex: a queued or running request can be
/// cancelled while invoke owns the stdio client. Unknown IDs never allocate.
#[derive(Clone, Debug, Default)]
pub struct HostCancellation {
    requests: Arc<Mutex<HashMap<RequestId, bool>>>,
}

impl HostCancellation {
    /// Register before waiting for the process mutex. Calling this again from
    /// invoke preserves an already queued cancellation.
    pub fn register(&self, id: &RequestId) -> bool {
        let mut requests = self
            .requests
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if requests.contains_key(id) {
            return false;
        }
        requests.insert(id.clone(), false);
        true
    }

    pub fn cancel(&self, id: &RequestId) -> bool {
        let mut requests = self
            .requests
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let Some(cancelled) = requests.get_mut(id) else {
            return false;
        };
        *cancelled = true;
        true
    }

    pub fn finish(&self, id: &RequestId) {
        self.requests
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(id);
    }

    pub(super) fn is_cancelled(&self, id: &RequestId) -> bool {
        self.requests
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .get(id)
            .copied()
            .unwrap_or(false)
    }
}

pub(super) struct RequestGuard {
    handle: HostCancellation,
    id: RequestId,
}

impl RequestGuard {
    pub(super) fn new(handle: HostCancellation, id: RequestId) -> Self {
        handle.register(&id);
        Self { handle, id }
    }
}

impl Drop for RequestGuard {
    fn drop(&mut self) {
        self.handle.finish(&self.id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancellation_survives_queueing_and_finishes_without_leaking_ids() {
        let handle = HostCancellation::default();
        let id = RequestId::from("renderer-request");
        assert!(!handle.cancel(&id));
        assert!(handle.register(&id));
        assert!(handle.cancel(&id));
        {
            let _guard = RequestGuard::new(handle.clone(), id.clone());
            assert!(handle.is_cancelled(&id));
        }
        assert!(!handle.cancel(&id));
        assert!(handle.register(&id));
        assert!(!handle.is_cancelled(&id));
    }
}
