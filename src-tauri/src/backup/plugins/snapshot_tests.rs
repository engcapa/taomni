//! Exercise the actual protected production composition, not just leaf helpers.
use super::super::{
    protected_snapshot::stage_with_plugins, range::resolve_scope_flags,
    snapshot_context::SnapshotContext,
};
use super::test_support::write;
use crate::{mfa::store::MfaStore, plugin::test_services::VaultHarness};
use std::fs;
use taomni_profile_locks::{PluginDataLease, PluginSlug, ProfileRoot};

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
