//! Stop ownership is retained until the kernel confirms the entire host tree
//! exited. Failed cleanup is retried before deleting data or changing versions.
use super::{PluginError, PluginRegistry};
use std::{
    sync::{Arc, TryLockError, atomic::Ordering},
    time::{Duration, Instant},
};

impl PluginRegistry {
    pub fn shutdown(&self) -> Result<(), PluginError> {
        {
            let _lifecycle = self
                .lifecycle
                .lock()
                .expect("plugin lifecycle lock poisoned");
            let already_stopping = self.shutting_down.swap(true, Ordering::AcqRel);
            if let Err(error) = self.stop_hosts() {
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

    fn cancel_host_requests(&self, slug: &str) {
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
