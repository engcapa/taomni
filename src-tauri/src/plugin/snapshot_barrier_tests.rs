use super::*;
use crate::{
    plugin::test_services::{PASSWORD, VaultHarness},
    vault::Vault,
};
use std::{
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};
use taomni_plugin_services::OperationKind;

fn deadline() -> Instant {
    Instant::now() + Duration::from_secs(5)
}

#[test]
fn failed_snapshot_releases_its_barrier_and_preserves_current_unlock_and_data() {
    let h = VaultHarness::new();
    h.initialize();
    let saved = h.vault.put("test", "retained", "retained-secret").unwrap();
    let result = h.registry.with_vault_snapshot(deadline(), &|| false, || {
        assert_eq!(h.services.admission.state(), AdmissionState::Open);
        assert!(h.services.admission.is_paused());
        assert!(VaultOperationLease::try_read(&h.services.root).is_err());
        Err::<(), _>("snapshot fixture failed".into())
    });
    assert_eq!(result.unwrap_err(), "snapshot fixture failed");
    assert!(h.services.vault_transition.lock().unwrap().is_none());
    assert_eq!(h.services.admission.state(), AdmissionState::Open);
    assert_eq!(
        h.vault.resolve(&saved.reference).unwrap().unwrap().as_str(),
        "retained-secret"
    );
}

#[test]
fn locked_snapshot_never_unlocks_or_mints_ordinary_admission() {
    let h = VaultHarness::new();
    h.initialize();
    h.registry.lock_vault(&h.vault).unwrap();
    h.registry
        .with_vault_snapshot(deadline(), &|| false, || {
            assert_eq!(h.services.admission.state(), AdmissionState::Locked);
            assert!(!h.vault.cached_root_is_current()?);
            assert!(VaultOperationLease::try_read(&h.services.root).is_err());
            Ok(())
        })
        .unwrap();
    assert_eq!(h.services.admission.state(), AdmissionState::Locked);
    assert!(!h.vault.cached_root_is_current().unwrap());
}

#[test]
fn drain_failure_never_enters_snapshot_or_invalidates_the_active_operation() {
    let h = VaultHarness::new();
    h.initialize();
    let permit = h
        .registry
        .admit_core_operation(OperationKind::ReadData, deadline())
        .unwrap();
    let called = AtomicBool::new(false);
    assert!(
        h.registry
            .with_vault_snapshot(
                Instant::now() + Duration::from_millis(20),
                &|| false,
                || {
                    called.store(true, Ordering::Release);
                    Ok(())
                },
            )
            .is_err()
    );
    assert!(!called.load(Ordering::Acquire));
    assert_eq!(h.services.admission.state(), AdmissionState::Open);
    assert!(!h.services.admission.is_paused());
    assert!(permit.check_current().is_ok());
    drop(permit);
    h.registry
        .with_vault_snapshot(deadline(), &|| false, || Ok(()))
        .unwrap();
    assert!(h.services.vault_transition.lock().unwrap().is_none());
    assert_eq!(h.services.admission.state(), AdmissionState::Open);
}

#[test]
fn external_reader_excludes_snapshot_and_callback_until_ownership_is_available() {
    let h = VaultHarness::new();
    h.initialize();
    let reader = VaultOperationLease::try_read(&h.services.root).unwrap();
    let called = AtomicBool::new(false);
    assert!(
        h.registry
            .with_vault_snapshot(
                Instant::now() + Duration::from_millis(20),
                &|| false,
                || {
                    called.store(true, Ordering::Release);
                    Ok(())
                },
            )
            .is_err()
    );
    assert!(!called.load(Ordering::Acquire));
    drop(reader);
    h.registry
        .with_vault_snapshot(deadline(), &|| false, || {
            called.store(true, Ordering::Release);
            Ok(())
        })
        .unwrap();
    assert!(called.load(Ordering::Acquire));
}

#[test]
fn cancellation_before_or_during_snapshot_does_not_leave_a_completed_barrier() {
    let h = VaultHarness::new();
    h.initialize();
    assert_eq!(
        h.registry
            .with_vault_snapshot::<()>(deadline(), &|| true, || {
                panic!("cancelled work must not execute")
            })
            .unwrap_err(),
        "REQUEST_CANCELLED"
    );
    assert_eq!(h.services.admission.state(), AdmissionState::Open);
    let cancelled = AtomicBool::new(false);
    assert_eq!(
        h.registry
            .with_vault_snapshot(deadline(), &|| cancelled.load(Ordering::Acquire), || {
                cancelled.store(true, Ordering::Release);
                Ok(())
            },)
            .unwrap_err(),
        "REQUEST_CANCELLED"
    );
    assert!(h.services.vault_transition.lock().unwrap().is_none());
    assert_eq!(h.services.admission.state(), AdmissionState::Open);
    assert!(VaultOperationLease::try_write(&h.services.root).is_ok());
}

#[test]
fn snapshot_cannot_reopen_an_old_root_after_another_core_rekeys() {
    let h = VaultHarness::new();
    h.initialize();
    let other = Vault::open(&h.root.path().join("vault.db")).unwrap();
    {
        let _exclusive = VaultOperationLease::try_write(&h.services.root).unwrap();
        other
            .change_master(PASSWORD, "qa-new-snapshot-master")
            .unwrap();
    }
    h.registry
        .with_vault_snapshot(deadline(), &|| false, || Ok(()))
        .unwrap();
    assert_eq!(h.services.admission.state(), AdmissionState::Revoking);
    assert!(!h.vault.cached_root_is_current().unwrap());
    h.registry
        .unlock_vault(&h.vault, "qa-new-snapshot-master")
        .unwrap();
}

#[test]
fn ordinary_credentials_status_and_mfa_requests_wait_outside_the_snapshot() {
    let h = VaultHarness::new();
    h.initialize();
    let saved = h.vault.put("test", "retained", "retained-secret").unwrap();
    let (acquired, acquired_rx) = std::sync::mpsc::channel();
    let (release, release_rx) = std::sync::mpsc::channel();
    let (results, results_rx) = std::sync::mpsc::channel();
    std::thread::scope(|scope| {
        let registry = &h.registry;
        let snapshot = scope.spawn(move || {
            registry.with_vault_snapshot(deadline(), &|| false, || {
                acquired.send(()).unwrap();
                release_rx.recv_timeout(Duration::from_secs(3)).unwrap();
                Ok(())
            })
        });
        acquired_rx.recv_timeout(Duration::from_secs(3)).unwrap();
        let credentials = scope.spawn(|| {
            let secret = h.vault.resolve(&saved.reference).unwrap().unwrap();
            results.send(secret.as_str().to_owned()).unwrap();
        });
        let mfa = scope.spawn(|| {
            let permit = h
                .registry
                .admit_core_operation(OperationKind::ReadData, deadline())
                .unwrap();
            permit.check_current().unwrap();
            results.send("MFA admitted".into()).unwrap();
        });
        let status = scope.spawn(|| {
            let status = h.vault.status().unwrap();
            results.send(format!("{:?}", status.state)).unwrap();
        });
        assert!(results_rx.recv_timeout(Duration::from_millis(30)).is_err());
        release.send(()).unwrap();
        snapshot.join().unwrap().unwrap();
        credentials.join().unwrap();
        mfa.join().unwrap();
        status.join().unwrap();
    });
    let mut results = results_rx.try_iter().collect::<Vec<_>>();
    results.sort();
    assert_eq!(results, ["MFA admitted", "Unlocked", "retained-secret"]);
    assert!(!h.services.admission.is_paused());
}
