//! Real MFA executable, production transport and typed reverse services.
mod mfa_support;
use mfa_support::*;
use serde_json::json;
use std::sync::atomic::Ordering;
use taomni_plugin_api::services::*;
use taomni_plugin_services::OperationKind;

#[test]
#[ignore = "actual MFA process and storage: GitHub runners only"]
fn real_mfa_hotp_metadata_preferences_and_delete_survive_normal_host_restart() {
    let mut harness = Harness::new();
    assert!(!harness.source().exists());
    harness.initialize();
    let id = harness.add();
    assert_eq!(harness.codes()[0]["code"], "755224");
    let result = harness
        .call(
            OperationKind::WriteData,
            "mfa_hotp_next",
            Some(json!({"id":id})),
        )
        .unwrap();
    assert_eq!(result["code"], "287082");
    assert_eq!(result["counter"], 1);
    assert!(
        harness
            .call(OperationKind::WriteData, "mfa_add", Some(input()))
            .is_err()
    );
    harness.call(OperationKind::WriteData, "mfa_update", Some(json!({"id":id,"patch":{"issuer":"retained","accountName":"qa@example.com","group":"work","note":"persisted metadata","pinned":true}}))).unwrap();
    harness
        .call(
            OperationKind::WriteData,
            "mfa_set_prefs",
            Some(json!({"prefs":{"sortMode":"issuer","groupFilter":"work"}})),
        )
        .unwrap();
    harness
        .call(
            OperationKind::WriteData,
            "mfa_mark_used",
            Some(json!({"id":id})),
        )
        .unwrap();
    harness
        .call(
            OperationKind::WriteData,
            "mfa_reorder",
            Some(json!({"ids":["stale",id]})),
        )
        .unwrap();
    let before = harness.list();
    let old_host = harness
        .process
        .authorized_host()
        .unwrap()
        .instance()
        .clone();
    harness.restart();
    assert_ne!(
        harness.process.authorized_host().unwrap().instance(),
        &old_host
    );
    assert_eq!(harness.list(), before);
    assert_eq!(before["accounts"][0]["note"], "persisted metadata");
    assert_eq!(before["accounts"][0]["pinned"], true);
    assert_eq!(before["accounts"][0]["useCount"], 1);
    assert_eq!(before["prefs"]["groupFilter"], "work");
    assert_eq!(harness.codes()[0]["code"], "287082");
    harness
        .call(
            OperationKind::WriteData,
            "mfa_delete",
            Some(json!({"id":id})),
        )
        .unwrap();
    harness.restart();
    assert!(harness.list()["accounts"].as_array().unwrap().is_empty());
    assert_eq!(harness.backend.creations.load(Ordering::Acquire), 1);
}

#[test]
#[ignore = "actual MFA process and storage: GitHub runners only"]
fn missing_mismatched_and_locked_keys_never_reinitialize_or_modify_accounts() {
    let mut harness = Harness::new();
    harness.initialize();
    harness.add();
    let before = std::fs::read(harness.source().with_file_name("mfa.db-wal")).unwrap();
    for (key, reason) in [
        (Ok(None), "MFA_KEY_MISSING"),
        (Ok(Some([38; 32])), "MFA_KEY_MISMATCH"),
        (Err(CoreServiceError::MfaKeyMismatch), "MFA_KEY_MISMATCH"),
        (Err(CoreServiceError::VaultLocked), "VAULT_LOCKED"),
    ] {
        *harness.backend.key.lock().unwrap() = key;
        assert!(
            harness
                .call(OperationKind::ReadData, "mfa_codes", None)
                .unwrap_err()
                .to_string()
                .contains(reason)
        );
        assert!(
            harness
                .call(
                    OperationKind::InitializeEmptyStore,
                    "mfa_initialize_empty",
                    None
                )
                .is_err()
        );
        assert_eq!(harness.backend.creations.load(Ordering::Acquire), 1);
        assert_eq!(
            std::fs::read(harness.source().with_file_name("mfa.db-wal")).unwrap(),
            before
        );
    }
    *harness.backend.key.lock().unwrap() = Ok(Some(KEY));
    assert_eq!(harness.codes()[0]["code"], "755224");
}

#[test]
#[ignore = "actual MFA process and export authorization: GitHub runners only"]
fn export_requires_a_core_issued_single_use_grant_for_that_operation() {
    let mut harness = Harness::new();
    harness.initialize();
    let id = harness.add();
    let grant = ExportGrantId::parse(ID).unwrap();
    let payload = json!({"id":id,"grant":grant});
    let calls = harness.backend.calls.load(Ordering::Acquire);
    assert!(
        harness
            .call(
                OperationKind::ExportSecret,
                "mfa_export_uri",
                Some(payload.clone())
            )
            .is_err()
    );
    assert!(
        harness
            .call(
                OperationKind::ReadData,
                "mfa_export_uri",
                Some(payload.clone())
            )
            .is_err()
    );
    assert!(
        harness
            .call(
                OperationKind::ExportSecret,
                "mfa_export_uri",
                Some(json!({"id":id,"masterPassword":"not-a-host-input","grant":grant}))
            )
            .is_err()
    );
    assert_eq!(harness.backend.calls.load(Ordering::Acquire), calls);
    let permit = harness.permit(OperationKind::ExportSecret);
    permit
        .grant_export_after_verified_password(grant.clone())
        .unwrap();
    let uri = harness
        .process
        .invoke_with_operation(permit, "mfa_export_uri", Some(payload.clone()))
        .unwrap();
    assert!(uri.as_str().unwrap().starts_with("otpauth://hotp/"));
    assert!(uri.as_str().unwrap().contains(SECRET));
    assert!(
        harness
            .call(OperationKind::ExportSecret, "mfa_export_uri", Some(payload))
            .is_err()
    );
    assert_eq!(harness.list()["accounts"].as_array().unwrap().len(), 1);
}

#[test]
#[ignore = "actual MFA process and reset authorization: GitHub runners only"]
fn unauthorized_reset_rolls_back_and_only_the_explicit_grant_can_rebind_a_broken_store() {
    let mut harness = Harness::new();
    harness.initialize();
    let id = harness.add();
    let payload = json!({"grant":ID});
    assert!(
        harness
            .call(
                OperationKind::WriteData,
                "mfa_reset_store",
                Some(payload.clone())
            )
            .is_err()
    );
    assert!(
        harness
            .call(
                OperationKind::ResetStore,
                "mfa_reset_store",
                Some(payload.clone())
            )
            .is_err()
    );
    assert_eq!(harness.list()["accounts"][0]["id"], id);
    *harness.backend.key.lock().unwrap() = Err(CoreServiceError::MfaKeyMismatch);
    let permit = harness.permit(OperationKind::ResetStore);
    permit
        .grant_reset(ResetGrantId::parse(ID).unwrap())
        .unwrap();
    harness
        .process
        .invoke_with_operation(permit, "mfa_reset_store", Some(payload.clone()))
        .unwrap();
    assert!(harness.list()["accounts"].as_array().unwrap().is_empty());
    assert_eq!(harness.backend.repairs.load(Ordering::Acquire), 1);
    assert!(
        harness
            .call(OperationKind::ResetStore, "mfa_reset_store", Some(payload))
            .is_err()
    );
    harness.restart();
    assert!(harness.list()["accounts"].as_array().unwrap().is_empty());
    harness.add();
    assert_eq!(harness.codes()[0]["code"], "755224");
}

#[test]
#[ignore = "actual MFA process and cancellation: GitHub runners only"]
fn cancelling_a_waiting_key_never_advances_the_hotp_counter_or_publishes_late_data() {
    let mut harness = Harness::new();
    harness.initialize();
    let id = harness.add();
    let before = harness.backend.calls.load(Ordering::Acquire);
    harness.backend.delay_ms.store(1500, Ordering::Release);
    let permit = harness.permit(OperationKind::WriteData);
    let request_id = format!(
        "core/{}/{}",
        permit.context().host_instance,
        permit.context().operation
    )
    .into();
    let cancel = harness.process.cancellation_handle();
    cancel.register(&request_id);
    let backend = harness.backend.clone();
    let canceller = std::thread::spawn(move || {
        let until = deadline();
        while backend.calls.load(Ordering::Acquire) == before {
            assert!(std::time::Instant::now() < until);
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        assert!(cancel.cancel(&request_id));
    });
    assert_eq!(
        harness
            .process
            .invoke_with_operation(permit, "mfa_hotp_next", Some(json!({"id":id})))
            .unwrap_err()
            .rpc_code(),
        -32006
    );
    canceller.join().unwrap();
    harness.backend.delay_ms.store(0, Ordering::Release);
    assert_eq!(harness.codes()[0]["counter"], 0);
    assert_eq!(harness.codes()[0]["code"], "755224");
    harness.restart();
    assert_eq!(harness.codes()[0]["counter"], 0);
}
