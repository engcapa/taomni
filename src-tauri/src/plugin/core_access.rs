//! Still-core business facades acquire this outer guard before their DB mutex.
use super::PluginRegistry;
use std::{sync::atomic::Ordering, time::Instant};
use taomni_plugin_api::services::{CoreServiceError, OperationId};
use taomni_plugin_services::{AdmissionState, CoreOperationPermit, OperationKind};
use taomni_profile_locks::{VaultOperationLease, WaitControl};

impl PluginRegistry {
    pub(crate) fn admit_core_operation(
        &self,
        kind: OperationKind,
        deadline: Instant,
    ) -> Result<CoreOperationPermit, String> {
        let services = self
            .services
            .as_ref()
            .ok_or("Vault services are unavailable")?;
        let unavailable = || {
            self.shutting_down.load(Ordering::Acquire)
                || self.quiescence.load(Ordering::Acquire) != 0
        };
        if unavailable() || services.admission.state() != AdmissionState::Open {
            return Err(crate::vault::ERR_VAULT_LOCKED.into());
        }
        let permit = loop {
            services
                .admission
                .wait_while_paused(deadline, &unavailable)
                .map_err(|e| e.kind().to_string())?;
            let wait = WaitControl::new(deadline, &unavailable);
            let lease = if kind.requires_exclusive_lease() {
                VaultOperationLease::write(&services.root, &wait)
            } else {
                VaultOperationLease::read(&services.root, &wait)
            }
            .map_err(|error| error.to_string())?;
            match services.admission.admit_core_until(
                OperationId::parse(uuid::Uuid::new_v4().to_string()).expect("canonical UUID"),
                kind,
                lease,
                deadline,
            ) {
                Ok(permit) => break permit,
                Err(CoreServiceError::CoreServiceBusy) if services.admission.is_paused() => (),
                Err(error) => return Err(error.kind().to_string()),
            }
        };
        // Metadata and root are compared with the same shared/exclusive lease
        // retained by the returned permit. An external rekey cannot intervene.
        if !services.vault.cached_root_is_current()? {
            services
                .admission
                .begin_or_join_revoke(&[])
                .map_err(|e| e.kind().to_string())?;
            return Err(crate::vault::ERR_VAULT_LOCKED.into());
        }
        if unavailable() {
            return Err(crate::vault::ERR_VAULT_LOCKED.into());
        }
        permit.check_current().map_err(|e| e.kind().to_string())?;
        Ok(permit)
    }
}
