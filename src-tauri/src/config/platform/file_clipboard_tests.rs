//! Pure filesystem/format tests. Never initialize GTK or open a system clipboard.

use super::*;

fn fixture() -> (tempfile::TempDir, Vec<String>) {
    let dir = tempfile::tempdir().unwrap();
    // Win32 normal path APIs do not preserve trailing filename spaces. Keep
    // those in the Unix fixtures, and cover legitimate Windows spacing too.
    #[cfg(not(windows))]
    let file = dir.path().join(" leading 空格 # % 🦀.txt ");
    #[cfg(not(windows))]
    let folder = dir.path().join(" directory 目录 ");
    #[cfg(windows)]
    let file = dir.path().join(" leading 空格 # % 🦀.txt");
    #[cfg(windows)]
    let folder = dir.path().join(" directory 目录");
    std::fs::write(&file, "content").unwrap();
    std::fs::create_dir(&folder).unwrap();
    (
        dir,
        vec![
            file.to_str().unwrap().into(),
            folder.to_str().unwrap().into(),
        ],
    )
}

#[test]
fn file_clipboard_validates_absolute_existing_files_and_directories_without_trimming() {
    let (_dir, paths) = fixture();
    validate_paths(&paths).unwrap();
    let offer = FileOffer::new(&paths).unwrap();
    for format in FileListFormat::ALL {
        assert_eq!(format.decode(offer.payload(format)).unwrap(), paths);
    }
}

#[test]
fn file_clipboard_rejects_entire_invalid_list_before_native_ownership() {
    let (dir, mut paths) = fixture();
    for invalid in [
        "".to_string(),
        "relative/file".to_string(),
        "~/not-expanded".to_string(),
        "a\0b".to_string(),
        dir.path().join("missing").to_str().unwrap().to_string(),
        "x".repeat(MAX_PATH_BYTES + 1),
    ] {
        paths.push(invalid);
        assert!(
            FileOffer::new(&paths)
                .err()
                .unwrap()
                .starts_with("clipboard_files:invalid:")
        );
        paths.pop();
    }
    assert!(
        FileOffer::new(&vec![paths[0].clone(); MAX_FILES + 1])
            .err()
            .unwrap()
            .contains("at most 256")
    );
    validate_paths(&vec![paths[0].clone(); MAX_FILES]).unwrap();
    validate_paths(&[]).unwrap();
}

#[cfg(unix)]
#[test]
fn file_clipboard_keeps_directory_links_and_dangling_links_as_the_copied_objects() {
    let (dir, paths) = fixture();
    let link = dir.path().join(" directory link ");
    let dangling = dir.path().join(" dangling link ");
    std::os::unix::fs::symlink(&paths[1], &link).unwrap();
    std::os::unix::fs::symlink(dir.path().join("missing"), &dangling).unwrap();
    let links = vec![
        link.to_str().unwrap().into(),
        dangling.to_str().unwrap().into(),
    ];
    let offer = FileOffer::new(&links).unwrap();
    for format in FileListFormat::ALL {
        assert_eq!(format.decode(offer.payload(format)).unwrap(), links);
        assert!(
            !format
                .decode(offer.payload(format))
                .unwrap()
                .contains(&paths[1])
        );
    }
}

#[cfg(unix)]
#[test]
fn file_clipboard_rejects_special_files() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("socket");
    let _listener = std::os::unix::net::UnixListener::bind(&path).unwrap();
    assert!(
        validate_paths(&[path.to_str().unwrap().into()])
            .unwrap_err()
            .contains("not a file")
    );
}

#[cfg(unix)]
#[test]
fn file_clipboard_roundtrips_embedded_line_breaks_without_line_based_path_splitting() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("\t leading\r\n文件 \n");
    std::fs::write(&path, "content").unwrap();
    let paths = vec![path.to_str().unwrap().into()];
    let offer = FileOffer::new(&paths).unwrap();
    for format in FileListFormat::ALL {
        assert_eq!(format.decode(offer.payload(format)).unwrap(), paths);
    }
}

#[test]
fn file_clipboard_native_formats_are_real_mime_targets_with_copy_semantics() {
    let (_dir, paths) = fixture();
    let offer = FileOffer::new(&paths).unwrap();
    assert_eq!(
        FileListFormat::GnomeCopiedFiles.mime(),
        "x-special/gnome-copied-files"
    );
    assert_eq!(FileListFormat::UriList.mime(), "text/uri-list");
    let gnome = std::str::from_utf8(offer.payload(FileListFormat::GnomeCopiedFiles)).unwrap();
    assert!(gnome.starts_with("copy\nfile://"));
    assert!(!gnome.ends_with('\n')); // modern Nautilus rejects an empty URI
    assert!(!gnome.contains('\r'));
    let uris = std::str::from_utf8(offer.payload(FileListFormat::UriList)).unwrap();
    assert!(uris.ends_with("\r\n"));
    assert!(uris.contains("%20"));
    assert!(uris.contains("%23"));
    assert!(uris.contains("%25"));
    assert_eq!(uris.lines().count(), paths.len());
    let external_cut = gnome.replacen("copy\n", "cut\n", 1);
    assert_eq!(
        FileListFormat::GnomeCopiedFiles
            .decode(external_cut.as_bytes())
            .unwrap(),
        paths
    );
}

#[test]
fn file_clipboard_native_reader_never_falls_back_to_plain_paths_or_path_text() {
    let (_dir, paths) = fixture();
    for format in FileListFormat::ALL {
        assert!(format.decode(paths.join("\n").as_bytes()).is_err());
        assert!(format.decode(b"arbitrary clipboard text").is_err());
    }
    assert!(
        FileListFormat::GnomeCopiedFiles
            .decode(b"file:///tmp/a")
            .is_err()
    );
    assert!(
        FileListFormat::UriList
            .decode(b"copy\nfile:///tmp/a")
            .is_err()
    );
}

#[test]
fn file_clipboard_decoding_is_strict_and_lossless_instead_of_skipping_bad_items() {
    let format = FileListFormat::UriList;
    for bytes in [
        b"https://example.com/file".as_slice(),
        b"file:///tmp/space name",
        b" file:///tmp/a",
        b"file:///tmp/a\t",
        b"file:///tmp/a%",
        b"file:///tmp/a%0G",
        b"file:///tmp/a%00",
        b"file:///tmp/a?query",
        b"file:///tmp/a#fragment",
        b"file:///tmp/invalid%FF",
        b"\xff",
        b"file:///tmp/ok\nthis is not a URI",
    ] {
        assert!(format.decode(bytes).is_err(), "accepted {bytes:?}");
    }
    assert!(format.decode(&vec![b'a'; MAX_PAYLOAD_BYTES + 1]).is_err());
    let uri = url::Url::from_file_path(std::env::temp_dir().join("file"))
        .unwrap()
        .to_string();
    assert!(
        format
            .decode(vec![uri; MAX_FILES + 1].join("\n").as_bytes())
            .is_err()
    );
}

#[cfg(not(windows))]
#[test]
fn file_clipboard_decoding_rejects_nonlocal_authorities_and_preserves_encoded_whitespace() {
    let format = FileListFormat::UriList;
    assert!(
        format
            .decode(b"file://other-host/tmp/a")
            .unwrap_err()
            .contains("unsupported")
    );
    let paths = format
        .decode(b"#comment\r\nfile://localhost/tmp/%20%E6%96%87%E4%BB%B6%20\r\n")
        .unwrap();
    assert_eq!(paths, ["/tmp/ 文件 "]);
    assert!(format.decode(b"#comment\r\n\r\n").unwrap().is_empty());
}

#[test]
fn file_clipboard_offer_owns_snapshot_after_writer_inputs_are_dropped() {
    let (_dir, mut paths) = fixture();
    let expected = paths.clone();
    let offer = FileOffer::new(&paths).unwrap();
    // Model GTK's retained get-data closure: the caller and its dialog can go
    // away, repeated selection requests must still receive the original offer.
    let owner = move |format| offer.payload(format).to_vec();
    paths.clear();
    drop(paths);
    for _ in 0..3 {
        for format in FileListFormat::ALL {
            assert_eq!(format.decode(&owner(format)).unwrap(), expected);
        }
    }
}

#[test]
fn file_clipboard_hdrop_header_and_utf16_terminators_preserve_paths_exactly() {
    let (_dir, paths) = fixture();
    let bytes = hdrop::encode(&paths).unwrap();
    assert_eq!(&bytes[..4], &20u32.to_le_bytes());
    assert!(bytes[4..16].iter().all(|byte| *byte == 0));
    assert_eq!(&bytes[16..20], &1u32.to_le_bytes());
    let wide: Vec<_> = bytes[20..]
        .chunks_exact(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .collect();
    assert!(wide.ends_with(&[0, 0]));
    let decoded: Vec<_> = wide[..wide.len() - 1]
        .split(|unit| *unit == 0)
        .filter(|part| !part.is_empty())
        .map(|part| String::from_utf16(part).unwrap())
        .collect();
    assert_eq!(decoded, paths);
}
