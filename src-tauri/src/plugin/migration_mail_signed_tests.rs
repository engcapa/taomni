//! Production trust and real host subprocesses run only on GitHub.
use std::process::{Command, Output};

use serde_json::Value;

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
    let state = VaultHarness::open(root);
    assert!(!provision::queued(&profile).unwrap());
    let journal = MigrationJournal::load(&profile.join("migration/journal.json")).unwrap();
    assert!(mail_already_committed(&journal).unwrap());

    state.registry.scan().unwrap();
    state.registry.set_enabled(OWNER, true).unwrap();
    for (account, expected) in [
        ("default", "old default inbox"),
        ("custom", "old custom inbox"),
    ] {
        let value = state
            .registry
            .invoke(
                OWNER,
                "mail_get_cached_body",
                json!({"accountId":account,"folder":"INBOX","uid":9}),
            )
            .unwrap();
        assert!(value["text"].as_str().unwrap().contains(expected));
        let drafts = state
            .registry
            .invoke(OWNER, "mail_list_drafts", json!({"accountId": account}))
            .unwrap();
        assert_eq!(drafts[0]["subject"], format!("Legacy {account} draft"));
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
                json!({"accountId":account,"query":"legacy"}),
            )
            .unwrap();
        assert_eq!(contacts.as_array().unwrap().len(), 1);
        assert_eq!(contacts[0]["source"], "addressBook");
        assert_eq!(contacts[0]["email"], format!("{account}@example.com"));
    }
    state.registry.shutdown().unwrap();
    let root = close_profile(state);

    let retry = run_maintenance(root.path());
    assert!(retry.status.success(), "{:?}", retry.stderr);
    assert!(String::from_utf8_lossy(&retry.stdout).contains("Mail data already migrated"));
    assert_eq!(
        caches.each_ref().map(|path| fs::read(path).unwrap()),
        before
    );
}
