//! Real production-key packages, registry lifecycle and persisted Vault gates.
//! This prototype has no frontend; it does not establish OS system trust,
//! installed-monolith upgrade or the app facade's eventual module routing.
#[path = "signed_mfa_support.rs"]
pub(super) mod support;
use super::*;
use serde_json::json;
use support::*;
use taomni_plugin_api::services::MFA_DATA_KEY_ID;
use taomni_plugin_services::OperationKind;

#[test]
#[ignore = "release-signed MFA package and real installed process: GitHub only"]
fn signed_mfa_installs_runs_and_retains_hotp_through_disable_and_reinstallation() {
    let h = InstalledMfa::new();
    h.initialize();
    let id = h.add();
    assert_eq!(h.code()["code"], "755224");
    let original_host = h.assert_host_owns_installed_data();
    h.call(OperationKind::WriteData, "mfa_hotp_next", json!({"id":id}))
        .unwrap();
    assert_eq!(h.code()["code"], "287082");
    let key = h.state.vault.get_fixed(MFA_DATA_KEY_ID).unwrap().unwrap();
    assert_eq!(
        h.state.registry.set_enabled("mfa", false).unwrap().state,
        LifecycleState::Disabled
    );
    h.assert_data_released();
    assert!(matches!(
        h.call(OperationKind::ReadData, "mfa_codes", json!({})),
        Err(PluginError::Disabled(_))
    ));
    h.state.registry.set_enabled("mfa", true).unwrap();
    assert_eq!(h.code()["code"], "287082");
    assert_ne!(h.assert_host_owns_installed_data(), original_host);
    let record = h.state.registry.uninstall("mfa", false).unwrap();
    assert_eq!(record.state, LifecycleState::Uninstalled);
    assert!(record.data_retained);
    h.assert_data_released();
    assert!(
        install::ModuleInstaller::new(h.state.registry.root())
            .active_pointer("mfa")
            .unwrap()
            .active_version
            .is_none()
    );
    h.state.registry.install_verified(&h.package).unwrap();
    h.state.registry.set_enabled("mfa", true).unwrap();
    let code = h.code();
    assert_eq!(code["id"], id);
    assert_eq!(code["counter"], 1);
    assert_eq!(code["code"], "287082");
    assert!(
        h.state
            .vault
            .get_fixed(MFA_DATA_KEY_ID)
            .unwrap()
            .unwrap()
            .as_str()
            == key.as_str(),
        "Reinstallation replaced the MFA fixed key"
    );
    h.state.registry.shutdown().unwrap();
    h.assert_data_released();
}

#[test]
#[ignore = "release key, tampered installed MFA code and real host: GitHub only"]
fn production_key_rejects_unit_signatures_and_tampered_mfa_without_changing_data_or_activation() {
    let bytes = b"unit signature must never authorize the hosted release gate";
    let unit = tempfile::NamedTempFile::new().unwrap();
    fs::write(unit.path(), bytes).unwrap();
    let signature = verify::test_support::sign(bytes, "unit-fixture");
    assert!(matches!(
        verify::VerifiedPackage::from_offline(unit.path(), &signature, current_platform()),
        Err(verify::TrustError::Signature(_))
    ));
    let h = InstalledMfa::new();
    h.initialize();
    h.add();
    assert_eq!(h.code()["code"], "755224");
    let active = h.active();
    h.state.registry.set_enabled("mfa", false).unwrap();
    h.assert_data_released();
    let pointer = fs::read(h.state.registry.root().join("mfa/active.json")).unwrap();
    let database = h.state.services.root.path().join("plugins/mfa/data/mfa.db");
    let data = fs::read(&database).unwrap();
    let key = h.state.vault.get_fixed(MFA_DATA_KEY_ID).unwrap().unwrap();
    let host = active.join(h.package.manifest().entry.host.as_ref().unwrap());
    let original = fs::read(&host).unwrap();
    let mut changed = original.clone();
    changed[0] ^= 1;
    fs::write(&host, changed).unwrap();
    assert!(h.state.registry.set_enabled("mfa", true).is_err());
    assert_eq!(
        fs::read(h.state.registry.root().join("mfa/active.json")).unwrap(),
        pointer
    );
    assert_eq!(fs::read(&database).unwrap(), data);
    assert!(
        h.state
            .vault
            .get_fixed(MFA_DATA_KEY_ID)
            .unwrap()
            .unwrap()
            .as_str()
            == key.as_str(),
        "Rejected installed code changed the MFA fixed key"
    );
    h.assert_data_released();
    fs::write(&host, original).unwrap();
    let unsigned = active.join("unsigned.js");
    fs::write(&unsigned, b"unsigned payload").unwrap();
    assert!(h.state.registry.set_enabled("mfa", true).is_err());
    fs::remove_file(unsigned).unwrap();
    h.state.registry.set_enabled("mfa", true).unwrap();
    assert_eq!(h.code()["code"], "755224");
    h.assert_host_owns_installed_data();
    h.state.registry.shutdown().unwrap();
    h.assert_data_released();
}

#[test]
#[ignore = "production registry Vault transitions with installed MFA: GitHub only"]
fn registered_mfa_survives_coordinated_rekey_lock_and_unlock_without_replacing_its_fixed_key() {
    let h = InstalledMfa::new();
    h.initialize();
    let id = h.add();
    h.call(OperationKind::WriteData, "mfa_hotp_next", json!({"id":id}))
        .unwrap();
    let key = h.state.vault.get_fixed(MFA_DATA_KEY_ID).unwrap().unwrap();
    h.state
        .registry
        .change_vault_master(
            &h.state.vault,
            test_services::PASSWORD,
            "signed-mfa-new-master",
        )
        .unwrap();
    assert_eq!(h.code()["code"], "287082");
    assert!(
        h.state
            .registry
            .verify_restore_password(&h.state.vault, Some(test_services::PASSWORD))
            .is_err()
    );
    assert_eq!(h.code()["code"], "287082");
    h.state.registry.lock_vault(&h.state.vault).unwrap();
    assert!(
        h.call(OperationKind::ReadData, "mfa_codes", json!({}))
            .unwrap_err()
            .to_string()
            .contains("VAULT_LOCKED")
    );
    assert!(
        h.state
            .registry
            .unlock_vault(&h.state.vault, test_services::PASSWORD)
            .is_err()
    );
    h.state
        .registry
        .unlock_vault(&h.state.vault, "signed-mfa-new-master")
        .unwrap();
    assert_eq!(h.code()["code"], "287082");
    assert!(
        h.state
            .vault
            .get_fixed(MFA_DATA_KEY_ID)
            .unwrap()
            .unwrap()
            .as_str()
            == key.as_str(),
        "Coordinated Vault transitions replaced the MFA fixed key"
    );
    h.assert_host_owns_installed_data();
    h.state.registry.shutdown().unwrap();
    h.assert_data_released();
}
