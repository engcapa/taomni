//! A core-owned barrier for the current Vault/MFA snapshot pair. Future plugin
//! stores still require their prepare/snapshot/release protocol.
use super::{PluginRegistry, vault_lifecycle::lock_until};
use std::{sync::atomic::Ordering, time::Instant};
use taomni_plugin_services::AdmissionState;
use taomni_profile_locks::{VaultOperationLease, WaitControl};

impl PluginRegistry {
    /// Inspect ownership only; backup must never start a host to read data.
    /// Called with the lifecycle guard held by with_vault_snapshot.
    pub(crate) fn owns_snapshot_host(&self, slug: &str) -> Result<bool, String> {
        Ok(self
            .hosts
            .lock()
            .map_err(|e| e.to_string())?
            .contains_key(slug))
    }

    /// The callback may lock stores, but must not take another operation
    /// lease or call ordinary Vault APIs. Pending requests wait outside their
    /// store mutexes; completed snapshots do not invalidate renderer epochs.
    pub(crate) fn with_vault_snapshot<T>(
        &self,
        deadline: Instant,
        cancelled: &dyn Fn() -> bool,
        snapshot: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        if cancelled() {
            return Err("REQUEST_CANCELLED".into());
        }
        let services = self
            .services
            .as_ref()
            .ok_or("Vault services are unavailable")?;
        let _transition = lock_until(&services.vault_transition, deadline, "Vault transition")?;
        let _lifecycle = lock_until(&self.lifecycle, deadline, "plugin lifecycle")?;
        if self.shutting_down.load(Ordering::Acquire)
            || self.quiescence.load(Ordering::Acquire) != 0
        {
            return Err("Snapshot is unavailable during application teardown".into());
        }
        let _pause = services
            .admission
            .pause_and_drain(deadline, cancelled)
            .map_err(|e| e.kind().to_string())?;
        let wait = WaitControl::new(deadline, cancelled);
        let _lease =
            VaultOperationLease::write(&services.root, &wait).map_err(|e| e.to_string())?;
        let result = if cancelled() {
            Err("REQUEST_CANCELLED".into())
        } else {
            snapshot()
        };
        if services.admission.state() == AdmissionState::Open
            && !services.vault.cached_root_is_current()?
        {
            // Another core may have rekeyed before exclusive ownership was
            // obtained. Do not let this temporary pause reopen its old root.
            services
                .admission
                .begin_or_join_revoke(&[])
                .map_err(|e| e.kind().to_string())?;
        }
        if cancelled() {
            return Err("REQUEST_CANCELLED".into());
        }
        result
    }
}

#[cfg(test)]
#[path = "snapshot_barrier_tests.rs"]
mod tests;
