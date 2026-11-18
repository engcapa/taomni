//! Keep data ownership and its inventory valid before removing activation.
use taomni_plugin_api::services::CoreServiceError;
use taomni_profile_locks::{PluginDataLease, PluginSlug, ProfileRoot};

use super::{PluginError, PluginRecord, PluginRegistry, data_contract, install, retained_data};

impl PluginRegistry {
    /// Deactivate a module under its cross-process data lease. Persist a
    /// data-only locator first, so a crash cannot orphan retained user data.
    pub fn uninstall(&self, slug: &str, delete_data: bool) -> Result<PluginRecord, PluginError> {
        let _lifecycle = self
            .lifecycle
            .lock()
            .expect("plugin lifecycle lock poisoned");
        let installer = install::ModuleInstaller::new(&self.root);
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
        let schema = if record.reason.is_none() {
            record.manifest.data_schema_version
        } else {
            previous
                .as_ref()
                .map_or(1, |locator| locator.data_schema_version)
        };
        let locator = retained_data::discover(&self.root, slug, schema)?;
        if !delete_data {
            retained_data::save(&self.root, &locator)?;
        }
        installer.uninstall(slug, delete_data)?;
        if delete_data {
            // Failed deletion keeps the prior locator available for recovery.
            retained_data::remove(&self.root, slug)?;
        }
        self.scan_locked()?;
        self.persist_enabled_preference(slug, None)?;
        self.get(slug)
            .ok_or_else(|| PluginError::NotFound(slug.to_owned()))
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

#[cfg(test)]
#[path = "uninstallation_tests.rs"]
mod tests;
