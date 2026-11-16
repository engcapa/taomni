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
    fn registry_with_enabled_metadata(root: &std::path::Path) -> PluginRegistry {
        let registry = PluginRegistry::new(root);
        let manifest = serde_json::from_value(serde_json::json!({
            "id":"taomni-plugin-mfa", "slug":"mfa", "name":"MFA", "version":"1.0.0",
            "coreApiVersion":"1", "kind":"auth", "status":"stable", "removalCandidate":false,
            "platforms":[super::super::current_platform()],
            "entry":{"host":"must-never-be-spawned", "protocol":1},
            "tabs":[], "commands":["ping"], "permissions":[], "dataDir":"plugins/mfa",
            "backupPaths":[], "legacyTables":[], "vaultFixedKeys":[], "snapshot":"file"
        }))
        .unwrap();
        registry.records.write().unwrap().insert(
            "mfa".into(),
            super::super::PluginRecord {
                manifest,
                state: super::super::LifecycleState::Enabled,
                reason: None,
            },
        );
        registry
    }

    #[test]
    fn quiescence_rejects_declared_calls_without_spawning_or_disabling_the_module() {
        let root = tempfile::tempdir().unwrap();
        let registry = registry_with_enabled_metadata(root.path());
        let first = registry.quiesce().unwrap();
        let second = registry.quiesce().unwrap();
        for guard in [first, second] {
            assert!(matches!(
                registry.invoke("mfa", "ping", serde_json::Value::Null),
                Err(PluginError::HostUnavailable(_))
            ));
            assert!(registry.hosts.lock().unwrap().is_empty());
            assert!(registry.pending_requests.lock().unwrap().is_empty());
            drop(guard);
        }
        // Caller cancellation leaves metadata enabled and accepts fresh calls
        // into the normal allowlist; it does not replay the cancelled operation.
        assert_eq!(
            registry.get("mfa").unwrap().state,
            super::super::LifecycleState::Enabled
        );
        assert!(matches!(
            registry.invoke("mfa", "unknown", serde_json::Value::Null),
            Err(PluginError::CommandDenied { .. })
        ));
        assert!(registry.hosts.lock().unwrap().is_empty());
    }

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
