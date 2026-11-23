//! Exercise the actual protected production composition, not just leaf helpers.
use super::super::{
    protected_snapshot::stage_with_plugins, range::resolve_scope_flags,
    snapshot_context::SnapshotContext,
};
use super::test_support::write;
use crate::{mfa::store::MfaStore, plugin::test_services::VaultHarness};
use std::{fs, path::Path};
use taomni_profile_locks::{PluginDataLease, PluginSlug, ProfileRoot};

#[test]
fn mail_only_backup_recognizes_owned_imap_and_pop3_and_applies_archive_selections() {
    let harness = VaultHarness::new();
    harness.initialize();
    let path = harness.root.path().join("plugins/mail/data");
    fs::create_dir_all(&path).unwrap();
    let account = "module-pop3";
    let stem = taomni_mail_engine::database::mail_db_file_stem(account);
    let db = rusqlite::Connection::open(path.join(format!("{stem}.db"))).unwrap();
    taomni_mail_engine::cache::init_mail_tables(&db).unwrap();
    taomni_mail_engine::pop3::ownership::mark_owned(&path, account).unwrap();
    let original = b"Subject: Kept in the module\r\n\r\nRaw POP3 bytes\r\n";
    taomni_mail_engine::pop3::local_store::import_local_messages(
        &db,
        account,
        "INBOX",
        &[original.to_vec()],
    )
    .unwrap();
    taomni_mail_engine::storage::store(&db, account, "INBOX", 1, 1, original.as_slice()).unwrap();
    write(&path.join("attachments/attachment.bin"), b"attachment");
    drop(db);

    let imap = "module-imap";
    let imap_stem = taomni_mail_engine::database::mail_db_file_stem(imap);
    let imap_name = format!("{imap_stem}.db");
    let imap_path = path.join(&imap_name);
    let db = rusqlite::Connection::open(&imap_path).unwrap();
    taomni_mail_engine::cache::init_mail_tables(&db).unwrap();
    let imap_message =
        taomni_mail_engine::parse_body_message(imap, "INBOX", 1, None, original, 1024);
    taomni_mail_engine::cache::upsert_message(&db, &imap_message).unwrap();
    taomni_mail_engine::imap_ownership::mark_owned(&path, imap).unwrap();
    drop(db);

    let staging = tempfile::tempdir().unwrap();
    for include_files in [false, true] {
        let flags = resolve_scope_flags(
            "custom",
            Some(super::super::range::BackupCustomOptions {
                include_mail: true,
                include_mail_originals: Some(include_files),
                include_mail_attachments: Some(include_files),
                ..Default::default()
            }),
        );
        let result = stage_with_plugins(
            &harness.registry,
            &harness.vault,
            None,
            staging.path(),
            flags,
            &SnapshotContext::default(),
        )
        .unwrap();
        assert_eq!(result.datasets.len(), 1);
        let dataset = &result.datasets[0];
        assert_eq!(dataset.slug, "mail");
        let covered = dataset
            .owned_mailbox_names()
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(
            covered,
            [format!("{stem}.db"), imap_name.clone()]
                .into_iter()
                .collect()
        );
        let imap_snapshot = result
            .files
            .iter()
            .find(|file| file.archive_path == format!("plugins/mail/data/{imap_name}"))
            .unwrap();
        let module_data = imap_snapshot.disk_path.parent().unwrap();
        assert_eq!(
            taomni_mail_engine::imap_ownership::database(module_data, imap).unwrap(),
            Some(imap_snapshot.disk_path.clone())
        );
        let restored_imap = rusqlite::Connection::open(&imap_snapshot.disk_path).unwrap();
        let body = taomni_mail_engine::cache::get_cached_body(&restored_imap, imap, "INBOX", 1)
            .unwrap()
            .unwrap();
        assert!(body.text.as_deref().unwrap().contains("Raw POP3 bytes"));
        assert!(
            dataset
                .files
                .iter()
                .any(|file| file.path == format!("{stem}.pop3-owner"))
        );
        assert_eq!(
            dataset
                .files
                .iter()
                .any(|file| file.path.starts_with("attachments/")),
            include_files
        );
        assert_eq!(
            dataset
                .files
                .iter()
                .any(|file| file.path.starts_with(&format!("{stem}.mail/"))),
            include_files
        );
        let staged = result
            .files
            .iter()
            .find(|file| {
                Path::new(&file.archive_path).file_name()
                    == Some(std::ffi::OsStr::new(&format!("{stem}.db")))
            })
            .unwrap();
        let restored = rusqlite::Connection::open(&staged.disk_path).unwrap();
        assert_eq!(
            taomni_mail_engine::storage::list(&restored, account, 0)
                .unwrap()
                .len(),
            usize::from(include_files)
        );
        assert_eq!(
            taomni_mail_engine::pop3::local_store::read_local_raw(&restored, account, "INBOX", 1)
                .unwrap()
                .as_deref(),
            Some(original.as_slice()),
        );
    }
}

#[test]
fn orphan_retained_data_and_locked_vault_share_the_job_without_starting_or_initializing_mfa() {
    let h = VaultHarness::new();
    h.initialize();
    h.registry.lock_vault(&h.vault).unwrap();
    let plugins = h.root.path().join("plugins");
    write(
        &plugins.join("hello/data/business"),
        b"retained without code",
    );
    let locator = crate::plugin::retained_data::discover(&plugins, "hello", 9).unwrap();
    crate::plugin::retained_data::save(&plugins, &locator).unwrap();
    h.registry.scan().unwrap();
    let before = h.registry.get("hello").unwrap();
    let staging = tempfile::tempdir().unwrap();
    let mfa = MfaStore::new(h.root.path().join("mfa.db"));
    let snapshot = stage_with_plugins(
        &h.registry,
        &h.vault,
        Some(&mfa),
        staging.path(),
        resolve_scope_flags("core", None),
        &SnapshotContext::default(),
    )
    .unwrap();
    assert_eq!(snapshot.files.len(), 2);
    assert_eq!(snapshot.datasets.len(), 1);
    assert_eq!(snapshot.datasets[0].data_schema_version, 9);
    assert_eq!(
        snapshot.datasets[0].profile_generation,
        crate::runtime::generation::current(h.root.path()).unwrap()
    );
    assert!(
        snapshot
            .files
            .iter()
            .any(|file| file.archive_path == "databases/vault.db")
    );
    assert_eq!(
        h.services.admission.state(),
        taomni_plugin_services::AdmissionState::Locked
    );
    assert_eq!(h.registry.get("hello").unwrap(), before);
    assert!(!h.registry.owns_snapshot_host("hello").unwrap());
    assert!(!mfa.path().exists());
    h.registry
        .unlock_vault(&h.vault, crate::plugin::test_services::PASSWORD)
        .unwrap();
    assert!(
        h.vault
            .get_fixed(crate::vault::MFA_DATA_KEY_ENTRY_ID)
            .unwrap()
            .is_none()
    );
}

#[test]
fn busy_retained_owner_aborts_the_complete_protected_batch_and_resumes_admission() {
    let h = VaultHarness::new();
    h.initialize();
    write(
        &h.root.path().join("plugins/hello/data/business"),
        b"retained",
    );
    let profile = ProfileRoot::prepare(h.root.path()).unwrap();
    let owner = PluginSlug::parse("hello").unwrap();
    let lease = PluginDataLease::try_acquire(&profile, &owner).unwrap();
    let staging = tempfile::tempdir().unwrap();
    let mfa = MfaStore::new(h.root.path().join("mfa.db"));
    let error = stage_with_plugins(
        &h.registry,
        &h.vault,
        Some(&mfa),
        staging.path(),
        resolve_scope_flags("core", None),
        &SnapshotContext::default(),
    )
    .unwrap_err();
    assert!(error.contains("in use"), "{error}");
    assert_eq!(fs::read_dir(staging.path()).unwrap().count(), 0);
    assert_eq!(
        h.services.admission.state(),
        taomni_plugin_services::AdmissionState::Open
    );
    assert!(!h.services.admission.is_paused());
    drop(lease);
    let snapshot = stage_with_plugins(
        &h.registry,
        &h.vault,
        Some(&mfa),
        staging.path(),
        resolve_scope_flags("core", None),
        &SnapshotContext::default(),
    )
    .unwrap();
    assert_eq!(snapshot.datasets.len(), 1);
}
