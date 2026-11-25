//! Keep data ownership and its inventory valid before removing activation.
use std::{fs, io};

use taomni_plugin_api::services::CoreServiceError;
use taomni_profile_locks::{PluginDataLease, PluginSlug, ProfileRoot};

use super::{
    ModuleManifest, PluginError, PluginRecord, PluginRegistry, current_platform, data_contract,
    install::{ActivePointer, ModuleInstaller, UninstalledModule},
    placeholder_manifest, retained_data, verify,
};

impl PluginRegistry {
    /// Deactivate a module under its cross-process data lease. Persist a
    /// data-only locator first, so a crash cannot orphan retained user data.
    pub fn uninstall(&self, slug: &str, delete_data: bool) -> Result<PluginRecord, PluginError> {
        let _lifecycle = self
            .lifecycle
            .lock()
            .expect("plugin lifecycle lock poisoned");
        let installer = ModuleInstaller::new(&self.root);
        let _mutation = installer.lock_mutations()?;
        let record = self
            .get(slug)
            .ok_or_else(|| PluginError::NotFound(slug.to_owned()))?;
        self.stop_host(slug)?;
        let profile = self.data_profile()?;
        let owner =
            PluginSlug::parse(slug).map_err(|_| data_contract::invalid("invalid data owner"))?;
        let _lease = PluginDataLease::try_acquire(&profile, &owner)
            .map_err(|_| super::services::service_error(CoreServiceError::PluginProfileInUse))?;
        let previous = retained_data::load(&self.root, slug)?;
        let schema =
            if record.reason.is_some() || record.state == super::LifecycleState::Uninstalled {
                previous
                    .as_ref()
                    .map_or(1, |locator| locator.data_schema_version)
            } else {
                record.manifest.data_schema_version
            };
        let locator = retained_data::discover(&self.root, slug, schema)?;
        if !delete_data || !locator.files.is_empty() {
            retained_data::save(&self.root, &locator)?;
        }
        installer.mark_uninstalled(slug, UninstalledModule::from(&record.manifest))?;
        let cleanup = (|| -> Result<(), PluginError> {
            installer.remove_code_trees(slug)?;
            if delete_data {
                match fs::remove_dir_all(self.root.join(slug).join("data")) {
                    Ok(()) => (),
                    Err(error) if error.kind() == io::ErrorKind::NotFound => (),
                    Err(error) => return Err(error.into()),
                }
                retained_data::remove(&self.root, slug)?;
            }
            Ok(())
        })();
        self.scan_locked()?;
        self.persist_enabled_preference(slug, None)?;
        cleanup?;
        self.get(slug)
            .ok_or_else(|| PluginError::NotFound(slug.to_owned()))
    }

    pub(super) fn uninstalled_manifest(
        &self,
        installer: &ModuleInstaller,
        slug: &str,
        pointer: &ActivePointer,
    ) -> ModuleManifest {
        let mut manifest = placeholder_manifest(slug);
        if let Some(version) = pointer.previous_version.as_deref() {
            manifest.version = version.into();
        }
        if let Some(display) = &pointer.uninstalled {
            // A restart or refresh can finish deleting code after an interrupted
            // uninstall. Every scan holds the cross-process mutation lock.
            if let Err(error) = installer.remove_code_trees(slug) {
                log::warn!("Could not remove uninstalled module {slug}: {error}");
            }
            display.apply(&mut manifest);
        } else if let Some(version) = pointer.previous_version.as_deref()
            && let Ok(path) = installer.version_dir(slug, version)
            && let Ok(old) = verify::verify_installed(&path, current_platform())
            && old.slug == slug
            && old.version == version
        {
            // Older versions kept the package after uninstall.
            UninstalledModule::from(&old).apply(&mut manifest);
        }
        manifest
    }

    pub(crate) fn data_profile(&self) -> Result<ProfileRoot, PluginError> {
        if let Some(services) = &self.services {
            return Ok(services.root.clone());
        }
        // The same canonical profile must be used by a host and every core.
        // Never put a registry test's locks in a shared system temp directory.
        if self.root.file_name() != Some(std::ffi::OsStr::new("plugins")) {
            return Err(data_contract::invalid(
                "plugin root must be <profile>/plugins",
            ));
        }
        ProfileRoot::prepare(self.root.parent().expect("plugins has a parent"))
            .map_err(|error| PluginError::HostRequest(error.to_string()))
    }
}

impl From<&ModuleManifest> for UninstalledModule {
    fn from(manifest: &ModuleManifest) -> Self {
        Self {
            name: manifest.name.clone(),
            description: manifest.description.clone(),
            kind: manifest.kind.clone(),
            status: manifest.status.clone(),
        }
    }
}

impl UninstalledModule {
    fn apply(&self, manifest: &mut ModuleManifest) {
        manifest.name.clone_from(&self.name);
        manifest.description.clone_from(&self.description);
        manifest.kind.clone_from(&self.kind);
        manifest.status.clone_from(&self.status);
    }
}

#[cfg(test)]
#[path = "uninstallation_tests.rs"]
mod tests;
