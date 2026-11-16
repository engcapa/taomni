//! A job guard owns the authenticated host's barrier until the Vault copy is
//! complete. Failure/Drop either releases it or confirms process containment.
use super::{LifecycleState, PluginRegistry, SnapshotMode, runtime::RuntimeHost};
use std::{
    sync::{Arc, MutexGuard, TryLockError},
    time::{Duration, Instant},
};
use taomni_plugin_api::services::*;

#[derive(Debug)]
pub(crate) struct HostSnapshot {
    runtime: Arc<RuntimeHost>,
    prepared: PreparedSnapshot,
    staging: StagingToken,
    released: bool,
}

impl PluginRegistry {
    /// Called only under the registry lifecycle and Vault snapshot barriers.
    /// Looking up a host here never starts one, changes enabled state or grants
    /// a renderer authority to choose the destination.
    pub(crate) fn prepare_data_snapshot(
        &self,
        slug: &str,
        request: PrepareSnapshot,
        deadline: Instant,
        cancelled: &(dyn Fn() -> bool + Sync),
    ) -> Result<HostSnapshot, String> {
        let record = self.get(slug).ok_or("Snapshot owner disappeared")?;
        let runtime = self
            .hosts
            .lock()
            .map_err(|e| e.to_string())?
            .get(slug)
            .cloned()
            .ok_or("Snapshot host disappeared")?;
        if record.reason.is_some()
            || record.state != LifecycleState::Enabled
            || record.manifest.snapshot != SnapshotMode::Rpc
            || record.manifest != runtime.manifest
            || self.active_directory(slug).map_err(|e| e.to_string())? != runtime.directory
        {
            return Err(format!(
                "Plugin {slug} does not support authenticated running snapshots"
            ));
        }
        for path in &request.destination.allowed_files {
            let absolute = format!("plugins/{slug}/data/{}", path.as_str());
            if !record
                .manifest
                .backup_paths
                .iter()
                .any(|allowed| absolute == *allowed || absolute.starts_with(&format!("{allowed}/")))
            {
                return Err("Plugin snapshot data is outside its signed backup contract".into());
            }
        }
        let prepared = {
            let mut process = lock_process(&runtime, deadline, cancelled)?;
            match process.prepare_snapshot(&request, deadline, cancelled) {
                Ok(prepared) => prepared,
                Err(error) => {
                    process.abort_snapshot(cleanup_deadline()).map_err(|cleanup|
                        format!("Snapshot prepare failed: {error}; containment unconfirmed: {cleanup}"))?;
                    return Err(error.to_string());
                }
            }
        };
        Ok(HostSnapshot {
            runtime,
            prepared,
            staging: request.destination.token,
            released: false,
        })
    }
}

impl HostSnapshot {
    pub(crate) fn export(
        &self,
        deadline: Instant,
        cancelled: &(dyn Fn() -> bool + Sync),
    ) -> Result<SnapshotResult, String> {
        lock_process(&self.runtime, deadline, cancelled)?
            .snapshot(&self.prepared, self.staging.clone(), deadline, cancelled)
            .map_err(|e| e.to_string())
    }

    pub(crate) fn release(mut self) -> Result<(), String> {
        self.cleanup()
    }

    fn cleanup(&mut self) -> Result<(), String> {
        if self.released {
            return Ok(());
        }
        let mut process = lock_process(&self.runtime, cleanup_deadline(), &|| false)?;
        let result = process.release_snapshot(&self.prepared, cleanup_deadline());
        if let Err(error) = result {
            process
                .abort_snapshot(cleanup_deadline())
                .map_err(|cleanup| {
                    format!("Snapshot release failed: {error}; containment unconfirmed: {cleanup}")
                })?;
            self.released = true;
            return Err(format!("Snapshot release failed; host contained: {error}"));
        }
        self.released = true;
        Ok(())
    }
}

impl Drop for HostSnapshot {
    fn drop(&mut self) {
        if let Err(error) = self.cleanup() {
            log::warn!("plugin snapshot cleanup: {error}");
        }
    }
}

fn lock_process<'a>(
    runtime: &'a RuntimeHost,
    deadline: Instant,
    cancelled: &dyn Fn() -> bool,
) -> Result<MutexGuard<'a, super::host::HostProcess>, String> {
    loop {
        if cancelled() {
            return Err("BACKUP_CANCELLED".into());
        }
        if Instant::now() >= deadline {
            return Err("Plugin snapshot ownership timed out".into());
        }
        match runtime.process.try_lock() {
            Ok(process) => return Ok(process),
            Err(TryLockError::Poisoned(_)) => return Err("Plugin snapshot owner failed".into()),
            Err(TryLockError::WouldBlock) => std::thread::sleep(Duration::from_millis(10)),
        }
    }
}

fn cleanup_deadline() -> Instant {
    Instant::now() + Duration::from_secs(5)
}
