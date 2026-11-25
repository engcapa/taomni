use std::time::{Duration, Instant};

use super::*;
use taomni_plugin_api::services::{HostInstanceId, OperationContext};
use taomni_profile_locks::ProfileRoot;

const FIRST: &str = "a1234567-1234-1234-1234-123456789abc";
const SECOND: &str = "b1234567-1234-1234-1234-123456789abc";

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

fn deadline() -> Instant {
    Instant::now() + Duration::from_secs(5)
}

#[test]
fn core_work_blocks_revoke_until_its_lease_and_result_are_released() {
    let (_directory, root) = root();
    let admission = admission();
    let permit = admission
        .admit_core_until(
            OperationId::parse(FIRST).unwrap(),
            OperationKind::WriteData,
            VaultOperationLease::try_read(&root).unwrap(),
            deadline(),
        )
        .unwrap();
    assert!(permit.check_current().is_ok());
    assert!(!permit.lease().is_exclusive());
    let revocation = admission.begin_revoke(&[]).unwrap();
    assert!(revocation.hosts.is_empty());
    assert_eq!(
        permit.check_current(),
        Err(CoreServiceError::StalePluginContext)
    );
    assert_eq!(
        admission.finish_revoke(&revocation),
        Err(CoreServiceError::CoreServiceBusy)
    );
    assert_eq!(
        admission.wait_revoke_drained(Instant::now(), &|| false),
        Err(CoreServiceError::TimedOut)
    );
    assert!(VaultOperationLease::try_write(&root).is_err());
    drop(permit);
    admission
        .wait_revoke_drained(deadline(), &|| false)
        .unwrap();
    admission.finish_revoke(&revocation).unwrap();
    assert!(VaultOperationLease::try_write(&root).is_ok());
    assert_eq!(admission.state(), AdmissionState::Locked);
}

#[test]
fn core_reset_requires_exclusive_ownership_and_cannot_upgrade_a_read_lease() {
    let (_directory, root) = root();
    let admission = admission();
    for kind in [
        OperationKind::InitializeEmptyStore,
        OperationKind::ResetStore,
    ] {
        assert!(matches!(
            admission.admit_core_until(
                OperationId::parse(FIRST).unwrap(),
                kind,
                VaultOperationLease::try_read(&root).unwrap(),
                deadline(),
            ),
            Err(CoreServiceError::PermissionDenied)
        ));
    }
    let permit = admission
        .admit_core_until(
            OperationId::parse(FIRST).unwrap(),
            OperationKind::InitializeEmptyStore,
            VaultOperationLease::try_write(&root).unwrap(),
            deadline(),
        )
        .unwrap();
    assert_eq!(permit.kind(), OperationKind::InitializeEmptyStore);
    assert_eq!(
        permit.consume_reset_grant(),
        Err(CoreServiceError::PermissionDenied)
    );
    assert!(permit.lease().is_exclusive());
    assert!(VaultOperationLease::try_read(&root).is_err());
    drop(permit);
    assert!(VaultOperationLease::try_read(&root).is_ok());
    assert!(matches!(
        admission.admit_core_until(
            OperationId::parse(SECOND).unwrap(),
            OperationKind::ResetStore,
            VaultOperationLease::try_write(&root).unwrap(),
            deadline(),
        ),
        Err(CoreServiceError::PermissionDenied)
    ));
}

#[test]
fn cancelled_core_result_is_rejected_but_still_holds_the_drain_barrier() {
    let (_directory, root) = root();
    let admission = admission();
    let permit = admission
        .admit_core_until(
            OperationId::parse(FIRST).unwrap(),
            OperationKind::ReadData,
            VaultOperationLease::try_read(&root).unwrap(),
            deadline(),
        )
        .unwrap();
    permit.cancel();
    assert_eq!(
        permit.check_current(),
        Err(CoreServiceError::StalePluginContext)
    );
    let revoke = admission
        .begin_profile_change(ProfileGeneration::parse(SECOND).unwrap(), &[])
        .unwrap();
    assert_eq!(
        admission.finish_revoke(&revoke),
        Err(CoreServiceError::CoreServiceBusy)
    );
    drop(permit);
    admission.finish_revoke(&revoke).unwrap();
    admission.after_verified_unlock().unwrap();
    let next = admission
        .admit_core_until(
            OperationId::parse(FIRST).unwrap(),
            OperationKind::ReadData,
            VaultOperationLease::try_read(&root).unwrap(),
            deadline(),
        )
        .unwrap();
    assert_eq!(next.generation.as_str(), SECOND);
    assert!(next.check_current().is_ok());
}

#[test]
fn core_admission_rejects_locked_and_expired_work_without_reserving_its_id() {
    let (_directory, root) = root();
    let admission = admission();
    assert!(matches!(
        admission.admit_core_until(
            OperationId::parse(FIRST).unwrap(),
            OperationKind::ReadData,
            VaultOperationLease::try_read(&root).unwrap(),
            Instant::now(),
        ),
        Err(CoreServiceError::TimedOut)
    ));
    let mut permit = admission
        .admit_core_until(
            OperationId::parse(FIRST).unwrap(),
            OperationKind::ReadData,
            VaultOperationLease::try_read(&root).unwrap(),
            deadline(),
        )
        .unwrap();
    permit.deadline = Instant::now();
    assert_eq!(permit.check_current(), Err(CoreServiceError::TimedOut));
    drop(permit);
    let revoke = admission.begin_revoke(&[]).unwrap();
    for finish in [false, true] {
        if finish {
            admission.finish_revoke(&revoke).unwrap();
        }
        assert!(matches!(
            admission.admit_core_until(
                OperationId::parse(SECOND).unwrap(),
                OperationKind::ReadData,
                VaultOperationLease::try_read(&root).unwrap(),
                deadline(),
            ),
            Err(CoreServiceError::VaultLocked)
        ));
    }
    admission.after_verified_unlock().unwrap();
    assert!(
        admission
            .admit_core_until(
                OperationId::parse(SECOND).unwrap(),
                OperationKind::ReadData,
                VaultOperationLease::try_read(&root).unwrap(),
                deadline(),
            )
            .is_ok()
    );
}

#[test]
fn core_permit_shares_host_limits_and_cannot_authorize_reverse_rpc_or_replay_host_ids() {
    use crate::VerifiedHostGrants;
    use std::collections::BTreeSet;
    use taomni_profile_locks::PluginSlug;

    let (_directory, root) = root();
    let admission = admission();
    admission.0.state.lock().unwrap().max_in_flight = 1;
    let host = VerifiedHostGrants::from_verified_manifest(
        PluginSlug::parse("hello-plugin").unwrap(),
        BTreeSet::new(),
        BTreeSet::new(),
    )
    .unwrap()
    .bind_authenticated_transport(HostInstanceId::parse(FIRST).unwrap());
    let permit = admission
        .admit_core_until(
            OperationId::parse(FIRST).unwrap(),
            OperationKind::ReadData,
            VaultOperationLease::try_read(&root).unwrap(),
            deadline(),
        )
        .unwrap();
    let fabricated = OperationContext {
        host_instance: host.instance().clone(),
        operation: OperationId::parse(FIRST).unwrap(),
        profile_generation: ProfileGeneration::parse(FIRST).unwrap(),
        vault_epoch: VaultEpoch::new(1).unwrap(),
    };
    assert!(matches!(
        admission.borrow_operation(&host, &fabricated),
        Err(CoreServiceError::StalePluginContext)
    ));
    assert!(matches!(
        admission.admit(
            &host,
            OperationId::parse(FIRST).unwrap(),
            OperationKind::ReadData,
            VaultOperationLease::try_read(&root).unwrap(),
        ),
        Err(CoreServiceError::DuplicateRequest)
    ));
    assert!(matches!(
        admission.admit(
            &host,
            OperationId::parse(SECOND).unwrap(),
            OperationKind::ReadData,
            VaultOperationLease::try_read(&root).unwrap(),
        ),
        Err(CoreServiceError::CoreServiceBusy)
    ));
    drop(permit);
    let next = admission
        .admit_core_until(
            OperationId::parse(FIRST).unwrap(),
            OperationKind::ReadData,
            VaultOperationLease::try_read(&root).unwrap(),
            deadline(),
        )
        .unwrap();
    assert!(matches!(
        admission.admit_core_until(
            OperationId::parse(FIRST).unwrap(),
            OperationKind::ReadData,
            VaultOperationLease::try_read(&root).unwrap(),
            deadline(),
        ),
        Err(CoreServiceError::DuplicateRequest)
    ));
    drop(next);
    let host_permit = admission
        .admit(
            &host,
            OperationId::parse(SECOND).unwrap(),
            OperationKind::ReadData,
            VaultOperationLease::try_read(&root).unwrap(),
        )
        .unwrap();
    assert!(host_permit.check_current().is_ok());
    drop(host_permit);
    assert!(matches!(
        admission.admit_core_until(
            OperationId::parse(SECOND).unwrap(),
            OperationKind::ReadData,
            VaultOperationLease::try_read(&root).unwrap(),
            deadline(),
        ),
        Err(CoreServiceError::DuplicateRequest)
    ));
    assert!(matches!(
        admission.admit(
            &host,
            OperationId::parse(SECOND).unwrap(),
            OperationKind::ReadData,
            VaultOperationLease::try_read(&root).unwrap(),
        ),
        Err(CoreServiceError::DuplicateRequest)
    ));
}

#[test]
fn sustained_local_polling_outlives_the_host_ledger_budget_and_still_drains() {
    let (_directory, root) = root();
    let admission = admission();
    // Reuse OS ownership across sequential local operations. This keeps the
    // stress test in-process and tests admission lifetime, not file-lock cost.
    let mut lease = VaultOperationLease::try_read(&root).unwrap();
    let until = Instant::now() + Duration::from_secs(30);
    for index in 0..65_538u32 {
        let permit = admission
            .admit_core_until(
                OperationId::parse(format!("{index:08x}-1234-1234-1234-123456789abc")).unwrap(),
                OperationKind::ReadData,
                lease,
                until,
            )
            .unwrap();
        permit.check_current().unwrap();
        lease = permit.release_admission();
    }
    let revoke = admission.begin_revoke(&[]).unwrap();
    admission
        .wait_revoke_drained(deadline(), &|| false)
        .unwrap();
    admission.finish_revoke(&revoke).unwrap();
    assert_eq!(admission.state(), AdmissionState::Locked);
    assert!(VaultOperationLease::try_write(&root).is_err());
    drop(lease);
    assert!(VaultOperationLease::try_write(&root).is_ok());
}

#[test]
fn transition_reset_requires_a_drained_current_revocation_and_retains_os_ownership() {
    let (_directory, root) = root();
    let admission = admission();
    let prior = admission
        .admit_core_until(
            OperationId::parse(FIRST).unwrap(),
            OperationKind::ReadData,
            VaultOperationLease::try_read(&root).unwrap(),
            deadline(),
        )
        .unwrap();
    let revocation = admission.begin_or_join_revoke(&[]).unwrap();
    drop(prior);
    let mut stale = revocation.clone();
    stale.epoch = VaultEpoch::new(1).unwrap();
    assert!(matches!(
        admission.admit_core_reset_after_drain(
            OperationId::parse(SECOND).unwrap(),
            &stale,
            VaultOperationLease::try_write(&root).unwrap(),
            deadline(),
        ),
        Err(CoreServiceError::StalePluginContext)
    ));
    assert!(matches!(
        admission.admit_core_reset_after_drain(
            OperationId::parse(SECOND).unwrap(),
            &revocation,
            VaultOperationLease::try_read(&root).unwrap(),
            deadline(),
        ),
        Err(CoreServiceError::PermissionDenied)
    ));
    let permit = admission
        .admit_core_reset_after_drain(
            OperationId::parse(SECOND).unwrap(),
            &revocation,
            VaultOperationLease::try_write(&root).unwrap(),
            deadline(),
        )
        .unwrap();
    assert_eq!(permit.kind(), OperationKind::ResetStore);
    assert!(permit.check_current().is_ok());
    assert_eq!(permit.consume_reset_grant(), Ok(()));
    assert_eq!(
        permit.consume_reset_grant(),
        Err(CoreServiceError::PermissionDenied)
    );
    assert_eq!(
        admission.finish_revoke(&revocation),
        Err(CoreServiceError::CoreServiceBusy)
    );
    let lease = permit.release_admission();
    admission.finish_revoke(&revocation).unwrap();
    admission.after_verified_unlock().unwrap();
    assert!(VaultOperationLease::try_read(&root).is_err());
    drop(lease);
    assert!(VaultOperationLease::try_read(&root).is_ok());
}
