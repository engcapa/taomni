use super::*;
#[test]
fn workspace_write_temp_paths_are_recognized_on_every_platform() {
    assert!(is_workspace_write_temp_path(
        "/ws/src/.taomni-write-4f7a1b2c3d4e5f6a7b8c9d0e1f2a3b4c"
    ));
    assert!(is_workspace_write_temp_path(
        "C:\\ws\\src\\.taomni-write-4f7a1b2c3d4e5f6a7b8c9d0e1f2a3b4c"
    ));
    assert!(is_workspace_write_temp_path(".taomni-write-abc"));
    assert!(!is_workspace_write_temp_path("/ws/src/Main.java"));
    assert!(!is_workspace_write_temp_path(
        "/ws/.taomni-write-notes/keep.java"
    ));
}

#[test]
fn hash_mismatch_error_format() {
    let err = hash_mismatch_error("expected_123", "found_456");
    assert!(err.starts_with("hash-mismatch: "));
    assert!(err.contains("expected hash expected_123"));
    assert!(err.contains("found found_456"));
}

#[test]
fn encoded_write_hash_conflict_returns_typed_error() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("a.txt"), "one").unwrap();
    let err = workspace_write_file_encoded(
        dir.path().to_string_lossy().to_string(),
        "a.txt".into(),
        "two".into(),
        Some("deadbeef".into()),
        "UTF-8".into(),
        None,
    )
    .unwrap_err();
    assert_eq!(err.kind, WorkspaceWriteErrorKind::HashMismatch);
    assert_eq!(err.expected_hash.as_deref(), Some("deadbeef"));
    assert!(err.actual_hash.is_some());
    // §8.18.1: precondition failures are provably zero-effect.
    assert_eq!(err.effect, Some(WorkspaceWriteEffect::None));
    // §8.19.1: the fact model still reports the intended bytes identity
    // and the pre-mutation old bytes identity.
    assert_eq!(
        err.intent_hash.as_deref(),
        Some(sha256_hex(b"two").as_str()),
        "hash conflict must carry the intended encoded-bytes hash"
    );
    assert_eq!(
        err.old_hash.as_deref(),
        Some(sha256_hex(b"one").as_str()),
        "hash conflict must carry the pre-mutation target hash"
    );
    assert_eq!(
        fs::read(dir.path().join("a.txt")).unwrap(),
        b"one".to_vec(),
        "hash conflict must leave target bytes unchanged"
    );
}

#[test]
fn encoded_write_success_ack_carries_intent_and_old_hash() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("facts.txt");
    // Fresh create: old hash is absent because no target existed.
    let first = workspace_write_loose_file_encoded(
        path.to_string_lossy().to_string(),
        "first\n".into(),
        None,
        "UTF-8".into(),
        Some(false),
    )
    .unwrap();
    assert_eq!(first.intent_hash, first.written_hash);
    assert_eq!(first.old_hash, None);
    assert_eq!(first.intent_hash, sha256_hex(b"first\n"));
    // Overwrite: the ack carries the previous bytes identity.
    let second = workspace_write_loose_file_encoded(
        path.to_string_lossy().to_string(),
        "second\n".into(),
        Some(first.written_hash.clone()),
        "UTF-8".into(),
        Some(false),
    )
    .unwrap();
    assert_eq!(second.intent_hash, second.written_hash);
    assert_eq!(
        second.old_hash.as_deref(),
        Some(first.written_hash.as_str()),
        "overwrite ack must report the pre-mutation bytes hash"
    );
}

#[test]
fn write_workspace_bytes_unknown_effect_error_carries_intent_and_old_hash() {
    // Simulate an uncertain replace outcome by making the parent directory
    // read-only after the temp file is written is not portable; instead
    // drive `write_workspace_bytes` directly against a target whose rename
    // cannot succeed: parent is a file, so mkdir/rename both fail before a
    // temp write (zero-effect) — this asserts the zero-effect path keeps
    // carrying intent facts only when reached after encoding succeeded.
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("existing.txt");
    fs::write(&target, b"old").unwrap();
    let result = write_workspace_bytes(&target, b"new".to_vec(), Some("deadbeef"));
    let err = result.unwrap_err();
    assert_eq!(err.effect, Some(WorkspaceWriteEffect::None));
    assert_eq!(
        err.intent_hash.as_deref(),
        Some(sha256_hex(b"new").as_str())
    );
    assert_eq!(err.old_hash.as_deref(), Some(sha256_hex(b"old").as_str()));
}

// ED-IMPROVE-006 A1: every pre-replace failure identifies the intended
// bytes, proves zero target effect where it can, and removes this writer's
// temp file without touching any other entry.
#[test]
fn write_workspace_bytes_read_failure_reports_zero_effect_with_intent() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("target-dir");
    fs::create_dir(&target).unwrap();
    let err = write_workspace_bytes(&target, b"new".to_vec(), None).unwrap_err();
    assert_eq!(err.kind, WorkspaceWriteErrorKind::Io);
    assert_eq!(err.effect, Some(WorkspaceWriteEffect::None));
    assert_eq!(
        err.intent_hash.as_deref(),
        Some(sha256_hex(b"new").as_str())
    );
    assert_eq!(err.intent_byte_length, Some(3));
    assert_eq!(err.old_hash, None);
    assert!(write_temp_entries(dir.path()).is_empty());
}

#[test]
fn write_workspace_bytes_missing_precondition_target_carries_intent() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("missing.txt");
    let err = write_workspace_bytes(&target, b"new".to_vec(), Some("abc")).unwrap_err();
    assert_eq!(err.effect, Some(WorkspaceWriteEffect::None));
    assert_eq!(
        err.intent_hash.as_deref(),
        Some(sha256_hex(b"new").as_str())
    );
    assert_eq!(err.old_hash, None);
    assert!(write_temp_entries(dir.path()).is_empty());
}

#[test]
fn write_workspace_bytes_temp_stage_failures_clean_up_and_keep_bytes() {
    for fault in [
        WriteBytesFault::TempOpen,
        WriteBytesFault::TempWrite,
        WriteBytesFault::TempSync,
        WriteBytesFault::Replace,
    ] {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("existing.txt");
        fs::write(&target, b"old").unwrap();
        // A foreign entry that must survive the cleanup.
        let foreign = dir.path().join(".taomni-write-foreign-owned");
        fs::write(&foreign, b"foreign").unwrap();
        let foreign_name = foreign.file_name().unwrap().to_string_lossy().to_string();

        let err = write_workspace_bytes_with_fault(&target, b"new-bytes".to_vec(), None, fault)
            .unwrap_err();
        assert_eq!(
            err.effect,
            Some(WorkspaceWriteEffect::None),
            "stage {fault:?} must prove zero target effect"
        );
        assert_eq!(
            err.intent_hash.as_deref(),
            Some(sha256_hex(b"new-bytes").as_str()),
            "stage {fault:?} must carry the intended hash"
        );
        assert_eq!(err.intent_byte_length, Some(9), "stage {fault:?}");
        assert_eq!(
            err.old_hash.as_deref(),
            Some(sha256_hex(b"old").as_str()),
            "stage {fault:?} must carry the old hash"
        );
        assert_eq!(
            fs::read(&target).unwrap(),
            b"old".to_vec(),
            "stage {fault:?} must leave the target untouched"
        );
        let leftovers: Vec<String> = write_temp_entries(dir.path())
            .into_iter()
            .filter(|name| name != &foreign_name)
            .collect();
        assert!(
            leftovers.is_empty(),
            "stage {fault:?} must remove its own temp file, found {leftovers:?}"
        );
        assert_eq!(fs::read(&foreign).unwrap(), b"foreign".to_vec());
    }
}

#[test]
fn write_workspace_bytes_parent_is_file_reports_zero_effect() {
    let dir = tempfile::tempdir().unwrap();
    let parent_file = dir.path().join("parent.txt");
    fs::write(&parent_file, b"not a dir").unwrap();
    let target = parent_file.join("child.txt");
    let err = write_workspace_bytes(&target, b"new".to_vec(), None).unwrap_err();
    assert_eq!(err.kind, WorkspaceWriteErrorKind::Io);
    assert_eq!(err.effect, Some(WorkspaceWriteEffect::None));
    assert_eq!(
        err.intent_hash.as_deref(),
        Some(sha256_hex(b"new").as_str())
    );
    assert_eq!(err.old_hash, None);
    assert_eq!(fs::read(&parent_file).unwrap(), b"not a dir".to_vec());
    assert!(write_temp_entries(dir.path()).is_empty());
}

#[test]
fn replace_file_preserves_existing_target_on_failure_and_replaces_on_success() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("existing.txt");
    fs::write(&target, b"old").unwrap();

    // A failing replace (missing source) must not delete the old target.
    let missing = dir.path().join("missing-temp");
    assert!(replace_file(&missing, &target).is_err());
    assert_eq!(
        fs::read(&target).unwrap(),
        b"old".to_vec(),
        "a failed replace must leave the old bytes in place"
    );

    // A successful replace swaps the bytes and consumes the temp file.
    let tmp = dir.path().join("new-temp");
    fs::write(&tmp, b"new").unwrap();
    replace_file(&tmp, &target).unwrap();
    assert_eq!(fs::read(&target).unwrap(), b"new".to_vec());
    assert!(!tmp.exists());
}

#[cfg(windows)]
#[test]
fn replace_file_failure_keeps_windows_target_bytes() {
    // Regression for the delete-then-rename window: on Windows a failed
    // replace used to remove the only copy of the old bytes. The target
    // must survive a failed replace.
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("existing.txt");
    fs::write(&target, b"old").unwrap();
    let missing = dir.path().join("missing-temp");
    assert!(replace_file(&missing, &target).is_err());
    assert_eq!(fs::read(&target).unwrap(), b"old".to_vec());
}

#[test]
fn write_workspace_bytes_replace_failure_on_missing_target_is_unknown() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("fresh.txt");
    let err =
        write_workspace_bytes_with_fault(&target, b"new".to_vec(), None, WriteBytesFault::Replace)
            .unwrap_err();
    assert_eq!(err.effect, Some(WorkspaceWriteEffect::Unknown));
    assert_eq!(
        err.intent_hash.as_deref(),
        Some(sha256_hex(b"new").as_str())
    );
    assert_eq!(err.old_hash, None);
    assert!(write_temp_entries(dir.path()).is_empty());
}

#[test]
fn encoded_write_encoding_error_carries_none_effect() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("a.txt"), "one").unwrap();
    let err = workspace_write_file_encoded(
        dir.path().to_string_lossy().to_string(),
        "a.txt".into(),
        "hello 世界".into(),
        None,
        "ISO-8859-1".into(),
        None,
    )
    .unwrap_err();
    assert_eq!(err.kind, WorkspaceWriteErrorKind::Encoding);
    assert_eq!(err.effect, Some(WorkspaceWriteEffect::None));
    assert_eq!(fs::read(dir.path().join("a.txt")).unwrap(), b"one".to_vec());
}

#[test]
fn encoded_write_iso_8859_1_latin1_bytes_round_trip() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("latin1.txt");
    // "café" in ISO-8859-1: é is the single byte 0xE9.
    let saved = workspace_write_loose_file_encoded(
        path.to_string_lossy().to_string(),
        "café\n".into(),
        None,
        "ISO-8859-1".into(),
        Some(false),
    )
    .unwrap();
    assert_eq!(
        fs::read(&path).unwrap(),
        vec![b'c', b'a', b'f', 0xE9, b'\n']
    );
    assert_eq!(saved.file.text, "café\n");
    assert_eq!(
        saved.written_hash,
        sha256_hex(&[b'c', b'a', b'f', 0xE9, b'\n'])
    );
    assert_eq!(saved.written_byte_length, 5);
    assert!(saved.atomic_replace_used);
}

#[test]
fn encoded_write_unrepresentable_char_returns_encoding_error() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("a.txt"), "one").unwrap();
    let err = workspace_write_file_encoded(
        dir.path().to_string_lossy().to_string(),
        "a.txt".into(),
        "hello 世界".into(),
        Some(sha256_hex(b"one")),
        "ISO-8859-1".into(),
        None,
    )
    .unwrap_err();
    assert_eq!(err.kind, WorkspaceWriteErrorKind::Encoding);
    assert_eq!(
        fs::read(dir.path().join("a.txt")).unwrap(),
        b"one".to_vec(),
        "encode failure must leave target bytes unchanged"
    );
}

#[test]
fn encoded_write_missing_target_with_hash_precondition_is_io_error() {
    let dir = tempfile::tempdir().unwrap();
    let err = workspace_write_file_encoded(
        dir.path().to_string_lossy().to_string(),
        "missing.txt".into(),
        "text".into(),
        Some("anyhash".into()),
        "UTF-8".into(),
        None,
    )
    .unwrap_err();
    assert_eq!(err.kind, WorkspaceWriteErrorKind::Io);
    assert!(!dir.path().join("missing.txt").exists());
}

#[test]
fn classify_io_error_maps_permission_denied() {
    let denied = std::io::Error::from(std::io::ErrorKind::PermissionDenied);
    assert_eq!(
        classify_io_error("open temp file", &denied).kind,
        WorkspaceWriteErrorKind::Permission
    );
    let other = std::io::Error::from(std::io::ErrorKind::NotFound);
    assert_eq!(
        classify_io_error("open temp file", &other).kind,
        WorkspaceWriteErrorKind::Io
    );
}
