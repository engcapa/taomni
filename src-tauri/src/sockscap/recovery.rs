//! Desktop facade for the SocksCap recovery journal.

use std::{
    fs,
    io::ErrorKind,
    path::{Path, PathBuf},
};

use crate::plugin::data_contract::{require_directory, require_file};

pub use taomni_sockscap_api::recovery::*;

/// Keep the network recovery record alongside the module pointer, outside
/// the portable backup and the disposable runtime versions.
pub(super) struct JournalLocations {
    module: PathBuf,
    legacy: PathBuf,
}

impl JournalLocations {
    pub(super) fn load(profile: &Path) -> Result<Self, String> {
        let plugins = profile.join("plugins");
        let owner = plugins.join(taomni_sockscap_api::SLUG);
        let legacy_dir = profile.join("sockscap");
        for directory in [&plugins, &owner, &legacy_dir] {
            if present(directory)? {
                require_directory(directory).map_err(|error| error.to_string())?;
            }
        }
        let module = journal_path(&owner);
        let legacy = journal_path(&legacy_dir);
        for path in [&module, &legacy] {
            match fs::symlink_metadata(path) {
                Ok(metadata) => require_file(&metadata).map_err(|error| error.to_string())?,
                Err(error) if error.kind() == ErrorKind::NotFound => (),
                Err(error) => return Err(error.to_string()),
            }
        }
        Ok(Self { module, legacy })
    }

    pub(super) fn for_start(&self, hosted: bool) -> &Path {
        if hosted { &self.module } else { &self.legacy }
    }

    pub(super) fn active(&self) -> &Path {
        // A first upgrade can still have an unresolved legacy journal. Give
        // either dirty record priority over one already marked clean.
        [&self.module, &self.legacy]
            .into_iter()
            .find(|path| needs_repair(path))
            .or_else(|| self.module.is_file().then_some(&self.module))
            .unwrap_or(&self.legacy)
    }

    #[cfg(target_os = "macos")]
    pub(super) fn only_dirty(&self) -> Option<&Path> {
        let mut dirty = [&self.module, &self.legacy]
            .into_iter()
            .filter(|path| needs_repair(path));
        let first = dirty.next()?;
        dirty.next().is_none().then_some(first.as_path())
    }

    pub(super) fn clear_after_repair(&self) -> Result<(), String> {
        for path in [&self.module, &self.legacy] {
            if present(path)? {
                mark_clean_and_clear(path)?;
            }
        }
        Ok(())
    }
}

fn present(path: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chooses_signed_location_and_detects_dirty_legacy_record() {
        let profile = tempfile::tempdir().unwrap();
        let locations = JournalLocations::load(profile.path()).unwrap();
        assert_eq!(
            locations.for_start(true),
            profile.path().join("plugins/sockscap/recovery.json")
        );
        let legacy = locations.for_start(false);
        fs::create_dir_all(legacy.parent().unwrap()).unwrap();
        fs::write(legacy, b"old incomplete journal").unwrap();
        let module = locations.for_start(true);
        fs::create_dir_all(module.parent().unwrap()).unwrap();
        fs::write(module, b"new incomplete journal").unwrap();
        assert_eq!(locations.active(), module);
        fs::remove_file(module).unwrap();
        assert_eq!(locations.active(), legacy);
        fs::write(module, b"new incomplete journal").unwrap();
        locations.clear_after_repair().unwrap();
        assert!(!legacy.exists());
        assert!(!module.exists());
    }
}
