//! Filesystem/journal server ownership contracts; execution belongs to hosted QA.
use super::*;
use tempfile::tempdir;

#[test]
fn pending_server_reclassification_is_idempotent_and_never_copies_the_core_database() {
    for (types, expected) in [
        (vec!["rdp"], vec![MigrationItem::RdpServerConfigs]),
        (vec!["vnc"], vec![MigrationItem::VncServerConfigs]),
        (
            vec!["http", "rdp", "vnc"],
            vec![
                MigrationItem::ServerConfigs,
                MigrationItem::RdpServerConfigs,
                MigrationItem::VncServerConfigs,
            ],
        ),
    ] {
        let directory = tempdir().unwrap();
        let source = directory.path().join("legacy");
        fs::create_dir_all(&source).unwrap();
        let database_path = source.join("taomni.db");
        let database = rusqlite::Connection::open(&database_path).unwrap();
        database.execute_batch("CREATE TABLE server_configs (server_type TEXT, config_json TEXT, updated_at INTEGER)").unwrap();
        for server_type in types {
            database
                .execute(
                    "INSERT INTO server_configs VALUES (?1, 'untouched opaque config', 42)",
                    [server_type],
                )
                .unwrap();
        }
        drop(database);
        let original = fs::read(&database_path).unwrap();
        let path = source.join("migration/journal.json");
        let mut old = MigrationJournal {
            from_version: "0.5.9".into(),
            to_core_api_version: "1".into(),
            status: MigrationRunState::Pending,
            entries: vec![],
        };
        old.mark_with_source(
            MigrationItem::ServerConfigs,
            MigrationStepState::Pending,
            "previous-undifferentiated-server-owner".into(),
            "taomni.db".into(),
            PathBuf::new(),
        );
        old.save_atomic(&path).unwrap();
        let snapshot = inspect_legacy_install(&source, "0.5.9").unwrap();
        let plugins = source.join("plugins");
        let executor = MigrationExecutor::new(&source, &plugins, &path, "0.5.9", "1").unwrap();
        let mut first = None;
        for _ in 0..2 {
            let result = executor.record_pending(&snapshot).unwrap();
            assert_eq!(result.status, MigrationRunState::Pending);
            assert_eq!(result.pending, expected);
            assert!(result.committed.is_empty());
            let journal = MigrationJournal::load(&path).unwrap();
            assert_eq!(
                journal
                    .entries
                    .iter()
                    .map(|entry| entry.item)
                    .collect::<Vec<_>>(),
                expected
            );
            for entry in journal.entries {
                assert_eq!(entry.state, MigrationStepState::Pending);
                assert_eq!(entry.source_path, PathBuf::from("taomni.db"));
                assert_eq!(
                    entry.source_fingerprint,
                    snapshot.source_fingerprints["taomni.db"]
                );
                assert!(entry.target.as_os_str().is_empty());
            }
            let bytes = fs::read(&path).unwrap();
            if let Some(previous) = &first {
                assert_eq!(&bytes, previous);
            } else {
                first = Some(bytes);
            }
            assert_eq!(fs::read(&database_path).unwrap(), original);
            assert!(!plugins.exists());
        }
        assert!(
            build_file_migration_specs(&source, &snapshot.candidates)
                .unwrap()
                .is_empty()
        );
    }
}
