use super::*;
use tempfile::tempdir;

#[test]
fn mfa_owner_requires_a_single_committed_entry_with_known_paths() {
    let mut journal = MigrationJournal::default();
    assert_eq!(journal.committed_mfa(), Ok(false));
    journal.mark_with_source(
        MigrationItem::Mfa,
        MigrationStepState::Pending,
        format!("sha256:{}:bytes:1", "a".repeat(64)),
        "mfa.db".into(),
        PathBuf::new(),
    );
    assert_eq!(journal.committed_mfa(), Ok(false));
    journal.entries[0].state = MigrationStepState::Committed;
    journal.entries[0].target = MFA_MIGRATION_TARGET.into();
    assert_eq!(journal.committed_mfa(), Ok(true));
    let committed = journal.entries[0].clone();
    journal.entries[0].source_path = "unexpected.db".into();
    assert!(journal.committed_mfa().is_err());
    journal.entries[0] = committed.clone();
    journal.entries.push(committed);
    assert!(journal.committed_mfa().is_err());
}

#[test]
fn detects_legacy_files_without_mutating_data_or_reading_removed_chat() {
    let dir = tempdir().unwrap();
    fs::write(dir.path().join("mfa.db"), b"legacy").unwrap();
    fs::write(dir.path().join("lanchat.sqlite"), b"legacy-chat").unwrap();
    let found = inspect_legacy_install(dir.path(), "0.5.9")
        .unwrap()
        .candidates;
    assert_eq!(
        found
            .iter()
            .map(|candidate| candidate.plugin_slug.as_str())
            .collect::<Vec<_>>(),
        vec!["mfa"]
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
    let data = data.canonicalize().unwrap();
    let db = rusqlite::Connection::open(data.join("taomni.db")).unwrap();
    db.execute_batch(
        "CREATE TABLE sessions (id TEXT, session_type TEXT);\
         CREATE TABLE rdp_certificate_pins (host TEXT);\
         CREATE TABLE server_configs (server_type TEXT);\
         INSERT INTO sessions VALUES ('rdp', 'RDP');\
         INSERT INTO rdp_certificate_pins VALUES ('rdp.example.test');\
         INSERT INTO server_configs VALUES ('ssh');",
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
    let sockscap = specs
        .iter()
        .find(|spec| spec.item == MigrationItem::SocksCap)
        .unwrap();
    assert_eq!(
        sockscap.source,
        std::path::Path::new("sockscap/config.json")
    );
    assert_eq!(sockscap.target, std::path::Path::new("data/config.json"));
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
    let data = data.canonicalize().unwrap();
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
    assert!(
        snapshot
            .candidates
            .iter()
            .any(|candidate| candidate.item == MigrationItem::Mfa)
    );
    assert!(snapshot.source_fingerprints.contains_key("vault.db"));
}

#[test]
fn missing_legacy_directory_is_an_empty_read_only_snapshot() {
    let dir = tempdir().unwrap();
    let data = dir.path().join("does-not-exist");
    let snapshot = inspect_legacy_install(&data, "0.5.9").unwrap();
    assert!(snapshot.candidates.is_empty());
    assert!(!data.exists());
}

#[test]
fn records_db_only_candidates_as_pending_without_a_pseudo_plugin_version() {
    let dir = tempdir().unwrap();
    let source_root = dir.path().join("legacy");
    let plugin_root = dir.path().join("plugins");
    let journal_path = dir.path().join("migration/journal.json");
    fs::create_dir_all(&source_root).unwrap();
    let db = rusqlite::Connection::open(source_root.join("taomni.db")).unwrap();
    db.execute_batch(
        "CREATE TABLE sessions (id TEXT, session_type TEXT);\
        INSERT INTO sessions VALUES ('rdp', 'RDP');",
    )
    .unwrap();
    drop(db);

    let snapshot = inspect_legacy_install(&source_root, "0.5.9").unwrap();
    assert_eq!(snapshot.candidates.len(), 1);
    let executor =
        MigrationExecutor::new(&source_root, &plugin_root, &journal_path, "0.5.9", "1").unwrap();

    let first = executor.record_pending(&snapshot).unwrap();
    assert_eq!(first.status, MigrationRunState::Pending);
    assert_eq!(first.pending, vec![MigrationItem::RdpVncSessions]);
    assert!(first.committed.is_empty());
    assert!(!plugin_root.exists());

    let journal = MigrationJournal::load(&journal_path).unwrap();
    assert_eq!(journal.status, MigrationRunState::Pending);
    assert_eq!(journal.entries.len(), 1);
    assert_eq!(journal.entries[0].state, MigrationStepState::Pending);
    assert_eq!(journal.entries[0].source_path, PathBuf::from("taomni.db"));
    assert_eq!(
        journal.entries[0].source_fingerprint,
        snapshot.source_fingerprints["taomni.db"]
    );
    assert!(journal.entries[0].target.as_os_str().is_empty());

    // Repeating preflight updates the same journal entry and does not create a
    // second record or any destination/version directory.
    let second = executor.record_pending(&snapshot).unwrap();
    assert_eq!(second.status, MigrationRunState::Pending);
    assert_eq!(second.pending, vec![MigrationItem::RdpVncSessions]);
    let retried = MigrationJournal::load(&journal_path).unwrap();
    assert_eq!(retried.entries.len(), 1);
    assert!(!plugin_root.exists());
}

#[test]
fn pending_preflight_preserves_an_existing_active_pointer_and_source_hash() {
    let dir = tempdir().unwrap();
    let source_root = dir.path().join("legacy");
    let plugin_root = dir.path().join("plugins");
    let journal_path = dir.path().join("migration/journal.json");
    fs::create_dir_all(&source_root).unwrap();
    fs::write(source_root.join("mfa.db"), b"legacy-mfa").unwrap();
    fs::create_dir_all(plugin_root.join("mfa")).unwrap();
    let pointer_path = plugin_root.join("mfa/active.json");
    let pointer = br#"{"activeVersion":"1.2.3","previousVersion":"1.2.2"}"#;
    fs::write(&pointer_path, pointer).unwrap();

    let snapshot = inspect_legacy_install(&source_root, "0.5.9").unwrap();
    let executor =
        MigrationExecutor::new(&source_root, &plugin_root, &journal_path, "0.5.9", "1").unwrap();
    let result = executor.record_pending(&snapshot).unwrap();
    assert_eq!(result.status, MigrationRunState::Pending);
    assert_eq!(result.pending, vec![MigrationItem::Mfa]);
    assert_eq!(fs::read(&pointer_path).unwrap(), pointer);
    assert_eq!(fs::read(source_root.join("mfa.db")).unwrap(), b"legacy-mfa");
    assert!(!plugin_root.join("mfa/versions").exists());

    let journal = MigrationJournal::load(&journal_path).unwrap();
    assert_eq!(journal.entries[0].source_path, PathBuf::from("mfa.db"));
    assert_eq!(
        journal.entries[0].source_fingerprint,
        snapshot.source_fingerprints["mfa.db"]
    );
}

#[test]
fn pending_rescan_replaces_obsolete_schema_hints_with_the_actual_vnc_owner() {
    let dir = tempdir().unwrap();
    let source = dir.path().join("legacy");
    fs::create_dir_all(&source).unwrap();
    let database = rusqlite::Connection::open(source.join("taomni.db")).unwrap();
    database
        .execute_batch(
            "CREATE TABLE sessions (id TEXT, session_type TEXT);
             INSERT INTO sessions VALUES ('vnc', 'VNC');",
        )
        .unwrap();
    drop(database);
    let path = dir.path().join("migration/journal.json");
    let mut old = MigrationJournal {
        from_version: "0.5.9".into(),
        to_core_api_version: "1".into(),
        status: MigrationRunState::Pending,
        entries: vec![],
    };
    for item in [MigrationItem::RdpVncSessions, MigrationItem::ServerConfigs] {
        old.mark_with_source(
            item,
            MigrationStepState::Pending,
            "old-schema-only-fingerprint".into(),
            "taomni.db".into(),
            PathBuf::new(),
        );
    }
    old.save_atomic(&path).unwrap();
    let snapshot = inspect_legacy_install(&source, "0.5.9").unwrap();
    let executor =
        MigrationExecutor::new(&source, dir.path().join("plugins"), &path, "0.5.9", "1").unwrap();
    for _ in 0..2 {
        let result = executor.record_pending(&snapshot).unwrap();
        assert_eq!(result.pending, [MigrationItem::VncSessions]);
        let journal = MigrationJournal::load(&path).unwrap();
        assert_eq!(journal.entries.len(), 1);
        assert_eq!(journal.entries[0].item, MigrationItem::VncSessions);
        assert_eq!(
            journal.entries[0].source_fingerprint,
            snapshot.source_fingerprints["taomni.db"]
        );
    }
    assert!(!dir.path().join("plugins").exists());
}

#[test]
fn pending_scan_cannot_erase_staged_or_completed_migration_history() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("migration/journal.json");
    let snapshot = inspect_legacy_install(&dir.path().join("absent"), "0.5.9").unwrap();
    let executor =
        MigrationExecutor::new(dir.path(), dir.path().join("plugins"), &path, "0.5.9", "1")
            .unwrap();
    for state in [
        MigrationStepState::Staged,
        MigrationStepState::Committed,
        MigrationStepState::RolledBack,
    ] {
        let mut journal = MigrationJournal {
            from_version: "0.5.9".into(),
            to_core_api_version: "1".into(),
            status: MigrationRunState::Pending,
            entries: vec![],
        };
        journal.mark(
            MigrationItem::RdpVncSessions,
            state,
            "original".into(),
            "plugins/rdp-client".into(),
        );
        journal.save_atomic(&path).unwrap();
        let before = fs::read(&path).unwrap();
        assert!(
            executor
                .record_pending(&snapshot)
                .unwrap_err()
                .contains("explicit recovery")
        );
        assert_eq!(fs::read(&path).unwrap(), before);
    }
}
