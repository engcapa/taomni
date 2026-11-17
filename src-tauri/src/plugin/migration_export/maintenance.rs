//! Exclusive profile ownership shared by offline export and crash recovery.
use taomni_profile_locks::{
    LegacyUpgradeLease, PluginDataLease, PluginSlug, ProfileRestoreLease, ProfileRoot,
    ProfileStateLease, VaultOperationLease,
};

use super::paths;

pub(crate) struct MfaMaintenance {
    profile: ProfileRoot,
    _data: PluginDataLease,
    pub(super) vault: VaultOperationLease,
    _state: ProfileStateLease,
    _profile: ProfileRestoreLease,
    _legacy_mode: LegacyUpgradeLease,
}

impl MfaMaintenance {
    pub(crate) fn acquire(profile: &ProfileRoot) -> Result<Self, String> {
        paths::directory(profile.path())?;
        let legacy_mode = LegacyUpgradeLease::try_acquire(profile)
            .map_err(|error| format!("Close the legacy application before MFA upgrade: {error}"))?;
        let profile_lease = ProfileRestoreLease::try_acquire(profile)
            .map_err(|error| format!("Close other instances before MFA upgrade: {error}"))?;
        let state = ProfileStateLease::try_acquire(profile).map_err(|error| error.to_string())?;
        let vault = VaultOperationLease::try_write(profile)
            .map_err(|error| format!("Vault is in use during MFA upgrade: {error}"))?;
        let data = PluginDataLease::try_acquire(
            profile,
            &PluginSlug::parse("mfa").map_err(|error| error.to_string())?,
        )
        .map_err(|error| format!("MFA data is in use during upgrade: {error}"))?;
        Ok(Self {
            profile: profile.clone(),
            _data: data,
            vault,
            _state: state,
            _profile: profile_lease,
            _legacy_mode: legacy_mode,
        })
    }

    pub(crate) fn profile(&self) -> &ProfileRoot {
        &self.profile
    }
}
