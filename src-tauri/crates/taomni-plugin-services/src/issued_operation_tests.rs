use super::*;

#[test]
fn core_issued_context_cannot_be_re_admitted_through_explicit_or_local_apis() {
    let (_directory, root) = root();
    let admission = admission();
    let host = host(FIRST);
    let deadline = Instant::now() + Duration::from_secs(5);
    let permit = admission
        .admit_new_until(
            &host,
            OperationKind::ReadData,
            VaultOperationLease::try_read(&root).unwrap(),
            deadline,
        )
        .unwrap();
    let old = permit.context().clone();
    assert!(admission.borrow_operation(&host, &old).is_ok());
    drop(permit);
    assert!(matches!(
        admission.borrow_operation(&host, &old),
        Err(CoreServiceError::StalePluginContext)
    ));
    assert!(matches!(
        admission.admit_until(
            &host,
            old.operation.clone(),
            OperationKind::ReadData,
            VaultOperationLease::try_read(&root).unwrap(),
            deadline
        ),
        Err(CoreServiceError::DuplicateRequest)
    ));
    assert!(matches!(
        admission.admit_core_until(
            old.operation.clone(),
            OperationKind::ReadData,
            VaultOperationLease::try_read(&root).unwrap(),
            deadline
        ),
        Err(CoreServiceError::DuplicateRequest)
    ));
    // A caller also cannot reserve a future issuer ID before it is minted.
    let future = OperationId::parse("74616f6d-0000-8000-8000-000000000002").unwrap();
    assert!(matches!(
        admission.admit_until(
            &host,
            future.clone(),
            OperationKind::ReadData,
            VaultOperationLease::try_read(&root).unwrap(),
            deadline
        ),
        Err(CoreServiceError::DuplicateRequest)
    ));
    let next = admission
        .admit_new_until(
            &host,
            OperationKind::ReadData,
            VaultOperationLease::try_read(&root).unwrap(),
            deadline,
        )
        .unwrap();
    assert_eq!(next.context().operation, future);
    assert_ne!(next.context().operation, old.operation);
    drop(next);
    let state = admission.0.state.lock().unwrap();
    assert!(state.seen_operations.is_empty());
    assert!(state.operations.is_empty());
    assert_eq!(state.in_flight, 0);
}

#[test]
fn new_admission_keeps_live_limits_and_recovers_when_one_owner_finishes() {
    let (_directory, root) = root();
    let admission = admission();
    let host = host(FIRST);
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut permits = Vec::new();
    for _ in 0..128 {
        permits.push(
            admission
                .admit_new_until(
                    &host,
                    OperationKind::ReadData,
                    VaultOperationLease::try_read(&root).unwrap(),
                    deadline,
                )
                .unwrap(),
        );
    }
    assert!(matches!(
        admission.admit_new_until(
            &host,
            OperationKind::ReadData,
            VaultOperationLease::try_read(&root).unwrap(),
            deadline
        ),
        Err(CoreServiceError::CoreServiceBusy)
    ));
    let retired = permits.pop().unwrap().context().clone();
    assert_eq!(admission.in_flight_count(), 127);
    assert!(matches!(
        admission.borrow_operation(&host, &retired),
        Err(CoreServiceError::StalePluginContext)
    ));
    let replacement = admission
        .admit_new_until(
            &host,
            OperationKind::ReadData,
            VaultOperationLease::try_read(&root).unwrap(),
            deadline,
        )
        .unwrap();
    assert_ne!(replacement.context().operation, retired.operation);
    drop(replacement);
    drop(permits);
    assert_eq!(admission.in_flight_count(), 0);
    assert!(VaultOperationLease::try_write(&root).is_ok());
}

#[test]
fn unlocking_does_not_reset_issuer_and_old_epoch_context_remains_invalid() {
    let (_directory, root) = root();
    let admission = admission();
    let host = host(FIRST);
    let deadline = Instant::now() + Duration::from_secs(5);
    let permit = admission
        .admit_new_until(
            &host,
            OperationKind::ReadData,
            VaultOperationLease::try_read(&root).unwrap(),
            deadline,
        )
        .unwrap();
    let old = permit.context().clone();
    drop(permit);
    let revocation = admission.begin_revoke(&[]).unwrap();
    admission.finish_revoke(&revocation).unwrap();
    admission.after_verified_unlock().unwrap();
    let next = admission
        .admit_new_until(
            &host,
            OperationKind::ReadData,
            VaultOperationLease::try_read(&root).unwrap(),
            deadline,
        )
        .unwrap();
    assert_ne!(next.context().operation, old.operation);
    assert_ne!(next.context().vault_epoch, old.vault_epoch);
    assert!(matches!(
        admission.borrow_operation(&host, &old),
        Err(CoreServiceError::StalePluginContext)
    ));
}
