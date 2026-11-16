//! Registry-owned host lifecycle, supervision and correlated request dispatch.

use super::*;
use serde_json::Value;
use std::sync::atomic::Ordering;
use std::time::Duration;
use taomni_plugin_api::ErrorCode;
use taomni_plugin_api::RequestId;

#[derive(Debug)]
pub(super) struct RuntimeHost {
    process: Mutex<host::HostProcess>,
    cancellation: host::HostCancellation,
    manifest: ModuleManifest,
    directory: PathBuf,
}

struct PendingCall<'a> {
    registry: &'a PluginRegistry,
    key: (String, String),
    cancellation: Option<host::HostCancellation>,
}

impl Drop for PendingCall<'_> {
    fn drop(&mut self) {
        if let Some(cancellation) = &self.cancellation {
            cancellation.finish(&RequestId::from(self.key.1.as_str()));
        }
        self.registry
            .pending_requests
            .lock()
            .expect("plugin request lock poisoned")
            .remove(&self.key);
    }
}

impl PluginRegistry {
    pub fn invoke(&self, slug: &str, command: &str, payload: Value) -> Result<Value, PluginError> {
        self.invoke_with_id(slug, command, payload, &uuid::Uuid::new_v4().to_string())
    }

    pub fn invoke_with_id(
        &self,
        slug: &str,
        command: &str,
        payload: Value,
        request_id: &str,
    ) -> Result<Value, PluginError> {
        if request_id.is_empty()
            || request_id.len() > 128
            || !request_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        {
            return Err(PluginError::Rpc {
                code: ErrorCode::InvalidRequest.as_i32(),
                message: "invalid request id".into(),
            });
        }
        let record = self
            .get(slug)
            .ok_or_else(|| PluginError::NotFound(slug.to_owned()))?;
        if record.state != LifecycleState::Enabled {
            return Err(PluginError::Disabled(slug.to_owned()));
        }
        if !record.manifest.commands.contains(command) {
            return Err(PluginError::CommandDenied {
                slug: slug.to_owned(),
                command: command.to_owned(),
            });
        }
        let key = (slug.to_owned(), request_id.to_owned());
        {
            let mut pending = self
                .pending_requests
                .lock()
                .expect("plugin request lock poisoned");
            if pending.contains_key(&key) {
                return Err(PluginError::Rpc {
                    code: ErrorCode::DuplicateRequest.as_i32(),
                    message: format!("duplicate request id: {request_id}"),
                });
            }
            pending.insert(key.clone(), false);
        }
        let mut pending_guard = PendingCall {
            registry: self,
            key: key.clone(),
            cancellation: None,
        };
        let runtime = self.host_for(slug, &record)?;
        let id = RequestId::from(request_id);
        runtime.cancellation.register(&id);
        pending_guard.cancellation = Some(runtime.cancellation.clone());
        if self
            .pending_requests
            .lock()
            .expect("plugin request lock poisoned")
            .get(&key)
            == Some(&true)
        {
            runtime.cancellation.cancel(&id);
        }
        loop {
            if (self.shutting_down.load(Ordering::Acquire)
                || self.quiescence.load(Ordering::Acquire) != 0)
                || self
                    .pending_requests
                    .lock()
                    .expect("plugin request lock poisoned")
                    .get(&key)
                    == Some(&true)
            {
                return Err(PluginError::Rpc {
                    code: ErrorCode::RequestCancelled.as_i32(),
                    message: "plugin request cancelled".into(),
                });
            }
            if let Ok(mut process) = runtime.process.try_lock() {
                return process
                    .invoke_with_id(id, command, Some(payload))
                    .map_err(|error| PluginError::Rpc {
                        code: error.rpc_code(),
                        message: format!("{slug}: {error}"),
                    });
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    pub fn cancel_request(&self, slug: &str, request_id: &str) -> bool {
        {
            let mut pending = self
                .pending_requests
                .lock()
                .expect("plugin request lock poisoned");
            let Some(cancelled) = pending.get_mut(&(slug.to_owned(), request_id.to_owned())) else {
                return false;
            };
            *cancelled = true;
        }
        if let Some(runtime) = self
            .hosts
            .lock()
            .expect("plugin host lock poisoned")
            .get(slug)
        {
            runtime.cancellation.cancel(&RequestId::from(request_id));
        }
        true
    }

    /// A single weak monitor follows the application-owned registry. It never
    /// holds the hosts map or records lock while invoking a process adapter.
    pub fn start_supervision(self: &Arc<Self>) {
        if self.monitor_started.swap(true, Ordering::AcqRel) {
            return;
        }
        let registry = Arc::downgrade(self);
        std::thread::spawn(move || {
            loop {
                std::thread::sleep(Duration::from_millis(100));
                let Some(registry) = registry.upgrade() else {
                    break;
                };
                if registry.shutting_down.load(Ordering::Acquire) {
                    break;
                }
                if registry.quiescence.load(Ordering::Acquire) != 0 {
                    continue;
                }
                let hosts = registry
                    .hosts
                    .lock()
                    .expect("plugin host lock poisoned")
                    .values()
                    .cloned()
                    .collect::<Vec<_>>();
                for runtime in hosts {
                    let Ok(_lifecycle) = registry.lifecycle.try_lock() else {
                        continue;
                    };
                    if registry.shutting_down.load(Ordering::Acquire)
                        || registry.quiescence.load(Ordering::Acquire) != 0
                    {
                        break;
                    }
                    let Ok(mut process) = runtime.process.try_lock() else {
                        continue;
                    };
                    let slug = &runtime.manifest.slug;
                    if registry.get(slug).is_none_or(|record| {
                        record.state != LifecycleState::Enabled
                            || record.manifest != runtime.manifest
                    }) || registry.active_directory(slug).ok().as_ref()
                        != Some(&runtime.directory)
                        || !registry
                            .hosts
                            .lock()
                            .expect("plugin host lock poisoned")
                            .get(slug)
                            .is_some_and(|current| Arc::ptr_eq(current, &runtime))
                    {
                        process.stop();
                        continue;
                    }
                    if matches!(process.tick(), host::HostTick::RestartReady { .. }) {
                        if verify::verify_installed(&runtime.directory, current_platform())
                            .map_or(true, |manifest| manifest != runtime.manifest)
                        {
                            log::warn!("plugin restart denied: installed package changed");
                            process.stop();
                            continue;
                        }
                        // Requests are never replayed. Restart only restores the
                        // transport for a subsequent explicitly issued command.
                        if let Err(error) = process.restart() {
                            log::warn!("plugin host restart failed: {error}");
                        }
                    }
                }
            }
        });
    }

    pub fn shutdown(&self) {
        let _lifecycle = self
            .lifecycle
            .lock()
            .expect("plugin lifecycle lock poisoned");
        self.shutting_down.store(true, Ordering::Release);
        self.stop_hosts();
    }

    pub(super) fn stop_hosts(&self) {
        let hosts = self
            .hosts
            .lock()
            .expect("plugin host lock poisoned")
            .drain()
            .map(|(_, runtime)| runtime)
            .collect::<Vec<_>>();
        for runtime in hosts {
            let ids = self
                .pending_requests
                .lock()
                .expect("plugin request lock poisoned")
                .keys()
                .filter(|(slug, _)| slug == &runtime.manifest.slug)
                .map(|(_, id)| RequestId::from(id.as_str()))
                .collect::<Vec<_>>();
            for id in ids {
                runtime.cancellation.cancel(&id);
            }
            runtime
                .process
                .lock()
                .expect("plugin process lock poisoned")
                .stop();
        }
    }

    fn host_for(&self, slug: &str, record: &PluginRecord) -> Result<Arc<RuntimeHost>, PluginError> {
        let _lifecycle = self
            .lifecycle
            .lock()
            .expect("plugin lifecycle lock poisoned");
        if (self.shutting_down.load(Ordering::Acquire)
            || self.quiescence.load(Ordering::Acquire) != 0)
        {
            return Err(PluginError::HostUnavailable(slug.into()));
        }
        let current = self
            .get(slug)
            .ok_or_else(|| PluginError::NotFound(slug.into()))?;
        if current.state != LifecycleState::Enabled || current.manifest != record.manifest {
            return Err(PluginError::Disabled(slug.into()));
        }
        let host_name = record
            .manifest
            .entry
            .host
            .as_deref()
            .ok_or_else(|| PluginError::HostUnavailable(slug.to_owned()))?;
        if let Some(runtime) = self
            .hosts
            .lock()
            .expect("plugin host lock poisoned")
            .get(slug)
        {
            return Ok(runtime.clone());
        }
        let (working_dir, host_path) = self.host_location(slug, host_name)?;
        let process = host::HostProcess::start(
            &record.manifest.id,
            &record.manifest.version,
            &host_path,
            &working_dir,
            &record.manifest.commands.iter().cloned().collect::<Vec<_>>(),
            &record
                .manifest
                .permissions
                .iter()
                .cloned()
                .collect::<Vec<_>>(),
            host::HostSupervisorConfig::default(),
        )
        .map_err(|error| PluginError::HostUnavailable(format!("{slug}: {error}")))?;
        let runtime = Arc::new(RuntimeHost {
            cancellation: process.cancellation_handle(),
            process: Mutex::new(process),
            manifest: record.manifest.clone(),
            directory: working_dir,
        });
        self.hosts
            .lock()
            .expect("plugin host lock poisoned")
            .insert(slug.to_owned(), runtime.clone());
        Ok(runtime)
    }

    pub(super) fn active_directory(&self, slug: &str) -> Result<PathBuf, PluginError> {
        let pointer = install::ModuleInstaller::new(&self.root).active_pointer(slug)?;
        let version = pointer
            .active_version
            .ok_or_else(|| PluginError::NotFound(slug.into()))?;
        Ok(self.root.join(slug).join("versions").join(version))
    }

    fn host_location(
        &self,
        slug: &str,
        host_name: &str,
    ) -> Result<(PathBuf, PathBuf), PluginError> {
        let working_dir = self.active_directory(slug)?;
        let verified = verify::verify_installed(&working_dir, current_platform())?;
        if self
            .get(slug)
            .is_none_or(|record| record.manifest != verified)
        {
            return Err(PluginError::InvalidManifest(
                "active host manifest changed; refresh modules".into(),
            ));
        }
        validate_relative_path(host_name)?;
        let host_path = working_dir.join(host_name);
        if !host_path.is_file() {
            return Err(PluginError::HostUnavailable(format!(
                "host executable is missing: {}",
                host_path.display()
            )));
        }
        Ok((working_dir, host_path))
    }

    pub(super) fn stop_host(&self, slug: &str) {
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
        let runtime = self
            .hosts
            .lock()
            .expect("plugin host lock poisoned")
            .remove(slug);
        if let Some(runtime) = runtime {
            runtime
                .process
                .lock()
                .expect("plugin process lock poisoned")
                .stop();
        }
    }
}
