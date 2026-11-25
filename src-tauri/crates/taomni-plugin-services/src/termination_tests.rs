use super::*;

#[test]
fn historical_termination_survives_replacement_without_releasing_live_operations() {
    let (_directory, root) = root();
    let admission = admission();
    let old = host(FIRST);
    let old_clone = old.clone();
    let permit = admission
        .admit(
            &old,
            OperationId::parse(FIRST).unwrap(),
            OperationKind::ReadData,
            VaultOperationLease::try_read(&root).unwrap(),
        )
        .unwrap();
    let borrowed = admission.borrow_operation(&old, permit.context()).unwrap();
    admission.record_host_terminated(&old_clone);
    assert!(old.termination_confirmed());
    assert_eq!(
        borrowed.check_current(),
        Err(CoreServiceError::StalePluginContext)
    );

    let replacement = host(SECOND);
    assert!(!replacement.termination_confirmed());
    let current = admission
        .admit(
            &replacement,
            OperationId::parse(SECOND).unwrap(),
            OperationKind::ReadData,
            VaultOperationLease::try_read(&root).unwrap(),
        )
        .unwrap();
    assert!(current.check_current().is_ok());
    let revocation = admission.begin_revoke(&[old, replacement.clone()]).unwrap();
    assert_eq!(revocation.hosts, vec![replacement.instance().clone()]);
    admission
        .acknowledge_revoke(
            &replacement,
            &RevokedKeys {
                host_instance: replacement.instance().clone(),
                profile_generation: revocation.generation.clone(),
                vault_epoch: revocation.epoch,
            },
        )
        .unwrap();
    drop(permit);
    drop(current);
    assert_eq!(
        admission.finish_revoke(&revocation),
        Err(CoreServiceError::CoreServiceBusy)
    );
    drop(borrowed);
    admission.finish_revoke(&revocation).unwrap();
}

#[test]
fn process_receipt_and_explicit_confirmation_are_idempotent_only_for_current_revocation() {
    let admission = admission();
    let old = host(FIRST);
    let revocation = admission.begin_revoke(std::slice::from_ref(&old)).unwrap();
    admission.record_host_terminated(&old);
    admission
        .confirm_host_terminated(&old, &revocation)
        .unwrap();
    admission
        .confirm_host_terminated(&old, &revocation)
        .unwrap();
    let mut stale = revocation.clone();
    stale.epoch = VaultEpoch::new(1).unwrap();
    assert_eq!(
        admission.confirm_host_terminated(&old, &stale),
        Err(CoreServiceError::StalePluginContext)
    );
    let mut other_generation = revocation.clone();
    other_generation.generation = ProfileGeneration::parse(SECOND).unwrap();
    assert_eq!(
        admission.confirm_host_terminated(&old, &other_generation),
        Err(CoreServiceError::StalePluginContext)
    );
    let replacement = host(SECOND);
    assert_eq!(
        admission.confirm_host_terminated(&replacement, &revocation),
        Err(CoreServiceError::StalePluginContext)
    );
    assert!(!replacement.termination_confirmed());
    admission.finish_revoke(&revocation).unwrap();
}

#[test]
fn terminated_identity_is_never_readmitted_even_after_verified_unlock() {
    let (_directory, root) = root();
    let admission = admission();
    let old = host(FIRST);
    admission.record_host_terminated(&old);
    let revocation = admission.begin_revoke(std::slice::from_ref(&old)).unwrap();
    assert!(revocation.hosts.is_empty());
    admission.finish_revoke(&revocation).unwrap();
    admission.after_verified_unlock().unwrap();
    assert!(matches!(
        admission.admit(
            &old,
            OperationId::parse(FIRST).unwrap(),
            OperationKind::ReadData,
            VaultOperationLease::try_read(&root).unwrap(),
        ),
        Err(CoreServiceError::StalePluginContext)
    ));
    let replacement = host(SECOND);
    assert!(
        admission
            .admit(
                &replacement,
                OperationId::parse(FIRST).unwrap(),
                OperationKind::ReadData,
                VaultOperationLease::try_read(&root).unwrap(),
            )
            .is_ok()
    );
}

#[test]
fn cancellation_is_not_a_termination_receipt() {
    let (_directory, root) = root();
    let admission = admission();
    let old = host(FIRST);
    let permit = admission
        .admit(
            &old,
            OperationId::parse(FIRST).unwrap(),
            OperationKind::ReadData,
            VaultOperationLease::try_read(&root).unwrap(),
        )
        .unwrap();
    admission.cancel_host(&old);
    assert!(!old.termination_confirmed());
    assert_eq!(
        permit.check_current(),
        Err(CoreServiceError::StalePluginContext)
    );
    let revocation = admission.begin_revoke(&[]).unwrap();
    assert_eq!(revocation.hosts, vec![old.instance().clone()]);
    drop(permit);
    assert_eq!(
        admission.finish_revoke(&revocation),
        Err(CoreServiceError::CoreServiceBusy)
    );
    admission.record_host_terminated(&old);
    admission.finish_revoke(&revocation).unwrap();
}
