use std::time::Duration;

use rusqlite::params;
use serde_json::json;
use taomni_mail_storage::cache::{get_cached_body, init_mail_tables, upsert_message};
use taomni_mail_storage::contacts::{MailAddressBookEntry, save_entry};

use super::*;
use crate::plugin::{
    migration::{MigrationExecutor, inspect_legacy_install},
    verify::test_support::verified_package,
};

#[cfg(feature = "qa-release-trust-gates")]
#[path = "migration_mail_signed_tests.rs"]
mod signed;

fn package() -> VerifiedPackage {
    let manifest = serde_json::from_str(include_str!("../../plugins/mail/module.json")).unwrap();
    verified_package(&manifest)
}

fn control() -> SnapshotControl {
    SnapshotControl::with_timeout(Duration::from_secs(30))
}

fn legacy_profile(profile: &Path, custom: &Path) {
    let db = Connection::open(profile.join("taomni.db")).unwrap();
    db.execute_batch(
        "CREATE TABLE sessions(id TEXT PRIMARY KEY, session_type TEXT, options_json TEXT, password TEXT);
         INSERT INTO sessions VALUES ('default', 'Mail', '{}', 'legacy-secret');
         INSERT INTO sessions VALUES ('ssh', 'SSH', 'unrelated settings', 'legacy-secret');",
    )
    .unwrap();
    db.execute(
        "INSERT INTO sessions VALUES ('custom', 'Mail', ?1, 'legacy-secret')",
        [json!({"mailStorageDirectory":custom}).to_string()],
    )
    .unwrap();
}

fn cached_mail(root: &Path, account: &str, text: &str) -> PathBuf {
    fs::create_dir_all(root).unwrap();
    let path = root.join(format!("{}.db", mail_db_file_stem(account)));
    let db = Connection::open(&path).unwrap();
    init_mail_tables(&db).unwrap();
    let raw = format!("Subject: legacy\r\n\r\n{text}\r\n");
    let message =
        taomni_mail_storage::parse_body_message(account, "INBOX", 9, None, raw.as_bytes(), 256);
    upsert_message(&db, &message).unwrap();
    let draft = serde_json::from_value(json!({
        "id": "scheduled", "subject": format!("Legacy {account} draft"),
        "replyContext": {"outbox": {"sendAt": 4102444800_i64, "attempts": 1}},
        "remoteDraftFolder":"Drafts","remoteDraftUid":9,
    }))
    .unwrap();
    taomni_mail_storage::drafts::save_mail_draft(&db, account, draft).unwrap();
    save_entry(
        &db,
        account,
        MailAddressBookEntry {
            display_name: format!("Legacy {account} contact"),
            emails: vec![format!("{account}@example.com")],
            ..Default::default()
        },
        "local",
    )
    .unwrap();
    path
}

fn active_version(profile: &Path) -> Option<String> {
    ModuleInstaller::new(profile.join("plugins"))
        .active_pointer(OWNER)
        .unwrap()
        .active_version
}

#[cfg(not(feature = "qa-release-trust-gates"))]
#[test]
fn legacy_mail_is_staged_without_opening_the_cache_and_applied_by_startup() {
    use crate::{
        plugin::migration_mail_provision as provision,
        runtime::profile::{ProfileRuntimeLeases, StartupMode},
    };

    let profile = tempfile::tempdir().unwrap();
    let custom = tempfile::tempdir().unwrap();
    let profile = profile.path().canonicalize().unwrap();
    legacy_profile(&profile, custom.path());
    cached_mail(custom.path(), "custom", "mail from legacy cache");

    let live = ProfileRuntimeLeases::acquire(&profile, StartupMode::Desktop).unwrap();
    assert!(provision::queue(&profile, &package()).unwrap());
    assert!(provision::queued(&profile).unwrap());
    assert!(provision::queued_pending(&profile).unwrap());
    assert_eq!(
        provision::queued_status(&profile).unwrap(),
        Some(provision::QueuedPlanStatus {
            failed: false,
            error: None,
        })
    );
    assert!(!profile.join(MAIL_MIGRATION_TARGET).exists());
    assert!(active_version(&profile).is_none());
    assert!(provision::apply_before_startup(&profile).is_err());
    assert!(provision::queued(&profile).unwrap());
    drop(live);

    let plan_path = profile.join("migration/mail-provision.json");
    let original: serde_json::Value = paths::read_json_bounded(&plan_path).unwrap();
    let mut tampered = original.clone();
    tampered["archive_sha256"] = json!("0".repeat(64));
    paths::write_json_durable(&plan_path, &tampered).unwrap();
    assert!(provision::apply_before_startup(&profile).is_err());
    assert_eq!(provision::queued_failure(&profile).unwrap(), Some(true));
    assert!(!provision::queued_pending(&profile).unwrap());
    let failed_status = provision::queued_status(&profile).unwrap().unwrap();
    assert!(failed_status.failed);
    assert!(
        failed_status
            .error
            .as_deref()
            .is_some_and(|message| message.contains("differs from the staged upgrade"))
    );
    assert!(active_version(&profile).is_none());
    assert!(!profile.join(MAIL_MIGRATION_TARGET).exists());

    // A previously failed Mail upgrade does not block normal restarts or retry forever.
    let live_after_fail = ProfileRuntimeLeases::acquire(&profile, StartupMode::Desktop).unwrap();
    assert_eq!(provision::queued_failure(&profile).unwrap(), Some(true));
    assert!(active_version(&profile).is_none());
    assert!(provision::queue(&profile, &package()).unwrap());
    assert!(provision::queued_pending(&profile).unwrap());
    drop(live_after_fail);

    let _startup = ProfileRuntimeLeases::acquire(&profile, StartupMode::Desktop).unwrap();
    assert!(
        mail_already_committed(
            &MigrationJournal::load(&profile.join("migration/journal.json")).unwrap()
        )
        .unwrap()
    );
    assert!(!provision::queued(&profile).unwrap());
    assert!(active_version(&profile).is_some());
}

#[test]
fn installs_and_records_default_and_custom_mail_data_for_a_verified_package() {
    let profile = tempfile::tempdir().unwrap();
    let custom = tempfile::tempdir().unwrap();
    let profile = profile.path().canonicalize().unwrap();
    let custom = custom.path().canonicalize().unwrap();
    legacy_profile(&profile, &custom);
    let default_path = cached_mail(&profile.join("mail-cache"), "default", "default cache");
    let custom_path = cached_mail(&custom, "custom", "custom cache");
    let original = [
        fs::read(&default_path).unwrap(),
        fs::read(&custom_path).unwrap(),
        fs::read(profile.join("taomni.db")).unwrap(),
    ];
    let snapshot = inspect_legacy_install(&profile, "0.5.10").unwrap();
    let journal_path = profile.join("migration/journal.json");
    let executor = MigrationExecutor::new(
        &profile,
        profile.join("plugins"),
        &journal_path,
        "0.5.10",
        CORE_API_VERSION,
    )
    .unwrap();
    executor.record_pending(&snapshot).unwrap();
    let package = package();
    assert_eq!(
        execute(&profile, &package, &control()).unwrap(),
        MailUpgradeOutcome::Migrated
    );
    assert_eq!(
        active_version(&profile).as_deref(),
        Some(package.manifest().version.as_str())
    );
    let journal = MigrationJournal::load(&journal_path).unwrap();
    let mail = journal
        .entries
        .iter()
        .find(|entry| entry.item == MigrationItem::MailAccounts)
        .unwrap();
    assert!(valid_mail_commit(mail));
    assert_eq!(
        mail.source_fingerprint,
        snapshot.source_fingerprints["taomni.db"]
    );
    let registry = crate::plugin::PluginRegistry::new(profile.join("plugins"));
    registry.scan().unwrap();
    let runtime = crate::state::MailRuntime::new(&profile);
    let rejected = runtime.database(&registry, "default", || panic!("do not read the old path"));
    assert!(rejected.err().unwrap().contains("Enable the Mail module"));
    registry.set_enabled(OWNER, true).unwrap();
    let default_target = profile
        .join(MAIL_MIGRATION_TARGET)
        .join(default_path.file_name().unwrap());
    assert_eq!(
        taomni_mail_storage::imap_ownership::database(default_target.parent().unwrap(), "default")
            .unwrap(),
        Some(default_target.clone())
    );
    let default_handle = runtime
        .database(&registry, "default", || panic!("do not read the old path"))
        .unwrap();
    {
        let db = default_handle.lock().unwrap();
        assert_eq!(
            Path::new(db.path().unwrap()).canonicalize().unwrap(),
            default_target
        );
        let value = get_cached_body(&db, "default", "INBOX", 9)
            .unwrap()
            .unwrap();
        assert!(value.text.unwrap().contains("default cache"));
        assert!(taomni_mail_storage::draft_import::is_owned(&db, "default").unwrap());
        let queued = taomni_mail_storage::drafts::get_mail_draft(&db, "default", "scheduled")
            .unwrap()
            .unwrap();
        assert_eq!(queued.remote_draft_uid, Some(9));
        assert_eq!(
            queued.reply_context.unwrap().outbox.unwrap().send_at,
            Some(4102444800)
        );
    }

    assert!(
        !profile
            .join(MAIL_MIGRATION_TARGET)
            .join(custom_path.file_name().unwrap())
            .exists()
    );
    assert!(
        taomni_mail_storage::imap_ownership::database(
            &profile.join(MAIL_MIGRATION_TARGET),
            "custom"
        )
        .unwrap()
        .is_none()
    );
    let custom_handle = runtime
        .database(&registry, "custom", || {
            Ok(Some(json!({"mailStorageDirectory": custom}).to_string()))
        })
        .unwrap();
    {
        let db = custom_handle.lock().unwrap();
        assert_eq!(
            Path::new(db.path().unwrap()).canonicalize().unwrap(),
            custom_path
        );
        let value = get_cached_body(&db, "custom", "INBOX", 9).unwrap().unwrap();
        assert!(value.text.unwrap().contains("custom cache"));
    }
    let retained = [
        fs::read(default_path).unwrap(),
        fs::read(custom_path).unwrap(),
        fs::read(profile.join("taomni.db")).unwrap(),
    ];
    assert_eq!(retained, original);

    let reconciled = executor.record_pending(&snapshot).unwrap();
    assert_eq!(reconciled.committed, [MigrationItem::MailAccounts]);
    assert!(reconciled.pending.is_empty());
    assert_eq!(
        execute(&profile, &package, &control()).unwrap(),
        MailUpgradeOutcome::AlreadyMigrated
    );
}

#[test]
fn refreshes_unactivated_data_after_the_legacy_app_has_reopened() {
    let profile = tempfile::tempdir().unwrap();
    let custom = tempfile::tempdir().unwrap();
    let profile = profile.path().canonicalize().unwrap();
    legacy_profile(&profile, custom.path());
    let db = cached_mail(&profile.join("mail-cache"), "default", "snapshot");
    let module = profile.join("plugins/mail");
    let data = module.join("data");
    fs::create_dir_all(&module).unwrap();
    let migration = paths::create_directory(&profile, "migration").unwrap();
    let transaction = uuid::Uuid::new_v4().to_string();
    paths::write_json_durable(&migration.join(TRANSACTION), &transaction).unwrap();
    publish_data(
        &profile,
        &module,
        &data,
        &transaction,
        false,
        HostedMailboxData::ALL,
        &control(),
    )
    .unwrap();
    assert!(active_version(&profile).is_none());
    let source = Connection::open(&db).unwrap();
    source
        .execute(
            "UPDATE mail_messages SET body_text=?1 WHERE account_id=?2",
            params!["changed after snapshot", "default"],
        )
        .unwrap();
    drop(source);

    assert_eq!(
        execute(&profile, &package(), &control()).unwrap(),
        MailUpgradeOutcome::Migrated
    );
    let dest = Connection::open(data.join(db.file_name().unwrap())).unwrap();
    let body = get_cached_body(&dest, "default", "INBOX", 9)
        .unwrap()
        .unwrap();
    assert_eq!(body.text.as_deref(), Some("changed after snapshot"));
    assert!(!migration.join(TRANSACTION).exists());
    assert!(active_version(&profile).is_some());
}

#[test]
fn preserves_existing_module_data_and_never_activates_on_a_failed_copy() {
    let profile = tempfile::tempdir().unwrap();
    let custom = tempfile::tempdir().unwrap();
    let profile = profile.path().canonicalize().unwrap();
    legacy_profile(&profile, custom.path());
    let source = cached_mail(&profile.join("mail-cache"), "default", "legacy");
    let target = profile.join(MAIL_MIGRATION_TARGET);
    fs::create_dir_all(&target).unwrap();
    let retained = target.join("existing.db");
    fs::write(&retained, b"retained").unwrap();
    let package = package();
    let error = execute(&profile, &package, &control()).unwrap_err();
    assert!(error.contains("already has module data"), "{error}");
    assert_eq!(fs::read(&retained).unwrap(), b"retained");
    assert!(active_version(&profile).is_none());

    fs::remove_file(&retained).unwrap();
    fs::write(&source, b"broken mailbox").unwrap();
    assert!(execute(&profile, &package, &control()).is_err());
    assert_eq!(fs::read(source).unwrap(), b"broken mailbox");
    assert!(active_version(&profile).is_none());
    assert!(target.read_dir().unwrap().next().is_none());
}

#[test]
fn a_restored_mailbox_takes_precedence_over_the_legacy_source_at_first_activation() {
    let temp = tempfile::tempdir().unwrap();
    let profile = temp.path().canonicalize().unwrap();
    let missing_custom = profile.join("previous-machine");
    legacy_profile(&profile, &missing_custom);
    let legacy = cached_mail(&profile.join("mail-cache"), "default", "legacy default");
    let data = profile.join(MAIL_MIGRATION_TARGET);
    let restored = [
        cached_mail(&data, "default", "restored default"),
        cached_mail(&data, "custom", "restored custom"),
    ];
    paths::write_json_durable(
        &data.join(RECEIPT),
        &DataReceipt {
            format_version: 1,
            transaction_id: uuid::Uuid::new_v4().to_string(),
            source_fingerprint: "a".repeat(64),
            data_schema_version: 1,
        },
    )
    .unwrap();
    let plugins = profile.join("plugins");
    taomni_mail_storage::imap_ownership::mark_owned(&data, "custom").unwrap();
    let locator = retained_data::discover(&plugins, OWNER, 1).unwrap();
    retained_data::save(&plugins, &locator).unwrap();
    let before = restored.each_ref().map(|path| fs::read(path).unwrap());
    let legacy_before = fs::read(&legacy).unwrap();
    let package = package();

    assert_eq!(
        execute(&profile, &package, &control()).unwrap(),
        MailUpgradeOutcome::Migrated
    );
    assert_eq!(
        execute(&profile, &package, &control()).unwrap(),
        MailUpgradeOutcome::AlreadyMigrated
    );
    assert!(active_version(&profile).is_some());
    assert_eq!(
        restored.each_ref().map(|path| fs::read(path).unwrap()),
        before
    );
    assert_eq!(fs::read(legacy).unwrap(), legacy_before);
    assert!(!missing_custom.exists());
    assert!(
        taomni_mail_storage::imap_ownership::database(&data, "default")
            .unwrap()
            .is_none()
    );
    assert_eq!(
        taomni_mail_storage::imap_ownership::database(&data, "custom").unwrap(),
        Some(restored[1].clone())
    );
}

#[test]
fn a_mixed_mail_restore_retries_from_the_original_data_until_first_activation() {
    for published in [false, true] {
        let temp = tempfile::tempdir().unwrap();
        let profile = temp.path().canonicalize().unwrap();
        let custom = tempfile::tempdir().unwrap();
        let custom_root = custom.path().canonicalize().unwrap();
        legacy_profile(&profile, &custom_root);
        let main_db = Connection::open(profile.join("taomni.db")).unwrap();
        main_db
            .execute(
                "INSERT INTO sessions VALUES ('secondary', 'Mail', '{}', 'legacy-secret')",
                [],
            )
            .unwrap();
        drop(main_db);
        let legacy = cached_mail(&profile.join("mail-cache"), "secondary", "legacy secondary");
        let custom_db = cached_mail(&custom_root, "custom", "legacy custom");
        let data = profile.join(MAIL_MIGRATION_TARGET);
        let restored = cached_mail(&data, "default", "restored default");
        let restored_bytes = fs::read(&restored).unwrap();
        let plugins = profile.join("plugins");
        let locator = retained_data::discover(&plugins, OWNER, 1).unwrap();
        retained_data::save(&plugins, &locator).unwrap();
        let migration = paths::create_directory(&profile, "migration").unwrap();
        let transaction = uuid::Uuid::new_v4().to_string();
        paths::write_json_durable(&migration.join(TRANSACTION), &transaction).unwrap();
        reuse_restored_data(
            &profile,
            &plugins,
            &locator,
            &transaction,
            HostedMailboxData::ALL,
            &control(),
        )
        .unwrap();
        let preserved = restored::saved_data(data.parent().unwrap(), &transaction).unwrap();
        assert_eq!(
            fs::read(preserved.join(restored.file_name().unwrap())).unwrap(),
            restored_bytes
        );
        assert!(!data.join(custom_db.file_name().unwrap()).exists());
        if !published {
            // Interruption after moving the restored directory aside and
            // before the replacement receives the final data path.
            fs::remove_dir_all(&data).unwrap();
        }
        let source = Connection::open(&legacy).unwrap();
        source.execute(
            "UPDATE mail_messages SET body_text='updated before activation' WHERE account_id='secondary'",
            [],
        ).unwrap();
        drop(source);
        let legacy_bytes = fs::read(&legacy).unwrap();
        assert!(active_version(&profile).is_none());

        assert_eq!(
            execute(&profile, &package(), &control()).unwrap(),
            MailUpgradeOutcome::Migrated
        );
        assert!(active_version(&profile).is_some());
        assert!(!preserved.exists());
        assert_eq!(fs::read(restored).unwrap(), restored_bytes);
        assert_eq!(fs::read(&legacy).unwrap(), legacy_bytes);
        assert!(!data.join(custom_db.file_name().unwrap()).exists());
        let dest = Connection::open(data.join(legacy.file_name().unwrap())).unwrap();
        let body = get_cached_body(&dest, "secondary", "INBOX", 9)
            .unwrap()
            .unwrap();
        assert_eq!(body.text.as_deref(), Some("updated before activation"));
    }
}

#[test]
fn older_packages_keep_the_live_legacy_mailbox_even_with_a_migrated_copy() {
    let temp = tempfile::tempdir().unwrap();
    let profile = temp.path().canonicalize().unwrap();
    let custom = profile.join("custom");
    fs::create_dir_all(&custom).unwrap();
    legacy_profile(&profile, &custom);
    let old = cached_mail(
        &profile.join("mail-cache"),
        "default",
        "the earlier core owns this cache",
    );
    let mut manifest = package().manifest().clone();
    assert!(
        manifest
            .commands
            .remove(taomni_mail_api::IMAP_MAILBOX_OWNER)
    );
    manifest.version = "0.1.48".into();
    execute(&profile, &verified_package(&manifest), &control()).unwrap();

    let staged = profile.join(MAIL_MIGRATION_TARGET);
    assert!(staged.join(old.file_name().unwrap()).exists());
    assert!(
        taomni_mail_storage::imap_ownership::database(&staged, "default")
            .unwrap()
            .is_none()
    );

    let registry = crate::plugin::PluginRegistry::new(profile.join("plugins"));
    registry.scan().unwrap();
    registry.set_enabled(OWNER, true).unwrap();
    let runtime = crate::state::MailRuntime::new(&profile);
    let handle = runtime.database(&registry, "default", || Ok(None)).unwrap();
    assert_eq!(
        Path::new(handle.lock().unwrap().path().unwrap())
            .canonicalize()
            .unwrap(),
        old
    );

    // A later owner-capable app must wait for a compatible installed module.
    taomni_mail_storage::imap_ownership::mark_owned(&staged, "default").unwrap();
    let result = runtime.database(&registry, "default", || {
        panic!("do not use the cached legacy handle")
    });
    assert!(result.err().unwrap().contains("Update the Mail module"));
}

#[test]
fn custom_only_mailbox_commits_mail_migration_without_copying_archives() {
    let temp = tempfile::tempdir().unwrap();
    let custom = tempfile::tempdir().unwrap();
    let profile = temp.path().canonicalize().unwrap();
    let custom_root = custom.path().canonicalize().unwrap();
    let db = Connection::open(profile.join("taomni.db")).unwrap();
    db.execute(
        "CREATE TABLE sessions(id TEXT PRIMARY KEY, session_type TEXT, options_json TEXT, password TEXT)",
        [],
    )
    .unwrap();
    db.execute(
        "INSERT INTO sessions VALUES ('custom', 'Mail', ?1, 'legacy-secret')",
        [json!({"mailStorageDirectory": custom_root}).to_string()],
    )
    .unwrap();
    drop(db);
    let custom_db = cached_mail(&custom_root, "custom", "custom archive cache");
    let raw = b"Subject: Custom Archive\r\n\r\nStored outside app data\r\n";
    let conn = Connection::open(&custom_db).unwrap();
    taomni_mail_storage::storage::store(&conn, "custom", "INBOX", 9, 1, raw.as_slice()).unwrap();
    drop(conn);

    assert_eq!(
        execute(&profile, &package(), &control()).unwrap(),
        MailUpgradeOutcome::Migrated
    );
    assert!(active_version(&profile).is_some());
    let journal = MigrationJournal::load(&profile.join("migration/journal.json")).unwrap();
    let mail = journal
        .entries
        .iter()
        .find(|entry| entry.item == MigrationItem::MailAccounts)
        .unwrap();
    assert!(valid_mail_commit(mail));

    let data = profile.join(MAIL_MIGRATION_TARGET);
    let entries: Vec<_> = fs::read_dir(&data)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(entries, [RECEIPT]);
    retained_data::discover(&profile.join("plugins"), OWNER, 1).unwrap();

    let registry = crate::plugin::PluginRegistry::new(profile.join("plugins"));
    registry.scan().unwrap();
    registry.set_enabled(OWNER, true).unwrap();
    let runtime = crate::state::MailRuntime::new(&profile);
    let handle = runtime
        .database(&registry, "custom", || {
            Ok(Some(
                json!({"mailStorageDirectory": custom_root}).to_string(),
            ))
        })
        .unwrap();
    assert_eq!(
        Path::new(handle.lock().unwrap().path().unwrap())
            .canonicalize()
            .unwrap(),
        custom_db
    );
}
