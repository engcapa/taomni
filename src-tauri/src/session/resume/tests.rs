use super::clearing::clear_run_snapshot;
use super::commit::commit_run_snapshot;
use super::legacy::legacy_candidate;
use super::metadata::init_tables;
use super::model::SnapshotEntry;
use super::reading::get_run_snapshot;
use rusqlite::Connection;

use rusqlite::params;

fn test_conn() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE sessions (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                session_type TEXT NOT NULL,
                group_path TEXT,
                host TEXT NOT NULL DEFAULT '',
                port INTEGER NOT NULL DEFAULT 22,
                username TEXT,
                auth_method TEXT NOT NULL DEFAULT '\"Password\"',
                options_json TEXT NOT NULL DEFAULT '{}',
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                last_connected_at INTEGER,
                sort_order INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS welcome_metadata (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );",
    )
    .unwrap();
    crate::terminal::local_directories::init_tables(&conn).unwrap();
    init_tables(&conn).unwrap();
    conn
}

fn insert_session(
    conn: &Connection,
    id: &str,
    name: &str,
    session_type: &str,
    last_connected_at: Option<i64>,
) {
    conn.execute(
        "INSERT INTO sessions (id, name, session_type, created_at, updated_at, last_connected_at)
             VALUES (?1, ?2, ?3, 0, 0, ?4)",
        params![id, name, session_type, last_connected_at],
    )
    .unwrap();
}

fn saved_entry(id: &str, session_type: &str) -> SnapshotEntry {
    SnapshotEntry::SavedSession {
        identity: format!("saved:{id}"),
        saved_session_id: id.to_string(),
        saved_session_type: session_type.to_string(),
        display_name: format!("session-{id}"),
    }
}

/// Legacy candidate: max positive last_connected_at, ties by id byte
/// order; empty/negative/ineligible entries are skipped in order.
#[test]
fn legacy_candidate_picks_latest_positive_and_skips_ineligible() {
    let conn = test_conn();
    insert_session(&conn, "b", "newer-ineligible", "Browser", Some(2000));
    insert_session(&conn, "a", "older", "SSH", Some(1000));
    insert_session(&conn, "z", "tie-loser", "SSH", Some(1500));
    insert_session(&conn, "y", "tie-winner", "SFTP", Some(1500));
    insert_session(&conn, "n", "never-connected", "SSH", None);
    insert_session(&conn, "neg", "negative", "SSH", Some(-5));

    let response = get_run_snapshot(&conn).unwrap();
    let candidate = response.legacy_candidate.expect("legacy candidate");
    match &candidate {
        SnapshotEntry::SavedSession {
            saved_session_id,
            saved_session_type,
            display_name,
            ..
        } => {
            assert_eq!(
                saved_session_id, "y",
                "latest positive time; id tie broken ascending"
            );
            assert_eq!(saved_session_type, "SFTP");
            assert_eq!(display_name, "tie-winner");
        }
        other => panic!("unexpected candidate {other:?}"),
    }
}

/// A committed snapshot takes precedence; legacy is not consulted.
#[test]
fn confirmed_snapshot_beats_legacy_candidate() {
    let mut conn = test_conn();
    insert_session(&conn, "a", "old", "SSH", Some(5000));

    let mut entries = vec![saved_entry("a", "SSH")];
    let response =
        commit_run_snapshot(&mut conn, "batch-1".into(), &mut entries, None, None, false).unwrap();
    assert!(response.applied);

    let response = get_run_snapshot(&conn).unwrap();
    assert!(response.legacy_candidate.is_none());
    let record = response.record.expect("snapshot record");
    assert_eq!(record.entries.len(), 1);
    assert_eq!(record.revision, 1);
}

/// Config deleted: the snapshot keeps the reference; the frontend re-reads
/// the config and reports missing-session (AC-15).
#[test]
fn snapshot_survives_session_deletion_and_replace() {
    let mut conn = test_conn();
    insert_session(&conn, "a", "will-be-deleted", "SSH", None);
    let mut entries = vec![saved_entry("a", "SSH")];
    commit_run_snapshot(&mut conn, "batch".into(), &mut entries, None, None, false).unwrap();

    conn.execute("DELETE FROM sessions WHERE id = 'a'", [])
        .unwrap();
    // INSERT OR REPLACE must not cascade into the snapshot either.
    insert_session(&conn, "a", "replaced", "SSH", None);
    conn.execute(
        "INSERT OR REPLACE INTO sessions
             (id, name, session_type, created_at, updated_at, last_connected_at)
             VALUES ('a', 'replaced2', 'SSH', 0, 0, NULL)",
        [],
    )
    .unwrap();

    let response = get_run_snapshot(&conn).unwrap();
    let record = response
        .record
        .expect("record preserved without foreign keys");
    assert_eq!(record.entries.len(), 1);
}

/// Clear tombstone: snapshot removed, legacy candidate suppressed, and a
/// later normal use (restored commit) revives the record.
#[test]
fn clear_tombstone_suppresses_legacy_and_revision_advances() {
    let mut conn = test_conn();
    insert_session(&conn, "a", "legacy source", "SSH", Some(1000));
    let mut entries = vec![saved_entry("a", "SSH")];
    commit_run_snapshot(&mut conn, "batch".into(), &mut entries, None, None, false).unwrap();
    clear_run_snapshot(&mut conn, None).unwrap();

    let response = get_run_snapshot(&conn).unwrap();
    assert!(response.record.is_none());
    assert!(
        response.legacy_candidate.is_none(),
        "cleared record must not resurrect from the legacy list"
    );

    // Revision kept advancing across the clear (no ABA).
    let mut entries = vec![saved_entry("a", "SSH")];
    let response =
        commit_run_snapshot(&mut conn, "batch2".into(), &mut entries, None, None, true).unwrap();
    assert!(response.applied);
    assert!(response.record.as_ref().unwrap().revision >= 3);
    let response = get_run_snapshot(&conn).unwrap();
    assert!(
        response.record.is_some(),
        "restored commit revives the record"
    );
}

/// CAS: expectedRevision mismatch does not overwrite the newer commit.
#[test]
fn cas_mismatch_does_not_overwrite_newer_record() {
    let mut conn = test_conn();
    let mut entries = vec![saved_entry("a", "SSH")];
    let first = commit_run_snapshot(
        &mut conn,
        "b1".into(),
        &mut entries.clone(),
        None,
        None,
        false,
    )
    .unwrap();
    let first_revision = first.record.as_ref().unwrap().revision;

    let mut newer = vec![saved_entry("b", "SFTP")];
    let second =
        commit_run_snapshot(&mut conn, "b2".into(), &mut newer, None, None, false).unwrap();
    let second_revision = second.record.as_ref().unwrap().revision;
    assert!(second_revision > first_revision);

    // A late writer holding the stale revision must not win.
    let mut stale = vec![saved_entry("c", "VNC")];
    let response = commit_run_snapshot(
        &mut conn,
        "b3".into(),
        &mut stale,
        None,
        Some(first_revision),
        false,
    )
    .unwrap();
    assert!(!response.applied);
    let record = response
        .record
        .expect("current record returned on CAS miss");
    match &record.entries[0] {
        SnapshotEntry::SavedSession {
            saved_session_id, ..
        } => {
            assert_eq!(saved_session_id, "b", "the newer commit survives");
        }
        other => panic!("unexpected entry {other:?}"),
    }
}

/// Unknown schema: reading reports an issue and committing refuses.
#[test]
fn unknown_schema_is_protected() {
    let conn = test_conn();
    conn.execute(
        "INSERT INTO welcome_run_snapshot
             (singleton, schema_version, revision, run_sequence, batch_id, committed_at_ms,
              entries_json, active_identity)
             VALUES (1, 99, 1, 1, 'future', 0, '[]', NULL)",
        [],
    )
    .unwrap();

    let response = get_run_snapshot(&conn).unwrap();
    assert!(response.record.is_none());
    assert!(response.legacy_candidate.is_none());
    let issue = response.issue.expect("unsupported schema issue");
    assert_eq!(issue.code, "unsupported");

    let mut conn = conn;
    let mut entries = vec![saved_entry("a", "SSH")];
    let result = commit_run_snapshot(&mut conn, "b".into(), &mut entries, None, None, false);
    assert!(
        result.is_err(),
        "must refuse to overwrite an unknown schema"
    );
    let version: i64 = conn
        .query_row(
            "SELECT schema_version FROM welcome_run_snapshot WHERE singleton = 1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(version, 99, "foreign schema row untouched");
}

/// Entry validation: empty snapshot, invalid local cwd and duplicate
/// identities are rejected; unknown-but-nonempty types are stored raw
/// (never defaulted to SSH).
#[test]
fn entry_validation_rules() {
    let mut conn = test_conn();

    let mut empty: Vec<SnapshotEntry> = Vec::new();
    assert!(
        commit_run_snapshot(&mut conn, "b".into(), &mut empty, None, None, false).is_err(),
        "empty snapshots are never committed"
    );

    let mut bad_cwd = vec![SnapshotEntry::LocalTerminal {
        identity: String::new(),
        display_name: "wsl-ish".to_string(),
        shell_id: "wsl.exe".to_string(),
        shell_args: vec!["-d".to_string(), "Ubuntu".to_string()],
        confirmed_cwd: "/home/user/linux-only".to_string(),
    }];
    // On a Linux test host "/home/user/linux-only" is lexically absolute,
    // so exercise the real boundary with a relative path instead.
    let mut bad_cwd = vec![SnapshotEntry::LocalTerminal {
        identity: String::new(),
        display_name: "relative".to_string(),
        shell_id: "bash".to_string(),
        shell_args: vec![],
        confirmed_cwd: "relative/path".to_string(),
    }];
    assert!(
        commit_run_snapshot(&mut conn, "b".into(), &mut bad_cwd, None, None, false).is_err(),
        "relative cwd is not a confirmed native cwd"
    );

    let mut dup = vec![saved_entry("a", "SSH"), saved_entry("a", "SSH")];
    assert!(
        commit_run_snapshot(&mut conn, "b".into(), &mut dup, None, None, false).is_err(),
        "duplicate identities are rejected"
    );

    // Unknown raw type is preserved verbatim (no SSH fallback).
    let mut unknown = vec![saved_entry("u", "SomeFutureProtocol")];
    let response =
        commit_run_snapshot(&mut conn, "b".into(), &mut unknown, None, None, false).unwrap();
    match &response.record.unwrap().entries[0] {
        SnapshotEntry::SavedSession {
            saved_session_type, ..
        } => assert_eq!(saved_session_type, "SomeFutureProtocol"),
        other => panic!("unexpected entry {other:?}"),
    }
}

/// Active identity must reference a real entry; reopen keeps data intact.
#[test]
fn active_identity_and_reopen_persistence() {
    let dir = tempfile::TempDir::new().unwrap();
    let path = dir.path().join("taomni.db");
    {
        let mut conn = Connection::open(&path).unwrap();
        test_schema(&mut conn);
        let mut entries = vec![saved_entry("a", "SSH"), saved_entry("b", "LocalShell")];
        let response = commit_run_snapshot(
            &mut conn,
            "batch".into(),
            &mut entries,
            Some("saved:b".to_string()),
            None,
            false,
        )
        .unwrap();
        assert!(response.applied);
    }
    {
        let conn = Connection::open(&path).unwrap();
        test_schema_readonly(&conn);
        let response = get_run_snapshot(&conn).unwrap();
        let record = response.record.expect("persisted across reopen");
        assert_eq!(record.active_identity.as_deref(), Some("saved:b"));
        assert_eq!(record.entries.len(), 2);
    }
    // Mismatched active identity is rejected.
    let mut conn = Connection::open(&path).unwrap();
    test_schema(&mut conn);
    let mut entries = vec![saved_entry("a", "SSH")];
    assert!(
        commit_run_snapshot(
            &mut conn,
            "b".into(),
            &mut entries,
            Some("saved:zz".to_string()),
            None,
            false
        )
        .is_err()
    );
}

fn test_schema(conn: &mut Connection) {
    crate::terminal::local_directories::init_tables(conn).unwrap();
    init_tables(conn).unwrap();
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                session_type TEXT NOT NULL,
                group_path TEXT,
                host TEXT NOT NULL DEFAULT '',
                port INTEGER NOT NULL DEFAULT 22,
                username TEXT,
                auth_method TEXT NOT NULL DEFAULT '\"Password\"',
                options_json TEXT NOT NULL DEFAULT '{}',
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                last_connected_at INTEGER,
                sort_order INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS welcome_metadata (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );",
    )
    .unwrap();
}

fn test_schema_readonly(conn: &Connection) {
    init_tables(conn).unwrap();
}
