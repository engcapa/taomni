//! Reversible mutation barrier, separate from permanent application shutdown.
use super::{PluginError, PluginRegistry};
use std::sync::atomic::Ordering;

/// While held, hosts are stopped and new calls/spawns are rejected. Dropping
/// resumes acceptance only; requests are never replayed or services auto-started.
pub struct QuiescenceGuard {
    registry: PluginRegistry,
}
impl PluginRegistry {
    pub fn quiesce(&self) -> Result<QuiescenceGuard, PluginError> {
        let _lifecycle = self
            .lifecycle
            .lock()
            .expect("plugin lifecycle lock poisoned");
        if self.shutting_down.load(Ordering::Acquire) {
            return Err(PluginError::HostUnavailable(
                "application is shutting down".into(),
            ));
        }
        self.quiescence.fetch_add(1, Ordering::AcqRel);
        self.stop_hosts();
        Ok(QuiescenceGuard {
            registry: self.clone(),
        })
    }
}
impl Drop for QuiescenceGuard {
    fn drop(&mut self) {
        let _lifecycle = self
            .registry
            .lifecycle
            .lock()
            .expect("plugin lifecycle lock poisoned");
        self.registry.quiescence.fetch_sub(1, Ordering::AcqRel);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn nested_or_cancelled_mutations_resume_without_permanent_shutdown() {
        let root = tempfile::tempdir().unwrap();
        let registry = PluginRegistry::new(root.path());
        let first = registry.quiesce().unwrap();
        let second = registry.quiesce().unwrap();
        assert_eq!(registry.quiescence.load(Ordering::Acquire), 2);
        drop(first);
        assert_eq!(registry.quiescence.load(Ordering::Acquire), 1);
        assert!(!registry.shutting_down.load(Ordering::Acquire));
        drop(second);
        assert_eq!(registry.quiescence.load(Ordering::Acquire), 0);
        assert!(registry.quiesce().is_ok());
    }
    #[test]
    fn dropping_a_quiescence_guard_cannot_undo_final_shutdown() {
        let root = tempfile::tempdir().unwrap();
        let registry = PluginRegistry::new(root.path());
        let guard = registry.quiesce().unwrap();
        registry.shutdown();
        drop(guard);
        assert!(registry.shutting_down.load(Ordering::Acquire));
        assert!(registry.quiesce().is_err());
    }
}
