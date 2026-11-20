//! Profile ownership is core infrastructure, including when mobile is absent.
use std::path::Path;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum StartupMode {
    Desktop,
    Headless,
}

#[derive(Debug, thiserror::Error)]
pub(crate) enum ProfileStartupError {
    #[error("Close the other Taomni mode using this profile first")]
    ModeInUse,
    #[error("{0}")]
    Failed(String),
}

impl From<String> for ProfileStartupError {
    fn from(error: String) -> Self {
        Self::Failed(error)
    }
}

/// Preserve the installed profile's existing desktop/shared, headless/exclusive lock.
pub(crate) struct ModeLease(std::fs::File);
impl ModeLease {
    pub(crate) fn acquire(data: &Path, mode: StartupMode) -> Result<Self, ProfileStartupError> {
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
        match result {
            Ok(()) => Ok(Self(file)),
            Err(std::fs::TryLockError::WouldBlock) => Err(ProfileStartupError::ModeInUse),
            Err(std::fs::TryLockError::Error(error)) => Err(ProfileStartupError::Failed(format!(
                "Could not acquire the Taomni profile mode lock: {error}"
            ))),
        }
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
    pub(crate) fn acquire(data: &Path, mode: StartupMode) -> Result<Self, ProfileStartupError> {
        crate::plugin::migration_commit::recover_at_startup(data)?;
        let mode = ModeLease::acquire(data, mode)?;
        // Record the installation origin before restore can create a modular
        // generation marker. Both occur under the profile lease.
        let profile = crate::backup::coordination::ProfileLease::prepare(data, || {
            if let Err(error) = crate::plugin::release_state::initialize(data) {
                tracing::warn!(%error, "Could not initialize module release state");
            }
        })?;
        crate::migrate::migrate_db_file(data)
            .map_err(|error| format!("Could not migrate the legacy database: {error}"))?;
        let generation = super::generation::current(data)?;
        Ok(Self {
            generation,
            _profile: profile,
            _mode: mode,
        })
    }
}
