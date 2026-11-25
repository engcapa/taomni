use super::{
    contracts::*,
    test_support::{dataset, manifest},
};

#[test]
fn data_metadata_rejects_paths_code_grants_and_case_collisions() {
    for path in [
        "../vault.db",
        "a/../../active.json",
        "C:/data.db",
        "data\\secret",
        "CON",
        "a/../b",
        "folder./a",
    ] {
        let mut data = dataset("hello", &[(path, PluginDataFileKind::File)]);
        assert!(data.validate().is_err(), "accepted {path}");
        data.slug = "../mfa".into();
        assert!(data.validate().is_err());
    }
    for files in [
        vec!["a", "A"],
        vec!["a", "a/b"],
        vec!["Folder/a", "folder/b"],
    ] {
        let data = dataset(
            "hello",
            &files
                .iter()
                .map(|path| (*path, PluginDataFileKind::File))
                .collect::<Vec<_>>(),
        );
        assert!(data.validate().is_err(), "accepted {files:?}");
    }
    let mut value =
        serde_json::to_value(dataset("hello", &[("data.bin", PluginDataFileKind::File)])).unwrap();
    for key in [
        "commands",
        "permissions",
        "entry",
        "vaultFixedKeys",
        "activeVersion",
    ] {
        value[key] = serde_json::json!([]);
        assert!(serde_json::from_value::<PluginDataSet>(value.clone()).is_err());
        value.as_object_mut().unwrap().remove(key);
    }
}

#[test]
fn data_metadata_cannot_omit_vault_or_mix_generations_or_sidecars() {
    let data = dataset("mfa", &[("tokens", PluginDataFileKind::Sqlite)]);
    let mut complete = manifest(data);
    assert!(validate_manifest(&complete).is_ok());
    complete
        .files
        .retain(|file| file.path != "databases/vault.db");
    assert!(
        validate_manifest(&complete)
            .unwrap_err()
            .contains("requires vault.db")
    );
    complete.plugin_datasets[0].requires_vault = false;
    assert!(
        validate_manifest(&complete)
            .unwrap_err()
            .contains("core policy")
    );
    let mut mixed = manifest(dataset("hello", &[("db", PluginDataFileKind::Sqlite)]));
    let mut other = dataset("other", &[("file", PluginDataFileKind::File)]);
    other.profile_generation =
        taomni_plugin_api::services::ProfileGeneration::parse(uuid::Uuid::new_v4().to_string())
            .unwrap();
    mixed.add_file(other.archive_path("file"), "f".repeat(64), 1);
    mixed.plugin_datasets.push(other);
    assert!(
        validate_manifest(&mixed)
            .unwrap_err()
            .contains("generations/jobs")
    );
    let sidecars = dataset(
        "hello",
        &[
            ("db", PluginDataFileKind::Sqlite),
            ("db-wal", PluginDataFileKind::File),
        ],
    );
    assert!(sidecars.validate().unwrap_err().contains("sidecars"));
}

#[test]
fn rdp_backup_with_settings_requires_vault_and_tls_only_archives_still_open() {
    let identity = [
        ("cert.pem", PluginDataFileKind::File),
        ("key.pem", PluginDataFileKind::File),
    ];
    assert!(validate_manifest(&manifest(dataset("rdp-server", &identity))).is_ok());

    let mut files = identity.to_vec();
    files.push(("config.json", PluginDataFileKind::File));
    let mut settings = manifest(dataset("rdp-server", &files));
    assert!(validate_manifest(&settings).is_ok());
    settings
        .files
        .retain(|file| file.path != "databases/vault.db");
    assert!(
        validate_manifest(&settings)
            .unwrap_err()
            .contains("requires vault.db")
    );
}

#[test]
fn payloads_and_datasets_must_match_and_legacy_cannot_hide_plugin_data() {
    let mut value = manifest(dataset("hello", &[("blob", PluginDataFileKind::File)]));
    value.files.clear();
    assert!(validate_manifest(&value).is_err());
    value.add_file("plugins/hello/data/unknown".into(), "e".repeat(64), 1);
    assert!(validate_manifest(&value).is_err());
    value = manifest(dataset("hello", &[("blob", PluginDataFileKind::File)]));
    value.format_version = 1;
    assert!(validate_manifest(&value).is_err());
    value.plugin_datasets.clear();
    assert!(validate_manifest(&value).is_err());
    let mut v1 = super::super::manifest::BackupManifest::new("old".into(), "core".into(), false);
    v1.add_file("databases/mfa.db".into(), "e".repeat(64), 1);
    assert!(
        validate_manifest(&v1)
            .unwrap_err()
            .contains("requires vault.db")
    );
}

#[test]
fn imap_ownership_receipt_requires_the_matching_sqlite_snapshot() {
    let receipt = ("account.imap-owner", PluginDataFileKind::File);
    let data = dataset("mail", &[receipt]);
    assert!(data.validate().is_err());
    let data = dataset("mail", &[receipt, ("account.db", PluginDataFileKind::File)]);
    assert!(data.validate().is_err());

    let data = dataset(
        "mail",
        &[receipt, ("account.db", PluginDataFileKind::Sqlite)],
    );
    data.validate().unwrap();
    assert_eq!(
        data.owned_mailbox_names().collect::<Vec<_>>(),
        ["account.db"]
    );
}
