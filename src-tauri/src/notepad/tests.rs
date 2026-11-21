use super::*;
use std::fs;
use tempfile::tempdir;

#[test]
fn save_as_rename_and_overwrite_guard_work() {
    let dir = tempdir().unwrap();
    let p1 = dir.path().join("hello.txt");
    let res = save_as(p1.to_str().unwrap(), "a\nb", "UTF-8", false, "CRLF", false).unwrap();
    assert_eq!(res.size, 4);
    assert_eq!(fs::read(&p1).unwrap(), b"a\r\nb");

    // Refuses overwrite when overwrite = false
    let err = save_as(p1.to_str().unwrap(), "new", "UTF-8", false, "LF", false).unwrap_err();
    assert!(err.starts_with("exists:"));

    // Allows overwrite when overwrite = true
    save_as(p1.to_str().unwrap(), "new", "UTF-8", true, "LF", true).unwrap();
    assert_eq!(fs::read(&p1).unwrap(), b"\xEF\xBB\xBFnew");

    // Rename prevents collision and renames cleanly
    let p2 = dir.path().join("collide.txt");
    fs::write(&p2, b"x").unwrap();
    let collide = rename_file(p1.to_str().unwrap(), "collide.txt").unwrap_err();
    assert!(collide.starts_with("exists:"));

    let renamed = rename_file(p1.to_str().unwrap(), "moved.txt").unwrap();
    assert_eq!(renamed.name, "moved.txt");
    assert!(!p1.exists());
    assert!(dir.path().join("moved.txt").exists());
}

#[test]
fn readonly_attr_and_dir_text_listing_work() {
    let dir = tempdir().unwrap();
    let text_file = dir.path().join("a.txt");
    let bin_file = dir.path().join("b.bin");
    fs::write(&text_file, b"hello").unwrap();
    fs::write(&bin_file, b"\x00\x01\x02\x03").unwrap();

    set_readonly_attr(text_file.to_str().unwrap(), true).unwrap();
    assert!(fs::metadata(&text_file).unwrap().permissions().readonly());
    set_readonly_attr(text_file.to_str().unwrap(), false).unwrap();
    assert!(!fs::metadata(&text_file).unwrap().permissions().readonly());

    let listed = list_dir_text_files(dir.path().to_str().unwrap(), Some(20)).unwrap();
    assert_eq!(listed.files.len(), 1);
    assert_eq!(listed.skipped_binary, 1);
}

#[test]
fn hash_vectors_encoding_list_and_loss_report_work() {
    let md5_res = compute_hash("md5", Some("abc"), None).unwrap();
    assert_eq!(md5_res.hex, "900150983cd24fb0d6963f7d28e17f72");
    let sha1_res = compute_hash("sha1", Some("abc"), None).unwrap();
    assert_eq!(sha1_res.hex, "a9993e364706816aba3e25717850c26c9cd0d89d");
    let sha256_res = compute_hash("sha256", Some("abc"), None).unwrap();
    assert_eq!(
        sha256_res.hex,
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
    let sha512_res = compute_hash("sha512", Some("abc"), None).unwrap();
    assert_eq!(sha512_res.hex.len(), 128);

    let dir = tempdir().unwrap();
    let f = dir.path().join("hash.txt");
    fs::write(&f, b"abc").unwrap();
    assert_eq!(
        compute_hash("sha256", None, Some(f.to_str().unwrap()))
            .unwrap()
            .hex,
        sha256_res.hex
    );

    assert!(
        list_encodings()
            .iter()
            .any(|g| g.encodings.contains(&"GBK".to_string()))
    );
    let loss = check_encoding_loss("Hello 世界 😀", "windows-1252").unwrap();
    assert_eq!(loss.unrepresentable_count, 3);
    assert!(loss.samples.contains(&"世".to_string()));
    assert_eq!(
        check_encoding_loss("Hello 世界", "UTF-8")
            .unwrap()
            .unrepresentable_count,
        0
    );
}

#[test]
fn backups_save_copies_macros_tamper_and_session_roundtrip() {
    let app = tempdir().unwrap();
    let app_dir = app.path();

    // Backup write / list / read / prune
    let entry = backup_write(
        app_dir,
        "untitled:1",
        None,
        "新建 1",
        "draft content",
        "UTF-8",
        false,
        "LF",
        "",
    )
    .unwrap();
    let listed = backup_list(app_dir).unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].id, entry.id);
    let read_back = backup_read(app_dir, &entry.id).unwrap();
    assert_eq!(read_back.content, "draft content");
    backup_prune(app_dir, "untitled:1").unwrap();
    assert!(backup_list(app_dir).unwrap().is_empty());

    // Save backup copy simple & verbose
    let src_dir = tempdir().unwrap();
    let src = src_dir.path().join("notes.txt");
    fs::write(&src, b"previous bytes").unwrap();
    let simple = save_backup_copy(app_dir, src.to_str().unwrap(), "simple", None)
        .unwrap()
        .unwrap();
    assert_eq!(fs::read(&simple).unwrap(), b"previous bytes");
    let verbose = save_backup_copy(app_dir, src.to_str().unwrap(), "verbose", None)
        .unwrap()
        .unwrap();
    assert!(verbose.ends_with(".bak"));

    // Macro SHA-256 tamper detection & accept
    let saved_macros = macros_save(app_dir, r#"[{"name":"M1","steps":[]}]"#).unwrap();
    assert!(!saved_macros.tampered);
    let macros_file = notepad_root(app_dir).join("macros.json");
    fs::write(&macros_file, r#"[{"name":"HACKED","steps":[]}]"#).unwrap();
    let tampered = macros_validate(app_dir).unwrap();
    assert!(tampered.tampered);
    let accepted = macros_accept(app_dir).unwrap();
    assert!(!accepted.tampered);

    // Session roundtrip
    let session_json = r#"{"version":1,"docs":[{"path":"/tmp/a.txt"}]}"#;
    let saved_session_path = session_save(app_dir, None, session_json).unwrap();
    assert!(Path::new(&saved_session_path).exists());
    let loaded_session = session_load(app_dir, None).unwrap().unwrap();
    assert_eq!(loaded_session, session_json);
}
