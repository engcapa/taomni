//! Factory authorization and real outer lease ownership, without host processes.
use super::*;
use crate::runtime::profile::StartupMode;
use std::time::Duration;
use taomni_plugin_api::services::{FIXED_KEY_SERVICE, HostInstanceId, MFA_DATA_KEY_ID};

#[test]
fn factory_keeps_legacy_wire_and_only_the_owner_receives_fixed_key_capability() {
    let root = tempfile::tempdir().unwrap();
    let profile =
        Arc::new(ProfileRuntimeLeases::acquire(root.path(), StartupMode::Desktop).unwrap());
    let vault = Arc::new(Vault::open(&root.path().join("vault.db")).unwrap());
    let services = PluginCoreServices::new(root.path(), vault, profile).unwrap();
    let mut manifest = crate::plugin::verify::test_support::manifest();
    assert!(services.host_config(&manifest).unwrap().is_none());
    manifest.permissions.insert(FIXED_KEY_SERVICE.into());
    manifest.vault_fixed_keys.push(MFA_DATA_KEY_ID.into());
    let config = services.host_config(&manifest).unwrap().unwrap();
    assert!(Arc::ptr_eq(&config.dispatcher, &services.dispatcher));
    assert!(
        config
            .grants
            .service_capabilities()
            .supports(FIXED_KEY_SERVICE, 1)
    );
    manifest.slug = "hello".into();
    manifest.id = "taomni-plugin-hello".into();
    manifest.data_dir = "plugins/hello".into();
    assert!(matches!(
        services.host_config(&manifest),
        Err(PluginError::Rpc { code: -32004, .. })
    ));
    assert!(crate::plugin::verify::test_support::try_verified_package(&manifest).is_err());
    manifest.slug = "mfa".into();
    manifest.permissions.clear();
    assert!(services.host_config(&manifest).is_err());
}

#[test]
fn production_admission_starts_locked_and_scoped_permit_holds_the_outer_lease() {
    let dir = tempfile::tempdir().unwrap();
    let profile =
        Arc::new(ProfileRuntimeLeases::acquire(dir.path(), StartupMode::Desktop).unwrap());
    let generation = profile.generation.clone();
    let vault = Arc::new(Vault::open(&dir.path().join("vault.db")).unwrap());
    let services = PluginCoreServices::new(dir.path(), vault, profile).unwrap();
    let mut manifest = crate::plugin::verify::test_support::manifest();
    manifest.permissions.insert(FIXED_KEY_SERVICE.into());
    manifest.vault_fixed_keys.push(MFA_DATA_KEY_ID.into());
    let host = manifest_grants(&manifest)
        .unwrap()
        .bind_authenticated_transport(
            HostInstanceId::parse(uuid::Uuid::new_v4().to_string()).unwrap(),
        );
    let deadline = Instant::now() + Duration::from_secs(2);
    assert!(matches!(
        services.admit(&host, OperationKind::ReadData, deadline, &|| false),
        Err(PluginError::Rpc { code: -32009, .. })
    ));
    // This unit models the trusted coordinator's post-verification action;
    // actual password verification/lifecycle remains a separate integration.
    services.admission.after_verified_unlock().unwrap();
    let permit = services
        .admit(&host, OperationKind::ReadData, deadline, &|| false)
        .unwrap();
    assert_eq!(permit.context().profile_generation, generation);
    assert!(VaultOperationLease::try_write(&services.root).is_err());
    assert!(VaultOperationLease::try_read(&services.root).is_ok());
    drop(permit);
    assert!(VaultOperationLease::try_write(&services.root).is_ok());
    let permit = services
        .admit(
            &host,
            OperationKind::InitializeEmptyStore,
            deadline,
            &|| false,
        )
        .unwrap();
    assert!(VaultOperationLease::try_read(&services.root).is_err());
    drop(permit);
    assert!(matches!(
        services.admit(&host, OperationKind::ReadData, deadline, &|| true),
        Err(PluginError::Rpc { code: -32006, .. })
    ));
}
