use super::*;
use crate::plugin::{LifecycleState, verify};
use std::fs;

fn fixture() -> (tempfile::TempDir, PluginRegistry) {
    let profile = tempfile::tempdir().unwrap();
    let registry = PluginRegistry::new(profile.path().join("plugins"));
    registry
        .install_verified(&verify::test_support::verified_package(
            &verify::test_support::manifest(),
        ))
        .unwrap();
    fs::create_dir_all(registry.root().join("mfa/data")).unwrap();
    fs::write(
        registry.root().join("mfa/data/accounts.bin"),
        b"real retained bytes",
    )
    .unwrap();
    (profile, registry)
}

#[test]
fn retained_locator_survives_registry_restart_and_explicit_delete_removes_it() {
    let (_profile, registry) = fixture();
    assert_eq!(
        registry.uninstall("mfa", false).unwrap().state,
        LifecycleState::Uninstalled
    );
    let locator = retained_data::load(registry.root(), "mfa")
        .unwrap()
        .unwrap();
    assert_eq!(locator.files[0].path, "accounts.bin");
    assert!(locator.requires_vault());
    let reopened = PluginRegistry::new(registry.root());
    reopened.scan().unwrap();
    assert_eq!(
        reopened.get("mfa").unwrap().state,
        LifecycleState::Uninstalled
    );
    assert_eq!(
        retained_data::load(reopened.root(), "mfa").unwrap(),
        Some(locator)
    );
    reopened.uninstall("mfa", true).unwrap();
    assert!(!reopened.root().join("mfa/data").exists());
    assert!(
        retained_data::load(reopened.root(), "mfa")
            .unwrap()
            .is_none()
    );
    assert!(reopened.root().join("mfa/versions/1.0.0/host").exists());
}

#[test]
fn competing_owner_prevents_uninstall_and_preserves_pointer_data_and_enablement() {
    let (_profile, registry) = fixture();
    registry.set_enabled("mfa", true).unwrap();
    let profile = registry.data_profile().unwrap();
    let owner = PluginSlug::parse("mfa").unwrap();
    let lease = PluginDataLease::try_acquire(&profile, &owner).unwrap();
    for delete in [false, true] {
        let error = registry.uninstall("mfa", delete).unwrap_err();
        assert!(
            error.to_string().contains("PLUGIN_PROFILE_IN_USE"),
            "{error}"
        );
        assert_eq!(registry.get("mfa").unwrap().state, LifecycleState::Enabled);
        assert_eq!(
            install::ModuleInstaller::new(registry.root())
                .active_pointer("mfa")
                .unwrap()
                .active_version
                .as_deref(),
            Some("1.0.0")
        );
        assert_eq!(
            fs::read(registry.root().join("mfa/data/accounts.bin")).unwrap(),
            b"real retained bytes"
        );
        assert!(
            retained_data::load(registry.root(), "mfa")
                .unwrap()
                .is_none()
        );
    }
    drop(lease);
    registry.uninstall("mfa", false).unwrap();
}

#[test]
fn locator_publication_failure_keeps_activation_and_user_data() {
    let (_profile, registry) = fixture();
    fs::write(
        registry.root().join(".retained-data"),
        b"invalid control directory",
    )
    .unwrap();
    assert!(registry.uninstall("mfa", false).is_err());
    assert_eq!(
        registry.get("mfa").unwrap().state,
        LifecycleState::Installed
    );
    assert_eq!(
        install::ModuleInstaller::new(registry.root())
            .active_pointer("mfa")
            .unwrap()
            .active_version
            .as_deref(),
        Some("1.0.0")
    );
    assert_eq!(
        fs::read(registry.root().join("mfa/data/accounts.bin")).unwrap(),
        b"real retained bytes"
    );
}
