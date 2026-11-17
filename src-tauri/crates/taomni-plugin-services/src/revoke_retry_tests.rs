use super::*;

fn acknowledge(admission: &OperationAdmission, host: &AuthorizedHost, revocation: &Revocation) {
    admission
        .acknowledge_revoke(
            host,
            &RevokedKeys {
                host_instance: host.instance().clone(),
                vault_epoch: revocation.epoch,
                profile_generation: revocation.generation.clone(),
            },
        )
        .unwrap();
}

#[test]
fn joining_stale_root_revocation_retains_acknowledgements_and_adds_missing_hosts() {
    let admission = admission();
    let first = host(FIRST);
    let second = host(SECOND);
    let initial = admission
        .begin_or_join_revoke(std::slice::from_ref(&first))
        .unwrap();
    assert!(admission.host_revoke_pending(&first, &initial).unwrap());
    acknowledge(&admission, &first, &initial);
    assert!(!admission.host_revoke_pending(&first, &initial).unwrap());
    let joined = admission
        .begin_or_join_revoke(&[first.clone(), second.clone()])
        .unwrap();
    assert_eq!(joined.epoch, initial.epoch);
    assert_eq!(joined.generation, initial.generation);
    assert_eq!(
        joined.hosts,
        vec![first.instance().clone(), second.instance().clone()]
    );
    assert!(!admission.host_revoke_pending(&first, &joined).unwrap());
    assert!(admission.host_revoke_pending(&second, &joined).unwrap());
    assert_eq!(
        admission.finish_revoke(&joined),
        Err(CoreServiceError::CoreServiceBusy)
    );
    acknowledge(&admission, &second, &joined);
    let retry = admission.begin_or_join_revoke(&[second, first]).unwrap();
    assert_eq!(retry, joined);
    admission.finish_revoke(&retry).unwrap();
}

#[test]
fn pending_query_rejects_foreign_hosts_epochs_and_generations() {
    let admission = admission();
    let first = host(FIRST);
    let foreign = host(SECOND);
    let revocation = admission
        .begin_revoke(std::slice::from_ref(&first))
        .unwrap();
    assert_eq!(
        admission.host_revoke_pending(&foreign, &revocation),
        Err(CoreServiceError::StalePluginContext)
    );
    let mut old = revocation.clone();
    old.epoch = VaultEpoch::new(1).unwrap();
    assert_eq!(
        admission.host_revoke_pending(&first, &old),
        Err(CoreServiceError::StalePluginContext)
    );
    old = revocation.clone();
    old.generation = ProfileGeneration::parse(SECOND).unwrap();
    assert_eq!(
        admission.host_revoke_pending(&first, &old),
        Err(CoreServiceError::StalePluginContext)
    );
    acknowledge(&admission, &first, &revocation);
    admission.finish_revoke(&revocation).unwrap();
    assert!(admission.begin_or_join_revoke(&[]).is_err());
    assert!(admission.host_revoke_pending(&first, &revocation).is_err());
    admission.after_verified_unlock().unwrap();
    let next = admission
        .begin_or_join_revoke(std::slice::from_ref(&first))
        .unwrap();
    assert_ne!(next.epoch, revocation.epoch);
    assert!(admission.host_revoke_pending(&first, &next).unwrap());
}
