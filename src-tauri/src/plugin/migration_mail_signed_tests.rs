//! Production trust and real host subprocesses run only on GitHub.
use std::process::{Command, Output};

use serde_json::Value;
use taomni_mail_storage::{archive::compress_message, storage};

use super::*;
use crate::plugin::{migration_mail_provision as provision, test_services::VaultHarness};

const QA_PROFILE: &str = "TAOMNI_SIGNED_MAIL_TEST_PROFILE";

fn close_profile(state: VaultHarness) -> tempfile::TempDir {
    let VaultHarness {
        registry,
        services,
        vault,
        root,
    } = state;
    drop((registry, services, vault));
    root
}

fn run_maintenance(profile: &Path) -> Output {
    Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "plugin::migration_mail::tests::signed::mail_maintenance_child",
            "--nocapture",
        ])
        .env(QA_PROFILE, profile)
        .output()
        .unwrap()
}

#[test]
fn mail_maintenance_child() {
    let Some(profile) = std::env::var_os(QA_PROFILE) else {
        return;
    };
    let [archive, signature] = signed_mail_files();
    if let Err(error) = crate::run_mail_maintenance([
        profile,
        archive.into_os_string(),
        signature.into_os_string(),
    ]) {
        eprintln!("{error}");
        std::process::exit(74);
    }
}

fn signed_mail_files() -> [PathBuf; 2] {
    let artifact = PathBuf::from(std::env::var_os("TAOMNI_SIGNED_MAIL_PACKAGE_DIR").unwrap());
    let receipt: Value = paths::read_json_bounded(&artifact.join("provenance.json")).unwrap();
    assert_eq!(receipt["platform"], current_platform());
    assert_eq!(
        receipt["sourceSha"],
        std::env::var("TAOMNI_SIGNED_MAIL_SOURCE_SHA").unwrap()
    );
    let artifact_path = |field: &str| {
        let name = receipt[field].as_str().unwrap();
        assert_eq!(Path::new(name).file_name().unwrap(), name);
        artifact.join(name)
    };
    [artifact_path("archive"), artifact_path("signature")]
}

#[test]
#[ignore = "production-key Mail package and actual subprocesses on GitHub"]
fn signed_mail_upgrade_starts_the_installed_host_with_retained_migrated_data() {
    let temp = tempfile::tempdir().unwrap();
    let profile = temp.path().canonicalize().unwrap();
    let custom = tempfile::tempdir().unwrap();
    let custom_root = custom.path().canonicalize().unwrap();
    legacy_profile(&profile, &custom_root);
    let caches = [
        cached_mail(&profile.join("mail-cache"), "default", "old default inbox"),
        cached_mail(&custom_root, "custom", "old custom inbox"),
    ];
    let raw = b"Subject: Migrated archive\r\n\r\nOriginal from default storage\r\n";
    let db = Connection::open(&caches[0]).unwrap();
    let saved = storage::store(&db, "default", "INBOX", 9, 1, raw.as_slice()).unwrap();
    let object = storage::account_root(&db, "default")
        .unwrap()
        .join("objects")
        .join(&saved.hash[..2])
        .join(format!("{}.eml.gz", saved.hash));
    drop(db);
    let original = fs::read(&object).unwrap();
    let mut replacement = Vec::new();
    compress_message(&vec![b'x'; raw.len()][..], &mut replacement, || Ok(())).unwrap();
    let before = caches.each_ref().map(|path| fs::read(path).unwrap());

    let state = VaultHarness::open(temp);
    let blocked = run_maintenance(&profile);
    assert_eq!(blocked.status.code(), Some(74));
    let error = String::from_utf8_lossy(&blocked.stderr);
    assert!(error.contains("Close the legacy application"), "{error}");
    let [archive, signature] = signed_mail_files();
    let package = verify_archive(&archive, &signature).unwrap();
    assert!(provision::queue(&profile, &package).unwrap());
    assert!(provision::queued(&profile).unwrap());
    assert!(active_version(&profile).is_none());
    // Keep the TempDir owned while releasing the active profile leases.
    let root = close_profile(state);
    fs::write(&object, &replacement).unwrap();
    let rejected = provision::apply_before_startup(&profile).unwrap_err();
    assert!(
        rejected.contains("checksum verification failed"),
        "{rejected}"
    );
    assert_eq!(provision::queued_failure(&profile).unwrap(), Some(true));
    assert!(active_version(&profile).is_none());
    assert!(!profile.join("plugins/mail/data").exists());
    assert_eq!(fs::read(&object).unwrap(), replacement);
    fs::write(&object, &original).unwrap();

    // Opening while failed does not stall or retry automatically until resumed.
    let paused = VaultHarness::open(root);
    assert_eq!(provision::queued_failure(&profile).unwrap(), Some(true));
    assert!(active_version(&profile).is_none());
    assert!(provision::queue(&profile, &package).unwrap());
    let root = close_profile(paused);

    let state = VaultHarness::open(root);
    assert!(!provision::queued(&profile).unwrap());
    let journal = MigrationJournal::load(&profile.join("migration/journal.json")).unwrap();
    assert!(mail_already_committed(&journal).unwrap());

    state.registry.scan().unwrap();
    state.registry.set_enabled(OWNER, true).unwrap();
    let runtime = crate::state::MailRuntime::new(&profile);
    let target = profile.join(MAIL_MIGRATION_TARGET);
    assert_eq!(
        state
            .registry
            .invoke(
                OWNER,
                taomni_mail_api::IMAP_MAILBOX_OWNER,
                json!({"accountId": "default"})
            )
            .unwrap(),
        json!(true)
    );
    let handle = runtime
        .database(&state.registry, "default", || {
            panic!("do not load the old path")
        })
        .unwrap();
    assert_eq!(
        Path::new(handle.lock().unwrap().path().unwrap())
            .canonicalize()
            .unwrap()
            .parent()
            .unwrap(),
        target
    );
    let value = state
        .registry
        .invoke(
            OWNER,
            "mail_get_cached_body",
            json!({"accountId":"default","folder":"INBOX","uid":9}),
        )
        .unwrap();
    assert!(
        value["text"]
            .as_str()
            .unwrap()
            .contains("Original from default storage")
    );
    let drafts = state
        .registry
        .invoke(OWNER, "mail_list_drafts", json!({"accountId": "default"}))
        .unwrap();
    assert_eq!(drafts[0]["subject"], "Legacy default draft");
    assert_eq!(drafts[0]["remoteDraftUid"], 9);
    assert_eq!(
        drafts[0]["replyContext"]["outbox"]["sendAt"],
        4102444800_i64
    );
    let contacts = state
        .registry
        .invoke(
            OWNER,
            "mail_search_contacts",
            json!({"accountId":"default","query":"legacy"}),
        )
        .unwrap();
    assert_eq!(contacts.as_array().unwrap().len(), 1);
    assert_eq!(contacts[0]["source"], "addressBook");
    assert_eq!(contacts[0]["email"], "default@example.com");

    assert_eq!(
        state
            .registry
            .invoke(
                OWNER,
                taomni_mail_api::IMAP_MAILBOX_OWNER,
                json!({"accountId": "custom"})
            )
            .unwrap(),
        json!(false)
    );
    let custom_handle = runtime
        .database(&state.registry, "custom", || {
            Ok(Some(
                json!({"mailStorageDirectory": custom_root}).to_string(),
            ))
        })
        .unwrap();
    assert_eq!(
        Path::new(custom_handle.lock().unwrap().path().unwrap())
            .canonicalize()
            .unwrap(),
        caches[1]
    );
    state.registry.shutdown().unwrap();
    let root = close_profile(state);

    let retry = run_maintenance(root.path());
    assert!(retry.status.success(), "{:?}", retry.stderr);
    assert!(String::from_utf8_lossy(&retry.stdout).contains("Mail data already migrated"));
    assert_eq!(
        caches.each_ref().map(|path| fs::read(path).unwrap()),
        before
    );
    assert_eq!(fs::read(object).unwrap(), original);
}

#[test]
#[ignore = "production-key Mail package and actual subprocesses on GitHub"]
fn signed_mail_upgrade_reuses_data_restored_before_first_activation() {
    let temp = tempfile::tempdir().unwrap();
    let profile = temp.path().canonicalize().unwrap();
    let legacy_directory = profile.join("legacy-custom");
    legacy_profile(&profile, &legacy_directory);
    let main_db = Connection::open(profile.join("taomni.db")).unwrap();
    main_db
        .execute(
            "INSERT INTO sessions VALUES ('secondary', 'Mail', '{}', 'legacy-secret')",
            [],
        )
        .unwrap();
    drop(main_db);
    let legacy = cached_mail(
        &profile.join("mail-cache"),
        "default",
        "current legacy inbox",
    );
    let legacy_secondary = cached_mail(
        &profile.join("mail-cache"),
        "secondary",
        "legacy secondary inbox",
    );
    let legacy_custom = cached_mail(&legacy_directory, "custom", "legacy custom inbox");
    let data = profile.join(MAIL_MIGRATION_TARGET);
    let restored = cached_mail(&data, "default", "restored default inbox");
    let plugins = profile.join("plugins");
    retained_data::save(
        &plugins,
        &retained_data::discover(&plugins, OWNER, 1).unwrap(),
    )
    .unwrap();
    let old_bytes = fs::read(&legacy).unwrap();
    let secondary_bytes = fs::read(&legacy_secondary).unwrap();
    let custom_bytes = fs::read(&legacy_custom).unwrap();
    let restored_bytes = fs::read(&restored).unwrap();
    let [archive, signature] = signed_mail_files();
    let package = verify_archive(&archive, &signature).unwrap();

    let live = VaultHarness::open(temp);
    assert!(provision::queue(&profile, &package).unwrap());
    assert!(active_version(&profile).is_none());
    let state = VaultHarness::open(close_profile(live));
    assert!(!provision::queued(&profile).unwrap());
    assert!(profile_committed(&profile).unwrap());
    state.registry.scan().unwrap();
    state.registry.set_enabled(OWNER, true).unwrap();
    let runtime = crate::state::MailRuntime::new(&profile);
    assert_eq!(
        state
            .registry
            .invoke(
                OWNER,
                taomni_mail_api::IMAP_MAILBOX_OWNER,
                json!({"accountId": "default"})
            )
            .unwrap(),
        json!(false)
    );
    let handle = runtime
        .database(&state.registry, "default", || Ok(None))
        .unwrap();
    assert_eq!(
        Path::new(
            handle
                .lock_for_snapshot(&tokio_util::sync::CancellationToken::new())
                .unwrap()
                .path()
                .unwrap()
        )
        .canonicalize()
        .unwrap(),
        legacy
    );
    assert_eq!(
        state
            .registry
            .invoke(
                OWNER,
                taomni_mail_api::IMAP_MAILBOX_OWNER,
                json!({"accountId": "secondary"})
            )
            .unwrap(),
        json!(true)
    );
    let handle = runtime
        .database(&state.registry, "secondary", || {
            panic!("do not load the old path")
        })
        .unwrap();
    assert_eq!(
        Path::new(handle.lock().unwrap().path().unwrap())
            .canonicalize()
            .unwrap()
            .parent()
            .unwrap(),
        data
    );
    assert_eq!(
        state
            .registry
            .invoke(
                OWNER,
                taomni_mail_api::IMAP_MAILBOX_OWNER,
                json!({"accountId": "custom"})
            )
            .unwrap(),
        json!(false)
    );
    let custom_handle = runtime
        .database(&state.registry, "custom", || {
            Ok(Some(
                json!({"mailStorageDirectory": legacy_directory}).to_string(),
            ))
        })
        .unwrap();
    assert_eq!(
        Path::new(custom_handle.lock().unwrap().path().unwrap())
            .canonicalize()
            .unwrap(),
        legacy_custom
    );
    for (account, expected) in [
        ("default", "restored default inbox"),
        ("secondary", "legacy secondary inbox"),
    ] {
        let body = state
            .registry
            .invoke(
                OWNER,
                "mail_get_cached_body",
                json!({"accountId":account,"folder":"INBOX","uid":9}),
            )
            .unwrap();
        assert!(body["text"].as_str().unwrap().contains(expected));
    }
    state.registry.shutdown().unwrap();
    assert_eq!(fs::read(legacy).unwrap(), old_bytes);
    assert_eq!(fs::read(&legacy_secondary).unwrap(), secondary_bytes);
    assert_eq!(fs::read(legacy_custom).unwrap(), custom_bytes);
    assert_eq!(fs::read(restored).unwrap(), restored_bytes);
}
