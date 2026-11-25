//! Authenticated per-spawn service identity; never derived from host JSON.
use std::sync::Arc;

use taomni_plugin_api::services::HostInstanceId;
use taomni_plugin_services::{CoreServiceDispatcher, ServiceSession, VerifiedHostGrants};

use super::*;

#[derive(Clone, Debug)]
pub struct HostServiceConfig {
    pub dispatcher: Arc<CoreServiceDispatcher>,
    /// Registry constructs this only from the freshly verified installed package.
    pub grants: VerifiedHostGrants,
}

impl HostProcess {
    /// Lifecycle RPC carries a core deadline and no data-key operation context.
    pub fn revoke_keys(
        &mut self,
        revocation: &taomni_plugin_services::Revocation,
        deadline: Instant,
    ) -> Result<taomni_plugin_api::services::RevokedKeys, HostProcessError> {
        let host = self.authorized_host().ok_or(HostProcessError::Crashed)?;
        let params = taomni_plugin_api::services::RevokeKeys {
            host_instance: host.instance().clone(),
            profile_generation: revocation.generation.clone(),
            vault_epoch: revocation.epoch,
        };
        let id = self.next_request_id()?;
        let result = self.invoke_until(
            id,
            taomni_plugin_api::services::VAULT_REVOKE_METHOD,
            Some(serde_json::to_value(params).expect("revoke metadata serializable")),
            Some(deadline),
        )?;
        serde_json::from_value(result).map_err(|_| HostProcessError::UnexpectedResponse)
    }
    pub fn authorized_host(&self) -> Option<&taomni_plugin_services::AuthorizedHost> {
        self.services.as_ref().map(ServiceSession::host)
    }

    /// Core-only entry: the renderer API cannot construct a permit or choose
    /// an operation class, export/reset grant, epoch or authenticated identity.
    pub fn invoke_with_operation(
        &mut self,
        permit: taomni_plugin_services::OperationPermit,
        method: &str,
        params: Option<Value>,
    ) -> Result<Value, HostProcessError> {
        permit.check_current().map_err(service_error)?;
        if self.active_operation.is_some()
            || self
                .authorized_host()
                .is_none_or(|host| host.instance() != &permit.context().host_instance)
            || permit.deadline().is_none()
        {
            return Err(service_error(
                taomni_plugin_api::services::CoreServiceError::StalePluginContext,
            ));
        }
        let id = format!(
            "core/{}/{}",
            permit.context().host_instance,
            permit.context().operation
        )
        .into();
        self.active_operation = Some(permit);
        let result = self.invoke_with_id(id, method, params);
        if let Some(permit) = self.active_operation.take() {
            if result.is_err() {
                permit.cancel();
            }
        }
        result
    }

    pub(super) fn discard_services(&mut self) {
        self.instance.take();
        self.request_id_mode = RequestIdMode::Legacy;
        if let Some(permit) = self.active_operation.as_ref() {
            permit.cancel();
        }
        // Drop invalidates every operation for this transport. Do this before
        // killing its process or accepting any replacement handshake.
        self.services.take();
    }
}

pub(super) fn service_error(
    error: taomni_plugin_api::services::CoreServiceError,
) -> HostProcessError {
    let error = error.into_rpc_error();
    HostProcessError::Rpc {
        code: error.code,
        message: error.message,
    }
}

pub(super) fn fresh_host_instance() -> HostInstanceId {
    let mut bytes = [0u8; 16];
    rand::fill(&mut bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    HostInstanceId::parse(format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    ))
    .expect("generated canonical UUID")
}
