use super::*;
use crate::plugin::migration::{MigrationExecutor, inspect_legacy_install};
use std::fs;

fn legacy_profile() -> tempfile::TempDir {
    let root = tempfile::tempdir().unwrap();
    fs::create_dir_all(root.path().join("plugins/rdp-client")).unwrap();
    let db = Connection::open(root.path().join(LEGACY_DATABASE)).unwrap();
    db.execute_batch(PINS_SCHEMA).unwrap();
    db.execute_batch("CREATE TABLE sessions (session_type TEXT NOT NULL);")
        .unwrap();
    db.execute(
        "INSERT INTO rdp_certificate_pins VALUES ('old.example:3389', ?1, 7)",
        ["AB".repeat(32)],
    )
    .unwrap();
    root
}

#[test]
fn copies_only_the_pin_table_and_keeps_its_receipt_in_the_repeated_preflight() {
    let root = legacy_profile();
    let data = root.path();
    let before = fs::read(data.join(LEGACY_DATABASE)).unwrap();
    import(data).unwrap();
    let db = Connection::open(data.join(PINS_DATABASE)).unwrap();
    let pins = read_legacy_pins(&db).unwrap();
    assert_eq!(pins, vec![("old.example:3389".into(), "ab".repeat(32), 7)]);
    assert!(!table_exists(&db, "sessions").unwrap());
    assert_eq!(fs::read(data.join(LEGACY_DATABASE)).unwrap(), before);

    let journal_path = data.join("migration/journal.json");
    let prior = MigrationJournal::load(&journal_path).unwrap();
    assert_eq!(prior.committed_rdp_pins(), Ok(true));
    let snapshot = inspect_legacy_install(data, LEGACY_SOURCE_VERSION).unwrap();
    let executor = MigrationExecutor::new(
        data,
        data.join("plugins"),
        &journal_path,
        LEGACY_SOURCE_VERSION,
        CORE_API_VERSION,
    )
    .unwrap();
    let result = executor.record_pending(&snapshot).unwrap();
    assert_eq!(result.committed, [MigrationItem::RdpCertificatePins]);
    let after = MigrationJournal::load(&journal_path).unwrap();
    assert_eq!(after.entries, prior.entries);
}

#[test]
fn interruption_after_publish_recovers_the_original_fingerprint() {
    let root = legacy_profile();
    let data = root.path();
    import(data).unwrap();
    let journal_path = data.join("migration/journal.json");
    let prior = MigrationJournal::load(&journal_path).unwrap();
    fs::remove_file(&journal_path).unwrap();
    {
        let legacy = Connection::open(data.join(LEGACY_DATABASE)).unwrap();
        legacy
            .execute(
                "UPDATE rdp_certificate_pins SET fingerprint = ?1",
                ["bb".repeat(32)],
            )
            .unwrap();
    }
    import(data).unwrap();
    assert_eq!(
        MigrationJournal::load(&journal_path).unwrap().entries,
        prior.entries
    );
    let db = Connection::open(data.join(PINS_DATABASE)).unwrap();
    assert_eq!(read_legacy_pins(&db).unwrap()[0].1, "ab".repeat(32));
}

#[test]
fn deleting_module_data_keeps_the_committed_legacy_import_retired() {
    let root = legacy_profile();
    let data = root.path();
    import(data).unwrap();
    fs::remove_file(data.join(PINS_DATABASE)).unwrap();
    import(data).unwrap();
    assert!(!data.join(PINS_DATABASE).exists());
    assert!(data.join(LEGACY_DATABASE).is_file());
}
