//! Profile ownership is core infrastructure, including when mobile is absent.
use std::path::Path;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum StartupMode {
    Desktop,
    Headless,
}

/// Preserve the installed profile's existing desktop/shared, headless/exclusive lock.
pub(crate) struct ModeLease(std::fs::File);
impl ModeLease {
    pub(crate) fn acquire(data: &Path, mode: StartupMode) -> Result<Self, String> {
        std::fs::create_dir_all(data).map_err(|e| e.to_string())?;
        let file = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(data.join(".mobile-mode.lock"))
            .map_err(|e| e.to_string())?;
        let result = match mode {
            StartupMode::Headless => file.try_lock(),
            StartupMode::Desktop => file.try_lock_shared(),
        };
        result.map_err(|_| "Close the other Taomni mode using this profile first")?;
        Ok(Self(file))
    }
}
impl Drop for ModeLease {
    fn drop(&mut self) {
        let _ = self.0.unlock();
    }
}

/// CoreState retains this lease after task/runtime teardown, until its stores close.
/// Field order drops the profile lock before the mode lock, matching acquisition.
pub(crate) struct ProfileRuntimeLeases {
    pub(crate) generation: taomni_plugin_api::services::ProfileGeneration,
    _profile: crate::backup::coordination::ProfileLease,
    _mode: ModeLease,
}
impl ProfileRuntimeLeases {
    pub(crate) fn acquire(data: &Path, mode: StartupMode) -> Result<Self, String> {
        crate::plugin::migration_commit::recover_at_startup(data)?;
        let mode = ModeLease::acquire(data, mode)?;
        // Applies a pending restore under exclusive ownership before any DB opens.
        let profile = crate::backup::coordination::ProfileLease::prepare(data)?;
        let generation = super::generation::current(data)?;
        Ok(Self {
            generation,
            _profile: profile,
            _mode: mode,
        })
    }
}
