use super::*;

fn manual(host: &str) -> AppProxyConfig {
    AppProxyConfig {
        enabled: true,
        host: host.into(),
        ..Default::default()
    }
}

#[test]
fn independent_proxy_roundtrips_without_replacing_application_settings_or_saving_passwords() {
    let directory = tempfile::tempdir().unwrap();
    let application = directory.path().join("proxy.json");
    manual("app.proxy").save(&application).unwrap();
    let before = fs::read(&application).unwrap();
    let settings = ModuleNetworkConfig {
        mode: "custom".into(),
        custom: AppProxyConfig {
            password_ref: "vault:module-password".into(),
            ..manual("feature.proxy")
        },
    };
    let path = directory.path().join("modules-network.json");
    settings.save(&path).unwrap();
    assert_eq!(ModuleNetworkConfig::load(&path).unwrap(), settings);
    assert_eq!(fs::read(application).unwrap(), before);
    let mut invalid = settings.clone();
    invalid.custom.password_ref = "plaintext-password".into();
    assert!(invalid.save(&path).is_err());
    assert!(
        !fs::read_to_string(&path)
            .unwrap()
            .contains("plaintext-password")
    );
    assert_eq!(ModuleNetworkConfig::load(&path).unwrap(), settings);
}

#[test]
fn default_uses_current_application_config_and_disabled_application_means_explicit_direct() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("proxy.json");
    let settings = ModuleNetworkConfig::load(&directory.path().join("missing.json")).unwrap();
    assert_eq!(settings.mode, "app");
    assert_eq!(resolve(&settings, &path, None, None).unwrap(), None);
    manual("first.proxy").save(&path).unwrap();
    assert_eq!(
        resolve(&settings, &path, None, None).unwrap().unwrap().host,
        "first.proxy"
    );
    manual("second.proxy").save(&path).unwrap();
    assert_eq!(
        resolve(&settings, &path, None, None).unwrap().unwrap().host,
        "second.proxy"
    );
    AppProxyConfig::default().save(&path).unwrap();
    assert_eq!(resolve(&settings, &path, None, None).unwrap(), None);
}

#[test]
fn corrupt_settings_and_unknown_modes_never_become_direct_connections() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("network.json");
    fs::write(&path, "{").unwrap();
    assert!(ModuleNetworkConfig::load(&path).is_err());
    let mut settings = ModuleNetworkConfig::default();
    settings.mode = "misspelled".into();
    assert!(settings.save(&path).is_err());
    assert!(resolve(&settings, &path, None, None).is_err());
    settings.mode = "app".into();
    assert!(resolve(&settings, &path, None, None).is_err());
    settings.mode = "none".into();
    assert_eq!(resolve(&settings, &path, None, None).unwrap(), None);
}

#[test]
fn selected_custom_proxy_cannot_be_disabled_into_direct_or_degrade_when_credentials_are_locked() {
    let directory = tempfile::tempdir().unwrap();
    let application = directory.path().join("invalid-app.json");
    fs::write(&application, "invalid application config").unwrap();
    let mut settings = ModuleNetworkConfig {
        mode: "custom".into(),
        custom: manual("feature.proxy"),
    };
    settings.custom.enabled = false;
    assert_eq!(
        resolve(&settings, &application, None, None)
            .unwrap()
            .unwrap()
            .host,
        "feature.proxy"
    );
    settings.custom.host.clear();
    assert!(resolve(&settings, &application, None, None).is_err());
    settings.custom.host = "feature.proxy".into();
    settings.custom.password_ref = "vault:missing".into();
    let vault = Vault::open(&directory.path().join("vault.db")).unwrap();
    assert!(
        resolve(&settings, &application, None, Some(&vault))
            .unwrap_err()
            .contains("unlock the vault")
    );
    settings.custom.mode = "session".into();
    settings.custom.session_id = "missing-session".into();
    assert!(resolve(&settings, &application, None, Some(&vault)).is_err());
}

#[cfg(unix)]
#[test]
fn linked_feature_config_is_rejected_for_read_and_save() {
    let directory = tempfile::tempdir().unwrap();
    let outside = directory.path().join("outside.json");
    let path = directory.path().join("linked.json");
    fs::write(&outside, "sensitive unrelated config").unwrap();
    std::os::unix::fs::symlink(&outside, &path).unwrap();
    assert!(ModuleNetworkConfig::load(&path).is_err());
    assert!(ModuleNetworkConfig::default().save(&path).is_err());
    assert_eq!(
        fs::read_to_string(outside).unwrap(),
        "sensitive unrelated config"
    );
}

#[path = "network_native_tests.rs"]
mod native;
