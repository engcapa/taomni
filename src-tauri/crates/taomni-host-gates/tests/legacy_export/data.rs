use std::fs;

use rusqlite::{Connection, types::Value};
use serde_json::json;
use taomni_mfa_engine as engine;
use taomni_profile_locks::{ProfileRoot, ProfileUseLease};

use super::{
    migration::{
        export::{MfaExportKind, PreparedMfaExport},
        inspect_legacy_install,
    },
    support::*,
};

fn rows(connection: &Connection, query: &str) -> Vec<Vec<Value>> {
    let mut statement = connection.prepare(query).unwrap();
    let count = statement.column_count();
    statement
        .query_map([], |row| (0..count).map(|index| row.get(index)).collect())
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
}

#[test]
#[ignore = "real SQLite, files and OS leases run only on GitHub"]
fn committed_wal_preserves_encrypted_hotp_metadata_preferences_and_source_bytes() {
    let fixture = Fixture::new();
    let snapshot = fixture.snapshot();
    let before = fixture.bytes();
    let original_main = readonly(&fixture.root.path().join("mfa.db"));
    // Read a copy of just the main file to establish the distinguishing oracle.
    let main_copy = fixture.root.path().join("main-only.db");
    fs::copy(fixture.root.path().join("mfa.db"), &main_copy).unwrap();
    assert_eq!(
        engine::store::count_accounts(&readonly(&main_copy)).unwrap(),
        0
    );
    assert_eq!(engine::store::count_accounts(&original_main).unwrap(), 1);
    let active = fixture.root.path().join("plugins/mfa/active.json");
    let live_data = fixture.root.path().join("plugins/mfa/data/mfa.db");
    fs::create_dir_all(live_data.parent().unwrap()).unwrap();
    fs::write(&active, b"existing-active-pointer").unwrap();
    fs::write(&live_data, b"existing-module-data").unwrap();
    fs::create_dir_all(fixture.root.path().join("migration")).unwrap();
    let journal = fixture.root.path().join("migration/journal.json");
    fs::write(&journal, b"existing-pending-journal").unwrap();

    let prepared = PreparedMfaExport::prepare(&fixture.root, &snapshot, &control()).unwrap();
    assert!(ProfileUseLease::try_acquire(&fixture.root).is_err());
    assert_eq!(prepared.receipt().kind, MfaExportKind::Database);
    assert_eq!(prepared.receipt().target.as_deref(), Some("data/mfa.db"));
    assert!(prepared.receipt().fixed_key_present);
    assert_eq!(
        prepared.receipt().source_fingerprints,
        snapshot.source_fingerprints
    );
    let path = prepared.database_path().unwrap();
    let exported = readonly(&path);
    for table in ["mfa_accounts", "mfa_meta", "mfa_prefs"] {
        let query = format!("SELECT * FROM {table} ORDER BY 1");
        assert_eq!(rows(&exported, &query), rows(&fixture.mfa, &query));
    }
    assert_eq!(
        rows(&exported, "SELECT sql FROM sqlite_master ORDER BY name"),
        rows(&fixture.mfa, "SELECT sql FROM sqlite_master ORDER BY name")
    );
    assert_eq!(
        rows(&exported, "PRAGMA user_version"),
        rows(&fixture.mfa, "PRAGMA user_version")
    );
    let original_key = engine::keys::prepare_key(&exported, &KnownKey)
        .unwrap()
        .unwrap();
    let codes = engine::operations::codes(&exported, &original_key, None, 0).unwrap();
    assert_eq!(codes.len(), 1);
    assert_eq!(codes[0].code, "755224");
    assert_eq!(codes[0].counter, 0);
    prepared.verify().unwrap();
    unchanged(&before);
    assert_eq!(fs::read(&active).unwrap(), b"existing-active-pointer");
    assert_eq!(fs::read(&live_data).unwrap(), b"existing-module-data");
    assert_eq!(fs::read(&journal).unwrap(), b"existing-pending-journal");
    evidence("mfa-export-wal-receipt", prepared.receipt());
    evidence(
        "mfa-export-wal-assertions",
        &json!({
            "main_only_accounts": 0, "exported_accounts": 1, "original_hotp_verified": true,
            "all_rows_schema_metadata_preferences_equal": true, "source_bytes_unchanged": true,
            "journal_active_and_existing_data_unchanged": true,
        }),
    );
    drop(exported);
    drop(prepared);
    assert!(!path.exists());
    fixture.assert_no_staging();
    assert!(ProfileUseLease::try_acquire(&fixture.root).is_ok());
}

#[test]
#[ignore = "real SQLite, files and OS leases run only on GitHub"]
fn uncommitted_writer_rows_are_excluded_from_the_standalone_export() {
    let fixture = Fixture::new();
    let snapshot = fixture.snapshot();
    fixture
        .mfa
        .execute_batch("BEGIN IMMEDIATE; UPDATE mfa_accounts SET counter=9, note='uncommitted'")
        .unwrap();
    let prepared = PreparedMfaExport::prepare(&fixture.root, &snapshot, &control()).unwrap();
    let exported = readonly(&prepared.database_path().unwrap());
    let result = rows(&exported, "SELECT counter,note FROM mfa_accounts");
    assert_eq!(
        result,
        vec![vec![
            Value::Integer(0),
            Value::Text("original metadata".into())
        ]]
    );
    assert_eq!(
        rows(&fixture.mfa, "SELECT counter FROM mfa_accounts"),
        vec![vec![Value::Integer(9)]]
    );
    fixture.mfa.execute_batch("ROLLBACK").unwrap();
    prepared.verify().unwrap();
    evidence(
        "mfa-export-uncommitted",
        &json!({"committed_counter": 0, "uncommitted_counter_excluded": 9}),
    );
    drop(exported);
    drop(prepared);
    fixture.assert_no_staging();
}

#[test]
#[ignore = "real SQLite, files and OS leases run only on GitHub"]
fn key_only_profile_keeps_the_original_key_without_creating_a_store() {
    let directory = tempfile::tempdir().unwrap();
    let root = ProfileRoot::prepare(directory.path()).unwrap();
    let vault_path = root.path().join("vault.db");
    let vault = Connection::open(&vault_path).unwrap();
    vault
        .execute_batch(
            "CREATE TABLE vault_entries (id TEXT, ciphertext TEXT);
         INSERT INTO vault_entries VALUES ('mfa.data-key-v1','private-key-only-fixture');",
        )
        .unwrap();
    let before = fs::read(&vault_path).unwrap();
    let snapshot = inspect_legacy_install(root.path(), "0.5.9").unwrap();
    let prepared = PreparedMfaExport::prepare(&root, &snapshot, &control()).unwrap();
    assert_eq!(prepared.receipt().kind, MfaExportKind::VaultKeyOnly);
    assert!(prepared.database_path().is_none());
    assert!(prepared.receipt().database_fingerprint.is_none());
    assert!(prepared.receipt().database_bytes.is_none());
    assert!(prepared.receipt().target.is_none());
    assert!(!root.path().join("mfa.db").exists());
    assert!(!root.path().join("plugins").exists());
    assert_eq!(fs::read(&vault_path).unwrap(), before);
    let receipt = serde_json::to_string(prepared.receipt()).unwrap();
    assert!(!receipt.contains("private-key-only-fixture"));
    prepared.verify().unwrap();
    evidence("mfa-export-key-only", prepared.receipt());
    drop(prepared);
    assert!(!root.path().join("mfa.db").exists());
    assert_eq!(fs::read(&vault_path).unwrap(), before);
}
