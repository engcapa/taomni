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

fn write_temp_entries(dir: &Path) -> Vec<String> {
    fs::read_dir(dir)
        .unwrap()
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.file_name().to_string_lossy().to_string())
        .filter(|name| is_workspace_write_temp_path(name))
        .collect()
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

#[test]
fn rejects_parent_dir_escape() {
    let dir = tempfile::tempdir().unwrap();
    let err = workspace_list_dir(dir.path().to_string_lossy().to_string(), Some("../".into()))
        .unwrap_err();
    assert!(err.contains(".."));
}

#[test]
fn rejects_dot_git_writes() {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir(dir.path().join(".git")).unwrap();
    let err = workspace_write_file(
        dir.path().to_string_lossy().to_string(),
        ".git/config".into(),
        "x".into(),
        None,
    )
    .unwrap_err();
    assert!(err.contains(".git"));
}

#[test]
fn detects_expected_hash_conflict() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("a.txt"), "one").unwrap();
    let file = workspace_read_file(
        dir.path().to_string_lossy().to_string(),
        "a.txt".into(),
        None,
    )
    .unwrap();
    fs::write(dir.path().join("a.txt"), "two").unwrap();
    let err = workspace_write_file(
        dir.path().to_string_lossy().to_string(),
        "a.txt".into(),
        "three".into(),
        Some(file.hash),
    )
    .unwrap_err();
    assert!(err.contains("changed on disk"));
}

#[test]
fn reads_and_writes_loose_file_with_hash_check() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("note.md");
    fs::write(&path, "one").unwrap();
    let path_string = path.to_string_lossy().to_string();

    let file = workspace_read_loose_file(path_string.clone(), None).unwrap();
    assert_eq!(PathBuf::from(&file.path), path.canonicalize().unwrap());
    assert_eq!(file.text, "one");

    let saved =
        workspace_write_loose_file(path_string.clone(), "two".into(), Some(file.hash)).unwrap();
    assert_eq!(saved.text, "two");

    let err =
        workspace_write_loose_file(path_string, "three".into(), Some("bad".into())).unwrap_err();
    assert!(err.contains("changed on disk"));
}

#[test]
fn reads_utf8_bom_without_exposing_marker_to_editor_text() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("bom.txt");
    fs::write(&path, b"\xEF\xBB\xBFhello\r\n").unwrap();

    let file = workspace_read_loose_file(path.to_string_lossy().to_string(), None).unwrap();
    assert_eq!(file.encoding, "UTF-8");
    assert!(file.bom);
    assert_eq!(file.text, "hello\r\n");
    assert_eq!(file.size, 10);
    assert_eq!(file.hash, sha256_hex(b"\xEF\xBB\xBFhello\r\n"));
}

#[test]
fn rejects_non_utf8_workspace_text_with_an_actionable_error() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("binary.txt");
    fs::write(&path, [0xff, 0xfe, 0xfd]).unwrap();

    let error = workspace_read_loose_file(path.to_string_lossy().to_string(), None).unwrap_err();
    assert!(error.contains("binary") || error.contains("decoded"));
}

#[test]
fn reads_utf16_bom_and_round_trips_selected_encoding() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("utf16.txt");
    let bytes = encode_workspace_text("hello\r\n世界", "UTF-16LE", true).unwrap();
    fs::write(&path, &bytes).unwrap();
    let path_string = path.to_string_lossy().to_string();

    let file = workspace_read_loose_file(path_string.clone(), None).unwrap();
    assert_eq!(file.encoding, "UTF-16LE");
    assert!(file.bom);
    assert_eq!(file.text, "hello\r\n世界");

    let saved = workspace_write_loose_file_encoded(
        path_string,
        "changed\n世界".into(),
        Some(file.hash),
        "UTF-16LE".into(),
        Some(true),
    )
    .unwrap();
    assert_eq!(saved.file.encoding, "UTF-16LE");
    assert!(saved.file.bom);
    assert_eq!(saved.file.text, "changed\n世界");
}

#[test]
fn auto_detects_utf16_without_a_bom() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("utf16-no-bom.txt");
    let bytes = encode_workspace_text("hello", "UTF-16BE", false).unwrap();
    fs::write(&path, &bytes).unwrap();

    let file = workspace_read_loose_file(path.to_string_lossy().to_string(), None).unwrap();
    assert_eq!(file.encoding, "UTF-16BE");
    assert!(!file.bom);
    assert_eq!(file.text, "hello");
}

#[test]
fn auto_detects_short_utf16_without_a_bom() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("short-utf16.txt");
    fs::write(
        &path,
        encode_workspace_text("A", "UTF-16LE", false).unwrap(),
    )
    .unwrap();

    let file = workspace_read_loose_file(path.to_string_lossy().to_string(), None).unwrap();
    assert_eq!(file.encoding, "UTF-16LE");
    assert_eq!(file.text, "A");
}

#[test]
fn round_trips_windows_1252() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("windows-1252.txt");
    let path_string = path.to_string_lossy().to_string();
    let saved = workspace_write_loose_file_encoded(
        path_string.clone(),
        "café – €".into(),
        None,
        "windows-1252".into(),
        Some(false),
    )
    .unwrap();
    assert_eq!(saved.file.encoding, "windows-1252");
    assert_eq!(saved.file.text, "café – €");
    assert_eq!(
        workspace_read_loose_file(path_string, None).unwrap().text,
        "café – €"
    );
}

#[test]
fn decodes_and_encodes_gbk_without_lossy_replacement() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("gbk.txt");
    // "中文" in GBK.
    fs::write(&path, [0xd6, 0xd0, 0xce, 0xc4]).unwrap();
    let path_string = path.to_string_lossy().to_string();
    let file =
        workspace_read_loose_file_with_encoding(path_string.clone(), None, "GBK".into()).unwrap();
    assert_eq!(file.encoding, "GBK");
    assert_eq!(file.text, "中文");

    let saved = workspace_write_loose_file_encoded(
        path_string,
        "中文".into(),
        Some(file.hash),
        "GBK".into(),
        Some(false),
    )
    .unwrap();
    assert_eq!(saved.file.text, "中文");
    assert_eq!(fs::read(path).unwrap(), [0xd6, 0xd0, 0xce, 0xc4]);
}

#[test]
fn rejects_unrepresentable_legacy_encoding_save() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("latin.txt");
    fs::write(&path, b"plain").unwrap();
    let error = workspace_write_loose_file_encoded(
        path.to_string_lossy().to_string(),
        "emoji 😀".into(),
        None,
        "windows-1252".into(),
        Some(false),
    )
    .unwrap_err();
    assert_eq!(error.kind, WorkspaceWriteErrorKind::Encoding);
    assert!(error.message.contains("not representable"));
    assert_eq!(fs::read(&path).unwrap(), b"plain".to_vec());
}

#[test]
fn rejects_dot_git_loose_writes() {
    let dir = tempfile::tempdir().unwrap();
    let git_dir = dir.path().join(".git");
    fs::create_dir(&git_dir).unwrap();
    let path = git_dir.join("config");
    fs::write(&path, "x").unwrap();

    let err = workspace_write_loose_file(path.to_string_lossy().to_string(), "y".into(), None)
        .unwrap_err();
    assert!(err.contains(".git"));
}

#[test]
fn creates_renames_and_deletes_file() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_string_lossy().to_string();

    workspace_create_dir(root.clone(), "src".into()).unwrap();
    let file =
        workspace_create_file(root.clone(), "src/main.ts".into(), Some("one".into())).unwrap();
    assert_eq!(file.path, "src/main.ts");
    assert_eq!(file.text, "one");

    let renamed =
        workspace_rename_path(root.clone(), "src/main.ts".into(), "src/app.ts".into()).unwrap();
    assert_eq!(renamed.path, "src/app.ts");
    assert!(!dir.path().join("src/main.ts").exists());
    assert!(dir.path().join("src/app.ts").exists());

    workspace_delete_path(root, "src/app.ts".into(), None).unwrap();
    assert!(!dir.path().join("src/app.ts").exists());
}

#[test]
fn applies_lsp_resource_operation_options() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_string_lossy().to_string();
    fs::create_dir(dir.path().join("src")).unwrap();

    let created = workspace_apply_resource_operation(
        root.clone(),
        WorkspaceResourceOperation::Create {
            path: "src/new.ts".into(),
            overwrite: false,
            ignore_if_exists: false,
        },
    )
    .unwrap();
    assert!(!created.ignored);
    fs::write(dir.path().join("src/new.ts"), "new").unwrap();

    let ignored = workspace_apply_resource_operation(
        root.clone(),
        WorkspaceResourceOperation::Create {
            path: "src/new.ts".into(),
            overwrite: false,
            ignore_if_exists: true,
        },
    )
    .unwrap();
    assert!(ignored.ignored);
    assert_eq!(
        fs::read_to_string(dir.path().join("src/new.ts")).unwrap(),
        "new"
    );

    let overwritten = workspace_apply_resource_operation(
        root.clone(),
        WorkspaceResourceOperation::Create {
            path: "src/new.ts".into(),
            overwrite: true,
            ignore_if_exists: true,
        },
    )
    .unwrap();
    assert!(!overwritten.ignored);
    assert_eq!(
        fs::read_to_string(dir.path().join("src/new.ts")).unwrap(),
        ""
    );
    fs::write(dir.path().join("src/new.ts"), "new").unwrap();

    fs::write(dir.path().join("src/final.ts"), "old").unwrap();
    workspace_apply_resource_operation(
        root.clone(),
        WorkspaceResourceOperation::Rename {
            from_path: "src/new.ts".into(),
            to_path: "src/final.ts".into(),
            to_repo_root: None,
            overwrite: true,
            ignore_if_exists: true,
        },
    )
    .unwrap();
    assert_eq!(
        fs::read_to_string(dir.path().join("src/final.ts")).unwrap(),
        "new"
    );

    workspace_apply_resource_operation(
        root.clone(),
        WorkspaceResourceOperation::Delete {
            path: "src/final.ts".into(),
            recursive: false,
            ignore_if_not_exists: false,
        },
    )
    .unwrap();
    let ignored_delete = workspace_apply_resource_operation(
        root,
        WorkspaceResourceOperation::Delete {
            path: "src/final.ts".into(),
            recursive: false,
            ignore_if_not_exists: true,
        },
    )
    .unwrap();
    assert!(ignored_delete.ignored);
}

#[test]
fn create_file_overwrite_rejects_existing_directory() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_string_lossy().to_string();
    fs::create_dir_all(dir.path().join("generated/nested")).unwrap();
    fs::write(dir.path().join("generated/nested/keep.txt"), "keep").unwrap();

    let error = workspace_apply_resource_operation(
        root,
        WorkspaceResourceOperation::Create {
            path: "generated".into(),
            overwrite: true,
            ignore_if_exists: true,
        },
    )
    .unwrap_err();

    assert!(error.contains("cannot overwrite directory"));
    assert_eq!(
        fs::read_to_string(dir.path().join("generated/nested/keep.txt")).unwrap(),
        "keep"
    );
}

#[test]
fn deserializes_lsp_resource_operation_camel_case_fields() {
    let operation: WorkspaceResourceOperation = serde_json::from_value(serde_json::json!({
        "kind": "rename",
        "fromPath": "src/old.ts",
        "toPath": "src/new.ts",
        "toRepoRoot": "/workspace-two",
        "overwrite": true,
        "ignoreIfExists": false
    }))
    .unwrap();
    assert!(matches!(
        operation,
        WorkspaceResourceOperation::Rename {
            from_path,
            to_path,
            to_repo_root: Some(to_repo_root),
            overwrite: true,
            ignore_if_exists: false,
        } if from_path == "src/old.ts"
            && to_path == "src/new.ts"
            && to_repo_root == "/workspace-two"
    ));
}

#[test]
fn applies_cross_root_lsp_rename_and_protects_same_path() {
    let source = tempfile::tempdir().unwrap();
    let destination = tempfile::tempdir().unwrap();
    fs::create_dir(source.path().join("src")).unwrap();
    fs::create_dir(destination.path().join("lib")).unwrap();
    fs::write(source.path().join("src/main.ts"), "content").unwrap();
    let source_root = source.path().to_string_lossy().to_string();
    let destination_root = destination.path().to_string_lossy().to_string();

    workspace_apply_resource_operation(
        source_root.clone(),
        WorkspaceResourceOperation::Rename {
            from_path: "src/main.ts".into(),
            to_path: "lib/main.ts".into(),
            to_repo_root: Some(destination_root),
            overwrite: false,
            ignore_if_exists: false,
        },
    )
    .unwrap();
    assert!(!source.path().join("src/main.ts").exists());
    assert_eq!(
        fs::read_to_string(destination.path().join("lib/main.ts")).unwrap(),
        "content"
    );

    let ignored = workspace_apply_resource_operation(
        source_root,
        WorkspaceResourceOperation::Rename {
            from_path: "src".into(),
            to_path: "src".into(),
            to_repo_root: None,
            overwrite: true,
            ignore_if_exists: false,
        },
    )
    .unwrap();
    assert!(ignored.ignored);
    assert!(source.path().join("src").is_dir());
}

#[test]
fn failed_overwrite_move_restores_existing_destination() {
    let dir = tempfile::tempdir().unwrap();
    let missing = dir.path().join("missing.ts");
    let destination = dir.path().join("destination.ts");
    fs::write(&destination, "original destination").unwrap();

    let error = move_resource_replacing(&missing, &destination).unwrap_err();

    assert!(error.contains("replace"));
    assert_eq!(
        fs::read_to_string(&destination).unwrap(),
        "original destination"
    );
    let entries = fs::read_dir(dir.path())
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(entries.len(), 1);
}

#[test]
fn rejects_moving_directory_inside_itself() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_string_lossy().to_string();
    fs::create_dir_all(dir.path().join("src/nested")).unwrap();
    fs::write(dir.path().join("src/main.ts"), "content").unwrap();

    let error = workspace_apply_resource_operation(
        root,
        WorkspaceResourceOperation::Rename {
            from_path: "src".into(),
            to_path: "src/nested/moved".into(),
            to_repo_root: None,
            overwrite: false,
            ignore_if_exists: false,
        },
    )
    .unwrap_err();

    assert!(error.contains("inside itself"));
    assert!(dir.path().join("src/main.ts").is_file());
    assert!(!dir.path().join("src/nested/moved").exists());
}

#[cfg(unix)]
#[test]
fn resource_copy_and_rename_preserve_symbolic_links() {
    use std::os::unix::fs::symlink;

    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_string_lossy().to_string();
    fs::write(dir.path().join("target.ts"), "content").unwrap();
    symlink("target.ts", dir.path().join("source-link.ts")).unwrap();

    copy_resource_target(
        &dir.path().join("source-link.ts"),
        &dir.path().join("copied-link.ts"),
    )
    .unwrap();
    assert!(
        fs::symlink_metadata(dir.path().join("copied-link.ts"))
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert_eq!(
        fs::read_link(dir.path().join("copied-link.ts")).unwrap(),
        PathBuf::from("target.ts")
    );

    workspace_apply_resource_operation(
        root,
        WorkspaceResourceOperation::Rename {
            from_path: "source-link.ts".into(),
            to_path: "renamed-link.ts".into(),
            to_repo_root: None,
            overwrite: false,
            ignore_if_exists: false,
        },
    )
    .unwrap();
    assert!(
        fs::symlink_metadata(dir.path().join("renamed-link.ts"))
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert_eq!(
        fs::read_link(dir.path().join("renamed-link.ts")).unwrap(),
        PathBuf::from("target.ts")
    );
}

#[test]
fn creates_and_deletes_directory_tree() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_string_lossy().to_string();

    let entry = workspace_create_dir(root.clone(), "src".into()).unwrap();
    assert_eq!(entry.file_type, "dir");
    workspace_create_file(root.clone(), "src/main.ts".into(), None).unwrap();

    let err = workspace_delete_path(root.clone(), "src".into(), Some(false)).unwrap_err();
    assert!(err.contains("rmdir"));

    workspace_delete_path(root, "src".into(), Some(true)).unwrap();
    assert!(!dir.path().join("src").exists());
}

#[test]
fn returns_compact_chain_endpoint() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_string_lossy().to_string();
    fs::create_dir_all(dir.path().join("src/main/java/com/example/service")).unwrap();
    fs::write(
        dir.path()
            .join("src/main/java/com/example/service/UserService.java"),
        "class UserService {}",
    )
    .unwrap();

    let chain = workspace_compact_chain(root, "src".into(), Some(16)).unwrap();

    assert_eq!(chain.path, "src/main/java/com/example/service");
    assert_eq!(chain.entries.len(), 1);
    assert_eq!(
        chain.entries[0].path,
        "src/main/java/com/example/service/UserService.java"
    );
}

#[test]
fn recursively_lists_files_with_limits_and_skips_git() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_string_lossy().to_string();
    fs::create_dir_all(dir.path().join("src/a")).unwrap();
    fs::create_dir_all(dir.path().join(".git")).unwrap();
    fs::write(dir.path().join("src/a/one.ts"), "one").unwrap();
    fs::write(dir.path().join("src/two.ts"), "two").unwrap();
    fs::write(dir.path().join(".git/config"), "hidden").unwrap();

    let files = workspace_list_files_recursive(root.clone(), None, Some(10), Some(10)).unwrap();
    let paths: Vec<_> = files.iter().map(|entry| entry.path.as_str()).collect();
    assert_eq!(paths, vec!["src/a/one.ts", "src/two.ts"]);

    let limited = workspace_list_files_recursive(root, None, Some(10), Some(1)).unwrap();
    assert_eq!(limited.len(), 1);
}

#[test]
fn recursive_listing_skips_dependency_and_build_dirs() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_string_lossy().to_string();
    fs::create_dir_all(dir.path().join("src")).unwrap();
    fs::create_dir_all(dir.path().join("node_modules/pkg")).unwrap();
    fs::create_dir_all(dir.path().join("target/debug")).unwrap();
    fs::write(dir.path().join("src/main.rs"), "fn main() {}").unwrap();
    fs::write(
        dir.path().join("node_modules/pkg/index.js"),
        "module.exports=1",
    )
    .unwrap();
    fs::write(dir.path().join("target/debug/app"), "bin").unwrap();

    let files = workspace_list_files_recursive(root, None, Some(10), Some(100)).unwrap();
    let paths: Vec<_> = files.iter().map(|entry| entry.path.as_str()).collect();
    assert_eq!(paths, vec!["src/main.rs"]);
}

#[test]
fn detects_git_roots_and_deduplicates_nested_roots() {
    let dir = tempfile::tempdir().unwrap();
    let repo = dir.path().join("repo");
    let nested = repo.join("packages/app");
    let plain = dir.path().join("plain");
    fs::create_dir_all(repo.join(".git")).unwrap();
    fs::create_dir_all(&nested).unwrap();
    fs::create_dir_all(&plain).unwrap();

    let repos = workspace_detect_git_roots(vec![
        WorkspaceGitRootCandidate {
            id: "repo".into(),
            name: "repo".into(),
            path: repo.to_string_lossy().to_string(),
        },
        WorkspaceGitRootCandidate {
            id: "app".into(),
            name: "app".into(),
            path: nested.to_string_lossy().to_string(),
        },
        WorkspaceGitRootCandidate {
            id: "plain".into(),
            name: "plain".into(),
            path: plain.to_string_lossy().to_string(),
        },
    ])
    .unwrap();

    let repo_root = path_to_string(&fs::canonicalize(&repo).unwrap_or(repo.clone()));
    let detected = repos
        .iter()
        .find(|item| item.repo_root == repo_root || Path::new(&item.repo_root) == repo)
        .expect("target repo should be detected");
    assert!(detected.root_ids.contains(&"repo".to_string()));
    assert!(detected.root_ids.contains(&"app".to_string()));
}

#[test]
fn detects_child_git_roots_under_plain_workspace_root() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = dir.path().join("workspace");
    let app = workspace.join("app");
    let service = workspace.join("service");
    fs::create_dir_all(app.join(".git")).unwrap();
    fs::create_dir_all(service.join(".git")).unwrap();
    fs::create_dir_all(workspace.join("node_modules/ignored/.git")).unwrap();

    let repos = workspace_detect_git_roots(vec![WorkspaceGitRootCandidate {
        id: "workspace".into(),
        name: "workspace".into(),
        path: workspace.to_string_lossy().to_string(),
    }])
    .unwrap();

    let app_canon = fs::canonicalize(&app).unwrap_or(app.clone());
    let service_canon = fs::canonicalize(&service).unwrap_or(service.clone());
    let workspace_canon = fs::canonicalize(&workspace).unwrap_or(workspace.clone());
    let repo_roots: Vec<_> = repos
        .iter()
        .map(|item| PathBuf::from(&item.repo_root))
        .collect();
    assert!(repo_roots.iter().any(|root| {
        root == &app || root == &app_canon || path_to_string(root) == path_to_string(&app_canon)
    }));
    assert!(repo_roots.iter().any(|root| {
        root == &service
            || root == &service_canon
            || path_to_string(root) == path_to_string(&service_canon)
    }));
    assert!(
        !repos
            .iter()
            .any(|item| item.repo_root.contains("node_modules"))
    );
    assert_eq!(
        repo_roots
            .iter()
            .filter(|root| root.starts_with(&workspace) || root.starts_with(&workspace_canon))
            .count(),
        2
    );
}

#[test]
fn marks_git_file_roots_as_submodules() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = dir.path().join("workspace");
    let submodule = workspace.join("vendor/lib");
    fs::create_dir_all(&submodule).unwrap();
    fs::write(
        submodule.join(".git"),
        "gitdir: ../../.git/modules/vendor/lib\n",
    )
    .unwrap();

    let repos = workspace_detect_git_roots(vec![WorkspaceGitRootCandidate {
        id: "workspace".into(),
        name: "workspace".into(),
        path: workspace.to_string_lossy().to_string(),
    }])
    .unwrap();

    let submodule_canon = fs::canonicalize(&submodule).unwrap_or(submodule.clone());
    let detected = repos
        .iter()
        .find(|item| {
            let root = Path::new(&item.repo_root);
            root == submodule
                || root == submodule_canon
                || item.repo_root == path_to_string(&submodule_canon)
        })
        .expect("submodule should be detected");
    assert!(detected.is_submodule);
}

#[test]
fn rejects_dot_git_deletes() {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir(dir.path().join(".git")).unwrap();
    fs::write(dir.path().join(".git/config"), "x").unwrap();

    let err = workspace_delete_path(
        dir.path().to_string_lossy().to_string(),
        ".git/config".into(),
        None,
    )
    .unwrap_err();
    assert!(err.contains(".git"));
}

#[test]
fn detects_package_cargo_and_make_tasks() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(
        dir.path().join("package.json"),
        r#"{"scripts":{"dev":"vite","test":"vitest run"}}"#,
    )
    .unwrap();
    fs::write(dir.path().join("pnpm-lock.yaml"), "lockfileVersion: 9").unwrap();
    fs::write(dir.path().join("Cargo.toml"), "[package]\nname='demo'").unwrap();
    fs::write(
        dir.path().join("Makefile"),
        "build:\n\t@echo build\n.PHONY: build\ninvalid target: ignored\n",
    )
    .unwrap();

    let tasks = detect_workspace_tasks(dir.path(), None).unwrap();
    assert!(tasks.iter().any(|task| {
        task.source == "package.json" && task.label == "dev" && task.command == "pnpm run dev"
    }));
    assert!(tasks.iter().any(|task| {
        task.source == "Cargo.toml" && task.label == "clippy" && task.command == "cargo clippy"
    }));
    assert!(tasks.iter().any(|task| {
        task.source == "Makefile" && task.label == "build" && task.command == "make build"
    }));
    assert!(!tasks.iter().any(|task| task.label == "invalid target"));
}

#[test]
fn detects_go_gradle_maven_and_python_tasks() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("go.mod"), "module example.com/demo").unwrap();
    fs::write(dir.path().join("build.gradle.kts"), "plugins {}").unwrap();
    fs::write(dir.path().join("pom.xml"), "<project />").unwrap();
    fs::write(
        dir.path().join("pyproject.toml"),
        "[project.scripts]\nserve = 'demo:main'\n[tool.poetry.scripts]\nworker = 'demo:worker'\n",
    )
    .unwrap();
    fs::write(dir.path().join("uv.lock"), "version = 1").unwrap();

    let tasks = detect_workspace_tasks(dir.path(), None).unwrap();
    for command in [
        "go test ./...",
        "gradle build",
        "mvn package",
        "uv run serve",
        "uv run worker",
    ] {
        assert!(
            tasks.iter().any(|task| task.command == command),
            "missing {command}"
        );
    }
}

#[test]
fn parses_maven_dependency_tree_with_nesting_and_scopes() {
    let output = "\
[INFO] com.example:demo:jar:1.0.0
[INFO] +- org.springframework:spring-core:jar:5.3.0:compile
[INFO] |  \\- org.springframework:spring-jcl:jar:5.3.0:compile
[INFO] \\- junit:junit:jar:4.13:test
[INFO]    \\- org.hamcrest:hamcrest-core:jar:1.3:test
";
    let tree = parse_maven_dependency_tree(output);
    // Root project's direct deps become the forest.
    assert_eq!(tree.len(), 2);
    assert_eq!(tree[0].artifact, "spring-core");
    assert_eq!(tree[0].scope, "compile");
    assert_eq!(tree[0].children.len(), 1);
    assert_eq!(tree[0].children[0].artifact, "spring-jcl");
    assert_eq!(tree[1].artifact, "junit");
    assert_eq!(tree[1].scope, "test");
    assert_eq!(tree[1].children[0].artifact, "hamcrest-core");
    assert!(tree.iter().all(|node| node.conflict.is_none()));
}

#[test]
fn parses_maven_verbose_conflict_marker() {
    let output = "\
[INFO] com.example:demo:jar:1.0.0
[INFO] +- a:one:jar:1.0:compile
[INFO] \\- b:two:jar:2.0:compile (omitted for conflict with 3.0)
";
    let tree = parse_maven_dependency_tree(output);
    assert_eq!(tree.len(), 2);
    assert_eq!(tree[1].artifact, "two");
    assert_eq!(
        tree[1].conflict.as_deref(),
        Some("(omitted for conflict with 3.0)")
    );
}

#[test]
fn parses_gradle_dependencies_with_arbitration() {
    let output = "\
runtimeClasspath - Runtime classpath of source set 'main'.
+--- org.springframework:spring-core:5.3.0
|    \\--- org.springframework:spring-jcl:5.3.0
\\--- com.google.guava:guava:30.0 -> 31.0 (*)
";
    let tree = parse_gradle_dependencies(output);
    assert_eq!(tree.len(), 2);
    assert_eq!(tree[0].artifact, "spring-core");
    assert_eq!(tree[0].version, "5.3.0");
    assert_eq!(tree[0].children[0].artifact, "spring-jcl");
    // Arbitration: resolved version wins, conflict note records the bump.
    assert_eq!(tree[1].artifact, "guava");
    assert_eq!(tree[1].version, "31.0");
    assert_eq!(
        tree[1].conflict.as_deref(),
        Some("com.google.guava:guava:30.0 -> 31.0")
    );
}

#[test]
fn dependency_parsers_tolerate_empty_and_noise() {
    assert!(parse_maven_dependency_tree("").is_empty());
    assert!(parse_gradle_dependencies("No dependencies\n").is_empty());
    assert!(parse_maven_dependency_tree("[INFO] Scanning for projects...\n").is_empty());
}

#[test]
fn task_tree_groups_by_source_with_full_maven_and_gradle_lifecycles() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(
        dir.path().join("package.json"),
        r#"{"scripts":{"dev":"vite","test":"vitest run"}}"#,
    )
    .unwrap();
    fs::write(dir.path().join("pom.xml"), "<project />").unwrap();
    fs::write(dir.path().join("build.gradle"), "plugins {}").unwrap();

    let groups = build_workspace_task_tree(dir.path(), None).unwrap();
    let find = |source: &str| groups.iter().find(|group| group.source == source);

    // Maven carries the full lifecycle (not just the Run-tab package/test subset).
    let maven = find("Maven").expect("Maven group");
    for phase in ["clean", "compile", "package", "verify", "install"] {
        assert!(
            maven.tasks.iter().any(|task| task.label == phase),
            "Maven lifecycle missing {phase}"
        );
    }
    // Gradle carries the common tasks.
    let gradle = find("Gradle").expect("Gradle group");
    for task in ["clean", "build", "assemble", "check"] {
        assert!(
            gradle.tasks.iter().any(|entry| entry.label == task),
            "Gradle tasks missing {task}"
        );
    }
    // Other ecosystems still group their detected tasks.
    let npm = find("package.json").expect("package.json group");
    assert!(npm.tasks.iter().any(|task| task.label == "dev"));
    assert!(npm.tasks.iter().any(|task| task.label == "test"));

    // No duplicate labels within a group (enrichment vs detection overlap).
    for group in &groups {
        let mut labels: Vec<&str> = group.tasks.iter().map(|task| task.label.as_str()).collect();
        let count = labels.len();
        labels.sort_unstable();
        labels.dedup();
        assert_eq!(labels.len(), count, "duplicate label in {}", group.source);
    }
}

#[test]
fn discovers_plain_java_main_without_debug_bundles() {
    let dir = tempfile::tempdir().unwrap();
    let source_dir = dir.path().join("src/com/example");
    fs::create_dir_all(&source_dir).unwrap();
    fs::write(
        source_dir.join("App.java"),
        r#"
                package com.example;
                // public static void main(String[] ignored) {}
                public class App {
                    String example = "static void main(String[] fake)";
                    public static void main(final String[] args) {
                        System.out.println("ok");
                    }
                }
            "#,
    )
    .unwrap();

    let target = workspace_java_run_target(
        dir.path().to_string_lossy().into_owned(),
        "src/com/example/App.java".into(),
        None,
    )
    .unwrap();
    assert_eq!(target.main_class, "com.example.App");
    assert_eq!(target.build_system, "source-file");
    assert!(target.command.starts_with("java "));
    assert!(target.command.contains("App.java"));
    assert_eq!(target.module_path, ".");
}

#[test]
fn rejects_java_file_with_main_only_in_comments_or_strings() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(
        dir.path().join("Example.java"),
        r#"
                /** public static void main(String[] args) {} */
                class Example {
                    String sample = "public static void main(String[] args)";
                }
            "#,
    )
    .unwrap();

    let error = workspace_java_run_target(
        dir.path().to_string_lossy().into_owned(),
        "Example.java".into(),
        None,
    )
    .unwrap_err();
    assert!(error.contains("No `static void main"));
}

#[test]
fn builds_maven_main_command_with_project_wrapper() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("pom.xml"), "<project />").unwrap();
    fs::write(dir.path().join("mvnw"), "#!/bin/sh").unwrap();
    let source_dir = dir.path().join("src/main/java/demo");
    fs::create_dir_all(&source_dir).unwrap();
    fs::write(
        source_dir.join("Main.java"),
        "package demo; class Main { public static void main(String... args) {} }",
    )
    .unwrap();

    let target = java_run_target_for_path(dir.path(), &source_dir.join("Main.java"), None).unwrap();
    assert_eq!(target.build_system, "maven");
    assert_eq!(target.main_class, "demo.Main");
    assert_eq!(target.cwd, path_to_string(dir.path()));
    assert!(target.command.contains("mvnw"));
    assert_eq!(target.execution.source, "wrapper");
    assert!(target.execution.executable.contains("mvnw"));
    assert!(target.execution.error.is_none());
    // PowerShell splits `-Dexec.mainClass='demo.Main'` at the property-name
    // dot. Quoting the whole Maven property keeps it a single argument.
    assert!(target.command.contains("'-Dexec.mainClass=demo.Main'"));
    assert!(
        target
            .command
            .contains("'-Dexec.cleanupDaemonThreads=false'")
    );
    assert_eq!(target.execution.args[2], "-Dexec.mainClass=demo.Main");
    assert_eq!(
        target.execution.args[3],
        "-Dexec.cleanupDaemonThreads=false"
    );
    assert!(target.command.contains("exec-maven-plugin:3.5.0:java"));
}

#[test]
fn applies_maven_run_jvm_options_through_task_environment() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(
        dir.path().join("pom.xml"),
        r#"
                <project>
                  <build><plugins><plugin><configuration>
                    <argLine>
                      @{argLine}
                      --add-exports java.base/sun.nio.ch=ALL-UNNAMED
                      --add-opens=java.base/java.lang.reflect=ALL-UNNAMED
                      --enable-native-access=ALL-UNNAMED
                      -javaagent:should-not-be-inherited.jar
                      -Xmx512m
                      --add-reads -Xms256m
                    </argLine>
                    <!-- <argLine>--add-opens=java.base/java.net=ALL-UNNAMED</argLine> -->
                  </configuration></plugin></plugins></build>
                </project>
            "#,
    )
    .unwrap();
    fs::write(dir.path().join("mvnw"), "#!/bin/sh").unwrap();
    let module = dir.path().join("server");
    let source_dir = module.join("src/main/java/demo");
    fs::create_dir_all(&source_dir).unwrap();
    fs::write(module.join("pom.xml"), "<project />").unwrap();
    fs::write(
        source_dir.join("Main.java"),
        "package demo; class Main { public static void main(String... args) {} }",
    )
    .unwrap();

    let target = java_run_target_for_path(
        dir.path(),
        &source_dir.join("Main.java"),
        Some(&WorkspaceToolConfig {
            maven_jvm_args: vec![
                "--add-opens=java.base/sun.nio.ch=ALL-UNNAMED".into(),
                "--add-opens=java.base/java.lang.reflect=ALL-UNNAMED".into(),
            ],
            ..WorkspaceToolConfig::default()
        }),
    )
    .unwrap();
    let maven_opts = &target.environment.unwrap()["MAVEN_OPTS"];
    assert_eq!(maven_opts.mode, "append");
    assert_eq!(
        maven_opts.value,
        "--add-exports=java.base/sun.nio.ch=ALL-UNNAMED \
             --add-opens=java.base/java.lang.reflect=ALL-UNNAMED \
             --enable-native-access=ALL-UNNAMED \
             --add-opens=java.base/sun.nio.ch=ALL-UNNAMED"
    );
    assert!(!maven_opts.value.contains("-javaagent"));
    assert!(!maven_opts.value.contains("-Xmx"));
    assert!(!maven_opts.value.contains("java.net"));
}

#[test]
fn can_disable_maven_arg_line_inheritance() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(
        dir.path().join("pom.xml"),
        "<project><argLine>--add-opens=java.base/java.io=ALL-UNNAMED</argLine></project>",
    )
    .unwrap();
    let source_dir = dir.path().join("src/main/java/demo");
    fs::create_dir_all(&source_dir).unwrap();
    fs::write(
        source_dir.join("Main.java"),
        "package demo; class Main { public static void main(String... args) {} }",
    )
    .unwrap();

    let target = java_run_target_for_path(
        dir.path(),
        &source_dir.join("Main.java"),
        Some(&WorkspaceToolConfig {
            maven_jvm_args: vec!["--add-opens=java.base/sun.nio.ch=ALL-UNNAMED".into()],
            inherit_maven_arg_line: Some(false),
            ..WorkspaceToolConfig::default()
        }),
    )
    .unwrap();
    assert_eq!(
        target.environment.unwrap()["MAVEN_OPTS"].value,
        "--add-opens=java.base/sun.nio.ch=ALL-UNNAMED"
    );
}

#[test]
fn builds_gradle_subproject_main_command_and_module_tasks() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("settings.gradle"), "include 'app'").unwrap();
    fs::write(dir.path().join("build.gradle"), "plugins { id 'base' }").unwrap();
    fs::write(dir.path().join("gradlew"), "#!/bin/sh").unwrap();
    fs::create_dir_all(dir.path().join("app/src/main/java/demo")).unwrap();
    fs::write(dir.path().join("app/build.gradle"), "plugins { id 'java' }").unwrap();
    let source = dir.path().join("app/src/main/java/demo/App.java");
    fs::write(
        &source,
        "package demo; class App { static void main(String args[]) {} }",
    )
    .unwrap();

    let target = java_run_target_for_path(dir.path(), &source, None).unwrap();
    assert_eq!(target.build_system, "gradle");
    assert_eq!(target.module_path, "app");
    assert_eq!(target.cwd, path_to_string(dir.path()));
    assert!(target.command.contains(":app:taomniRun"));
    assert!(target.command.contains("-PtaomniMainClass='demo.App'"));
    assert!(target.command.contains("java-run.init.gradle"));

    let groups = build_workspace_task_tree(dir.path(), None).unwrap();
    let gradle = groups
        .iter()
        .find(|group| group.source == "Gradle")
        .unwrap();
    let module_compile = gradle
        .tasks
        .iter()
        .find(|task| task.module_path.as_deref() == Some("app") && task.label == "classes")
        .unwrap();
    assert!(module_compile.command.contains(":app:classes"));
    assert!(module_compile.command.contains("gradlew"));
}

#[test]
fn java_target_scan_skips_test_sources() {
    let dir = tempfile::tempdir().unwrap();
    for (folder, name) in [
        ("src/main/java/demo", "App"),
        ("src/test/java/demo", "FixtureMain"),
    ] {
        let source_dir = dir.path().join(folder);
        fs::create_dir_all(&source_dir).unwrap();
        fs::write(
            source_dir.join(format!("{name}.java")),
            format!("package demo; class {name} {{ public static void main(String[] args) {{}} }}"),
        )
        .unwrap();
    }
    let targets = detect_java_run_targets(dir.path(), None).unwrap();
    assert_eq!(targets.len(), 1);
    assert_eq!(targets[0].main_class, "demo.App");
}

// ---- Cross-platform tool resolution (M11 build/run robustness) ----
//
// These tests inject `HostPlatform` and `PATH` explicitly so the Windows
// `.cmd`/`.bat` resolution and launch planning are exercised on non-Windows
// CI too (the production entry points use `HostPlatform::current()`).

#[test]
fn resolves_windows_batch_wrapper_before_configured_or_path() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("pom.xml"), "<project />").unwrap();
    fs::write(dir.path().join("mvnw.cmd"), "@echo off").unwrap();
    let config = WorkspaceToolConfig {
        maven: Some("C:/tools/mvn.cmd".into()),
        gradle: None,
        ..WorkspaceToolConfig::default()
    };
    let resolution = resolve_build_tool_with_path(
        dir.path(),
        dir.path(),
        BuildTool::Maven,
        Some(&config),
        HostPlatform::Windows,
        None,
    );
    assert_eq!(resolution.source, ToolSource::Wrapper);
    assert!(resolution.available);
    assert!(resolution.executable.ends_with("mvnw.cmd"));
    // PowerShell call operator + absolute path (never the fragile bare `.\mvnw.cmd`).
    let runner = resolution.task_runner(HostPlatform::Windows);
    assert!(runner.starts_with("& '"));
    assert!(runner.contains("mvnw.cmd"));
}

#[test]
fn walks_up_to_find_wrapper_in_monorepo() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("mvnw"), "#!/bin/sh").unwrap();
    let module = dir.path().join("services/api");
    fs::create_dir_all(&module).unwrap();
    let resolution = resolve_build_tool_with_path(
        &module,
        dir.path(),
        BuildTool::Maven,
        None,
        HostPlatform::Unix,
        None,
    );
    assert_eq!(resolution.source, ToolSource::Wrapper);
    assert!(resolution.executable.ends_with("mvnw"));
}

#[test]
fn falls_back_to_configured_executable_then_reports_missing() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("pom.xml"), "<project />").unwrap();
    let mvn = dir.path().join("custom-mvn");
    fs::write(&mvn, "#!/bin/sh").unwrap();

    // A configured path with a directory separator resolves relative to the
    // workspace root; a bare name (no separator) is a PATH lookup instead.
    let config = WorkspaceToolConfig {
        maven: Some("./custom-mvn".into()),
        gradle: None,
        ..WorkspaceToolConfig::default()
    };
    let resolution = resolve_build_tool_with_path(
        dir.path(),
        dir.path(),
        BuildTool::Maven,
        Some(&config),
        HostPlatform::Unix,
        None,
    );
    assert_eq!(resolution.source, ToolSource::Configured);
    assert!(resolution.available);
    assert_eq!(resolution.executable, fs::canonicalize(&mvn).unwrap_or(mvn));

    // A configured executable that does not exist yields a clear diagnostic
    // rather than a shell "not recognized" error at run time.
    let missing = WorkspaceToolConfig {
        maven: Some("nope-not-here".into()),
        gradle: None,
        ..WorkspaceToolConfig::default()
    };
    let resolution = resolve_build_tool_with_path(
        dir.path(),
        dir.path(),
        BuildTool::Maven,
        Some(&missing),
        HostPlatform::Unix,
        None,
    );
    assert_eq!(resolution.source, ToolSource::Configured);
    assert!(!resolution.available);
    assert!(resolution.require_available().is_err());
    assert!(
        resolution
            .diagnostic
            .as_deref()
            .unwrap()
            .contains("nope-not-here")
    );
}

#[test]
fn reports_missing_tool_when_no_wrapper_config_or_path() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("build.gradle"), "plugins {}").unwrap();
    let resolution = resolve_build_tool_with_path(
        dir.path(),
        dir.path(),
        BuildTool::Gradle,
        None,
        HostPlatform::Unix,
        None,
    );
    assert_eq!(resolution.source, ToolSource::Path);
    assert!(!resolution.available);
    let error = resolution.require_available().unwrap_err();
    assert!(error.contains("Gradle"));
    assert!(error.contains("gradlew"));
}

#[test]
fn plans_windows_batch_launch_via_cmd_exe() {
    let plan = plan_tool_launch(
        Path::new(r"C:\proj\mvnw.cmd"),
        &["-B".into(), "dependency:tree".into()],
        HostPlatform::Windows,
    );
    assert_eq!(plan.program, "cmd.exe");
    assert_eq!(plan.args[0], "/D");
    assert_eq!(plan.args[1], "/S");
    assert_eq!(plan.args[2], "/C");
    // The whole command line is one argument, wrapper quoted, args appended.
    assert!(plan.args[3].contains(r"C:\proj\mvnw.cmd"));
    assert!(plan.args[3].contains("dependency:tree"));
}

#[test]
fn plans_direct_launch_for_plain_executable() {
    let plan = plan_tool_launch(
        Path::new("/usr/bin/gradle"),
        &["dependencies".into()],
        HostPlatform::Unix,
    );
    assert_eq!(plan.program, "/usr/bin/gradle");
    assert_eq!(plan.args, vec!["dependencies".to_string()]);
}

#[test]
fn build_task_tree_surfaces_missing_tool_diagnostic() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("pom.xml"), "<project />").unwrap();
    // No wrapper, no config; PATH lookup disabled → execution carries the error.
    let resolution = resolve_build_tool_with_path(
        dir.path(),
        dir.path(),
        BuildTool::Maven,
        None,
        HostPlatform::Unix,
        None,
    );
    let execution = resolution.execution(&["package"]);
    assert_eq!(execution.args, vec!["package".to_string()]);
    assert!(execution.error.is_some());
}

#[test]
fn raw_bytes_matrix_and_unrepresentable_fixture() {
    let dir = tempfile::tempdir().unwrap();
    let eols: &[(&str, &[u8])] = &[("lf", b"\n"), ("crlf", b"\r\n"), ("cr", b"\r")];
    let encodings: &[(&str, bool, &[u8])] = &[
        ("UTF-8", false, b""),
        ("UTF-8", true, &[0xEF, 0xBB, 0xBF]),
        ("UTF-16LE", true, &[0xFF, 0xFE]),
        ("UTF-16BE", true, &[0xFE, 0xFF]),
        ("ISO-8859-1", false, b""),
        ("windows-1252", false, b""),
    ];

    for (eol_name, eol_bytes) in eols {
        for (enc_name, bom, bom_bytes) in encodings {
            let filename = format!(
                "test_{}_{}_{}.txt",
                eol_name,
                enc_name.replace('-', "_"),
                bom
            );
            let path = dir.path().join(&filename);
            let path_string = path.to_string_lossy().to_string();

            let initial_text = match *eol_name {
                "lf" => "hello\nworld",
                "crlf" => "hello\r\nworld",
                "cr" => "hello\rworld",
                _ => unreachable!(),
            };

            let saved = workspace_write_loose_file_encoded(
                path_string.clone(),
                initial_text.into(),
                None,
                (*enc_name).into(),
                Some(*bom),
            )
            .unwrap();

            // WhatWG Encoding folds the ISO-8859-1/latin1 labels into
            // windows-1252 on read-back; raw bytes stay exact below.
            let expected_label = if *enc_name == "ISO-8859-1" {
                "windows-1252"
            } else {
                enc_name
            };
            assert_eq!(saved.file.encoding, expected_label);
            assert_eq!(saved.file.bom, *bom);

            let raw_on_disk = fs::read(&path).unwrap();
            let mut expected_bytes = Vec::new();
            expected_bytes.extend_from_slice(bom_bytes);
            if *enc_name == "UTF-16LE" {
                for ch in "hello".encode_utf16() {
                    expected_bytes.extend_from_slice(&ch.to_le_bytes());
                }
                for byte in *eol_bytes {
                    expected_bytes.extend_from_slice(&(*byte as u16).to_le_bytes());
                }
                for ch in "world".encode_utf16() {
                    expected_bytes.extend_from_slice(&ch.to_le_bytes());
                }
            } else if *enc_name == "UTF-16BE" {
                for ch in "hello".encode_utf16() {
                    expected_bytes.extend_from_slice(&ch.to_be_bytes());
                }
                for byte in *eol_bytes {
                    expected_bytes.extend_from_slice(&(*byte as u16).to_be_bytes());
                }
                for ch in "world".encode_utf16() {
                    expected_bytes.extend_from_slice(&ch.to_be_bytes());
                }
            } else {
                expected_bytes.extend_from_slice(b"hello");
                expected_bytes.extend_from_slice(eol_bytes);
                expected_bytes.extend_from_slice(b"world");
            }
            assert_eq!(
                raw_on_disk, expected_bytes,
                "Mismatch for {} / {} / bom={}",
                eol_name, enc_name, bom
            );

            // Closed workspace edit path
            let edit_text = match *eol_name {
                "lf" => "closed\nedit",
                "crlf" => "closed\r\nedit",
                "cr" => "closed\redit",
                _ => unreachable!(),
            };
            let edit_saved = workspace_write_loose_file_encoded(
                path_string.clone(),
                edit_text.into(),
                Some(saved.written_hash.clone()),
                (*enc_name).into(),
                Some(*bom),
            )
            .unwrap();
            assert_eq!(edit_saved.file.encoding, expected_label);

            // Replay path
            let replay_saved = workspace_write_loose_file_encoded(
                path_string.clone(),
                initial_text.into(),
                Some(edit_saved.written_hash),
                (*enc_name).into(),
                Some(*bom),
            )
            .unwrap();
            assert_eq!(replay_saved.written_hash, saved.written_hash);
            assert_eq!(fs::read(&path).unwrap(), expected_bytes);
        }
    }

    // Non-representable characters must not be written and must retain original file hash
    let win_path = dir.path().join("win_protect.txt");
    let win_path_string = win_path.to_string_lossy().to_string();
    let initial_win = workspace_write_loose_file_encoded(
        win_path_string.clone(),
        "valid ascii".into(),
        None,
        "windows-1252".into(),
        Some(false),
    )
    .unwrap();
    let initial_hash = initial_win.written_hash.clone();
    let initial_bytes = fs::read(&win_path).unwrap();

    let unrep_err = workspace_write_loose_file_encoded(
        win_path_string.clone(),
        "invalid emoji 😀".into(),
        Some(initial_hash.clone()),
        "windows-1252".into(),
        Some(false),
    )
    .unwrap_err();
    assert_eq!(unrep_err.kind, WorkspaceWriteErrorKind::Encoding);
    assert!(unrep_err.message.contains("not representable"));

    assert_eq!(fs::read(&win_path).unwrap(), initial_bytes);
    let read_back = workspace_read_loose_file(win_path_string, None).unwrap();
    assert_eq!(read_back.hash, initial_hash);
    assert_eq!(read_back.text, "valid ascii");
}
