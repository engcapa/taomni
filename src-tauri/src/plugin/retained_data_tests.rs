use super::*;
use crate::plugin::{data_contract, verify};
use tempfile::tempdir;

#[test]
fn stored_mail_attachment_is_opaque_even_with_a_database_header() {
    let profile = tempdir().unwrap();
    let plugins = profile.path().join("plugins");
    let data = plugins.join("mail/data");
    let attachment = "attachments/account/INBOX/4-1.bin";
    fs::create_dir_all(data.join(attachment).parent().unwrap()).unwrap();
    let payload = b"SQLite format 3\0fixture contents";
    fs::write(data.join(attachment), payload).unwrap();
    fs::write(data.join("account.db"), payload).unwrap();
    let files = discover(&plugins, "mail", 1).unwrap().files;
    assert_eq!(files[0].kind, DataFileKind::Sqlite);
    assert_eq!(files[1].path, attachment);
    assert_eq!(files[1].kind, DataFileKind::File);
    assert!(is_database("another-owner", attachment, &payload[..16]));
}

#[test]
fn manifest_data_paths_cannot_reach_core_code_other_owners_or_control_files() {
    let mut manifest = verify::test_support::manifest();
    for path in [
        "vault.db",
        "plugins/mfa/data.db",
        "plugins/other/data/accounts.db",
        "plugins/mfa/versions/1.0.0/host",
        "plugins/mfa/active.json",
        "plugins/mfa/data/../active.json",
        "plugins/mfa/data/./accounts.db",
        "plugins/mfa/data/link:stream",
        "plugins/mfa/data/CON.db",
        "plugins/mfa/data/trailing. ",
        "plugins/mfa/data/a?b",
    ] {
        manifest.backup_paths = vec![path.into()];
        assert!(
            data_contract::validate_manifest(&manifest).is_err(),
            "{path}"
        );
        assert!(
            verify::test_support::try_verified_package(&manifest).is_err(),
            "signed {path}"
        );
    }
    manifest.backup_paths = vec![
        "plugins/mfa/data".into(),
        "plugins/mfa/data/accounts/mfa.db".into(),
    ];
    assert!(data_contract::validate_manifest(&manifest).is_ok());
    assert!(verify::test_support::try_verified_package(&manifest).is_ok());
    manifest.backup_paths = vec![
        "plugins/mfa/data/A.db".into(),
        "plugins/mfa/data/a.db".into(),
    ];
    assert!(data_contract::validate_manifest(&manifest).is_err());
    manifest.backup_paths.clear();
    manifest.data_schema_version = 0;
    assert!(data_contract::validate_manifest(&manifest).is_err());
}

#[test]
fn discovery_is_data_only_classifies_sqlite_and_does_not_initialize_missing_data() {
    let profile = tempdir().unwrap();
    let plugins = profile.path().join("plugins");
    fs::create_dir_all(plugins.join("mfa/versions/1.0.0")).unwrap();
    fs::write(
        plugins.join("mfa/versions/1.0.0/host"),
        b"never archive code",
    )
    .unwrap();
    let empty = discover(&plugins, "mfa", 1).unwrap();
    assert!(empty.files.is_empty());
    assert!(!empty.requires_vault());
    assert!(!plugins.join("mfa/data").exists());
    fs::create_dir_all(plugins.join("mfa/data/accounts")).unwrap();
    fs::write(
        plugins.join("mfa/data/accounts/mfa.db"),
        b"SQLite format 3\0unit contents",
    )
    .unwrap();
    fs::write(plugins.join("mfa/data/settings.json"), b"{}").unwrap();
    let locator = discover(&plugins, "mfa", 7).unwrap();
    assert_eq!(locator.data_schema_version, 7);
    assert_eq!(
        locator.files,
        vec![
            RetainedDataFile {
                path: "accounts/mfa.db".into(),
                kind: DataFileKind::Sqlite
            },
            RetainedDataFile {
                path: "settings.json".into(),
                kind: DataFileKind::File
            },
        ]
    );
    assert!(locator.requires_vault());
    save(&plugins, &locator).unwrap();
    assert_eq!(load(&plugins, "mfa").unwrap(), Some(locator));
    remove(&plugins, "mfa").unwrap();
    assert!(load(&plugins, "mfa").unwrap().is_none());
    assert!(plugins.join("mfa/data/accounts/mfa.db").is_file());
    assert!(plugins.join("mfa/versions/1.0.0/host").is_file());
}

#[test]
fn locator_metadata_cannot_grant_authority_or_disable_the_core_vault_dependency() {
    let profile = tempdir().unwrap();
    let plugins = profile.path().join("plugins");
    fs::create_dir_all(plugins.join("mfa/data")).unwrap();
    fs::write(plugins.join("mfa/data/mfa.db"), b"retained encrypted data").unwrap();
    let locator = discover(&plugins, "mfa", 1).unwrap();
    assert!(locator.requires_vault());
    for field in [
        "commands",
        "permissions",
        "vaultFixedKeys",
        "requiresVault",
        "activeVersion",
        "host",
    ] {
        let mut forged = serde_json::to_value(&locator).unwrap();
        forged[field] = serde_json::json!(false);
        assert!(
            serde_json::from_value::<RetainedDataLocator>(forged).is_err(),
            "{field}"
        );
    }
    for path in [
        "../vault.db",
        "/vault.db",
        "C:/vault.db",
        "a\\b",
        "./mfa.db",
    ] {
        let mut forged = locator.clone();
        forged.files[0].path = path.into();
        assert!(save(&plugins, &forged).is_err(), "{path}");
    }
    let mut forged = locator.clone();
    forged.slug = "other".into();
    assert!(forged.validate("mfa").is_err());
    forged = locator.clone();
    forged.files.push(locator.files[0].clone());
    assert!(forged.validate("mfa").is_err());
}

#[test]
fn bounded_or_invalid_locator_load_never_falls_back_to_silent_data_loss() {
    let profile = tempdir().unwrap();
    fs::create_dir(profile.path().join(CONTROL_DIRECTORY)).unwrap();
    let path = profile.path().join(CONTROL_DIRECTORY).join("mfa.json");
    fs::write(&path, b"not JSON").unwrap();
    assert!(load(profile.path(), "mfa").is_err());
    fs::write(&path, vec![b' '; MAX_BYTES as usize + 1]).unwrap();
    assert!(load(profile.path(), "mfa").is_err());
    assert!(remove(profile.path(), "mfa").is_err());
    assert!(path.exists());
}

#[cfg(unix)]
#[test]
fn discovery_and_control_metadata_reject_links_and_leave_external_data_untouched() {
    use std::os::unix::fs::symlink;
    let profile = tempdir().unwrap();
    let external = tempdir().unwrap();
    fs::write(external.path().join("secret.db"), b"external vault data").unwrap();
    let plugins = profile.path().join("plugins");
    fs::create_dir_all(plugins.join("mfa")).unwrap();
    symlink(external.path(), plugins.join("mfa/data")).unwrap();
    assert!(discover(&plugins, "mfa", 1).is_err());
    fs::remove_file(plugins.join("mfa/data")).unwrap();
    fs::create_dir(plugins.join("mfa/data")).unwrap();
    symlink(
        external.path().join("secret.db"),
        plugins.join("mfa/data/link.db"),
    )
    .unwrap();
    assert!(discover(&plugins, "mfa", 1).is_err());
    fs::remove_file(plugins.join("mfa/data/link.db")).unwrap();
    fs::hard_link(
        external.path().join("secret.db"),
        plugins.join("mfa/data/link.db"),
    )
    .unwrap();
    assert!(discover(&plugins, "mfa", 1).is_err());
    symlink(external.path(), plugins.join(CONTROL_DIRECTORY)).unwrap();
    assert!(load(&plugins, "mfa").is_err());
    assert_eq!(
        fs::read(external.path().join("secret.db")).unwrap(),
        b"external vault data"
    );
}
