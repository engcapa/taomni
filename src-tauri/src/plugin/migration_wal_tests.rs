//! Real SQLite/WAL and journal contracts; run on the hosted native runners.

use super::*;
use rusqlite::Connection;
use tempfile::{TempDir, tempdir};

fn wal_database(name: &str, schema: &str) -> (TempDir, PathBuf, Connection) {
    let directory = tempdir().unwrap();
    let path = directory.path().canonicalize().unwrap().join(name);
    let database = Connection::open(&path).unwrap();
    database
        .execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;")
        .unwrap();
    database.execute_batch(schema).unwrap();
    database
        .execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
        .unwrap();
    (directory, path, database)
}

#[test]
fn wal_only_commits_refresh_pending_fingerprints_without_changing_main_or_rows() {
    let (directory, path, database) = wal_database(
        "taomni.db",
        "CREATE TABLE sessions (id TEXT, session_type TEXT, options_json TEXT);",
    );
    database
        .execute_batch("INSERT INTO sessions VALUES ('vnc', 'VNC', 'original opaque options')")
        .unwrap();
    let main = fs::read(&path).unwrap();
    let first = inspect_legacy_install(directory.path(), "0.5.9").unwrap();
    let journal_path = directory.path().join("migration/journal.json");
    let plugins = directory.path().join("plugins");
    let executor =
        MigrationExecutor::new(directory.path(), &plugins, &journal_path, "0.5.9", "1").unwrap();
    executor.record_pending(&first).unwrap();
    let first_journal = fs::read(&journal_path).unwrap();

    database
        .execute_batch("UPDATE sessions SET options_json = 'committed WAL-only options'")
        .unwrap();
    assert_eq!(fs::read(&path).unwrap(), main);
    let second = inspect_legacy_install(directory.path(), "0.5.9").unwrap();
    assert_eq!(first.candidates, second.candidates);
    assert_ne!(
        first.source_fingerprints["taomni.db"],
        second.source_fingerprints["taomni.db"]
    );
    executor.record_pending(&second).unwrap();
    assert_ne!(fs::read(&journal_path).unwrap(), first_journal);
    let journal = MigrationJournal::load(&journal_path).unwrap();
    assert_eq!(journal.entries.len(), 1);
    assert_eq!(
        journal.entries[0].source_fingerprint,
        second.source_fingerprints["taomni.db"]
    );
    assert_eq!(journal.entries[0].state, MigrationStepState::Pending);
    assert!(journal.entries[0].target.as_os_str().is_empty());
    let stable_journal = fs::read(&journal_path).unwrap();
    executor
        .record_pending(&inspect_legacy_install(directory.path(), "0.5.9").unwrap())
        .unwrap();
    assert_eq!(fs::read(&journal_path).unwrap(), stable_journal);
    assert_eq!(fs::read(&path).unwrap(), main);
    assert_eq!(
        database
            .query_row("SELECT options_json FROM sessions", [], |row| row
                .get::<_, String>(0))
            .unwrap(),
        "committed WAL-only options"
    );
    assert!(!plugins.exists());
}

#[test]
fn a_writer_racing_read_only_discovery_requires_a_retry() {
    let (_directory, path, database) =
        wal_database("taomni.db", "CREATE TABLE sessions (session_type TEXT);");
    database
        .execute("INSERT INTO sessions VALUES ('VNC')", [])
        .unwrap();
    let result = source::read_snapshot(&path, |reader| {
        assert_eq!(
            reader
                .query_row("SELECT count(*) FROM sessions", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
        database
            .execute("INSERT INTO sessions VALUES ('RDP')", [])
            .unwrap();
        // SQLite still exposes one consistent old read snapshot. Its file
        // fingerprint must not falsely describe the newer WAL state.
        assert_eq!(
            reader
                .query_row("SELECT count(*) FROM sessions", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
        Ok(())
    });
    let error = result.unwrap_err();
    assert!(
        error.contains("changed during upgrade inspection"),
        "{error}"
    );
    let (count, _) = source::read_snapshot(&path, |reader| {
        reader
            .query_row("SELECT count(*) FROM sessions", [], |row| {
                row.get::<_, i64>(0)
            })
            .map_err(|error| error.to_string())
    })
    .unwrap();
    assert_eq!(count, 2);
}

#[test]
fn vault_fixed_key_and_mfa_files_include_their_wal_inputs() {
    for (name, schema, first_write, second_write) in [
        (
            "vault.db",
            "CREATE TABLE vault_entries (id TEXT, ciphertext TEXT)",
            "INSERT INTO vault_entries VALUES ('mfa.data-key-v1', 'opaque ciphertext A')",
            "UPDATE vault_entries SET ciphertext = 'opaque ciphertext B'",
        ),
        (
            "mfa.db",
            "CREATE TABLE accounts (ciphertext TEXT)",
            "INSERT INTO accounts VALUES ('opaque ciphertext A')",
            "UPDATE accounts SET ciphertext = 'opaque ciphertext B'",
        ),
    ] {
        let (directory, path, database) = wal_database(name, schema);
        database.execute_batch(first_write).unwrap();
        let main = fs::read(&path).unwrap();
        let first = inspect_legacy_install(directory.path(), "0.5.9").unwrap();
        database.execute_batch(second_write).unwrap();
        let second = inspect_legacy_install(directory.path(), "0.5.9").unwrap();
        assert_eq!(first.candidates, second.candidates);
        assert_eq!(second.candidates.len(), 1);
        assert_eq!(second.candidates[0].item, MigrationItem::Mfa);
        assert_ne!(
            first.source_fingerprints[name],
            second.source_fingerprints[name]
        );
        assert_eq!(fs::read(&path).unwrap(), main);
        let public = serde_json::to_string(&second).unwrap();
        assert!(!public.contains("opaque ciphertext"));
    }
}

#[cfg(unix)]
#[test]
fn linked_wal_is_rejected_before_sqlite_reads_it() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("taomni.db");
    let database = Connection::open(&path).unwrap();
    database
        .execute_batch("CREATE TABLE sessions (session_type TEXT)")
        .unwrap();
    drop(database);
    let target = directory.path().join("outside-input");
    fs::write(&target, b"not a SQLite WAL; must never be opened by SQLite").unwrap();
    std::os::unix::fs::symlink(&target, path.with_file_name("taomni.db-wal")).unwrap();
    let error = inspect_legacy_install(directory.path(), "0.5.9").unwrap_err();
    assert!(error.contains("must be a regular file"));
    assert_eq!(
        fs::read(target).unwrap(),
        b"not a SQLite WAL; must never be opened by SQLite"
    );
}
