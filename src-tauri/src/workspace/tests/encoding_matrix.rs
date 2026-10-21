use super::*;
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
