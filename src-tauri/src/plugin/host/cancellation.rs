use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use taomni_plugin_api::RequestId;

/// Separate from the process mutex: a queued or running request can be
/// cancelled while invoke owns the stdio client. Unknown IDs never allocate.
#[derive(Clone, Debug, Default)]
pub struct HostCancellation {
    requests: Arc<Mutex<HashMap<RequestId, Arc<AtomicBool>>>>,
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
        requests.insert(id.clone(), Arc::new(AtomicBool::new(false)));
        true
    }

    /// The stable caller ID and the sequenced wire ID share one cancellation
    /// flag. Linking is atomic with queued cancellation and never overwrites
    /// another request. Both IDs are released by their own RequestGuard.
    pub(super) fn link(&self, owner: &RequestId, alias: &RequestId) -> bool {
        let mut requests = self
            .requests
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if requests.contains_key(alias) {
            return false;
        }
        let Some(flag) = requests.get(owner).cloned() else {
            return false;
        };
        requests.insert(alias.clone(), flag);
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
        cancelled.store(true, Ordering::Release);
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
            .map(|flag| flag.load(Ordering::Acquire))
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

    #[test]
    fn linked_wire_cancellation_preserves_queued_and_running_ownership() {
        for cancel_before_link in [false, true] {
            let handle = HostCancellation::default();
            let caller = RequestId::from("core/host/operation-uuid");
            let wire = RequestId::from("core/host/123");
            let caller_guard = RequestGuard::new(handle.clone(), caller.clone());
            if cancel_before_link {
                assert!(handle.cancel(&caller));
            }
            assert!(handle.link(&caller, &wire));
            let guard = RequestGuard::new(handle.clone(), wire.clone());
            if !cancel_before_link {
                assert!(handle.cancel(&caller));
            }
            assert!(handle.is_cancelled(&wire));
            assert!(handle.is_cancelled(&caller));
            drop(guard);
            assert!(!handle.cancel(&wire));
            assert!(handle.is_cancelled(&caller));
            drop(caller_guard);
            assert!(!handle.cancel(&caller));
            assert!(handle.requests.lock().unwrap().is_empty());
        }
    }

    #[test]
    fn linking_never_allocates_an_unknown_owner_or_overwrites_another_request() {
        let handle = HostCancellation::default();
        let caller = RequestId::from("caller");
        let other = RequestId::from("other");
        assert!(!handle.link(&caller, &other));
        let _caller = RequestGuard::new(handle.clone(), caller.clone());
        let _other = RequestGuard::new(handle.clone(), other.clone());
        assert!(!handle.link(&caller, &other));
        assert!(handle.cancel(&caller));
        assert!(!handle.is_cancelled(&other));
    }
}
