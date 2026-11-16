//! Registry-owned host lifecycle, supervision and correlated request dispatch.

use super::*;
use std::sync::atomic::Ordering;
use std::time::Duration;

#[derive(Debug)]
pub(super) struct RuntimeHost {
    pub(super) process: Mutex<host::HostProcess>,
    pub(super) identity: RwLock<Option<taomni_plugin_services::AuthorizedHost>>,
    pub(super) cancellation: host::HostCancellation,
    manifest: ModuleManifest,
    directory: PathBuf,
}

impl PluginRegistry {
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
                        *runtime.identity.write().expect("plugin identity poisoned") =
                            process.authorized_host().cloned();
                    }
                }
            }
        });
    }

    pub fn shutdown(&self) {
        {
            let _lifecycle = self
                .lifecycle
                .lock()
                .expect("plugin lifecycle lock poisoned");
            self.shutting_down.store(true, Ordering::Release);
            self.stop_hosts();
        }
        if let Some(services) = &self.services {
            services.dispatcher.shutdown();
        }
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
                .map(|(_, id)| id.clone())
                .collect::<Vec<_>>();
            for id in ids {
                self.cancel_request(&runtime.manifest.slug, &id);
            }
            runtime
                .process
                .lock()
                .expect("plugin process lock poisoned")
                .stop();
        }
    }

    pub(super) fn host_for(
        &self,
        slug: &str,
        record: &PluginRecord,
    ) -> Result<Arc<RuntimeHost>, PluginError> {
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
        let (working_dir, host_path, verified) = self.host_location(slug, host_name)?;
        let services = self
            .services
            .as_ref()
            .map(|services| services.host_config(&verified))
            .transpose()?
            .flatten();
        let process = host::HostProcess::start_with_services(
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
            services,
        )
        .map_err(|error| PluginError::HostUnavailable(format!("{slug}: {error}")))?;
        let runtime = Arc::new(RuntimeHost {
            identity: RwLock::new(process.authorized_host().cloned()),
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
    ) -> Result<(PathBuf, PathBuf, ModuleManifest), PluginError> {
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
        Ok((working_dir, host_path, verified))
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
