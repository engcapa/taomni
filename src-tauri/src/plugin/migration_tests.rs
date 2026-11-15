use super::*;
use tempfile::tempdir;

#[test]
fn detects_legacy_files_and_tables_without_mutating_data() {
    let dir = tempdir().unwrap();
    fs::write(dir.path().join("mfa.db"), b"legacy").unwrap();
    fs::write(dir.path().join("lanchat.sqlite"), b"legacy-chat").unwrap();
    let found = detect_legacy_install(dir.path(), &["server_configs", "rdp_certificate_pins"]);
    assert_eq!(
        found
            .iter()
            .map(|candidate| candidate.plugin_slug.as_str())
            .collect::<Vec<_>>(),
        vec!["rdp-client", "rdp-client", "servers", "mfa"]
    );
    assert_eq!(fs::read(dir.path().join("mfa.db")).unwrap(), b"legacy");
    assert_eq!(
        fs::read(dir.path().join("lanchat.sqlite")).unwrap(),
        b"legacy-chat"
    );
    assert!(
        !found
            .iter()
            .any(|candidate| candidate.plugin_slug == "lanchat")
    );
}

#[test]
fn journal_resume_is_idempotent_and_atomic() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("migration/journal.json");
    let mut journal = MigrationJournal {
        from_version: "0.5.9".into(),
        to_core_api_version: "1".into(),
        status: MigrationRunState::Pending,
        entries: vec![],
    };
    journal.mark(
        MigrationItem::Mfa,
        MigrationStepState::Committed,
        "hash".into(),
        PathBuf::from("plugins/mfa"),
    );
    journal.save_atomic(&path).unwrap();
    let loaded = MigrationJournal::load(&path).unwrap();
    assert!(loaded.committed(MigrationItem::Mfa));
    assert_eq!(loaded.entries.len(), 1);
}

#[test]
fn executes_fixture_preserving_legacy_data_and_supporting_idempotent_retry() {
    let dir = tempdir().unwrap();
    let source_root = dir.path().join("legacy");
    let plugin_root = dir.path().join("plugins");
    let journal_path = dir.path().join("migration/journal.json");
    fs::create_dir_all(source_root.join("rdp")).unwrap();
    fs::write(source_root.join("mfa.db"), b"mfa-v1").unwrap();
    fs::write(source_root.join("rdp/sessions.json"), b"sessions-v1").unwrap();
    fs::write(source_root.join("lanchat.sqlite"), b"keep-this-file").unwrap();
    let specs = vec![
        MigrationSpec {
            item: MigrationItem::Mfa,
            plugin_slug: "mfa".into(),
            source: PathBuf::from("mfa.db"),
            target: PathBuf::from("data/mfa.db"),
        },
        MigrationSpec {
            item: MigrationItem::RdpVncSessions,
            plugin_slug: "rdp-client".into(),
            source: PathBuf::from("rdp/sessions.json"),
            target: PathBuf::from("data/sessions.json"),
        },
    ];
    let executor =
        MigrationExecutor::new(&source_root, &plugin_root, &journal_path, "0.5.9", "1").unwrap();

    let first = executor.execute(&specs).unwrap();
    assert_eq!(first.status, MigrationRunState::Complete);
    assert_eq!(first.committed.len(), 2);
    assert!(first.skipped.is_empty());
    let version = "0.0.0-migration-1";
    assert_eq!(
        fs::read(plugin_root.join(format!("mfa/versions/{version}/data/mfa.db"))).unwrap(),
        b"mfa-v1"
    );
    let pointer: serde_json::Value =
        serde_json::from_slice(&fs::read(plugin_root.join("mfa/active.json")).unwrap()).unwrap();
    assert_eq!(pointer["activeVersion"], version);
    assert!(pointer["previousVersion"].is_null());
    let journal = MigrationJournal::load(&journal_path).unwrap();
    assert_eq!(journal.status, MigrationRunState::Complete);
    assert!(
        journal
            .entries
            .iter()
            .all(|entry| entry.state == MigrationStepState::Committed)
    );

    let second = executor.execute(&specs).unwrap();
    assert_eq!(second.status, MigrationRunState::Complete);
    assert!(second.committed.is_empty());
    assert_eq!(second.skipped.len(), 2);
    assert_eq!(
        fs::read(source_root.join("lanchat.sqlite")).unwrap(),
        b"keep-this-file"
    );
}

#[test]
fn preserves_previous_active_pointer_and_marks_failed_run_rolled_back() {
    let dir = tempdir().unwrap();
    let source_root = dir.path().join("legacy");
    let plugin_root = dir.path().join("plugins");
    let journal_path = dir.path().join("migration/journal.json");
    fs::create_dir_all(&source_root).unwrap();
    fs::write(source_root.join("mfa.db"), b"mfa-v1").unwrap();
    fs::create_dir_all(plugin_root.join("mfa")).unwrap();
    fs::write(
        plugin_root.join("mfa/active.json"),
        br#"{"activeVersion":"0.5.9","previousVersion":null}"#,
    )
    .unwrap();
    // A file at `versions` makes the second item fail after the first item
    // has been staged, exercising journal rollback without touching source data.
    fs::create_dir_all(plugin_root.join("servers")).unwrap();
    fs::write(plugin_root.join("servers/versions"), b"not-a-directory").unwrap();
    let specs = vec![
        MigrationSpec {
            item: MigrationItem::Mfa,
            plugin_slug: "mfa".into(),
            source: PathBuf::from("mfa.db"),
            target: PathBuf::from("data/mfa.db"),
        },
        MigrationSpec {
            item: MigrationItem::ServerConfigs,
            plugin_slug: "servers".into(),
            source: PathBuf::from("mfa.db"),
            target: PathBuf::from("data/server.json"),
        },
    ];
    let executor =
        MigrationExecutor::new(&source_root, &plugin_root, &journal_path, "0.5.9", "1").unwrap();
    let error = executor.execute(&specs).unwrap_err();
    assert!(error.contains("directory") || error.contains("Directory") || error.contains("exists"));
    let journal = MigrationJournal::load(&journal_path).unwrap();
    assert_eq!(journal.status, MigrationRunState::RolledBack);
    let restored: serde_json::Value =
        serde_json::from_slice(&fs::read(plugin_root.join("mfa/active.json")).unwrap()).unwrap();
    assert_eq!(restored["activeVersion"], "0.5.9");
    assert!(!plugin_root.join("mfa/versions/0.0.0-migration-1").exists());
    assert_eq!(fs::read(source_root.join("mfa.db")).unwrap(), b"mfa-v1");
}

#[test]
fn rejects_path_traversal_and_symlink_sources_without_mutating_roots() {
    let dir = tempdir().unwrap();
    let source_root = dir.path().join("legacy");
    let plugin_root = dir.path().join("plugins");
    let executor = MigrationExecutor::new(
        &source_root,
        &plugin_root,
        dir.path().join("journal.json"),
        "0.5.9",
        "1",
    )
    .unwrap();
    let traversal = MigrationSpec {
        item: MigrationItem::Mfa,
        plugin_slug: "mfa".into(),
        source: PathBuf::from("../outside"),
        target: PathBuf::from("data/mfa.db"),
    };
    assert!(executor.preflight(&[traversal]).is_err());
    assert!(!source_root.exists());

    fs::create_dir_all(&source_root).unwrap();
    fs::write(dir.path().join("outside"), b"outside").unwrap();
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(dir.path().join("outside"), source_root.join("link")).unwrap();
        let symlink = MigrationSpec {
            item: MigrationItem::Mfa,
            plugin_slug: "mfa".into(),
            source: PathBuf::from("link"),
            target: PathBuf::from("data/mfa.db"),
        };
        assert!(executor.preflight(&[symlink]).is_err());
    }
}

#[test]
fn inspects_real_legacy_sqlite_and_builds_only_file_specs() {
    let dir = tempdir().unwrap();
    let data = dir.path().join("legacy");
    fs::create_dir_all(data.join("sockscap")).unwrap();
    let db = rusqlite::Connection::open(data.join("taomni.db")).unwrap();
    db.execute_batch(
        "CREATE TABLE sessions (id TEXT);\
         CREATE TABLE rdp_certificate_pins (host TEXT);\
         CREATE TABLE server_configs (id TEXT);",
    )
    .unwrap();
    drop(db);
    fs::write(data.join("mfa.db"), b"mfa").unwrap();
    fs::write(data.join("sockscap/config.json"), b"{}").unwrap();
    fs::write(data.join("lanchat.sqlite"), b"do-not-open").unwrap();
    let before = fs::read(data.join("lanchat.sqlite")).unwrap();

    let snapshot = inspect_legacy_install(&data, "0.5.9").unwrap();
    assert_eq!(snapshot.from_version, "0.5.9");
    assert_eq!(
        snapshot.database_tables,
        vec!["rdp_certificate_pins", "server_configs", "sessions"]
    );
    assert_eq!(snapshot.candidates.len(), 5);
    assert!(
        snapshot
            .candidates
            .iter()
            .any(|candidate| candidate.item == MigrationItem::Mfa)
    );
    assert!(
        snapshot
            .candidates
            .iter()
            .any(|candidate| candidate.item == MigrationItem::SocksCap)
    );
    assert_eq!(snapshot.retained_paths, vec![data.join("lanchat.sqlite")]);
    assert!(
        snapshot
            .source_fingerprints
            .keys()
            .any(|path| path == "taomni.db")
    );

    let specs = build_file_migration_specs(&data, &snapshot.candidates).unwrap();
    assert_eq!(specs.len(), 2);
    assert!(
        specs
            .iter()
            .all(|spec| { matches!(spec.item, MigrationItem::Mfa | MigrationItem::SocksCap) })
    );
    assert_eq!(fs::read(data.join("lanchat.sqlite")).unwrap(), before);
}

#[test]
fn preflight_records_vault_fixed_key_without_reading_plaintext() {
    let dir = tempdir().unwrap();
    let data = dir.path().join("legacy");
    fs::create_dir_all(&data).unwrap();
    let vault = rusqlite::Connection::open(data.join("vault.db")).unwrap();
    vault
        .execute_batch(
            "CREATE TABLE vault_entries (id TEXT PRIMARY KEY, ciphertext BLOB);\
             INSERT INTO vault_entries(id, ciphertext) VALUES ('mfa.data-key-v1', X'00');",
        )
        .unwrap();
    drop(vault);

    let snapshot = inspect_legacy_install(&data, "0.5.9").unwrap();
    let evidence = snapshot.vault.expect("vault evidence");
    assert!(evidence.fixed_key_present);
    assert_eq!(evidence.path, data.join("vault.db"));
}

#[test]
fn missing_legacy_directory_is_an_empty_read_only_snapshot() {
    let dir = tempdir().unwrap();
    let data = dir.path().join("does-not-exist");
    let snapshot = inspect_legacy_install(&data, "0.5.9").unwrap();
    assert!(snapshot.candidates.is_empty());
    assert!(!data.exists());
}
