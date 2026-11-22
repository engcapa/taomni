//! Serve the active signed frontend through the registry trust boundary.

use super::*;

impl PluginRegistry {
    pub(super) fn has_verified_client_locked(&self, slug: &str, start: &str, test: &str) -> bool {
        let Ok(record) = self.enabled_record(slug) else {
            return false;
        };
        record.manifest.entry.frontend.is_some()
            && record.manifest.commands.contains(start)
            && record.manifest.commands.contains(test)
            && self.active_directory(slug).ok().is_some_and(|path| {
                verify::verify_installed(&path, current_platform())
                    .is_ok_and(|manifest| manifest == record.manifest)
            })
    }

    pub(super) fn frontend_asset(
        &self,
        slug: &str,
        version: &str,
        relative: &str,
    ) -> Result<Vec<u8>, PluginError> {
        validate_relative_path(relative)?;
        if !relative.starts_with("frontend/") {
            return Err(PluginError::InvalidManifest(
                "only frontend assets can be served".into(),
            ));
        }
        self.with_active_package(slug, version, |trusted| trusted.read_file(relative))
    }

    pub(crate) fn with_active_package<T>(
        &self,
        slug: &str,
        version: &str,
        inspect: impl FnOnce(&verify::InstalledTrust) -> Result<T, verify::TrustError>,
    ) -> Result<T, PluginError> {
        let _lifecycle = self
            .lifecycle
            .lock()
            .expect("plugin lifecycle lock poisoned");
        let record = self.enabled_record(slug)?;
        if record.manifest.version != version {
            return Err(PluginError::InvalidManifest(
                "frontend version is no longer active; reopen the module".into(),
            ));
        }
        let directory = self.active_directory(slug)?;
        let cached = self
            .frontend_trust
            .read()
            .expect("plugin asset lock poisoned")
            .get(&directory)
            .cloned();
        let trusted = match cached {
            Some(trusted) => trusted,
            None => {
                let trusted = Arc::new(verify::InstalledTrust::verify(
                    &directory,
                    current_platform(),
                )?);
                if trusted.manifest() != &record.manifest {
                    return Err(PluginError::InvalidManifest(
                        "active frontend manifest changed".into(),
                    ));
                }
                self.frontend_trust
                    .write()
                    .expect("plugin asset lock poisoned")
                    .insert(directory, trusted.clone());
                trusted
            }
        };
        if trusted.manifest() != &record.manifest {
            return Err(PluginError::InvalidManifest(
                "cached frontend manifest differs from registry".into(),
            ));
        }
        Ok(inspect(&trusted)?)
    }
}
