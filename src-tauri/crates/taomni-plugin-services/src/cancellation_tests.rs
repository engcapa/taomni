use super::*;

#[test]
fn every_operation_invalidation_notifies_children_without_granting_termination() {
    for action in [
        "cancel",
        "retire",
        "disconnect",
        "revoke",
        "generation",
        "terminate",
    ] {
        let (_directory, root) = root();
        let admission = admission();
        let host = host(FIRST);
        let permit = admission
            .admit_until(
                &host,
                OperationId::parse(FIRST).unwrap(),
                OperationKind::ReadData,
                VaultOperationLease::try_read(&root).unwrap(),
                Instant::now() + Duration::from_secs(5),
            )
            .unwrap();
        let borrowed = admission.borrow_operation(&host, permit.context()).unwrap();
        let token = borrowed.cancellation_token();
        assert!(!token.is_cancelled());
        match action {
            "cancel" => permit.cancel(),
            "retire" => drop(permit),
            "disconnect" => admission.cancel_host(&host),
            "revoke" => {
                admission.begin_revoke(&[]).unwrap();
            }
            "generation" => {
                admission
                    .begin_profile_change(ProfileGeneration::parse(SECOND).unwrap(), &[])
                    .unwrap();
            }
            "terminate" => admission.record_host_terminated(&host),
            _ => unreachable!(),
        }
        assert!(
            token.is_cancelled(),
            "{action} must notify the network task"
        );
        assert!(
            borrowed.cancellation_token().is_cancelled(),
            "late child after {action}"
        );
        assert_eq!(
            borrowed.check_current(),
            Err(CoreServiceError::StalePluginContext)
        );
        assert_eq!(host.termination_confirmed(), action == "terminate");
    }
}

#[test]
fn cancelling_one_transfer_child_leaves_its_operation_and_sibling_current() {
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
    let first = borrowed.cancellation_token();
    let sibling = borrowed.cancellation_token();
    first.cancel();
    assert!(!sibling.is_cancelled());
    assert!(permit.check_current().is_ok());
    assert!(borrowed.check_current().is_ok());
    permit.cancel();
    assert!(sibling.is_cancelled());
}

#[tokio::test]
async fn request_without_a_core_deadline_cannot_start_a_binary_task() {
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
    let request = admission
        .borrow_operation(&host, permit.context())
        .unwrap()
        .begin_service_request(taomni_plugin_api::RequestId::from("reverse/1"))
        .unwrap();
    let pool = taomni_plugin_stream::TransferPool::new(Default::default()).unwrap();
    let result = offer_binary_for_request(
        request,
        pool.reserve(4).unwrap(),
        b"safe".to_vec(),
        "application/octet-stream",
        taomni_plugin_stream::TransferLimits::default(),
    )
    .await;
    assert_eq!(
        result.err().unwrap(),
        CoreServiceError::StalePluginContext.into_rpc_error()
    );
    assert_eq!(pool.usage(), taomni_plugin_stream::TransferUsage::default());
    assert!(permit.check_current().is_ok());
}
