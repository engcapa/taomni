use super::super::{
    archive_writer::StagedFile,
    restore::{self, RESTORE_INTENT_FILE},
};
use super::{
    contracts::{PluginDataFileKind, validate_manifest},
    test_support::{archive, dataset, manifest, write},
};
use std::fs;

#[test]
fn mail_attachment_with_a_sqlite_header_restores_as_its_original_bytes() {
    let source = tempfile::tempdir().unwrap();
    let attachment = source.path().join("attachment.bin");
    let db = rusqlite::Connection::open(&attachment).unwrap();
    db.execute_batch(
        "CREATE TABLE test(value); INSERT INTO test VALUES ('downloaded attachment');",
    )
    .unwrap();
    drop(db);
    let original = fs::read(&attachment).unwrap();
    let relative = "attachments/account/INBOX/4-1.bin";
    let data = dataset("mail", &[(relative, PluginDataFileKind::File)]);
    let archive_path = data.archive_path(relative);
    let archive = archive(
        source.path(),
        data,
        &[StagedFile {
            archive_path: archive_path.clone(),
            disk_path: attachment,
        }],
        None,
    );
    let profile = tempfile::tempdir().unwrap();
    restore::stage_restore_to_dir(profile.path(), &archive, None).unwrap();
    restore::apply_pending_restore(profile.path()).unwrap();
    assert_eq!(
        fs::read(profile.path().join(archive_path)).unwrap(),
        original
    );
}

#[test]
fn modular_archive_restores_whole_data_set_without_activating_code_or_trust() {
    for password in [None, Some("qa-modular-backup-password")] {
        let source = tempfile::tempdir().unwrap();
        let opaque = source.path().join("opaque");
        write(&opaque, b"original module bytes");
        let db = source.path().join("source.db");
        let conn = rusqlite::Connection::open(&db).unwrap();
        conn.execute_batch(
            "CREATE TABLE marker(value); INSERT INTO marker VALUES('module database');",
        )
        .unwrap();
        drop(conn);
        let data = dataset(
            "hello",
            &[
                ("folder", PluginDataFileKind::File),
                ("database.opaque", PluginDataFileKind::Sqlite),
                ("branch/leaf", PluginDataFileKind::File),
            ],
        );
        let files: Vec<_> = data
            .files
            .iter()
            .map(|file| StagedFile {
                archive_path: data.archive_path(&file.path),
                disk_path: if file.kind == PluginDataFileKind::Sqlite {
                    db.clone()
                } else {
                    opaque.clone()
                },
            })
            .collect();
        let archive = archive(source.path(), data, &files, password);
        let target = tempfile::tempdir().unwrap();
        let profile = taomni_profile_locks::ProfileRoot::prepare(target.path()).unwrap();
        let root = profile.path();
        let plugin = root.join("plugins/hello");
        write(
            &plugin.join("active.json"),
            b"activation must stay unchanged",
        );
        write(&plugin.join("versions/1.0.0/host"), b"installed executable");
        write(
            &plugin.join("data/folder/old-child"),
            b"old directory becomes a file",
        );
        write(&plugin.join("data/branch"), b"old file becomes a directory");
        write(&plugin.join("data/stale.bin"), b"remove stale content");
        write(&plugin.join("data/database.opaque-wal"), b"stale WAL");
        write(&plugin.join("data/database.opaque-shm"), b"stale SHM");
        let before = crate::runtime::generation::current(root).unwrap();
        let inspected = restore::inspect_archive(&archive, password).unwrap();
        assert_eq!(inspected.format_version, 2);
        validate_manifest(&inspected).unwrap();
        restore::stage_restore_to_dir(root, &archive, password).unwrap();
        assert_eq!(
            fs::read(plugin.join("data/stale.bin")).unwrap(),
            b"remove stale content",
            "staging must not apply data"
        );
        restore::apply_pending_restore(root).unwrap();
        assert_eq!(
            fs::read(plugin.join("data/folder")).unwrap(),
            b"original module bytes"
        );
        assert_eq!(
            fs::read(plugin.join("data/branch/leaf")).unwrap(),
            b"original module bytes"
        );
        assert!(!plugin.join("data/stale.bin").exists());
        assert!(!plugin.join("data/database.opaque-wal").exists());
        assert!(!plugin.join("data/database.opaque-shm").exists());
        let conn = rusqlite::Connection::open(plugin.join("data/database.opaque")).unwrap();
        assert_eq!(
            conn.query_row("SELECT value FROM marker", [], |row| row
                .get::<_, String>(0))
                .unwrap(),
            "module database"
        );
        let locator = crate::plugin::retained_data::load(&root.join("plugins"), "hello")
            .unwrap()
            .unwrap();
        assert_eq!(locator.data_schema_version, 7);
        assert_eq!(locator.files.len(), 3);
        assert_eq!(
            fs::read(plugin.join("active.json")).unwrap(),
            b"activation must stay unchanged"
        );
        assert_eq!(
            fs::read(plugin.join("versions/1.0.0/host")).unwrap(),
            b"installed executable"
        );
        assert!(!root.join(RESTORE_INTENT_FILE).exists());
        assert_ne!(crate::runtime::generation::current(root).unwrap(), before);
    }
}

#[test]
fn restored_modular_mfa_owns_the_store_without_a_migration_journal() {
    let source = tempfile::tempdir().unwrap();
    let vault = source.path().join("vault.db");
    let mfa = source.path().join("mfa.db");
    rusqlite::Connection::open(&vault)
        .unwrap()
        .execute_batch("CREATE TABLE marker(value);")
        .unwrap();
    rusqlite::Connection::open(&mfa)
        .unwrap()
        .execute_batch("CREATE TABLE mfa_accounts(id); INSERT INTO mfa_accounts VALUES (1);")
        .unwrap();
    let mut data = dataset("mfa", &[("mfa.db", PluginDataFileKind::Sqlite)]);
    data.data_schema_version = 1;
    let archive = archive(
        source.path(),
        data,
        &[
            StagedFile {
                archive_path: "databases/vault.db".into(),
                disk_path: vault,
            },
            StagedFile {
                archive_path: "plugins/mfa/data/mfa.db".into(),
                disk_path: mfa,
            },
        ],
        None,
    );
    let target = tempfile::tempdir().unwrap();
    let profile = target.path();
    let legacy = profile.join("mfa.db");
    rusqlite::Connection::open(&legacy)
        .unwrap()
        .execute_batch("CREATE TABLE mfa_accounts(id);")
        .unwrap();
    let legacy_bytes = fs::read(&legacy).unwrap();
    restore::stage_restore_to_dir(profile, &archive, None).unwrap();
    restore::apply_pending_restore(profile).unwrap();

    let backend = crate::mfa::backend::MfaBackend::load(profile);
    assert!(backend.legacy_store().unwrap().is_none());
    assert_eq!(fs::read(&legacy).unwrap(), legacy_bytes);
    assert!(!profile.join("plugins/mfa/active.json").exists());
    assert!(!profile.join("migration/journal.json").exists());

    // A subsequent v1 restore must target the same active data owner.
    let mut legacy_manifest =
        crate::backup::BackupManifest::new("0.5.10".into(), "core".into(), false);
    legacy_manifest.add_file("databases/mfa.db".into(), "a".repeat(64), 1);
    assert_eq!(
        super::restore::destination(profile, &legacy_manifest, "databases/mfa.db").unwrap(),
        Some(profile.join("plugins/mfa/data/mfa.db"))
    );

    let target_with_accounts = tempfile::tempdir().unwrap();
    let profile = target_with_accounts.path();
    let legacy = profile.join("mfa.db");
    rusqlite::Connection::open(&legacy)
        .unwrap()
        .execute_batch("CREATE TABLE mfa_accounts(id); INSERT INTO mfa_accounts VALUES (2);")
        .unwrap();
    let legacy_bytes = fs::read(&legacy).unwrap();
    let error = restore::stage_restore_to_dir(profile, &archive, None).unwrap_err();
    assert!(error.contains("matching existing MFA accounts"), "{error}");
    assert_eq!(fs::read(&legacy).unwrap(), legacy_bytes);
    assert!(!profile.join(RESTORE_INTENT_FILE).exists());
}

#[test]
fn legacy_rdp_pins_restore_into_an_owned_module_and_modern_core_only_backups_leave_pins_in_place() {
    use crate::backup::archive_writer::pack_staged_archive;
    use taomni_profile_locks::{PluginDataLease, PluginSlug, ProfileRoot};
    use taomni_rdp_client_api::{PINS_DATABASE, PINS_SCHEMA};

    let source = tempfile::tempdir().unwrap();
    let legacy = source.path().join("taomni.db");
    let old = rusqlite::Connection::open(&legacy).unwrap();
    old.execute_batch(PINS_SCHEMA).unwrap();
    old.execute(
        "INSERT INTO rdp_certificate_pins VALUES ('legacy.example:3389', ?1, 8)",
        ["ab".repeat(32)],
    )
    .unwrap();
    drop(old);
    let files = [StagedFile {
        archive_path: "databases/taomni.db".into(),
        disk_path: legacy.clone(),
    }];
    let archive = source.path().join("legacy.taobak");
    pack_staged_archive(&files, "0.5.10", "core", None, &archive).unwrap();

    let target = tempfile::tempdir().unwrap();
    let profile = target.path().canonicalize().unwrap();
    let pins = profile.join(PINS_DATABASE);
    fs::create_dir_all(pins.parent().unwrap()).unwrap();
    let module = rusqlite::Connection::open(&pins).unwrap();
    module.execute_batch(PINS_SCHEMA).unwrap();
    module
        .execute(
            "INSERT INTO rdp_certificate_pins VALUES ('later.example:3389', ?1, 19)",
            ["bb".repeat(32)],
        )
        .unwrap();
    drop(module);
    restore::stage_restore_to_dir(&profile, &archive, None).unwrap();
    let root = ProfileRoot::prepare(&profile).unwrap();
    let slug = PluginSlug::parse(taomni_rdp_client_api::SLUG).unwrap();
    let lease = PluginDataLease::try_acquire(&root, &slug).unwrap();
    let previous = fs::read(&pins).unwrap();
    let busy = restore::apply_pending_restore(&profile).unwrap_err();
    assert!(busy.contains("Plugin rdp-client is in use during restore"));
    assert!(profile.join(RESTORE_INTENT_FILE).is_file());
    assert_eq!(fs::read(&pins).unwrap(), previous);
    drop(lease);
    restore::apply_pending_restore(&profile).unwrap();
    let configured = |path: &std::path::Path| {
        rusqlite::Connection::open(path)
            .unwrap()
            .query_row(
                "SELECT endpoint, fingerprint FROM rdp_certificate_pins ORDER BY endpoint",
                [],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .unwrap()
    };
    assert_eq!(
        configured(&pins),
        ("legacy.example:3389".into(), "ab".repeat(32))
    );
    assert_eq!(configured(&profile.join("taomni.db")), configured(&pins));
    assert!(!profile.join("plugins/rdp-client/active.json").is_file());
    assert!(
        crate::plugin::retained_data::load(&profile.join("plugins"), "rdp-client")
            .unwrap()
            .is_some()
    );

    let modern_core = rusqlite::Connection::open(&legacy).unwrap();
    crate::plugin::migration_rdp_pins::omit_rollback_pins(&modern_core).unwrap();
    drop(modern_core);
    let core_only = source.path().join("core-only.taobak");
    pack_staged_archive(&files, "0.5.11", "core", None, &core_only).unwrap();
    let before = fs::read(&pins).unwrap();
    restore::stage_restore_to_dir(&profile, &core_only, None).unwrap();
    restore::apply_pending_restore(&profile).unwrap();
    assert_eq!(fs::read(&pins).unwrap(), before);
}

#[test]
fn dishonest_or_corrupt_sqlite_payloads_never_stage_or_change_target_data() {
    for (actual_sqlite, kind, corrupt_pages) in [
        (true, PluginDataFileKind::File, false),
        (false, PluginDataFileKind::Sqlite, false),
        (true, PluginDataFileKind::Sqlite, true),
    ] {
        let source = tempfile::tempdir().unwrap();
        let payload = source.path().join("payload");
        if actual_sqlite {
            let connection = rusqlite::Connection::open(&payload).unwrap();
            connection
                .execute_batch("CREATE TABLE marker(value);")
                .unwrap();
            drop(connection);
            if corrupt_pages {
                fs::write(&payload, b"SQLite format 3\0damaged pages").unwrap();
            }
        } else {
            write(&payload, b"ordinary data cannot claim to be SQLite");
        }
        let data = dataset("hello", &[("store.opaque", kind)]);
        let file = StagedFile {
            archive_path: data.archive_path("store.opaque"),
            disk_path: payload,
        };
        let archive = archive(source.path(), data, &[file], None);
        let target = tempfile::tempdir().unwrap();
        let profile = taomni_profile_locks::ProfileRoot::prepare(target.path()).unwrap();
        let existing = profile.path().join("plugins/hello/data/store.opaque");
        write(&existing, b"working target data");
        let generation = crate::runtime::generation::current(profile.path()).unwrap();
        if !corrupt_pages {
            assert!(
                restore::inspect_archive(&archive, None)
                    .unwrap_err()
                    .contains("SQLite header")
            );
        }
        assert!(restore::stage_restore_to_dir(profile.path(), &archive, None).is_err());
        assert_eq!(fs::read(existing).unwrap(), b"working target data");
        for name in [
            RESTORE_INTENT_FILE,
            restore::JOURNAL_FILE,
            restore::PENDING_RESTORE_DIR,
        ] {
            assert!(!profile.path().join(name).exists());
        }
        assert_eq!(
            crate::runtime::generation::current(profile.path()).unwrap(),
            generation
        );
        assert!(fs::read_dir(profile.path()).unwrap().all(|entry| {
            !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".restore-verify-")
        }));
    }
}

#[test]
fn vault_restore_cannot_strand_target_encrypted_plugin_or_drop_dependency_at_stage() {
    let source = tempfile::tempdir().unwrap();
    let core = source.path().join("vault.db");
    let conn = rusqlite::Connection::open(&core).unwrap();
    conn.execute_batch("CREATE TABLE marker(value);").unwrap();
    drop(conn);
    let archive = source.path().join("core.taobak");
    super::super::archive_writer::pack_staged_archive(
        &[StagedFile {
            archive_path: "databases/vault.db".into(),
            disk_path: core,
        }],
        "test",
        "core",
        None,
        &archive,
    )
    .unwrap();
    let target = tempfile::tempdir().unwrap();
    write(
        &target.path().join("plugins/mfa/data/tokens"),
        b"retained encrypted data",
    );
    let error = restore::stage_restore_to_dir(target.path(), &archive, None).unwrap_err();
    assert!(error.contains("matching data key"), "{error}");
    assert!(!target.path().join(RESTORE_INTENT_FILE).exists());
    assert_eq!(
        fs::read(target.path().join("plugins/mfa/data/tokens")).unwrap(),
        b"retained encrypted data"
    );
    let invalid = manifest(dataset("mfa", &[("db", PluginDataFileKind::Sqlite)]));
    assert!(super::check_restore_dependencies(target.path(), &invalid).is_ok());
    let mut missing = invalid.clone();
    missing
        .files
        .retain(|file| file.path != "databases/vault.db");
    assert!(super::check_restore_dependencies(target.path(), &missing).is_err());
}

#[test]
fn apply_rechecks_dependencies_created_after_staging_and_retains_intent() {
    let source = tempfile::tempdir().unwrap();
    let vault = source.path().join("vault.db");
    let conn = rusqlite::Connection::open(&vault).unwrap();
    conn.execute_batch("CREATE TABLE marker(value);").unwrap();
    drop(conn);
    let archive = source.path().join("core.taobak");
    super::super::archive_writer::pack_staged_archive(
        &[StagedFile {
            archive_path: "databases/vault.db".into(),
            disk_path: vault,
        }],
        "test",
        "core",
        None,
        &archive,
    )
    .unwrap();
    let target = tempfile::tempdir().unwrap();
    restore::stage_restore_to_dir(target.path(), &archive, None).unwrap();
    write(
        &target.path().join("plugins/mfa/data/new-tokens"),
        b"created after staging",
    );
    assert!(
        restore::apply_pending_restore(target.path())
            .unwrap_err()
            .contains("matching data key")
    );
    assert!(target.path().join(RESTORE_INTENT_FILE).exists());
    assert!(!target.path().join("vault.db").exists());
}

#[test]
fn uncommitted_modular_journal_recovers_old_data_and_keeps_new_generation() {
    let dir = tempfile::tempdir().unwrap();
    let root = taomni_profile_locks::ProfileRoot::prepare(dir.path()).unwrap();
    let profile = root.path();
    let before = crate::runtime::generation::current(profile).unwrap();
    let old = profile.join("plugins/hello/data/old");
    let new = profile.join("plugins/hello/data/new");
    let saved = profile.join("backups/rollback-old");
    write(&saved, b"original data");
    write(&old, b"partially restored");
    write(&new, b"new uncommitted file");
    super::super::control::write_json(&profile.join(super::super::restore::JOURNAL_FILE), &serde_json::json!({
        "committed":false,"plugin_owners":["hello"],
        "entries":[{"path":old,"saved":saved,"existed":true}, {"path":new,"saved":profile.join("unused"),"existed":false}]
    })).unwrap();
    restore::apply_pending_restore(profile).unwrap();
    assert_eq!(fs::read(old).unwrap(), b"original data");
    assert!(!new.exists());
    let recovered = crate::runtime::generation::current(profile).unwrap();
    assert_ne!(before, recovered);
    restore::apply_pending_restore(profile).unwrap();
    assert_eq!(
        crate::runtime::generation::current(profile).unwrap(),
        recovered
    );
}

#[test]
fn missing_or_damaged_safety_copy_never_deletes_readable_uncommitted_data() {
    for damaged in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let root = taomni_profile_locks::ProfileRoot::prepare(dir.path()).unwrap();
        let data = root.path().join("plugins/hello/data/value");
        let safety = root.path().join("backups/safety");
        write(&data, b"last readable data");
        if damaged {
            write(&safety, b"damaged safety copy");
        }
        let journal = root.path().join(super::super::restore::JOURNAL_FILE);
        super::super::control::write_json(&journal, &serde_json::json!({
            "committed": false, "plugin_owners": ["hello"],
            "entries": [{"path": data, "saved": safety, "existed": true,
                         "saved_sha256": super::super::manifest::bytes_sha256(b"old original data")}]
        })).unwrap();
        assert!(restore::apply_pending_restore(root.path()).is_err());
        assert_eq!(fs::read(&data).unwrap(), b"last readable data");
        assert!(journal.exists());
        let generation = crate::runtime::generation::current(root.path()).unwrap();
        write(&safety, b"old original data");
        restore::apply_pending_restore(root.path()).unwrap();
        assert_eq!(fs::read(data).unwrap(), b"old original data");
        assert_eq!(
            crate::runtime::generation::current(root.path()).unwrap(),
            generation
        );
    }
}
