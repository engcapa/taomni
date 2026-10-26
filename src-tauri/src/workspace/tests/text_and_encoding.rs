use super::*;
#[tokio::test]
async fn rejects_parent_dir_escape() {
    let dir = tempfile::tempdir().unwrap();
    let err = workspace_list_dir(dir.path().to_string_lossy().to_string(), Some("../".into()))
        .await
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
