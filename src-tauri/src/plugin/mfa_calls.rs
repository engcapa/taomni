//! Native authorization for the two MFA operations that carry grants.
use std::{sync::Arc, time::Instant};

use serde_json::{Value, json};
use taomni_plugin_api::services::{CoreServiceError, ExportGrantId, ResetGrantId};
use taomni_plugin_services::OperationKind;
use taomni_profile_locks::{VaultOperationLease, WaitControl};

use super::{PluginError, PluginRegistry, services::service_error, vault_lifecycle::lock_until};

const OWNER: &str = "mfa";

impl PluginRegistry {
    pub(crate) fn installed_mfa_upgrade_package(
        &self,
    ) -> Result<(std::path::PathBuf, std::path::PathBuf), String> {
        let _lifecycle = self
            .lifecycle
            .lock()
            .map_err(|_| "Module registry is unavailable")?;
        let directory = self
            .active_directory(OWNER)
            .map_err(|error| error.to_string())?;
        let manifest = super::verify::verify_installed(&directory, super::current_platform())
            .map_err(|error| error.to_string())?;
        super::migration_commit::validate_manifest(&manifest)?;
        Ok(super::verify::installed_proof_paths(&directory))
    }

    pub(crate) fn export_mfa_uri(
        &self,
        id: &str,
        password: &str,
        deadline: Instant,
    ) -> Result<Value, PluginError> {
        let services = self.services.as_ref().ok_or_else(missing)?;
        self.invoke_scoped_inner(
            OWNER,
            "mfa_export_uri",
            &uuid::Uuid::new_v4().to_string(),
            OperationKind::ExportSecret,
            deadline,
            |permit| {
                services
                    .vault
                    .verify_mfa_host_export_password(password, permit)
                    .map_err(PluginError::HostRequest)?;
                let grant =
                    ExportGrantId::parse(uuid::Uuid::new_v4().to_string()).expect("canonical UUID");
                permit
                    .grant_export_after_verified_password(grant.clone())
                    .map_err(service_error)?;
                Ok(json!({"id": id, "grant": grant}))
            },
        )
    }

    pub(crate) fn reset_mfa_host(&self, deadline: Instant) -> Result<Value, PluginError> {
        const COMMAND: &str = "mfa_reset_store";
        let record = self.call_record(OWNER, COMMAND)?;
        let pending = self.begin_call(OWNER, &uuid::Uuid::new_v4().to_string())?;
        let services = self.services.as_ref().ok_or_else(missing)?;
        if services.admission.state() != taomni_plugin_services::AdmissionState::Open {
            return Err(service_error(CoreServiceError::VaultLocked));
        }
        let host = self.host_for(OWNER, &record)?;
        let _transition = lock_until(&services.vault_transition, deadline, "Vault transition")
            .map_err(PluginError::HostRequest)?;
        let _lifecycle = lock_until(&self.lifecycle, deadline, "plugin lifecycle")
            .map_err(PluginError::HostRequest)?;
        if self.call_record(OWNER, COMMAND)?.manifest != record.manifest
            || !self
                .hosts
                .lock()
                .map_err(|_| missing())?
                .get(OWNER)
                .is_some_and(|current| Arc::ptr_eq(current, &host))
        {
            return Err(missing());
        }
        let identity = host
            .identity
            .read()
            .map_err(|_| missing())?
            .clone()
            .ok_or_else(missing)?;
        let cancelled = || pending.cancelled();
        let mut pause = services
            .admission
            .pause_and_drain(deadline, &cancelled)
            .map_err(service_error)?;
        let wait = WaitControl::new(deadline, &cancelled);
        let lease = VaultOperationLease::write(&services.root, &wait)
            .map_err(|error| PluginError::HostRequest(error.to_string()))?;
        if !services
            .vault
            .cached_root_is_current()
            .map_err(PluginError::HostRequest)?
        {
            return Err(service_error(CoreServiceError::VaultLocked));
        }
        let permit = pause
            .admit_mfa_reset(&identity, lease, deadline)
            .map_err(service_error)?;
        let grant = ResetGrantId::parse(uuid::Uuid::new_v4().to_string()).expect("canonical UUID");
        permit.grant_reset(grant.clone()).map_err(service_error)?;
        self.call_scoped_host(&pending, &host, permit, COMMAND, json!({"grant": grant}))
    }
}

fn missing() -> PluginError {
    PluginError::HostUnavailable(OWNER.into())
}
