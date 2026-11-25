//! Profile ownership is core infrastructure, including when mobile is absent.
use std::path::Path;
use taomni_profile_locks::{
    LeaseError, LeaseKind, LegacyDesktopLease, LegacyUpgradeLease, ProfileRoot,
};

use crate::plugin::{migration::export::MfaMaintenanceError, migration_commit};

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
pub(crate) enum ModeLease {
    Desktop { _lease: LegacyDesktopLease },
    Headless { _lease: LegacyUpgradeLease },
}

impl ModeLease {
    pub(crate) fn acquire(data: &Path, mode: StartupMode) -> Result<Self, ProfileStartupError> {
        let profile = ProfileRoot::prepare(data).map_err(mode_lease_error)?;
        let result = match mode {
            StartupMode::Desktop => {
                LegacyDesktopLease::try_acquire(&profile).map(|_lease| Self::Desktop { _lease })
            }
            StartupMode::Headless => {
                LegacyUpgradeLease::try_acquire(&profile).map(|_lease| Self::Headless { _lease })
            }
        };
        result.map_err(mode_lease_error)
    }
}

fn mode_lease_error(error: LeaseError) -> ProfileStartupError {
    match error {
        LeaseError::Busy(LeaseKind::LegacyUpgrade) => ProfileStartupError::ModeInUse,
        error => ProfileStartupError::Failed(format!(
            "Could not acquire the Taomni profile mode lock: {error}"
        )),
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
        use crate::plugin::migration_mail_provision as mail_upgrade;

        let (profile, mode_lease) = Self::prepare_profile(data, mode)?;
        let (profile, mode_lease) = match mail_upgrade::queued(data) {
            Ok(true) => {
                // Existing restore intents take precedence. Both live leases
                // then yield so migration can take exclusive ownership before
                // normal startup creates a database handle.
                drop(profile);
                drop(mode_lease);
                if let Err(error) = mail_upgrade::apply_before_startup(data) {
                    tracing::warn!(%error, "Could not complete the staged Mail upgrade");
                }
                Self::prepare_profile(data, mode)?
            }
            Ok(false) => (profile, mode_lease),
            Err(error) => {
                tracing::warn!(%error, "Could not read the staged Mail upgrade");
                (profile, mode_lease)
            }
        };
        let generation = super::generation::current(data)?;
        Ok(Self {
            generation,
            _profile: profile,
            _mode: mode_lease,
        })
    }

    fn prepare_profile(
        data: &Path,
        mode: StartupMode,
    ) -> Result<(crate::backup::coordination::ProfileLease, ModeLease), ProfileStartupError> {
        let mode_lease = loop {
            let lease = ModeLease::acquire(data, mode)?;
            // An offline upgrade can publish a transaction only while holding
            // the exclusive mode lock. Check with ownership before opening stores.
            if !migration_commit::recovery_pending(data)? {
                break lease;
            }
            drop(lease);
            migration_commit::recover_at_startup(data).map_err(|error| match error {
                MfaMaintenanceError::LegacyMode(LeaseError::Busy(LeaseKind::LegacyUpgrade)) => {
                    ProfileStartupError::ModeInUse
                }
                error => ProfileStartupError::Failed(error.to_string()),
            })?;
        };
        // Record the installation origin before restore can create a modular
        // generation marker. Both occur under the profile lease.
        let profile = crate::backup::coordination::ProfileLease::prepare(data, || {
            if let Err(error) = crate::plugin::release_state::initialize(data) {
                tracing::warn!(%error, "Could not initialize module release state");
            }
        })?;
        crate::migrate::migrate_db_file(data)
            .map_err(|error| format!("Could not migrate the legacy database: {error}"))?;
        Ok((profile, mode_lease))
    }
}
