use taomni_plugin_api::services::{
    CoreServiceError, ExportGrantId, FixedKeyAction, FixedKeyRequest, ResetGrantId,
};

use crate::{FixedKeyOwner, OperationKind, OperationPermit, ReverseRequestPermit};

#[derive(Default)]
pub(crate) struct OperationGrants {
    reset: Option<ResetGrantId>,
    export: Option<ExportGrantId>,
    reset_issued: bool,
    export_issued: bool,
}

impl OperationPermit {
    /// Called by core only for its explicit confirmed reset command. The
    /// authenticated host cannot create a new admitted operation or grant.
    pub fn grant_reset(&self, grant: ResetGrantId) -> Result<(), CoreServiceError> {
        if self.record.kind != OperationKind::ResetStore {
            return Err(CoreServiceError::PermissionDenied);
        }
        let mut grants = self
            .record
            .grants
            .lock()
            .expect("operation grants poisoned");
        if grants.reset_issued {
            return Err(CoreServiceError::DuplicateRequest);
        }
        grants.reset = Some(grant);
        grants.reset_issued = true;
        Ok(())
    }

    /// Core calls this only after independently verifying the supplied master
    /// password. The password never enters the host's invoke payload.
    pub fn grant_export_after_verified_password(
        &self,
        grant: ExportGrantId,
    ) -> Result<(), CoreServiceError> {
        if self.record.kind != OperationKind::ExportSecret {
            return Err(CoreServiceError::PermissionDenied);
        }
        let mut grants = self
            .record
            .grants
            .lock()
            .expect("operation grants poisoned");
        if grants.export_issued {
            return Err(CoreServiceError::DuplicateRequest);
        }
        grants.export = Some(grant);
        grants.export_issued = true;
        Ok(())
    }
}

impl ReverseRequestPermit {
    pub fn authorize_fixed_key(
        &self,
        request: &FixedKeyRequest,
    ) -> Result<FixedKeyOwner, CoreServiceError> {
        self.check_current()?;
        let owner = self.operation().host().fixed_key_owner(&request.key_id)?;
        match &request.action {
            FixedKeyAction::Load => {}
            FixedKeyAction::CreateIfAbsent => {
                if !matches!(
                    self.operation().kind(),
                    OperationKind::InitializeEmptyStore | OperationKind::ResetStore
                ) {
                    return Err(CoreServiceError::PermissionDenied);
                }
            }
            FixedKeyAction::RepairEmptyAfterReset { grant } => {
                if self.operation().kind() != OperationKind::ResetStore {
                    return Err(CoreServiceError::PermissionDenied);
                }
                let mut grants = self
                    .operation()
                    .0
                    .grants
                    .lock()
                    .expect("operation grants poisoned");
                if grants.reset.as_ref() != Some(grant) {
                    return Err(CoreServiceError::PermissionDenied);
                }
                grants.reset.take();
            }
        }
        Ok(owner)
    }

    pub fn consume_export_grant(&self, grant: &ExportGrantId) -> Result<(), CoreServiceError> {
        self.check_current()?;
        if self.operation().kind() != OperationKind::ExportSecret {
            return Err(CoreServiceError::PermissionDenied);
        }
        let mut grants = self
            .operation()
            .0
            .grants
            .lock()
            .expect("operation grants poisoned");
        if grants.export.as_ref() != Some(grant) {
            return Err(CoreServiceError::PermissionDenied);
        }
        grants.export.take();
        Ok(())
    }
}
