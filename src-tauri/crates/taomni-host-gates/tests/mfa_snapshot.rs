//! Actual MFA connection, WAL, serial actor barriers and scoped keys.
mod mfa_support;
use mfa_support::*;
use rusqlite::{Connection, OpenFlags};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::sync::atomic::Ordering;
use taomni_plugin_api::services::CoreServiceError;
use taomni_plugin_services::OperationKind;

fn counter_and_code(path: &std::path::Path) -> (u64, String) {
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let codes =
        taomni_mfa_engine::operations::codes(&db, &zeroize::Zeroizing::new(KEY), None, 0).unwrap();
    let result = (codes[0].counter, codes[0].code.clone());
    db.close().unwrap();
    result
}

#[test]
#[ignore = "actual MFA process and WAL snapshot: GitHub runners only"]
fn mfa_snapshot_needs_no_vault_key_and_preserves_wal_and_hotp_until_release() {
    let mut harness = Harness::new();
    harness.initialize();
    let id = harness.add();
    let before = std::fs::read(harness.source().with_file_name("mfa.db-wal")).unwrap();
    let key_calls = harness.backend.calls.load(Ordering::Acquire);
    *harness.backend.key.lock().unwrap() = Err(CoreServiceError::VaultLocked);
    let request = harness.snapshot_request(ID, &["mfa.db"]);
    let prepared = harness
        .process
        .prepare_snapshot(&request, deadline(), &|| false)
        .unwrap();
    let error = harness
        .call(
            OperationKind::WriteData,
            "mfa_hotp_next",
            Some(json!({"id":id})),
        )
        .unwrap_err();
    assert!(error.to_string().contains("PLUGIN_SNAPSHOT_BUSY"));
    let receipt = harness
        .process
        .snapshot(&prepared, request.destination.token, deadline(), &|| false)
        .unwrap();
    assert_eq!(receipt.files.len(), 1);
    assert_eq!(receipt.files[0].relative_path.as_str(), "mfa.db");
    let snapshot = request.destination.absolute_job_root.join("mfa.db");
    let bytes = std::fs::read(&snapshot).unwrap();
    assert_eq!(
        receipt.files[0].sha256.as_str(),
        format!("{:x}", Sha256::digest(&bytes))
    );
    assert_eq!(receipt.files[0].size_bytes, bytes.len() as u64);
    assert_eq!(counter_and_code(&snapshot), (0, "755224".into()));
    assert_eq!(
        std::fs::read(harness.source().with_file_name("mfa.db-wal")).unwrap(),
        before
    );
    assert_eq!(harness.backend.calls.load(Ordering::Acquire), key_calls);
    harness
        .process
        .release_snapshot(&prepared, deadline())
        .unwrap();
    *harness.backend.key.lock().unwrap() = Ok(Some(KEY));
    harness
        .call(
            OperationKind::WriteData,
            "mfa_hotp_next",
            Some(json!({"id":id})),
        )
        .unwrap();
    harness.restart();
    // Normal startup must reclaim its authoritative persisted connection,
    // before a business command or Vault key request opens the store.
    let key_calls = harness.backend.calls.load(Ordering::Acquire);
    let request = harness.snapshot_request(OTHER, &["mfa.db"]);
    let prepared = harness
        .process
        .prepare_snapshot(&request, deadline(), &|| false)
        .unwrap();
    harness
        .process
        .snapshot(&prepared, request.destination.token, deadline(), &|| false)
        .unwrap();
    assert_eq!(
        counter_and_code(&request.destination.absolute_job_root.join("mfa.db")),
        (1, "287082".into())
    );
    assert_eq!(harness.backend.calls.load(Ordering::Acquire), key_calls);
    harness
        .process
        .release_snapshot(&prepared, deadline())
        .unwrap();
    assert_eq!(harness.codes()[0]["code"], "287082");
}

#[test]
#[ignore = "actual unused MFA process snapshot: GitHub runners only"]
fn unused_mfa_snapshot_never_creates_a_store_or_reads_or_initializes_a_key() {
    let mut harness = Harness::new();
    let request = harness.snapshot_request(ID, &[]);
    let prepared = harness
        .process
        .prepare_snapshot(&request, deadline(), &|| false)
        .unwrap();
    let result = harness
        .process
        .snapshot(&prepared, request.destination.token, deadline(), &|| false)
        .unwrap();
    assert!(result.files.is_empty());
    harness
        .process
        .release_snapshot(&prepared, deadline())
        .unwrap();
    assert!(!harness.source().exists());
    assert_eq!(harness.backend.calls.load(Ordering::Acquire), 0);
    assert_eq!(harness.backend.creations.load(Ordering::Acquire), 0);
    assert_eq!(
        std::fs::read_dir(request.destination.absolute_job_root)
            .unwrap()
            .count(),
        0
    );
    harness.initialize();
    harness.add();
    assert_eq!(harness.codes()[0]["code"], "755224");
}
