//! Ordinary core credential consumers share service admission without knowing
//! a registry or host. Reverse RPC and MFA already carry their outer permit.
use super::{ERR_VAULT_LOCKED, Vault, VaultInner, plugin_access};
use crate::runtime::profile::ProfileRuntimeLeases;
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};
use taomni_plugin_api::services::{CoreServiceError, OperationId};
use taomni_plugin_services::{
    AdmissionState, CoreOperationPermit, OperationAdmission, OperationKind,
};
use taomni_profile_locks::{ProfileRoot, VaultOperationLease, WaitControl};

pub(crate) struct VaultDataAccess {
    pub(crate) admission: OperationAdmission,
    pub(crate) root: ProfileRoot,
    pub(crate) shutting_down: Arc<AtomicBool>,
    pub(crate) quiescence: Arc<AtomicUsize>,
    pub(crate) _profile: Arc<ProfileRuntimeLeases>,
}

impl VaultDataAccess {
    fn unavailable(&self) -> bool {
        self.shutting_down.load(Ordering::Acquire) || self.quiescence.load(Ordering::Acquire) != 0
    }

    fn read_lease(&self) -> Result<VaultOperationLease, String> {
        if self.unavailable() {
            return Err(ERR_VAULT_LOCKED.into());
        }
        let cancelled = || self.unavailable();
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            self.admission
                .wait_while_paused(deadline, &cancelled)
                .map_err(access_error)?;
            let wait = WaitControl::new(deadline, &cancelled);
            let lease = VaultOperationLease::read(&self.root, &wait).map_err(|e| e.to_string())?;
            if !self.admission.is_paused() {
                return Ok(lease);
            }
            drop(lease);
        }
    }

    fn admit(&self, kind: OperationKind) -> Result<CoreOperationPermit, String> {
        if self.admission.state() != AdmissionState::Open {
            return Err(ERR_VAULT_LOCKED.into());
        }
        let deadline = Instant::now() + Duration::from_secs(10);
        let permit = loop {
            self.admission
                .wait_while_paused(deadline, &|| self.unavailable())
                .map_err(access_error)?;
            let lease = self.read_lease()?;
            match self.admission.admit_core_until(
                OperationId::parse(uuid::Uuid::new_v4().to_string()).expect("canonical UUID"),
                kind,
                lease,
                deadline,
            ) {
                Ok(permit) => break permit,
                Err(CoreServiceError::CoreServiceBusy) if self.admission.is_paused() => (),
                Err(error) => return Err(access_error(error)),
            }
        };
        if self.unavailable() {
            return Err(ERR_VAULT_LOCKED.into());
        }
        Ok(permit)
    }
}

impl Vault {
    pub(crate) fn bind_data_access(&self, access: VaultDataAccess) -> Result<(), String> {
        self.data_access
            .set(access)
            .map_err(|_| "Vault service owner is already bound".into())
    }

    /// Nonsecret listing/status and deletion retain their existing locked-state
    /// behavior. Their shared lease also excludes restore and rekey writers.
    pub(super) fn metadata_lease(&self) -> Result<Option<VaultOperationLease>, String> {
        self.data_access
            .get()
            .map(VaultDataAccess::read_lease)
            .transpose()
    }

    pub(super) fn with_sensitive_data<T>(
        &self,
        kind: OperationKind,
        operation: impl FnOnce(&VaultInner) -> Result<T, String>,
    ) -> Result<T, String> {
        let access = self.data_access.get();
        let permit = access.map(|access| access.admit(kind)).transpose()?;
        let result = {
            let mut inner = self.inner.lock().map_err(|_| "Vault is unavailable")?;
            if let Some(permit) = &permit {
                permit.check_current().map_err(access_error)?;
            }
            match self.verify_service_root(&mut inner) {
                Ok(()) => operation(&inner),
                Err(error) => Err(error.to_string()),
            }
        };
        if let Some(permit) = &permit {
            permit.check_current().map_err(access_error)?;
        }
        if access.is_some_and(VaultDataAccess::unavailable) {
            return Err(ERR_VAULT_LOCKED.into());
        }
        result
    }

    /// Reverse-RPC workers also close the shared epoch when they detect that
    /// another core rekeyed Vault. No callback to a registry or host is needed.
    pub(super) fn verify_service_root(
        &self,
        inner: &mut VaultInner,
    ) -> Result<(), plugin_access::PluginKeyError> {
        let result = plugin_access::verify_current_root(inner);
        if matches!(result, Err(plugin_access::PluginKeyError::VaultLocked)) {
            if let Some(access) = self.data_access.get() {
                if access.admission.state() != AdmissionState::Locked {
                    access.admission.begin_or_join_revoke(&[])?;
                }
            }
        }
        result
    }
}

fn access_error(error: CoreServiceError) -> String {
    match error {
        CoreServiceError::StalePluginContext | CoreServiceError::VaultLocked => {
            ERR_VAULT_LOCKED.into()
        }
        other => other.kind().to_string(),
    }
}
