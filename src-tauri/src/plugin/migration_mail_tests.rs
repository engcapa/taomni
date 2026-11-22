use std::time::Duration;

use rusqlite::params;
use serde_json::json;
use taomni_mail_engine::cache::{get_cached_body, init_mail_tables, upsert_message};
use taomni_mail_engine::contacts::{MailAddressBookEntry, save_entry};

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
        taomni_mail_engine::parse_body_message(account, "INBOX", 9, None, raw.as_bytes(), 256);
    upsert_message(&db, &message).unwrap();
    let draft = serde_json::from_value(json!({
        "id": "scheduled", "subject": format!("Legacy {account} draft"),
        "replyContext": {"outbox": {"sendAt": 4102444800_i64, "attempts": 1}},
        "remoteDraftFolder":"Drafts","remoteDraftUid":9,
    }))
    .unwrap();
    taomni_mail_engine::drafts::save_mail_draft(&db, account, draft).unwrap();
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
    assert!(active_version(&profile).is_none());
    assert!(!profile.join(MAIL_MIGRATION_TARGET).exists());
    paths::write_json_durable(&plan_path, &original).unwrap();

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
    for (account, source, text) in [
        ("default", &default_path, "default cache"),
        ("custom", &custom_path, "custom cache"),
    ] {
        let path = profile
            .join(MAIL_MIGRATION_TARGET)
            .join(source.file_name().unwrap());
        let db = Connection::open(path).unwrap();
        let value = get_cached_body(&db, account, "INBOX", 9).unwrap().unwrap();
        assert!(value.text.unwrap().contains(text));
        assert!(taomni_mail_engine::draft_import::is_owned(&db, account).unwrap());
        let queued = taomni_mail_engine::drafts::get_mail_draft(&db, account, "scheduled")
            .unwrap()
            .unwrap();
        assert_eq!(queued.remote_draft_uid, Some(9));
        assert_eq!(
            queued.reply_context.unwrap().outbox.unwrap().send_at,
            Some(4102444800)
        );
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
    let db = cached_mail(custom.path(), "custom", "snapshot");
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
            params!["changed after snapshot", "custom"],
        )
        .unwrap();
    drop(source);

    assert_eq!(
        execute(&profile, &package(), &control()).unwrap(),
        MailUpgradeOutcome::Migrated
    );
    let dest = Connection::open(data.join(db.file_name().unwrap())).unwrap();
    let body = get_cached_body(&dest, "custom", "INBOX", 9)
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
    let source = cached_mail(custom.path(), "custom", "legacy");
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
