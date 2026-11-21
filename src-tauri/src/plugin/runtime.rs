//! Registry-owned host lifecycle, supervision and correlated request dispatch.

use super::*;
use std::sync::atomic::Ordering;
use std::time::Duration;

#[derive(Debug)]
pub(super) struct RuntimeHost {
    pub(super) process: Mutex<host::HostProcess>,
    pub(super) identity: RwLock<Option<taomni_plugin_services::AuthorizedHost>>,
    pub(super) cancellation: host::HostCancellation,
    pub(super) manifest: ModuleManifest,
    pub(super) directory: PathBuf,
}

#[cfg(test)]
impl RuntimeHost {
    pub(super) fn stopped_for_test(manifest: ModuleManifest) -> Self {
        let process = host::HostProcess::stopped_for_registry_test();
        Self {
            cancellation: process.cancellation_handle(),
            process: Mutex::new(process),
            identity: RwLock::new(None),
            manifest,
            directory: PathBuf::new(),
        }
    }
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
                        if let Err(error) = process.stop_confirmed(stop_deadline()) {
                            log::warn!("plugin stale-host cleanup unconfirmed: {error}");
                        }
                        continue;
                    }
                    if matches!(process.tick(), host::HostTick::RestartReady { .. }) {
                        if verify::verify_installed(&runtime.directory, current_platform())
                            .map_or(true, |manifest| manifest != runtime.manifest)
                        {
                            log::warn!("plugin restart denied: installed package changed");
                            if let Err(error) = process.stop_confirmed(stop_deadline()) {
                                log::warn!("plugin untrusted-host cleanup unconfirmed: {error}");
                            }
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

    pub(super) fn host_for(
        &self,
        slug: &str,
        record: &PluginRecord,
    ) -> Result<Arc<RuntimeHost>, PluginError> {
        let _lifecycle = self
            .lifecycle
            .lock()
            .expect("plugin lifecycle lock poisoned");
        self.host_for_locked(slug, record)
    }

    pub(super) fn host_for_locked(
        &self,
        slug: &str,
        record: &PluginRecord,
    ) -> Result<Arc<RuntimeHost>, PluginError> {
        if (self.shutting_down.load(Ordering::Acquire)
            || self.quiescence.load(Ordering::Acquire) != 0)
        {
            return Err(PluginError::HostUnavailable(slug.into()));
        }
        let current = self.enabled_record(slug)?;
        if current.manifest != record.manifest {
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
        let profile = self.data_profile()?;
        let generation = crate::runtime::generation::current(profile.path())
            .map_err(PluginError::HostRequest)?;
        let owner = taomni_profile_locks::PluginSlug::parse(verified.slug.clone())
            .map_err(|error| PluginError::HostRequest(error.to_string()))?;
        let mut supervisor = host::HostSupervisorConfig::default();
        if verified.slug == taomni_mail_api::SLUG
            && verified.commands.contains(taomni_mail_api::CHECK_INCOMING)
        {
            supervisor.request_timeout = taomni_mail_api::HOST_REQUEST_TIMEOUT;
        } else if verified.slug == crate::vnc::MODULE_SLUG {
            // Allow for the RFB security and authentication waits in the host.
            supervisor.request_timeout = Duration::from_secs(65);
        }
        let process = host::HostProcess::start_profiled(
            host::HostProfileConfig::new(profile, owner, generation),
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
            supervisor,
            services,
        )
        .map_err(|error| match error {
            host::HostProcessError::NoExec(_) => PluginError::Rpc {
                code: error.rpc_code(),
                message: format!("{slug}: {error}"),
            },
            _ => PluginError::HostUnavailable(format!("{slug}: {error}")),
        })?;
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
}

fn stop_deadline() -> std::time::Instant {
    std::time::Instant::now() + Duration::from_secs(5)
}
