use super::identity::normalize_path_key;
use super::limits::MAX_DISPLAYED_NON_DEFAULT;
use super::limits::SOURCE_LOCAL_CWD;
use super::limits::SOURCE_LOCAL_START;
use super::listing::compare_directories;
use super::listing::default_candidates;
use super::listing::list_directory_shortcuts;
use super::listing::merge_directory_candidates;
use super::migration::migrate_legacy_history;
use super::model::Availability;
use super::model::DirectoryRow;
use super::model::PersistedRow;
use super::recording::record_directory_use;
use super::schema::METADATA_MIGRATION_COMPLETE;
use super::schema::init_tables;
use rusqlite::Connection;
use rusqlite::params;
use std::path::Path;
use std::path::PathBuf;

fn row(
    id: &str,
    display_path: &str,
    identity_key: &str,
    last_used_at_ms: Option<i64>,
    legacy_rank: Option<i64>,
    default_rank: Option<u32>,
) -> DirectoryRow {
    DirectoryRow {
        directory_id: id.to_string(),
        display_path: display_path.to_string(),
        label: "L".to_string(),
        kind: "personal".to_string(),
        last_used_at_ms,
        time_source: last_used_at_ms.map(|_| SOURCE_LOCAL_START.to_string()),
        legacy_rank,
        default_rank,
        default_id: default_rank.map(|_| format!("default-{default_rank:?}")),
        identity_key: identity_key.to_string(),
        availability: Availability::Unknown,
    }
}

/// AC-01/AC-03: confirmed times dominate regardless of input order;
/// legacy ranks beat unconfirmed defaults; ties resolve by identity key.
#[test]
fn ordering_is_deterministic_across_shuffled_input() {
    let a_confirmed = row("a", "/a", "/a", Some(3000), None, None);
    let home = row("home", "/home", "/home", Some(2000), None, Some(0));
    let downloads = row("dl", "/dl", "/dl", Some(1000), None, Some(3));
    let legacy = row("l1", "/l1", "/l1", None, Some(4), None);
    let unconfirmed_default = row("d9", "/d9", "/d9", None, None, Some(9));
    let tie1 = row("t1", "/t1", "/t1", Some(3000), None, None);
    let tie2 = row("t2", "/t2", "/t2", Some(3000), None, None);

    let expected_ids = ["a", "t1", "t2", "home", "dl", "l1", "d9"];
    let build = || {
        let mut rows = vec![
            unconfirmed_default.clone(),
            downloads.clone(),
            legacy.clone(),
            a_confirmed.clone(),
            tie2.clone(),
            home.clone(),
            tie1.clone(),
        ];
        rows.sort_by(compare_directories);
        rows.into_iter().map(|r| r.directory_id).collect::<Vec<_>>()
    };
    let first = build();
    assert_eq!(
        first, expected_ids,
        "shuffled input must still sort the same"
    );
    let second = build();
    assert_eq!(first, second, "re-sorting must be stable");
}

/// AC-04: same path with different textual forms merges into one row and
/// the default name/kind wins; confirmed time survives the merge.
#[test]
fn default_and_history_paths_merge_without_losing_time() {
    let home = std::env::temp_dir().join(format!("taomni-ldt-merge-{}", std::process::id()));
    std::fs::create_dir_all(&home).unwrap();
    let downloads = home.join("Downloads");
    std::fs::create_dir_all(&downloads).unwrap();
    let defaults = vec![(
        "downloads".to_string(),
        3u32,
        "Downloads".to_string(),
        downloads.clone(),
    )];
    // Legacy-persisted row for the same directory under a different
    // display path with a confirmed time.
    let persisted = vec![PersistedRow {
        directory_id: "used-1".to_string(),
        display_path: downloads.to_string_lossy().into_owned(),
        label: "weird case".to_string(),
        kind: "personal".to_string(),
        last_used_at_ms: Some(1234),
        last_use_source: Some(SOURCE_LOCAL_CWD.to_string()),
        legacy_rank: None,
        identity_key: normalize_path_key(&downloads).unwrap(),
    }];
    let merged = merge_directory_candidates(persisted, &defaults);
    let matches: Vec<&DirectoryRow> = merged
        .iter()
        .filter(|r| r.display_path == downloads.to_string_lossy())
        .collect();
    assert_eq!(matches.len(), 1, "one row for one identity, got {merged:?}");
    let row = matches[0];
    assert_eq!(row.label, "Downloads");
    assert_eq!(row.kind, "system");
    assert_eq!(row.last_used_at_ms, Some(1234));
    assert_eq!(row.default_rank, Some(3));
    std::fs::remove_dir_all(&home).ok();
}

/// Identity: canonicalize merges case-variant spellings on
/// case-insensitive volumes; POSIX backslashes stay literal filenames.
#[test]
fn path_key_normalization_rules() {
    let tmp = std::env::temp_dir().join(format!("taomni-ldt-key-{}", std::process::id()));
    std::fs::create_dir_all(&tmp).unwrap();
    let key = normalize_path_key(&tmp).expect("temp dir key");
    assert!(key.starts_with('/'), "posix key is absolute: {key}");

    // Relative and empty inputs are rejected.
    assert!(normalize_path_key(Path::new("relative/path")).is_none());
    assert!(normalize_path_key(Path::new("")).is_none());

    // `..` components are preserved, not folded.
    let parent_key = normalize_path_key(&tmp.join("..")).unwrap();
    assert!(parent_key.ends_with(".."));

    std::fs::remove_dir_all(&tmp).ok();
}

#[cfg(target_os = "linux")]
#[test]
fn symlinked_alias_confirms_same_directory() {
    let base = std::env::temp_dir().join(format!("taomni-ldt-sym-{}", std::process::id()));
    let real = base.join("real");
    std::fs::create_dir_all(&real).unwrap();
    let alias = base.join("alias");
    #[cfg(unix)]
    std::os::unix::fs::symlink(&real, &alias).unwrap();
    #[cfg(not(unix))]
    return; // symlink alias confirmation is exercised on unix test runs

    let conn = Connection::open_in_memory().unwrap();
    init_tables(&conn).unwrap();
    let mut conn = conn;
    // Record through the symlink once.
    {
        let (changed, _) = record_directory_use(&mut conn, &alias, SOURCE_LOCAL_START, 1000)
            .expect("record symlink use");
        assert!(changed);
    }
    // Recording the real path must merge into the same directory id.
    record_directory_use(&mut conn, &real, SOURCE_LOCAL_CWD, 2000).expect("record real use");
    let usage_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM welcome_directory_usage", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(usage_count, 1, "symlink and target are one directory");
    let alias_rows: i64 = conn
        .query_row("SELECT COUNT(*) FROM welcome_directory_alias", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert!(alias_rows >= 2, "both spellings registered as aliases");
    std::fs::remove_dir_all(&base).ok();
}

/// AC-02: two uses at the same instant keep local-start precedence;
/// later times always win; older events never regress the record.
#[test]
fn record_use_time_and_source_precedence() {
    let conn = Connection::open_in_memory().unwrap();
    init_tables(&conn).unwrap();
    let tmp = std::env::temp_dir().join(format!("taomni-ldt-time-{}", std::process::id()));
    std::fs::create_dir_all(&tmp).unwrap();
    let mut writable = conn;

    let (changed, _) = record_directory_use(&mut writable, &tmp, SOURCE_LOCAL_CWD, 1000).unwrap();
    assert!(changed);
    let (changed, _) = record_directory_use(&mut writable, &tmp, SOURCE_LOCAL_START, 1000).unwrap();
    assert!(changed, "same-time source upgrade counts as a change");
    let source: String = writable
        .query_row(
            "SELECT last_use_source FROM welcome_directory_usage LIMIT 1",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(source, SOURCE_LOCAL_START);

    let (changed, _) = record_directory_use(&mut writable, &tmp, SOURCE_LOCAL_CWD, 900).unwrap();
    assert!(!changed, "older events never regress the confirmed time");
    let time: i64 = writable
        .query_row(
            "SELECT last_used_at_ms FROM welcome_directory_usage LIMIT 1",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(time, 1000);
    std::fs::remove_dir_all(&tmp).ok();
}

/// V-02 / AC-05: legacy migration keeps observation times separate from
/// confirmed use, is idempotent across reopen, and bad timestamps stay
/// unobserved.
#[test]
fn legacy_migration_is_idempotent_and_keeps_times_legacy() {
    let dir = tempfile::TempDir::new().unwrap();
    let conn = Connection::open(dir.path().join("taomni.db")).unwrap();
    conn.execute_batch(
        "CREATE TABLE command_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                host_key TEXT NOT NULL,
                command TEXT NOT NULL,
                last_used_at INTEGER NOT NULL,
                use_count INTEGER NOT NULL DEFAULT 1,
                UNIQUE(host_key, command)
            );",
    )
    .unwrap();
    let work = dir.path().join("work");
    std::fs::create_dir_all(&work).unwrap();
    let inserts = [
        (format!("cd {}", work.display()), 1_700_000_000i64),
        (
            "cd /definitely/not/a/real/path-xyz".to_string(),
            1_699_999_999,
        ),
        ("cd projects".to_string(), 1_699_999_998), // relative: skipped
        ("cd ~/taomni-legacy-work".to_string(), -5), // bad timestamp
    ];
    for (command, ts) in &inserts {
        conn.execute(
                "INSERT INTO command_history (host_key, command, last_used_at) VALUES ('local', ?1, ?2)",
                params![command, ts],
            )
            .unwrap();
    }

    let mut writable = conn;
    migrate_legacy_history(&mut writable).unwrap();
    // Re-run: idempotent.
    migrate_legacy_history(&mut writable).unwrap();

    let usage_count: i64 = writable
        .query_row("SELECT COUNT(*) FROM welcome_directory_usage", [], |r| {
            r.get(0)
        })
        .unwrap();
    // Three unique resolvable paths: <tmp>/work, /definitely/not/a/real,
    // <home>/taomni-legacy-work. The relative `cd projects` is skipped.
    assert_eq!(usage_count, 3, "one row per resolvable unique path");

    let work_key = normalize_path_key(&work).unwrap();
    let (legacy_ms, legacy_rank, confirmed): (Option<i64>, Option<i64>, Option<i64>) = writable
        .query_row(
            "SELECT u.legacy_observed_at_ms, u.legacy_rank, u.last_used_at_ms
                 FROM welcome_directory_usage u
                 JOIN welcome_directory_alias a ON a.directory_id = u.directory_id
                 WHERE a.path_key = ?1",
            params![work_key],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!(
        legacy_ms,
        Some(1_700_000_000_000),
        "observation time preserved in ms"
    );
    assert_eq!(
        legacy_rank,
        Some(0),
        "most recent legacy command gets rank 0"
    );
    assert_eq!(
        confirmed, None,
        "legacy observation never becomes confirmed use"
    );

    let marker: String = writable
        .query_row(
            "SELECT value FROM welcome_metadata WHERE key = ?1",
            params![METADATA_MIGRATION_COMPLETE],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(marker, "complete");

    // Listing after migration: legacy row sorts after confirmed rows and
    // the confirmed-use flow still promotes the same directory.
    let envelope = list_directory_shortcuts(&writable).unwrap();
    assert!(envelope.directories.iter().any(|d| d.legacy_rank.is_some()));
    let (changed, _) =
        record_directory_use(&mut writable, &work, SOURCE_LOCAL_START, 2_000_000_000_000).unwrap();
    assert!(changed);
    let envelope = list_directory_shortcuts(&writable).unwrap();
    let used = envelope
        .directories
        .iter()
        .find(|d| d.last_used_at_ms == Some(2_000_000_000_000))
        .expect("confirmed use listed");
    assert_eq!(used.time_source.as_deref(), Some(SOURCE_LOCAL_START));
    assert_eq!(
        normalize_path_key(Path::new(&used.path)).as_deref(),
        Some(work_key.as_str())
    );
}

/// Default candidates: home subdirectory guesses only surface when they
/// exist; system folders may be reported even when missing (they are
/// real OS-configured directories).
#[test]
fn default_guesses_require_existence() {
    let home = std::env::temp_dir().join(format!("taomni-ldt-def-{}", std::process::id()));
    std::fs::create_dir_all(home.join("Projects")).unwrap();
    let candidates = default_candidates(Some(&home));
    let names: Vec<&str> = candidates.iter().map(|c| c.2.as_str()).collect();
    assert!(names.contains(&"Home"));
    assert!(names.contains(&"Projects"));
    // nonexistent guess is absent
    let persisted = Vec::new();
    let merged = merge_directory_candidates(persisted, &candidates);
    assert!(
        merged
            .iter()
            .all(|r| r.display_path != home.join("src").to_string_lossy()),
        "non-existent guesses must not create rows"
    );
    std::fs::remove_dir_all(&home).ok();
}

/// AC-03: the 24 non-default cap never evicts used default directories.
#[test]
fn non_default_cap_keeps_defaults() {
    let mut persisted = Vec::new();
    for i in 0..30 {
        persisted.push(PersistedRow {
            directory_id: format!("d{i}"),
            display_path: format!("/opt/dir{i}"),
            label: format!("dir{i}"),
            kind: "personal".to_string(),
            last_used_at_ms: Some(1000 + i),
            last_use_source: Some(SOURCE_LOCAL_START.to_string()),
            legacy_rank: None,
            identity_key: format!("/opt/dir{i}"),
        });
    }
    let defaults = vec![(
        "home".to_string(),
        0u32,
        "Home".to_string(),
        PathBuf::from("/home/x"),
    )];
    let merged = merge_directory_candidates(persisted, &defaults);
    let non_default = merged.iter().filter(|r| r.default_rank.is_none()).count();
    assert_eq!(non_default, MAX_DISPLAYED_NON_DEFAULT);
    assert!(
        merged
            .iter()
            .any(|r| r.default_id.as_deref() == Some("home"))
    );
}
