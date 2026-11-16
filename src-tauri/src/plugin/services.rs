//! Core service owners never call back into the registry or a host mutex.
use std::{sync::Arc, time::Instant};
use taomni_plugin_api::services::{CoreServiceError, OperationId, VaultEpoch};
use taomni_plugin_services::{
    AdmissionState, AuthorizedHost, CoreServiceDispatcher, DispatcherConfig, OperationAdmission,
    OperationKind, OperationPermit, VerifiedHostGrants,
};
use taomni_profile_locks::{PluginSlug, ProfileRoot, VaultOperationLease, WaitControl};

use super::{ModuleManifest, PluginError, host::HostServiceConfig};
use crate::{runtime::profile::ProfileRuntimeLeases, vault::Vault};

pub(crate) struct PluginCoreServices {
    pub(crate) admission: OperationAdmission,
    pub(crate) dispatcher: Arc<CoreServiceDispatcher>,
    root: ProfileRoot,
    // The backend owns Vault beyond CoreState; keep its profile ownership too.
    _profile: Arc<ProfileRuntimeLeases>,
}

impl std::fmt::Debug for PluginCoreServices {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("PluginCoreServices([REDACTED])")
    }
}

pub(super) fn manifest_grants(
    manifest: &ModuleManifest,
) -> Result<VerifiedHostGrants, PluginError> {
    let slug = PluginSlug::parse(manifest.slug.clone())
        .map_err(|_| PluginError::InvalidManifest("invalid service owner".into()))?;
    VerifiedHostGrants::from_verified_manifest(
        slug,
        manifest.permissions.clone(),
        manifest.vault_fixed_keys.iter().cloned().collect(),
    )
    .map_err(service_error)
}

pub(super) fn service_error(error: CoreServiceError) -> PluginError {
    let error = error.into_rpc_error();
    PluginError::Rpc {
        code: error.code,
        message: error.message,
    }
}

impl PluginCoreServices {
    pub(crate) fn new(
        data: &std::path::Path,
        vault: Arc<Vault>,
        profile: Arc<ProfileRuntimeLeases>,
    ) -> Result<Self, String> {
        let root = ProfileRoot::prepare(data).map_err(|e| e.to_string())?;
        let admission = OperationAdmission::new(
            profile.generation.clone(),
            VaultEpoch::new(1).expect("nonzero epoch"),
            true,
        );
        let dispatcher = Arc::new(
            CoreServiceDispatcher::new(admission.clone(), vault, DispatcherConfig::default())
                .map_err(|e| e.to_string())?,
        );
        Ok(Self {
            admission,
            dispatcher,
            root,
            _profile: profile,
        })
    }

    /// Only host_location's freshly verified manifest may reach this factory.
    /// Legacy hosts without service declarations retain their existing wire.
    pub(super) fn host_config(
        &self,
        verified: &ModuleManifest,
    ) -> Result<Option<HostServiceConfig>, PluginError> {
        let grants = manifest_grants(verified)?;
        Ok(
            (!grants.service_capabilities().is_empty()).then(|| HostServiceConfig {
                dispatcher: self.dispatcher.clone(),
                grants,
            }),
        )
    }

    /// Acquire the outer lease before waiting for a HostProcess mutex. Reverse
    /// requests borrow this permit rather than recursively taking a file lock.
    pub(super) fn admit(
        &self,
        host: &AuthorizedHost,
        kind: OperationKind,
        deadline: Instant,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<OperationPermit, PluginError> {
        if self.admission.state() != AdmissionState::Open {
            return Err(service_error(CoreServiceError::VaultLocked));
        }
        let wait = WaitControl::new(deadline, cancelled);
        let lease = if kind.requires_exclusive_lease() {
            VaultOperationLease::write(&self.root, &wait)
        } else {
            VaultOperationLease::read(&self.root, &wait)
        }
        .map_err(|error| {
            service_error(match error {
                taomni_profile_locks::LeaseError::Cancelled => CoreServiceError::Cancelled,
                taomni_profile_locks::LeaseError::TimedOut => CoreServiceError::TimedOut,
                _ => CoreServiceError::PluginProfileInUse,
            })
        })?;
        self.admission
            .admit_until(
                host,
                OperationId::parse(uuid::Uuid::new_v4().to_string()).expect("canonical UUID"),
                kind,
                lease,
                deadline,
            )
            .map_err(service_error)
    }
}

#[cfg(test)]
#[path = "services_tests.rs"]
mod tests;
