//! Stop ownership is retained until the kernel confirms the entire host tree
//! exited. Failed cleanup is retried before deleting data or changing versions.
use super::vault_lifecycle::{VAULT_TRANSITION_TIMEOUT, lock_until};
use super::{PluginError, PluginRegistry};
use std::{
    sync::{Arc, TryLockError, atomic::Ordering},
    time::{Duration, Instant},
};

/// Legacy application-owned resources associated with a replaceable host.
/// Called under the lifecycle lock, so cleanup cannot invoke the registry.
pub(crate) trait ModuleCleanup: std::fmt::Debug + Send + Sync {
    fn prepare_stop(&self, slug: &str) -> Result<(), String>;
}

impl PluginRegistry {
    pub(crate) fn with_module_cleanup(mut self, cleanup: impl ModuleCleanup + 'static) -> Self {
        self.module_cleanup = Some(Arc::new(cleanup));
        self
    }

    pub fn shutdown(&self) -> Result<(), PluginError> {
        self.shutdown_until(Instant::now() + VAULT_TRANSITION_TIMEOUT)
    }

    pub(crate) fn shutdown_until(&self, deadline: Instant) -> Result<(), PluginError> {
        {
            // All service transitions take these two locks in this order.
            let mut pending = self
                .services
                .as_ref()
                .map(|services| {
                    lock_until(&services.vault_transition, deadline, "Vault transition")
                })
                .transpose()
                .map_err(PluginError::HostUnavailable)?;
            let _lifecycle = lock_until(&self.lifecycle, deadline, "plugin lifecycle")
                .map_err(PluginError::HostUnavailable)?;
            let already_stopping = self.shutting_down.swap(true, Ordering::AcqRel);
            let result = (|| {
                if let (Some(services), Some(pending)) = (&self.services, pending.as_mut()) {
                    self.drain_vault_operations(services, pending, deadline)
                        .map_err(PluginError::HostUnavailable)?;
                }
                self.stop_hosts()?;
                if let (Some(services), Some(pending)) = (&self.services, pending.as_mut()) {
                    self.complete_service_barrier(services, pending, deadline, true)
                        .map_err(PluginError::HostUnavailable)?;
                }
                Ok(())
            })();
            if let Err(error) = result {
                if !already_stopping {
                    self.shutting_down.store(false, Ordering::Release);
                }
                return Err(error);
            }
        }
        // No registry/host locks while joining core-service workers.
        if let Some(services) = &self.services {
            services.dispatcher.shutdown();
        }
        Ok(())
    }

    pub(super) fn stop_hosts(&self) -> Result<(), PluginError> {
        let slugs = self
            .hosts
            .lock()
            .expect("plugin host lock poisoned")
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        // Cancel every host before waiting on any one host's process mutex.
        for slug in &slugs {
            self.cancel_host_requests(slug);
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut failure = None;
        for slug in slugs {
            if let Err(error) = self.stop_host_until(&slug, deadline) {
                log::warn!("plugin cleanup unconfirmed: {error}");
                failure.get_or_insert(error);
            }
        }
        failure.map_or(Ok(()), Err)
    }

    pub(super) fn stop_host(&self, slug: &str) -> Result<(), PluginError> {
        if let Some(cleanup) = &self.module_cleanup {
            cleanup
                .prepare_stop(slug)
                .map_err(PluginError::HostRequest)?;
        }
        self.stop_host_until(slug, Instant::now() + Duration::from_secs(5))
    }

    pub(super) fn stop_host_until(&self, slug: &str, deadline: Instant) -> Result<(), PluginError> {
        self.cancel_host_requests(slug);
        let runtime = self
            .hosts
            .lock()
            .expect("plugin host lock poisoned")
            .get(slug)
            .cloned();
        let Some(runtime) = runtime else {
            return Ok(());
        };
        let mut process = loop {
            match runtime.process.try_lock() {
                Ok(process) => break process,
                Err(TryLockError::Poisoned(_)) => {
                    return Err(PluginError::HostUnavailable(format!(
                        "{slug}: process ownership lock is poisoned"
                    )));
                }
                Err(TryLockError::WouldBlock) => {
                    if Instant::now() >= deadline {
                        return Err(PluginError::HostUnavailable(format!(
                            "{slug}: timed out waiting for active operations to stop; retry cleanup"
                        )));
                    }
                    std::thread::sleep(Duration::from_millis(10));
                }
            }
        };
        process.stop_confirmed(deadline).map_err(|error| {
            PluginError::HostUnavailable(format!("{slug}: {error}; retry cleanup"))
        })?;
        drop(process);
        *runtime.identity.write().expect("plugin identity poisoned") = None;
        let mut hosts = self.hosts.lock().expect("plugin host lock poisoned");
        if hosts
            .get(slug)
            .is_some_and(|current| Arc::ptr_eq(current, &runtime))
        {
            hosts.remove(slug);
        }
        Ok(())
    }

    pub(super) fn cancel_host_requests(&self, slug: &str) {
        let ids = self
            .pending_requests
            .lock()
            .expect("plugin request lock poisoned")
            .keys()
            .filter(|(owner, _)| owner == slug)
            .map(|(_, id)| id.clone())
            .collect::<Vec<_>>();
        for id in ids {
            self.cancel_request(slug, &id);
        }
    }
}

#[cfg(test)]
#[path = "stopping_tests.rs"]
mod tests;
