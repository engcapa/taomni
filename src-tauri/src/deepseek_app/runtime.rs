//! Request lifetime belongs to the application, never to a mounted view.
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use tokio_util::sync::CancellationToken;

struct ActiveRun {
    id: String,
    cancel: CancellationToken,
    reason: Arc<Mutex<&'static str>>,
}

fn runs() -> &'static Mutex<HashMap<String, ActiveRun>> {
    static RUNS: OnceLock<Mutex<HashMap<String, ActiveRun>>> = OnceLock::new();
    RUNS.get_or_init(Mutex::default)
}

pub struct RunGuard {
    thread_id: String,
    id: String,
    pub cancel: CancellationToken,
    reason: Arc<Mutex<&'static str>>,
}

impl RunGuard {
    pub fn begin(thread_id: &str) -> Result<Self, String> {
        let mut registry = runs().lock().map_err(|_| "request registry unavailable")?;
        if registry.contains_key(thread_id) {
            return Err("protocol: this Tao conversation already has an active request".into());
        }
        let id = uuid::Uuid::new_v4().to_string();
        let cancel = CancellationToken::new();
        let reason = Arc::new(Mutex::new("interrupted"));
        registry.insert(
            thread_id.into(),
            ActiveRun {
                id: id.clone(),
                cancel: cancel.clone(),
                reason: reason.clone(),
            },
        );
        Ok(Self {
            thread_id: thread_id.into(),
            id,
            cancel,
            reason,
        })
    }

    pub fn reason(&self) -> &'static str {
        self.reason
            .lock()
            .map(|reason| *reason)
            .unwrap_or("interrupted")
    }
}

impl Drop for RunGuard {
    fn drop(&mut self) {
        if let Ok(mut registry) = runs().lock() {
            if registry
                .get(&self.thread_id)
                .is_some_and(|run| run.id == self.id)
            {
                registry.remove(&self.thread_id);
            }
        }
    }
}

pub fn stop(thread_id: &str) -> Result<(), String> {
    let registry = runs().lock().map_err(|_| "request registry unavailable")?;
    if let Some(run) = registry.get(thread_id) {
        run.cancel.cancel();
    }
    Ok(())
}

pub fn cancel_all() {
    if let Ok(registry) = runs().lock() {
        for run in registry.values() {
            if let Ok(mut reason) = run.reason.lock() {
                *reason = "vault_locked";
            }
            run.cancel.cancel();
        }
    }
}

pub fn is_active(thread_id: &str) -> bool {
    runs()
        .lock()
        .map(|runs| runs.contains_key(thread_id))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_run_per_thread_and_drop_releases_ownership() {
        let thread = uuid::Uuid::new_v4().to_string();
        let first = RunGuard::begin(&thread).unwrap();
        assert!(RunGuard::begin(&thread).is_err());
        stop(&thread).unwrap();
        assert!(first.cancel.is_cancelled());
        drop(first);
        assert!(RunGuard::begin(&thread).is_ok());
    }
}
