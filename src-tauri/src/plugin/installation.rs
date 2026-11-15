//! Trusted installation boundary for the registry.

use super::*;

impl PluginRegistry {
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
        let _lifecycle = self
            .lifecycle
            .lock()
            .expect("plugin lifecycle lock poisoned");
        let manifest = package.manifest();
        self.validate_manifest_fields(manifest)?;
        let slug = &manifest.slug;
        let installer = install::ModuleInstaller::new(&self.root);
        let previous = installer.active_pointer(slug)?;
        verify::validate_candidate_version(
            previous
                .active_version
                .as_deref()
                .or(previous.previous_version.as_deref()),
            &manifest.version,
            false,
        )
        .map_err(|error| PluginError::InvalidManifest(error.to_string()))?;
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
        self.activate_transaction(manifest, &previous, || {
            installer.activate(slug, &manifest.version)
        })
    }

    /// Roll back metadata and the in-memory projection together if publishing
    /// the new version or refreshing persisted preferences fails.
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
        self.stop_host(slug);
        let result = (|| {
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
            Ok(record)
        })();
        if result.is_err() {
            if let Err(restore_error) =
                install::ModuleInstaller::new(&self.root).restore_pointer(slug, previous)
            {
                let reason = format!(
                    "activation failed: {}; restoring previous version failed: {restore_error}",
                    result.as_ref().unwrap_err()
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
        }
        result
    }
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
