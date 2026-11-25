use std::{
    collections::BTreeSet,
    time::{Duration, Instant},
};

use crate::*;
use taomni_plugin_api::services::*;
use taomni_profile_locks::*;

const FIRST: &str = "a1234567-1234-1234-1234-123456789abc";
const SECOND: &str = "b1234567-1234-1234-1234-123456789abc";

#[path = "cancellation_tests.rs"]
mod cancellation_tests;
#[path = "issued_operation_tests.rs"]
mod issued_operation_tests;
#[path = "revoke_retry_tests.rs"]
mod revoke_retry_tests;
#[path = "snapshot_pause_tests.rs"]
mod snapshot_pause_tests;
#[path = "termination_tests.rs"]
mod termination_tests;

fn host(id: &str) -> AuthorizedHost {
    VerifiedHostGrants::from_verified_manifest(
        PluginSlug::parse("mfa").unwrap(),
        BTreeSet::from([FIXED_KEY_SERVICE.into()]),
        BTreeSet::from([MFA_DATA_KEY_ID.into()]),
    )
    .unwrap()
    .bind_authenticated_transport(HostInstanceId::parse(id).unwrap())
}

fn admission() -> OperationAdmission {
    OperationAdmission::new(
        ProfileGeneration::parse(FIRST).unwrap(),
        VaultEpoch::new(1).unwrap(),
        false,
    )
}

fn root() -> (tempfile::TempDir, ProfileRoot) {
    let directory = tempfile::tempdir().unwrap();
    let root = ProfileRoot::prepare(directory.path()).unwrap();
    (directory, root)
}

#[test]
fn fixed_key_requires_core_owner_manifest_declaration_and_permission() {
    let permissions = BTreeSet::from([FIXED_KEY_SERVICE.into()]);
    let keys = BTreeSet::from([MFA_DATA_KEY_ID.into()]);
    assert!(
        VerifiedHostGrants::from_verified_manifest(
            PluginSlug::parse("other").unwrap(),
            permissions.clone(),
            keys.clone()
        )
        .is_err()
    );
    assert!(
        VerifiedHostGrants::from_verified_manifest(
            PluginSlug::parse("mfa").unwrap(),
            BTreeSet::new(),
            keys.clone()
        )
        .is_err()
    );
    assert!(
        VerifiedHostGrants::from_verified_manifest(
            PluginSlug::parse("mfa").unwrap(),
            permissions.clone(),
            BTreeSet::from(["other.key".into()])
        )
        .is_err()
    );
    let undeclared = VerifiedHostGrants::from_verified_manifest(
        PluginSlug::parse("mfa").unwrap(),
        permissions,
        BTreeSet::new(),
    )
    .unwrap()
    .bind_authenticated_transport(HostInstanceId::parse(FIRST).unwrap());
    assert_eq!(
        undeclared.fixed_key_owner(&FixedKeyId::parse(MFA_DATA_KEY_ID).unwrap()),
        Err(CoreServiceError::PermissionDenied)
    );
    assert_eq!(
        host(FIRST)
            .fixed_key_owner(&FixedKeyId::parse(MFA_DATA_KEY_ID).unwrap())
            .unwrap(),
        MFA_FIXED_KEY_OWNER
    );
}

#[test]
fn reverse_request_borrows_the_existing_lease_without_reacquiring_it() {
    let (_directory, root) = root();
    let admission = admission();
    let host = host(FIRST);
    let permit = admission
        .admit(
            &host,
            OperationId::parse(FIRST).unwrap(),
            OperationKind::ReadData,
            VaultOperationLease::try_read(&root).unwrap(),
        )
        .unwrap();
    let reverse = admission.borrow_operation(&host, permit.context()).unwrap();
    assert!(reverse.check_current().is_ok());
    assert!(matches!(
        VaultOperationLease::try_write(&root),
        Err(LeaseError::Busy(_))
    ));
    drop(permit);
    assert_eq!(
        reverse.check_current(),
        Err(CoreServiceError::StalePluginContext)
    );
    // Queued service completion still owns its original read permit.
    assert!(matches!(
        VaultOperationLease::try_write(&root),
        Err(LeaseError::Busy(_))
    ));
    drop(reverse);
    assert!(VaultOperationLease::try_write(&root).is_ok());
}

#[test]
fn self_reported_old_generation_or_other_host_context_is_rejected() {
    let (_directory, root) = root();
    let admission = admission();
    let host = host(FIRST);
    let permit = admission
        .admit(
            &host,
            OperationId::parse(FIRST).unwrap(),
            OperationKind::ReadData,
            VaultOperationLease::try_read(&root).unwrap(),
        )
        .unwrap();
    let mut context = permit.context().clone();
    context.profile_generation = ProfileGeneration::parse(SECOND).unwrap();
    assert!(matches!(
        admission.borrow_operation(&host, &context),
        Err(CoreServiceError::StalePluginContext)
    ));
    assert!(matches!(
        admission.borrow_operation(&super::tests::host(SECOND), permit.context()),
        Err(CoreServiceError::StalePluginContext)
    ));
    permit.cancel();
    assert!(matches!(
        admission.borrow_operation(&host, permit.context()),
        Err(CoreServiceError::StalePluginContext)
    ));
}

#[test]
fn revoke_cannot_finish_until_inflight_responses_and_host_confirmation_are_drained() {
    let (_directory, root) = root();
    let admission = admission();
    let host = host(FIRST);
    let permit = admission
        .admit(
            &host,
            OperationId::parse(FIRST).unwrap(),
            OperationKind::ReadData,
            VaultOperationLease::try_read(&root).unwrap(),
        )
        .unwrap();
    let reverse = admission.borrow_operation(&host, permit.context()).unwrap();
    let revocation = admission.begin_revoke(std::slice::from_ref(&host)).unwrap();
    assert_eq!(admission.state(), AdmissionState::Revoking);
    assert_eq!(
        reverse.check_current(),
        Err(CoreServiceError::StalePluginContext)
    );
    assert_eq!(
        admission.finish_revoke(&revocation),
        Err(CoreServiceError::CoreServiceBusy)
    );
    admission
        .confirm_host_terminated(&host, &revocation)
        .unwrap();
    drop(permit);
    assert_eq!(
        admission.finish_revoke(&revocation),
        Err(CoreServiceError::CoreServiceBusy)
    );
    drop(reverse);
    admission
        .wait_revoke_drained(Instant::now() + Duration::from_secs(1), &|| false)
        .unwrap();
    admission.finish_revoke(&revocation).unwrap();
    assert_eq!(admission.state(), AdmissionState::Locked);
    let epoch = admission.after_verified_unlock().unwrap();
    assert_eq!(epoch.get(), 3);
    assert_eq!(admission.state(), AdmissionState::Open);
}

#[test]
fn revoke_timeout_keeps_admission_closed_and_stale_ack_cannot_unlock_it() {
    let admission = admission();
    let host = host(FIRST);
    let revocation = admission.begin_revoke(std::slice::from_ref(&host)).unwrap();
    assert_eq!(
        admission.wait_revoke_drained(Instant::now(), &|| false),
        Err(CoreServiceError::TimedOut)
    );
    assert_eq!(
        admission.after_verified_unlock(),
        Err(CoreServiceError::StalePluginContext)
    );
    assert!(
        admission
            .acknowledge_revoke(
                &host,
                &RevokedKeys {
                    host_instance: host.instance().clone(),
                    profile_generation: revocation.generation.clone(),
                    vault_epoch: VaultEpoch::new(1).unwrap(),
                }
            )
            .is_err()
    );
    assert_eq!(
        admission.finish_revoke(&revocation),
        Err(CoreServiceError::CoreServiceBusy)
    );
    admission
        .confirm_host_terminated(&host, &revocation)
        .unwrap();
    admission.finish_revoke(&revocation).unwrap();
}

#[test]
fn reset_and_first_key_creation_require_an_exclusive_cross_process_permit() {
    let (_directory, root) = root();
    let admission = admission();
    assert!(matches!(
        admission.admit(
            &host(FIRST),
            OperationId::parse(FIRST).unwrap(),
            OperationKind::InitializeEmptyStore,
            VaultOperationLease::try_read(&root).unwrap()
        ),
        Err(CoreServiceError::PermissionDenied)
    ));
    assert!(
        admission
            .admit(
                &host(FIRST),
                OperationId::parse(FIRST).unwrap(),
                OperationKind::ResetStore,
                VaultOperationLease::try_write(&root).unwrap()
            )
            .is_ok()
    );
}

#[test]
fn repeated_reverse_ids_are_rejected_even_after_the_response_has_been_dropped() {
    let (_directory, root) = root();
    let admission = admission();
    let host = host(FIRST);
    let permit = admission
        .admit(
            &host,
            OperationId::parse(FIRST).unwrap(),
            OperationKind::ReadData,
            VaultOperationLease::try_read(&root).unwrap(),
        )
        .unwrap();
    let reverse = admission.borrow_operation(&host, permit.context()).unwrap();
    drop(reverse.begin_service_request("host-one".into()).unwrap());
    assert!(matches!(
        reverse.begin_service_request("host-one".into()),
        Err(CoreServiceError::DuplicateRequest)
    ));
    let calls = (0..8)
        .map(|i| {
            reverse
                .begin_service_request(format!("host-{i}").into())
                .unwrap()
        })
        .collect::<Vec<_>>();
    assert!(matches!(
        reverse.begin_service_request("host-over-budget".into()),
        Err(CoreServiceError::CoreServiceBusy)
    ));
    drop(calls);
    assert!(reverse.begin_service_request("host-new".into()).is_ok());
}

#[test]
fn fixed_key_mutation_and_export_grants_are_operation_bound_and_single_use() {
    let (_directory, root) = root();
    let admission = admission();
    let host = host(FIRST);
    let reset = admission
        .admit(
            &host,
            OperationId::parse(FIRST).unwrap(),
            OperationKind::ResetStore,
            VaultOperationLease::try_write(&root).unwrap(),
        )
        .unwrap();
    let grant = ResetGrantId::parse(FIRST).unwrap();
    reset.grant_reset(grant.clone()).unwrap();
    assert_eq!(
        reset.grant_reset(grant.clone()),
        Err(CoreServiceError::DuplicateRequest)
    );
    let operation = admission.borrow_operation(&host, reset.context()).unwrap();
    let reverse = operation.begin_service_request("reset-key".into()).unwrap();
    let request = FixedKeyRequest {
        key_id: FixedKeyId::parse(MFA_DATA_KEY_ID).unwrap(),
        action: FixedKeyAction::RepairEmptyAfterReset { grant },
    };
    assert!(reverse.authorize_fixed_key(&request).is_ok());
    assert_eq!(
        reverse.authorize_fixed_key(&request),
        Err(CoreServiceError::PermissionDenied)
    );
    drop(reverse);
    drop(operation);
    drop(reset);
    let export = admission
        .admit(
            &host,
            OperationId::parse(SECOND).unwrap(),
            OperationKind::ExportSecret,
            VaultOperationLease::try_read(&root).unwrap(),
        )
        .unwrap();
    let grant = ExportGrantId::parse(FIRST).unwrap();
    export
        .grant_export_after_verified_password(grant.clone())
        .unwrap();
    let operation = admission.borrow_operation(&host, export.context()).unwrap();
    let request = operation
        .begin_service_request("export-key".into())
        .unwrap();
    request.consume_export_grant(&grant).unwrap();
    assert_eq!(
        request.consume_export_grant(&grant),
        Err(CoreServiceError::PermissionDenied)
    );
}

#[test]
fn queued_sensitive_frames_keep_revocation_blocked_until_discarded() {
    let (_directory, root) = root();
    let admission = admission();
    let host = host(FIRST);
    let permit = admission
        .admit(
            &host,
            OperationId::parse(FIRST).unwrap(),
            OperationKind::ReadData,
            VaultOperationLease::try_read(&root).unwrap(),
        )
        .unwrap();
    let borrowed = admission.borrow_operation(&host, permit.context()).unwrap();
    let reverse = borrowed.begin_service_request("key-frame".into()).unwrap();
    let frame = SensitiveServiceFrame::encode(
        "key-frame".into(),
        FixedKeyResult::Key {
            context: permit.context().clone(),
            key: SecretKey32::new([3; 32]),
        },
        reverse,
    )
    .unwrap();
    assert!(frame.current_bytes().is_ok());
    let revocation = admission.begin_revoke(&[]).unwrap();
    // Even if the caller omitted the active host, it still has to be revoked.
    assert_eq!(revocation.hosts, vec![host.instance().clone()]);
    assert!(matches!(
        frame.current_bytes(),
        Err(CoreServiceError::StalePluginContext)
    ));
    admission
        .confirm_host_terminated(&host, &revocation)
        .unwrap();
    drop(permit);
    drop(borrowed);
    assert_eq!(
        admission.finish_revoke(&revocation),
        Err(CoreServiceError::CoreServiceBusy)
    );
    drop(frame);
    admission.finish_revoke(&revocation).unwrap();
}

#[test]
fn operation_ids_cannot_be_replayed_within_an_epoch() {
    let (_directory, root) = root();
    let admission = admission();
    let host = host(FIRST);
    drop(
        admission
            .admit(
                &host,
                OperationId::parse(FIRST).unwrap(),
                OperationKind::ReadData,
                VaultOperationLease::try_read(&root).unwrap(),
            )
            .unwrap(),
    );
    assert!(matches!(
        admission.admit(
            &host,
            OperationId::parse(FIRST).unwrap(),
            OperationKind::ReadData,
            VaultOperationLease::try_read(&root).unwrap()
        ),
        Err(CoreServiceError::DuplicateRequest)
    ));
}

#[test]
fn epoch_exhaustion_fails_closed_and_profile_changes_never_reuse_old_context() {
    let exhausted = OperationAdmission::new(
        ProfileGeneration::parse(FIRST).unwrap(),
        VaultEpoch::new(u64::MAX).unwrap(),
        false,
    );
    assert!(exhausted.begin_revoke(&[]).is_err());
    assert_eq!(exhausted.state(), AdmissionState::Revoking);
    let admission = admission();
    let revocation = admission
        .begin_profile_change(ProfileGeneration::parse(SECOND).unwrap(), &[])
        .unwrap();
    assert_eq!(revocation.generation.as_str(), SECOND);
    admission.finish_revoke(&revocation).unwrap();
    admission.after_verified_unlock().unwrap();
}
