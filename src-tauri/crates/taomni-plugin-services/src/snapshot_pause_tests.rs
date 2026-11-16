use super::*;

fn deadline() -> Instant {
    Instant::now() + Duration::from_secs(3)
}

#[test]
fn paused_admission_rejects_new_work_without_changing_epoch_or_replay_protection() {
    let (_directory, root) = root();
    let admission = admission();
    let host = host(FIRST);
    let first = admission
        .admit(
            &host,
            OperationId::parse(FIRST).unwrap(),
            OperationKind::ReadData,
            VaultOperationLease::try_read(&root).unwrap(),
        )
        .unwrap();
    let epoch = first.context().vault_epoch;
    drop(first);
    let pause = admission.pause_and_drain(deadline(), &|| false).unwrap();
    assert!(admission.is_paused());
    assert!(matches!(
        admission.admit(
            &host,
            OperationId::parse(SECOND).unwrap(),
            OperationKind::ReadData,
            VaultOperationLease::try_read(&root).unwrap()
        ),
        Err(CoreServiceError::CoreServiceBusy)
    ));
    assert!(matches!(
        admission.admit_core_until(
            OperationId::parse(SECOND).unwrap(),
            OperationKind::ReadData,
            VaultOperationLease::try_read(&root).unwrap(),
            deadline()
        ),
        Err(CoreServiceError::CoreServiceBusy)
    ));
    assert!(
        VaultOperationLease::try_write(&root).is_ok(),
        "rejected work retains no OS lease"
    );
    drop(pause);
    let next = admission
        .admit(
            &host,
            OperationId::parse(SECOND).unwrap(),
            OperationKind::ReadData,
            VaultOperationLease::try_read(&root).unwrap(),
        )
        .unwrap();
    assert_eq!(next.context().vault_epoch, epoch);
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
fn pause_waits_for_existing_reverse_completion_without_cancelling_its_keys() {
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
    let waiting = admission.clone();
    let (ready, result) = std::sync::mpsc::channel();
    let thread = std::thread::spawn(move || {
        ready
            .send(waiting.pause_and_drain(deadline(), &|| false))
            .unwrap()
    });
    let until = deadline();
    while !admission.is_paused() {
        assert!(Instant::now() < until);
        std::thread::sleep(Duration::from_millis(1));
    }
    reverse.check_current().unwrap();
    admission
        .borrow_operation(&host, permit.context())
        .unwrap()
        .check_current()
        .unwrap();
    assert!(result.recv_timeout(Duration::from_millis(20)).is_err());
    drop(permit);
    assert!(
        result.recv_timeout(Duration::from_millis(20)).is_err(),
        "queued sensitive completion still retains its lease"
    );
    drop(reverse);
    let pause = result
        .recv_timeout(Duration::from_secs(3))
        .unwrap()
        .unwrap();
    assert!(VaultOperationLease::try_write(&root).is_ok());
    drop(pause);
    thread.join().unwrap();
    assert!(!admission.is_paused());
    assert_eq!(admission.state(), AdmissionState::Open);
}

#[test]
fn failed_drain_releases_pause_and_preserves_the_active_core_permit() {
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
    assert!(matches!(
        admission.pause_and_drain(Instant::now() + Duration::from_millis(20), &|| false),
        Err(CoreServiceError::TimedOut)
    ));
    assert!(!admission.is_paused());
    permit.check_current().unwrap();
    assert_eq!(admission.state(), AdmissionState::Open);
}

#[test]
fn waiting_without_a_lease_can_be_cancelled_and_revocation_stays_closed() {
    let admission = admission();
    let pause = admission.pause_and_drain(deadline(), &|| false).unwrap();
    assert_eq!(
        admission.wait_while_paused(deadline(), &|| true),
        Err(CoreServiceError::Cancelled)
    );
    let revocation = admission.begin_revoke(&[]).unwrap();
    drop(pause);
    assert_eq!(admission.state(), AdmissionState::Revoking);
    assert!(!admission.is_paused());
    assert!(matches!(
        admission.pause_and_drain(deadline(), &|| false),
        Err(CoreServiceError::CoreServiceBusy)
    ));
    admission.finish_revoke(&revocation).unwrap();
    let pause = admission.pause_and_drain(deadline(), &|| false).unwrap();
    drop(pause);
    assert_eq!(admission.state(), AdmissionState::Locked);
}
