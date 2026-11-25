use super::*;
use tempfile::tempdir;

fn manifest(slug: &str) -> ModuleManifest {
    ModuleManifest {
        id: format!("taomni-plugin-{slug}"),
        slug: slug.into(),
        name: slug.into(),
        description: String::new(),
        version: "1.0.0".into(),
        core_api_version: CORE_API_VERSION.into(),
        kind: PluginKind::Auth,
        status: PluginStatus::Stable,
        removal_candidate: false,
        platforms: [current_platform().into()].into_iter().collect(),
        entry: PluginEntry {
            host: Some("bin/host".into()),
            frontend: Some("frontend/index.js".into()),
            protocol: 1,
        },
        tabs: vec![PluginTab {
            kind: slug.into(),
            title: slug.into(),
        }],
        commands: ["ping".into()].into(),
        permissions: ["session.read".into()].into(),
        data_dir: format!("plugins/{slug}"),
        data_schema_version: 1,
        backup_paths: vec![format!("plugins/{slug}/data/data.db")],
        legacy_tables: vec![],
        vault_fixed_keys: vec![],
        snapshot: SnapshotMode::Rpc,
    }
}

#[test]
fn scans_valid_and_retains_invalid_manifests_as_disabled_records() {
    let dir = tempdir().unwrap();
    let registry = PluginRegistry::new(dir.path());
    registry
        .install_verified(&verify::test_support::verified_package(&manifest("mfa")))
        .unwrap();
    let invalid = dir.path().join("invalid");
    fs::create_dir(&invalid).unwrap();
    fs::write(invalid.join("module.json"), b"{}").unwrap();
    let registry = PluginRegistry::new(dir.path());
    registry.scan().unwrap();
    assert_eq!(
        registry.get("mfa").unwrap().state,
        LifecycleState::Installed
    );
    assert!(registry.get("mfa").unwrap().reason.is_none());
    let invalid_record = registry.get("invalid").unwrap();
    assert_eq!(invalid_record.state, LifecycleState::Disabled);
    assert!(invalid_record.reason.is_some());
}

#[test]
fn enable_state_is_persisted_and_command_is_allowlisted() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("plugins");
    fs::create_dir(&path).unwrap();
    let registry = PluginRegistry::new(&path);
    registry
        .install_verified(&verify::test_support::verified_package(&manifest("mfa")))
        .unwrap();
    registry.scan().unwrap();
    registry.set_enabled("mfa", true).unwrap();
    assert_eq!(
        registry
            .invoke("mfa", "unknown", Value::Null)
            .unwrap_err()
            .to_string(),
        "plugin command unknown is not declared by mfa"
    );
    let reloaded = PluginRegistry::new(&path);
    reloaded.scan().unwrap();
    assert_eq!(reloaded.get("mfa").unwrap().state, LifecycleState::Enabled);
}

#[test]
fn rejects_path_traversal() {
    assert!(validate_relative_path("../data").is_err());
    assert!(validate_relative_path("/tmp/data").is_err());
    assert!(validate_relative_path("data/file.db").is_ok());
}

#[test]
fn installs_rolls_back_and_uninstalls_through_registry_projection() {
    let root = tempdir().unwrap();
    let plugins = root.path().join("plugins");
    let registry = PluginRegistry::new(&plugins);
    let package_v1 = verify::test_support::verified_package(&manifest("mfa"));
    let first = registry.install_verified(&package_v1).unwrap();
    assert_eq!(first.manifest.version, "1.0.0");
    let mut updated = manifest("mfa");
    updated.version = "1.1.0".into();
    let package_v2 = verify::test_support::verified_package(&updated);
    let second = registry.install_verified(&package_v2).unwrap();
    assert_eq!(second.manifest.version, "1.1.0");
    assert_eq!(second.previous_version.as_deref(), Some("1.0.0"));
    assert!(registry.rollback_to("mfa", Some("0.9.0")).is_err());
    let rolled = registry.rollback("mfa").unwrap();
    assert_eq!(rolled.manifest.version, "1.0.0");

    fs::create_dir_all(plugins.join("mfa/data")).unwrap();
    fs::write(plugins.join("mfa/data/keep.db"), b"keep").unwrap();
    let uninstalled = registry.uninstall("mfa", false).unwrap();
    assert_eq!(uninstalled.state, LifecycleState::Uninstalled);
    assert!(uninstalled.previous_version.is_none());
    assert!(registry.rollback("mfa").is_err());
    assert!(plugins.join("mfa/data/keep.db").is_file());
    let retained = retained_data::load(&plugins, "mfa").unwrap().unwrap();
    assert_eq!(retained.files[0].path, "keep.db");
    assert!(retained.requires_vault());
}

#[test]
fn rejects_unsigned_directory_without_activating() {
    let root = tempdir().unwrap();
    let package = tempdir().unwrap();
    fs::write(
        package.path().join("module.json"),
        serde_json::to_vec(&manifest("mfa")).unwrap(),
    )
    .unwrap();
    let registry = PluginRegistry::new(root.path());
    registry.scan().unwrap();
    let error = registry
        .install_staged("mfa", "2.0.0", package.path())
        .unwrap_err();
    assert!(error.to_string().contains("unsigned package directories"));
    assert!(!root.path().join("mfa/active.json").exists());
}

#[test]
fn uninstall_does_not_restore_enabled_state_from_settings() {
    let root = tempdir().unwrap();
    let plugins = root.path().join("plugins");
    let package = tempdir().unwrap();
    fs::write(
        package.path().join("module.json"),
        serde_json::to_vec(&manifest("mfa")).unwrap(),
    )
    .unwrap();
    let registry = PluginRegistry::new(&plugins);
    registry.scan().unwrap();
    registry
        .install_verified(&verify::test_support::verified_package(&manifest("mfa")))
        .unwrap();
    registry.set_enabled("mfa", true).unwrap();
    let uninstalled = registry.uninstall("mfa", false).unwrap();
    assert_eq!(uninstalled.state, LifecycleState::Uninstalled);

    let reloaded = PluginRegistry::new(&plugins);
    reloaded.scan().unwrap();
    assert_eq!(
        reloaded.get("mfa").expect("uninstalled record").state,
        LifecycleState::Uninstalled
    );
    assert!(
        !fs::read_to_string(plugins.join("state.json"))
            .unwrap()
            .contains("mfa")
    );
}

#[test]
fn restored_data_requires_installation_and_is_preserved_when_installing() {
    let root = tempdir().unwrap();
    let plugins = root.path().join("plugins");
    let data = plugins.join("mfa/data/mfa.db");
    fs::create_dir_all(data.parent().unwrap()).unwrap();
    fs::write(&data, b"restored MFA data").unwrap();
    let locator = retained_data::discover(&plugins, "mfa", 1).unwrap();
    retained_data::save(&plugins, &locator).unwrap();

    let registry = PluginRegistry::new(&plugins);
    registry.scan().unwrap();
    let record = registry.get("mfa").unwrap();
    assert_eq!(record.state, LifecycleState::Uninstalled);
    assert!(record.data_retained && record.reason.is_none());
    assert!(matches!(
        registry.invoke("mfa", "ping", Value::Null),
        Err(PluginError::NotFound(_))
    ));
    assert!(matches!(
        registry.frontend_asset("mfa", "1.0.0", "frontend/index.js"),
        Err(PluginError::NotFound(_))
    ));
    assert!(matches!(
        registry.set_enabled("mfa", true),
        Err(PluginError::NotFound(_))
    ));
    assert!(!plugins.join("mfa/active.json").exists());

    let record = registry
        .install_verified(&verify::test_support::verified_package(&manifest("mfa")))
        .unwrap();
    assert_eq!(record.state, LifecycleState::Installed);
    assert!(record.data_retained);
    assert!(matches!(
        registry.invoke("mfa", "ping", Value::Null),
        Err(PluginError::Disabled(_))
    ));
    assert_eq!(fs::read(data).unwrap(), b"restored MFA data");
}

#[test]
fn frontend_serves_signed_bytes_and_rejects_tampering_or_disabled_state() {
    let root = tempdir().unwrap();
    let registry = PluginRegistry::new(root.path());
    registry
        .install_verified(&verify::test_support::verified_package(&manifest("mfa")))
        .unwrap();
    assert!(
        registry
            .frontend_asset("mfa", "1.0.0", "frontend/index.js")
            .is_err()
    );
    registry.set_enabled("mfa", true).unwrap();
    assert_eq!(
        registry
            .frontend_asset("mfa", "1.0.0", "frontend/index.js")
            .unwrap(),
        b"export default () => null;"
    );
    assert!(registry.frontend_asset("mfa", "1.0.0", "bin/host").is_err());
    fs::write(
        root.path().join("mfa/versions/1.0.0/frontend/index.js"),
        b"tampered",
    )
    .unwrap();
    assert!(
        registry
            .frontend_asset("mfa", "1.0.0", "frontend/index.js")
            .is_err()
    );
    registry.set_enabled("mfa", false).unwrap();
    assert!(registry.set_enabled("mfa", true).is_err());
}

#[test]
fn uninstall_does_not_allow_an_offline_downgrade() {
    let root = tempdir().unwrap();
    let plugins = root.path().join("plugins");
    let registry = PluginRegistry::new(&plugins);
    let mut latest = manifest("mfa");
    latest.version = "2.0.0".into();
    registry
        .install_verified(&verify::test_support::verified_package(&latest))
        .unwrap();
    registry.uninstall("mfa", false).unwrap();
    let error = registry
        .install_verified(&verify::test_support::verified_package(&manifest("mfa")))
        .unwrap_err();
    assert!(error.to_string().contains("older than installed"));
    assert_eq!(
        install::ModuleInstaller::new(&plugins)
            .active_pointer("mfa")
            .unwrap()
            .previous_version
            .as_deref(),
        Some("2.0.0")
    );
}

#[test]
fn activation_failure_restores_the_old_pointer_and_projection() {
    let root = tempdir().unwrap();
    let registry = PluginRegistry::new(root.path());
    registry
        .install_verified(&verify::test_support::verified_package(&manifest("mfa")))
        .unwrap();
    registry.set_enabled("mfa", true).unwrap();
    fs::write(root.path().join("state.json"), b"broken settings JSON").unwrap();
    let mut next = manifest("mfa");
    next.version = "1.1.0".into();
    assert!(
        registry
            .install_verified(&verify::test_support::verified_package(&next))
            .is_err()
    );
    assert_eq!(
        install::ModuleInstaller::new(root.path())
            .active_pointer("mfa")
            .unwrap()
            .active_version
            .as_deref(),
        Some("1.0.0")
    );
    assert_eq!(registry.get("mfa").unwrap().manifest.version, "1.0.0");
    assert_eq!(registry.get("mfa").unwrap().state, LifecycleState::Enabled);
}

#[test]
fn scan_rejects_a_signed_version_moved_into_another_version_directory() {
    let root = tempdir().unwrap();
    let registry = PluginRegistry::new(root.path());
    registry
        .install_verified(&verify::test_support::verified_package(&manifest("mfa")))
        .unwrap();
    fs::rename(
        root.path().join("mfa/versions/1.0.0"),
        root.path().join("mfa/versions/9.0.0"),
    )
    .unwrap();
    fs::write(
        root.path().join("mfa/active.json"),
        br#"{"activeVersion":"9.0.0","previousVersion":null}"#,
    )
    .unwrap();
    registry.scan().unwrap();
    assert_eq!(registry.get("mfa").unwrap().state, LifecycleState::Disabled);
    assert!(
        registry
            .get("mfa")
            .unwrap()
            .reason
            .as_ref()
            .unwrap()
            .contains("version directory")
    );
}

#[test]
fn private_download_and_trust_directories_do_not_become_disabled_plugins() {
    let root = tempdir().unwrap();
    for name in [".downloads", ".catalog-trust"] {
        fs::create_dir(root.path().join(name)).unwrap();
    }
    let registry = PluginRegistry::new(root.path());
    registry.scan().unwrap();
    assert!(registry.list().is_empty());
    assert!(!registry.cancel_request("mfa", "missing"));
}

#[test]
fn failed_enabled_preference_write_does_not_enable_the_module_in_memory() {
    let root = tempdir().unwrap();
    let registry = PluginRegistry::new(root.path());
    registry
        .install_verified(&verify::test_support::verified_package(&manifest("mfa")))
        .unwrap();
    fs::create_dir(root.path().join("state.json.tmp")).unwrap();
    assert!(registry.set_enabled("mfa", true).is_err());
    assert_eq!(
        registry.get("mfa").unwrap().state,
        LifecycleState::Installed
    );
    assert!(matches!(
        registry.invoke("mfa", "ping", Value::Null),
        Err(PluginError::Disabled(_))
    ));
}
