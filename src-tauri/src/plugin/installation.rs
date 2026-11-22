//! Trusted installation boundary for the registry.

use super::*;

pub(crate) enum InstallIntent<'a> {
    Explicit,
    Update(&'a str),
    Legacy,
}

impl PluginRegistry {
    pub(crate) fn record_legacy_migration(
        &self,
        executor: &super::migration::MigrationExecutor,
        snapshot: &super::migration::LegacyInstallSnapshot,
    ) -> Result<super::migration::MigrationExecutionResult, String> {
        use super::migration::MigrationItem;
        let _lifecycle = self
            .lifecycle
            .lock()
            .expect("plugin lifecycle lock poisoned");
        let _mutation = install::ModuleInstaller::new(&self.root)
            .lock_mutations()
            .map_err(|error| error.to_string())?;
        let mut retained = Vec::new();
        for candidate in &snapshot.candidates {
            let (slug, start, test) = match candidate.item {
                MigrationItem::VncSessions => (crate::vnc::MODULE_SLUG, "vnc/start", "vnc/test"),
                MigrationItem::RdpVncSessions => {
                    use taomni_rdp_client_api::{SLUG, START, TEST};
                    (SLUG, START, TEST)
                }
                _ => continue,
            };
            if self.has_verified_client_locked(slug, start, test) {
                retained.push(candidate.item);
            }
        }
        executor.record_session_retention(snapshot, &retained)
    }

    /// Retained IPC contract: arbitrary renderer directories are never trusted.
    /// Callers must supply a signed archive through the verified installer.
    pub fn install_staged(
        &self,
        _slug: &str,
        _version: &str,
        _package_dir: &Path,
    ) -> Result<PluginRecord, PluginError> {
        Err(PluginError::InvalidManifest(
            "unsigned package directories cannot be installed; select a signed .taomni-plugin archive"
                .into(),
        ))
    }

    pub fn install_verified(
        &self,
        package: &verify::VerifiedPackage,
    ) -> Result<PluginRecord, PluginError> {
        self.install_with_intent(package, InstallIntent::Explicit)?
            .ok_or_else(|| PluginError::InvalidManifest("explicit install was skipped".into()))
    }

    pub(crate) fn install_with_intent(
        &self,
        package: &verify::VerifiedPackage,
        intent: InstallIntent<'_>,
    ) -> Result<Option<PluginRecord>, PluginError> {
        let _lifecycle = self
            .lifecycle
            .lock()
            .expect("plugin lifecycle lock poisoned");
        self.ensure_installation_available()?;
        let manifest = package.manifest();
        self.validate_manifest_fields(manifest)?;
        let slug = &manifest.slug;
        let installer = install::ModuleInstaller::new(&self.root);
        let _mutation = installer.lock_mutations()?;
        let previous = installer.active_pointer(slug)?;
        match intent {
            InstallIntent::Legacy
                if previous.active_version.is_some() || previous.was_uninstalled() =>
            {
                return Ok(None);
            }
            InstallIntent::Update(version) => check_update(&previous, version, &manifest.version)?,
            _ => {}
        }
        verify::validate_candidate_version(
            previous
                .active_version
                .as_deref()
                .or(previous.previous_version.as_deref()),
            &manifest.version,
            false,
        )
        .map_err(|error| PluginError::InvalidManifest(error.to_string()))?;
        if previous.uninstalled.is_some() && previous.was_uninstalled() {
            installer.remove_version_tree(slug)?;
        }
        // Stage and recheck content before stopping a working host or changing
        // the pointer. A bad download never interrupts the active version.
        let destination = installer.stage_verified(package)?;
        self.validate_manifest(manifest, &self.root.join(slug))?;
        let checked = verify::verify_installed(&destination, current_platform())?;
        if checked != *manifest {
            return Err(PluginError::InvalidManifest(
                "installed manifest differs from verified package".into(),
            ));
        }
        if previous.was_uninstalled() {
            // Also covers interruption before uninstall cleared the preference.
            self.persist_enabled_preference(slug, None)?;
        }
        self.activate_transaction(manifest, &previous, || {
            installer.activate(slug, &manifest.version)
        })
        .map(Some)
    }

    pub fn rollback(&self, slug: &str) -> Result<PluginRecord, PluginError> {
        self.rollback_to(slug, None)
    }

    pub(crate) fn rollback_to(
        &self,
        slug: &str,
        expected: Option<&str>,
    ) -> Result<PluginRecord, PluginError> {
        let _lifecycle = self
            .lifecycle
            .lock()
            .expect("plugin lifecycle lock poisoned");
        self.ensure_installation_available()?;
        let installer = install::ModuleInstaller::new(&self.root);
        let _mutation = installer.lock_mutations()?;
        let pointer = installer.active_pointer(slug)?;
        let previous = pointer.rollback_version(slug)?;
        if expected.is_some_and(|version| version != previous) {
            return Err(PluginError::InvalidManifest(
                "Rollback version changed; refresh the module store".into(),
            ));
        }
        let target = installer.version_dir(slug, previous)?;
        let manifest = verify::verify_installed(&target, current_platform())?;
        if manifest.version != previous || manifest.slug != slug {
            return Err(PluginError::InvalidManifest(
                "rollback version directory does not match its manifest".into(),
            ));
        }
        self.activate_transaction(&manifest, &pointer, || installer.rollback(slug))
    }

    fn ensure_installation_available(&self) -> Result<(), PluginError> {
        use std::sync::atomic::Ordering::Acquire;
        if self.shutting_down.load(Acquire) || self.quiescence.load(Acquire) != 0 {
            return Err(PluginError::HostRequest(
                "Module operations are paused. Retry when Taomni is ready".into(),
            ));
        }
        Ok(())
    }

    /// Renew an already running host before reporting activation success.
    /// If activation fails, restore the pointer and reopen the previous host.
    pub(super) fn activate_transaction(
        &self,
        manifest: &ModuleManifest,
        previous: &install::ActivePointer,
        activate: impl FnOnce() -> Result<install::ActivePointer, install::InstallError>,
    ) -> Result<PluginRecord, PluginError> {
        let before = self
            .records
            .read()
            .expect("plugin registry lock poisoned")
            .clone();
        let slug = &manifest.slug;
        let was_running = self
            .hosts
            .lock()
            .expect("plugin host lock poisoned")
            .contains_key(slug);
        self.stop_host(slug)?;
        let result = (|| {
            super::migration_rdp_pins::prepare(&self.root, manifest)
                .map_err(PluginError::HostRequest)?;
            super::migration_vnc_server::prepare(&self.root, manifest)
                .map_err(PluginError::HostRequest)?;
            if previous.active_version.is_none() && !previous.was_uninstalled() {
                super::migration_rdp_server_identity::prepare(&self.root, manifest)
                    .map_err(PluginError::HostRequest)?;
                super::migration_local_servers_identity::prepare(&self.root, manifest)
                    .map_err(PluginError::HostRequest)?;
            }
            if !previous.was_uninstalled() {
                super::migration_rdp_server::prepare(&self.root, manifest)
                    .map_err(PluginError::HostRequest)?;
                super::migration_local_servers::prepare(&self.root, manifest)
                    .map_err(PluginError::HostRequest)?;
            }
            activate()?;
            self.scan_locked()?;
            let record = self
                .get(slug)
                .ok_or_else(|| PluginError::NotFound(slug.clone()))?;
            if record.reason.is_some() || record.manifest != *manifest {
                return Err(PluginError::InvalidManifest(
                    record
                        .reason
                        .unwrap_or_else(|| "activated manifest differs".into()),
                ));
            }
            if was_running
                && record.state == LifecycleState::Enabled
                && manifest.entry.host.is_some()
            {
                self.host_for_locked(slug, &record)?;
            }
            Ok(record)
        })();
        if let Err(failure) = result {
            if let Err(restore_error) =
                install::ModuleInstaller::new(&self.root).restore_pointer(slug, previous)
            {
                let reason = format!(
                    "activation failed: {}; restoring previous version failed: {restore_error}",
                    failure
                );
                let mut records = self.records.write().expect("plugin registry lock poisoned");
                if let Some(record) = records.get_mut(slug) {
                    record.state = LifecycleState::Disabled;
                    record.reason = Some(reason.clone());
                }
                self.frontend_trust
                    .write()
                    .expect("plugin asset lock poisoned")
                    .clear();
                return Err(PluginError::InvalidManifest(reason));
            }
            *self.records.write().expect("plugin registry lock poisoned") = before;
            self.frontend_trust
                .write()
                .expect("plugin asset lock poisoned")
                .clear();
            if let Some(old) = self
                .get(slug)
                .filter(|old| was_running && old.state == LifecycleState::Enabled)
            {
                if let Err(recovery_error) = self.host_for_locked(slug, &old) {
                    return Err(PluginError::HostRequest(format!(
                        "{failure}. Previous version restored, but its host could not restart: {recovery_error}"
                    )));
                }
            }
            return Err(failure);
        }
        result
    }
}

pub(crate) fn check_update(
    pointer: &install::ActivePointer,
    installed: &str,
    candidate: &str,
) -> Result<(), PluginError> {
    if pointer.active_version.as_deref() != Some(installed) {
        return Err(PluginError::InvalidManifest(
            "Installed module changed; refresh the module store before updating".into(),
        ));
    }
    if !verify::compare_versions(candidate, installed)
        .map_err(|error| PluginError::InvalidManifest(error.to_string()))?
        .is_gt()
    {
        return Err(PluginError::InvalidManifest(
            "Module update must be newer than the installed version".into(),
        ));
    }
    Ok(())
}

/// The platform is owned by the native core; a renderer cannot override it.
pub fn current_platform() -> &'static str {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => "linux-x86_64",
        ("windows", "x86_64") => "windows-x86_64",
        ("macos", "aarch64") => "darwin-aarch64",
        ("macos", "x86_64") => "darwin-x86_64",
        _ => "unsupported",
    }
}
