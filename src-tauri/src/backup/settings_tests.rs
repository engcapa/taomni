use super::*;

#[test]
fn full_and_mail_commit_together_and_server_fields_cannot_be_overwritten() {
    let policy = policy::BackupPolicy {
        last_backup_at: Some(123),
        ..Default::default()
    };
    let next = patch_policy(
        &policy,
        &serde_json::json!({"defaultScope":"full","includeMail":true}),
    )
    .unwrap();
    assert_eq!(next.default_scope, "full");
    assert_eq!(next.include_mail, Some(true));
    assert_eq!(next.last_backup_at, Some(123));
    assert_eq!(next.settings_revision, 1);
    assert!(patch_policy(&policy, &serde_json::json!({"lastBackupAt":0})).is_err());
    assert!(patch_policy(&policy, &serde_json::json!({"settingsRevision":0})).is_err());
}

#[test]
fn legacy_policy_migration_and_a_fresh_reader_preserve_full_and_false() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("backup_policy.json");
    std::fs::write(&path, br#"{"defaultScope":"full","includeMail":false,"frequency":"daily","maxRetainedCopies":90}"#).unwrap();
    let old = policy::read_policy_at(&path).unwrap();
    assert_eq!(old.settings_revision, 0);
    assert!(old.local_channel_enabled);
    assert!(old.local_range_override.is_none());
    assert_eq!(old.include_mail, Some(false));
    let next = patch_policy(
        &old,
        &serde_json::json!({"localRangeOverride":{"scope":"core","customOptions":null}}),
    )
    .unwrap();
    control::write_json(&path, &next).unwrap();
    let reopened = policy::read_policy_at(&path).unwrap();
    assert_eq!(next, reopened);
    assert_eq!(range::global(&reopened).scope, "full");
    assert_eq!(reopened.local_range_override.unwrap().scope, "core");
    std::fs::write(&path, b"{").unwrap();
    assert!(policy::read_policy_at(&path).is_err());
}

#[test]
fn invalid_settings_are_rejected_without_mutating_the_original_policy() {
    let policy = policy::BackupPolicy::default();
    for patch in [
        serde_json::json!({"defaultScope":"inherit"}),
        serde_json::json!({"frequency":"unknown"}),
        serde_json::json!({"maxRetainedCopies":0}),
        serde_json::json!({"localRangeOverride":{"scope":"invalid","customOptions":null}}),
    ] {
        assert!(patch_policy(&policy, &patch).is_err());
    }
    assert_eq!(policy.settings_revision, 0);
    assert_eq!(policy.default_scope, "core");
}
